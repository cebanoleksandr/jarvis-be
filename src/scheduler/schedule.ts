import type { LocalClock } from '../common/time.js';

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

/**
 * Briefings whose window is open at the user's local `clock`. The window never
 * crosses local midnight, so a run always belongs to `clock.date`.
 */
export function dueKinds(
  s: ScheduleSettings,
  clock: LocalClock,
): BriefingKind[] {
  const open = (time: string) => {
    const start = toMinutes(time);
    return clock.minutes >= start && clock.minutes < start + GRACE_MINUTES;
  };
  const due: BriefingKind[] = [];
  if (s.morningEnabled && open(s.morningTime)) due.push('morning');
  if (s.eveningEnabled && open(s.eveningTime)) due.push('evening');
  if (s.weeklyEnabled && clock.weekday === s.weeklyDay && open(s.weeklyTime))
    due.push('weekly');
  return due;
}
