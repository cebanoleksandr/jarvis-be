import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Subscription } from 'rxjs';
import type { Env } from '../config/env.validation.js';
import { UserEvents } from '../users/user-events.js';
import { BRIEFING_KINDS, type BriefingKind } from './schedule.js';
import {
  type BriefingJob,
  type RunOutcome,
  SchedulerService,
} from './scheduler.service.js';

const QUEUE = 'briefings';
const BRIEFING = 'briefing';
const RECONCILE = 'reconcile';
/** Briefings generated in parallel by one instance. */
const CONCURRENCY = 3;
/** Safety net: re-plans every active user (lost jobs, users back after a break). */
const RECONCILE_EVERY_MS = 60 * 60_000;

type QueueJob = Job<BriefingJob | Record<string, never>, RunOutcome | void>;

/** One pending job per user and briefing kind; `:` is not allowed in ids. */
export const briefingJobId = (kind: BriefingKind, userId: string) =>
  `${kind}-${userId}`;

/**
 * Briefing timing on BullMQ: each user has one delayed job per enabled
 * briefing, due at its next local time. When a job finishes, the next one is
 * planned; settings, time zone and sign-in changes re-plan right away, and an
 * hourly job re-plans every active user in case something was lost.
 *
 * Off under NODE_ENV=test or SCHEDULER_ENABLED=false; tests call start().
 */
@Injectable()
export class BriefingQueue implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BriefingQueue.name);
  private readonly enabled: boolean;
  private readonly redisUrl: string;
  private queue?: Queue;
  private worker?: Worker;
  private connections: Redis[] = [];
  private subscription?: Subscription;

  constructor(
    config: ConfigService<Env, true>,
    private readonly scheduler: SchedulerService,
    private readonly userEvents: UserEvents,
  ) {
    this.enabled =
      config.get('SCHEDULER_ENABLED', { infer: true }) &&
      config.get('NODE_ENV', { infer: true }) !== 'test';
    this.redisUrl = config.get('REDIS_URL', { infer: true });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.enabled) await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /**
   * `prefix` keeps test runs apart from each other and from dev data;
   * `reconcile: false` leaves other users alone (tests share the database).
   */
  async start(
    redisUrl = this.redisUrl,
    { prefix = 'jarvis', reconcile = true } = {},
  ): Promise<void> {
    if (this.queue) return;
    const connect = () => {
      // BullMQ needs maxRetriesPerRequest: null; ioredis keeps reconnecting,
      // so the app starts (and briefings wait) while Redis is down.
      const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
      redis.on('error', (err) =>
        this.logger.warn(`Redis: ${(err as Error).message}`),
      );
      this.connections.push(redis);
      return redis;
    };
    this.queue = new Queue(QUEUE, {
      connection: connect(),
      prefix,
      defaultJobOptions: {
        // Finished jobs go away so their id can be planned again. Failures
        // are kept in scheduled_runs and the logs instead.
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 1,
      },
    });
    this.worker = new Worker(QUEUE, (job: QueueJob) => this.process(job), {
      connection: connect(),
      prefix,
      concurrency: CONCURRENCY,
    });
    // Planned after the job is gone, so the same id can be reused.
    const next = (job: QueueJob | undefined) => {
      if (job?.name === BRIEFING) this.replan((job.data as BriefingJob).userId);
    };
    this.worker.on('completed', next);
    this.worker.on('failed', (job, err) => {
      this.logger.error(`Briefing job ${job?.id} failed: ${err.message}`);
      next(job);
    });
    this.worker.on('error', (err) =>
      this.logger.warn(`Briefing worker: ${err.message}`),
    );

    this.subscription = this.userEvents.scheduleChanged$.subscribe((userId) =>
      this.replan(userId),
    );
    if (!reconcile) return;
    // Non-blocking: with Redis down the app still starts.
    void this.queue
      .upsertJobScheduler(
        RECONCILE,
        { every: RECONCILE_EVERY_MS },
        {
          name: RECONCILE,
          opts: { removeOnComplete: true, removeOnFail: true },
        },
      )
      .then(() => this.reconcile())
      .catch((err: Error) =>
        this.logger.error(`Briefing queue setup failed: ${err.message}`),
      );
  }

  async stop(): Promise<void> {
    this.subscription?.unsubscribe();
    await this.worker?.close();
    await this.queue?.close();
    await Promise.all(this.connections.map((c) => c.quit().catch(() => null)));
    this.connections = [];
    this.worker = this.queue = this.subscription = undefined;
  }

  /** Fire-and-forget re-plan, for callers that must not wait on Redis. */
  replan(userId: string): void {
    void this.plan(userId).catch((err: Error) =>
      this.logger.error(
        `Planning briefings for ${userId} failed: ${err.message}`,
      ),
    );
  }

  /**
   * Makes the user's delayed jobs match their next runs: keeps a job that is
   * already right, replaces one planned for another time, removes the ones
   * that should no longer run. A job being processed cannot be removed; it
   * re-plans the user itself when it finishes.
   */
  async plan(userId: string, now = new Date()): Promise<void> {
    const queue = this.queue;
    if (!queue) return;
    const plans = await this.scheduler.plansFor(userId, now);
    for (const kind of BRIEFING_KINDS) {
      const id = briefingJobId(kind, userId);
      const plan = plans.find((p) => p.kind === kind);
      const existing = await queue.getJob(id);
      if (
        existing &&
        plan &&
        (existing.data as BriefingJob).localDate === plan.localDate &&
        Math.abs(existing.timestamp + existing.delay - plan.at.getTime()) < 1000
      ) {
        continue;
      }
      if (existing) {
        try {
          await existing.remove();
        } catch {
          continue; // active: it plans the next run when done
        }
      }
      if (plan) {
        const data: BriefingJob = {
          userId,
          kind,
          localDate: plan.localDate,
        };
        await queue.add(BRIEFING, data, {
          jobId: id,
          delay: Math.max(0, plan.at.getTime() - now.getTime()),
        });
      }
    }
  }

  /** Plans every active user; cheap when their jobs are already right. */
  async reconcile(now = new Date()): Promise<void> {
    for (const userId of await this.scheduler.activeUserIds(now)) {
      await this.plan(userId, now);
    }
  }

  private async process(job: QueueJob): Promise<RunOutcome | void> {
    if (job.name === RECONCILE) return this.reconcile();
    return this.scheduler.runPlanned(job.data as BriefingJob, new Date());
  }
}
