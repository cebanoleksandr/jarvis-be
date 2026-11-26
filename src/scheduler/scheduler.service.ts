import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { AgentService } from '../agent/agent.service.js';
import { Conversation } from '../chat/conversation.entity.js';
import { localClock, type LocalClock } from '../common/time.js';
import { User } from '../users/user.entity.js';
import { briefingPrompt, briefingTitle } from './briefing-prompts.js';
import type { Language } from '../users/languages.js';
import { NotificationSettings } from './notification-settings.entity.js';
import {
  BRIEFING_KINDS,
  type BriefingKind,
  briefingWindow,
  DEFAULT_SETTINGS,
  nextRun,
  type ScheduleSettings,
} from './schedule.js';
import { ScheduledRun } from './scheduled-run.entity.js';

/** Briefings stop for users who have not used the app for this long. */
export const INACTIVE_AFTER_DAYS = 14;
const RUN_TIMEOUT_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** A queued job firing this much before its window (clock skew) still runs. */
const EARLY_TOLERANCE_MS = 60_000;

/** What a queued briefing job carries; everything else is re-read when it runs. */
export interface BriefingJob {
  userId: string;
  kind: BriefingKind;
  /** The user's local date the briefing is for, `YYYY-MM-DD`. */
  localDate: string;
}

export interface PlannedRun {
  kind: BriefingKind;
  localDate: string;
  /** Window start; in the past when the briefing is due right away. */
  at: Date;
}

/** `skipped`: not due (settings changed, inactive, already claimed, ...). */
export type RunOutcome = 'sent' | 'failed' | 'skipped';

interface Run {
  userId: string;
  kind: BriefingKind;
  clock: LocalClock;
  language: Language | null;
}

const isActive = (u: Pick<User, 'lastActiveAt' | 'createdAt'>, now: Date) =>
  (u.lastActiveAt ?? u.createdAt).getTime() >=
  now.getTime() - INACTIVE_AFTER_DAYS * DAY_MS;

/**
 * Decides when briefings are due and runs them. Timing lives in the briefing
 * queue (one delayed job per user and kind); this service is the database
 * side: what to plan, and whether a job that fires is still due.
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(NotificationSettings)
    private readonly settings: Repository<NotificationSettings>,
    @InjectRepository(ScheduledRun)
    private readonly runs: Repository<ScheduledRun>,
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    private readonly agent: AgentService,
  ) {}

  /**
   * The next run of each enabled briefing of the user, skipping dates already
   * sent. Empty for unknown or inactive users: their jobs are dropped.
   */
  async plansFor(userId: string, now: Date): Promise<PlannedRun[]> {
    const user = await this.users.findOne({
      select: { id: true, timezone: true, createdAt: true, lastActiveAt: true },
      where: { id: userId },
    });
    if (!user || !isActive(user, now)) return [];
    const settings = await this.settingsOf(userId);
    const today = localClock(now, user.timezone).date;
    const claimed = await this.runs.find({
      select: { kind: true, localDate: true },
      where: { userId, localDate: MoreThanOrEqual(today) },
    });
    return BRIEFING_KINDS.flatMap((kind) => {
      const done = new Set(
        claimed.filter((r) => r.kind === kind).map((r) => r.localDate),
      );
      const next = nextRun(settings, kind, user.timezone, now, done);
      return next ? [{ kind, ...next }] : [];
    });
  }

  /** Users whose briefings should be planned (used by the hourly check). */
  async activeUserIds(now: Date): Promise<string[]> {
    const users = await this.users.find({
      select: { id: true, createdAt: true, lastActiveAt: true },
    });
    return users.filter((u) => isActive(u, now)).map((u) => u.id);
  }

  /**
   * Runs a queued briefing if it is still due at `now` under the user's
   * current settings and time zone; jobs left over from older settings are
   * skipped. The unique claim in scheduled_runs makes a duplicate job (two
   * instances, a retry) harmless: the briefing is sent once.
   */
  async runPlanned(job: BriefingJob, now: Date): Promise<RunOutcome> {
    const { userId, kind, localDate } = job;
    const user = await this.users.findOneBy({ id: userId });
    if (!user || !isActive(user, now)) return 'skipped';
    const window = briefingWindow(
      await this.settingsOf(userId),
      kind,
      localDate,
      user.timezone,
    );
    if (!window) return 'skipped';
    const early = window.start.getTime() - now.getTime();
    const at = early > 0 && early <= EARLY_TOLERANCE_MS ? window.start : now;
    if (at < window.start || at >= window.end) return 'skipped';

    const claim = await this.runs
      .createQueryBuilder()
      .insert()
      .values({ userId, kind, localDate, status: 'running' })
      .orIgnore()
      .returning('id')
      .execute();
    const runId = (claim.raw as { id: string }[])[0]?.id;
    if (!runId) return 'skipped';

    try {
      const conversation = await this.open({
        userId,
        kind,
        clock: localClock(at, user.timezone),
        language: user.language,
      });
      await this.runs.update(runId, { conversationId: conversation.id });
      await this.generate(userId, conversation.id);
      await this.runs.update(runId, { status: 'done', finishedAt: new Date() });
      return 'sent';
    } catch (err) {
      // Not retried: the claim stays, so a broken briefing is not re-billed.
      this.logger.error(
        `${kind} briefing for ${userId} failed: ${(err as Error).stack ?? String(err)}`,
      );
      await this.runs.update(runId, {
        status: 'failed',
        error: (err as Error).message.slice(0, 1000),
        finishedAt: new Date(),
      });
      return 'failed';
    }
  }

  /**
   * Starts a briefing right now, outside the schedule, and returns its
   * conversation while the reply is generated in the background. If
   * generation fails the conversation is removed.
   */
  async runNow(userId: string, kind: BriefingKind): Promise<Conversation> {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found');
    const conversation = await this.open({
      userId,
      kind,
      clock: localClock(new Date(), user.timezone),
      language: user.language,
    });
    void this.generate(userId, conversation.id).catch((err) =>
      this.logger.error(
        `Manual ${kind} briefing for ${userId} failed: ${(err as Error).message}`,
      ),
    );
    return conversation;
  }

  private async settingsOf(userId: string): Promise<ScheduleSettings> {
    return (await this.settings.findOneBy({ userId })) ?? DEFAULT_SETTINGS;
  }

  private open({ userId, kind, clock, language }: Run) {
    return this.agent.startAutomatedConversation(userId, {
      kind,
      title: briefingTitle(kind, clock),
      prompt: briefingPrompt(kind, clock, language),
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
