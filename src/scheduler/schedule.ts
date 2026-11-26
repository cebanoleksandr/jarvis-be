import { addDays, localClock, zonedToUtc } from '../common/time.js';

export const BRIEFING_KINDS = ['morning', 'evening', 'weekly'] as const;
export type BriefingKind = (typeof BRIEFING_KINDS)[number];

export interface ScheduleSettings {
  morningEnabled: boolean;
  /** `HH:mm` in the user's time zone. */
  morningTime: string;
  eveningEnabled: boolean;
  eveningTime: string;
  weeklyEnabled: boolean;
  /** 0 = Sunday ... 6 = Saturday. */
  weeklyDay: number;
  weeklyTime: string;
}

export const DEFAULT_SETTINGS: ScheduleSettings = {
  morningEnabled: true,
  morningTime: '08:00',
  eveningEnabled: true,
  eveningTime: '21:00',
  weeklyEnabled: true,
  weeklyDay: 0,
  weeklyTime: '18:00',
};

/**
 * How long after the configured time a briefing may still be sent. Covers
 * downtime and slow ticks without delivering a morning plan in the evening.
 */
export const GRACE_MINUTES = 120;

export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** Briefings look this far ahead for their next run (covers a weekly one). */
const LOOKAHEAD_DAYS = 8;

const timeOf = (s: ScheduleSettings, kind: BriefingKind) =>
  kind === 'morning'
    ? { enabled: s.morningEnabled, time: s.morningTime }
    : kind === 'evening'
      ? { enabled: s.eveningEnabled, time: s.eveningTime }
      : { enabled: s.weeklyEnabled, time: s.weeklyTime };

/** 0 = Sunday ... 6 = Saturday, for a `YYYY-MM-DD` calendar date. */
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/**
 * When `kind` may be sent for the user's local `date`: from its configured
 * time until the grace period ends, but never past local midnight (a run
 * always belongs to its own date). Null when it does not run that day.
 */
export function briefingWindow(
  s: ScheduleSettings,
  kind: BriefingKind,
  date: string,
  tz: string,
): { start: Date; end: Date } | null {
  const { enabled, time } = timeOf(s, kind);
  if (!enabled) return null;
  if (kind === 'weekly' && weekdayOf(date) !== s.weeklyDay) return null;
  const start = zonedToUtc(`${date}T${time}`, tz);
  const midnight = zonedToUtc(addDays(date, 1), tz);
  const end = new Date(
    Math.min(start.getTime() + GRACE_MINUTES * 60_000, midnight.getTime()),
  );
  return { start, end };
}

/**
 * The next run of `kind` after `now`: the first local date whose window has
 * not closed yet and that is not in `done` (already sent or claimed). `at` is
 * the window start, possibly already past (then the run is due right away).
 */
export function nextRun(
  s: ScheduleSettings,
  kind: BriefingKind,
  tz: string,
  now: Date,
  done: ReadonlySet<string> = new Set(),
): { localDate: string; at: Date } | null {
  const today = localClock(now, tz).date;
  for (let i = 0; i <= LOOKAHEAD_DAYS; i++) {
    const date = addDays(today, i);
    if (done.has(date)) continue;
    const window = briefingWindow(s, kind, date, tz);
    if (window && now < window.end)
      return { localDate: date, at: window.start };
  }
  return null;
}
