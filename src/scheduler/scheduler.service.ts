import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AgentService } from '../agent/agent.service.js';
import { Conversation } from '../chat/conversation.entity.js';
import { localClock, type LocalClock } from '../common/time.js';
import type { Env } from '../config/env.validation.js';
import { User } from '../users/user.entity.js';
import { briefingPrompt, briefingTitle } from './briefing-prompts.js';
import { NotificationSettings } from './notification-settings.entity.js';
import {
  type BriefingKind,
  DEFAULT_SETTINGS,
  dueKinds,
  type ScheduleSettings,
} from './schedule.js';
import { ScheduledRun } from './scheduled-run.entity.js';

/** Briefings stop for users who have not used the app for this long. */
export const INACTIVE_AFTER_DAYS = 14;
/** Briefings generated in parallel within one tick. */
const CONCURRENCY = 3;
const RUN_TIMEOUT_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

interface DueRun {
  userId: string;
  kind: BriefingKind;
  clock: LocalClock;
}

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly enabled: boolean;
  private ticking = false;

  constructor(
    config: ConfigService<Env, true>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(NotificationSettings)
    private readonly settings: Repository<NotificationSettings>,
    @InjectRepository(ScheduledRun)
    private readonly runs: Repository<ScheduledRun>,
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    private readonly agent: AgentService,
  ) {
    this.enabled =
      config.get('SCHEDULER_ENABLED', { infer: true }) &&
      config.get('NODE_ENV', { infer: true }) !== 'test';
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    // A slow tick (many briefings) must not overlap with the next one.
    if (!this.enabled || this.ticking) return;
    this.ticking = true;
    try {
      await this.runDue(new Date());
    } catch (err) {
      this.logger.error(
        `Scheduler tick failed: ${(err as Error).stack ?? String(err)}`,
      );
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Sends every briefing whose window is open at `now` and that was not sent
   * yet. Returns how many were started. `onlyUserIds` narrows the scan (tests).
   */
  async runDue(now: Date, onlyUserIds?: string[]): Promise<number> {
    // Scans all users each tick: fine for the MVP, replace with one delayed
    // BullMQ job per user when the user count makes this slow.
    const users = await this.users.find({
      select: { id: true, timezone: true, createdAt: true, lastActiveAt: true },
      where: onlyUserIds ? { id: In(onlyUserIds) } : {},
    });
    const activeSince = now.getTime() - INACTIVE_AFTER_DAYS * DAY_MS;
    const active = users.filter(
      (u) => (u.lastActiveAt ?? u.createdAt).getTime() >= activeSince,
    );
    if (!active.length) return 0;

    const settings = new Map(
      (await this.settings.findBy({ userId: In(active.map((u) => u.id)) })).map(
        (s) => [s.userId, s as ScheduleSettings],
      ),
    );
    const due: DueRun[] = active.flatMap((u) => {
      const clock = localClock(now, u.timezone);
      return dueKinds(settings.get(u.id) ?? DEFAULT_SETTINGS, clock).map(
        (kind) => ({ userId: u.id, kind, clock }),
      );
    });
    if (!due.length) return 0;

    // Skip what is already claimed, so an open window costs one query per tick.
    const existing = await this.runs.find({
      select: { userId: true, kind: true, localDate: true },
      where: {
        userId: In([...new Set(due.map((d) => d.userId))]),
        localDate: In([...new Set(due.map((d) => d.clock.date))]),
      },
    });
    const taken = new Set(
      existing.map((r) => runKey(r.userId, r.kind, r.localDate)),
    );
    const todo = due.filter(
      (d) => !taken.has(runKey(d.userId, d.kind, d.clock.date)),
    );

    let started = 0;
    const queue = [...todo];
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        for (let d = queue.shift(); d; d = queue.shift()) {
          if (await this.runScheduled(d)) started++;
        }
      }),
    );
    return started;
  }

  /**
   * Starts a briefing right now, outside the schedule, and returns its
   * conversation while the reply is generated in the background. If
   * generation fails the conversation is removed.
   */
  async runNow(userId: string, kind: BriefingKind): Promise<Conversation> {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found');
    const conversation = await this.open(
      userId,
      kind,
      localClock(new Date(), user.timezone),
    );
    void this.generate(userId, conversation.id).catch((err) =>
      this.logger.error(
        `Manual ${kind} briefing for ${userId} failed: ${(err as Error).message}`,
      ),
    );
    return conversation;
  }

  /** False when another tick or instance already claimed this run. */
  private async runScheduled({
    userId,
    kind,
    clock,
  }: DueRun): Promise<boolean> {
    const claim = await this.runs
      .createQueryBuilder()
      .insert()
      .values({ userId, kind, localDate: clock.date, status: 'running' })
      .orIgnore()
      .returning('id')
      .execute();
    const runId = (claim.raw as { id: string }[])[0]?.id;
    if (!runId) return false;

    try {
      const conversation = await this.open(userId, kind, clock);
      await this.runs.update(runId, { conversationId: conversation.id });
      await this.generate(userId, conversation.id);
      await this.runs.update(runId, { status: 'done', finishedAt: new Date() });
    } catch (err) {
      // Not retried: the claim stays, so a broken briefing is not re-billed every minute.
      this.logger.error(
        `${kind} briefing for ${userId} failed: ${(err as Error).stack ?? String(err)}`,
      );
      await this.runs.update(runId, {
        status: 'failed',
        error: (err as Error).message.slice(0, 1000),
        finishedAt: new Date(),
      });
    }
    return true;
  }

  private open(userId: string, kind: BriefingKind, clock: LocalClock) {
    return this.agent.startAutomatedConversation(userId, {
      kind,
      title: briefingTitle(kind, clock),
      prompt: briefingPrompt(kind, clock),
    });
  }

  /** Generates the reply; removes the conversation if there is nothing to show. */
  private async generate(
    userId: string,
    conversationId: string,
  ): Promise<void> {
    try {
      const { assistantMessageId, stopReason } =
        await this.agent.runToCompletion(
          userId,
          conversationId,
          AbortSignal.timeout(RUN_TIMEOUT_MS),
        );
      if (!assistantMessageId) {
        throw new Error(`No reply was produced (stop reason: ${stopReason})`);
      }
    } catch (err) {
      await this.conversations.delete({ id: conversationId, userId });
      throw err;
    }
  }
}

function runKey(userId: string, kind: string, localDate: string): string {
  return `${userId}:${kind}:${localDate}`;
}
