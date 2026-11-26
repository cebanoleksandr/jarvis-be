import { localClock } from '../common/time.js';
import { briefingPrompt, briefingTitle } from './briefing-prompts.js';
import { briefingWindow, DEFAULT_SETTINGS, nextRun } from './schedule.js';

const at = (iso: string, tz = 'Europe/Kyiv') => localClock(new Date(iso), tz);

describe('localClock', () => {
  it('gives the local date, minutes and weekday', () => {
    // 2026-11-12 is a Thursday; Kyiv is UTC+2 in winter.
    expect(at('2026-11-12T06:05:00Z')).toEqual({
      date: '2026-11-12',
      minutes: 8 * 60 + 5,
      weekday: 4,
    });
  });

  it('rolls the date over by zone', () => {
    expect(at('2026-11-12T22:30:00Z')).toMatchObject({
      date: '2026-11-13',
      minutes: 30,
      weekday: 5,
    });
    expect(at('2026-11-12T03:00:00Z', 'America/New_York')).toMatchObject({
      date: '2026-11-11',
      weekday: 3,
    });
  });
});

const KYIV = 'Europe/Kyiv';
const utc = (iso: string) => new Date(iso);

describe('briefingWindow', () => {
  it('opens at the configured local time for the grace period', () => {
    expect(
      briefingWindow(DEFAULT_SETTINGS, 'morning', '2026-11-12', KYIV),
    ).toEqual({
      start: utc('2026-11-12T06:00:00Z'),
      end: utc('2026-11-12T08:00:00Z'),
    });
  });

  it('uses the user zone, not UTC', () => {
    // 08:00 in New York (UTC-5) is 13:00 UTC.
    expect(
      briefingWindow(
        DEFAULT_SETTINGS,
        'morning',
        '2026-11-12',
        'America/New_York',
      )?.start,
    ).toEqual(utc('2026-11-12T13:00:00Z'));
  });

  it('runs the weekly review only on its weekday, and nothing disabled', () => {
    // Sunday 2026-11-15, 18:00 in Kyiv.
    expect(
      briefingWindow(DEFAULT_SETTINGS, 'weekly', '2026-11-15', KYIV)?.start,
    ).toEqual(utc('2026-11-15T16:00:00Z'));
    expect(
      briefingWindow(DEFAULT_SETTINGS, 'weekly', '2026-11-14', KYIV),
    ).toBeNull();
    const off = { ...DEFAULT_SETTINGS, morningEnabled: false };
    expect(briefingWindow(off, 'morning', '2026-11-12', KYIV)).toBeNull();
  });

  it('does not carry a late window past midnight', () => {
    const s = { ...DEFAULT_SETTINGS, eveningTime: '23:30' };
    expect(briefingWindow(s, 'evening', '2026-11-12', KYIV)).toEqual({
      start: utc('2026-11-12T21:30:00Z'),
      end: utc('2026-11-12T22:00:00Z'), // local midnight
    });
  });

  it('still opens when the configured time is skipped by DST', () => {
    // Kyiv jumps 03:00 -> 04:00 on 2026-03-29; 03:30 never exists.
    const s = { ...DEFAULT_SETTINGS, morningTime: '03:30' };
    const w = briefingWindow(s, 'morning', '2026-03-29', KYIV)!;
    expect(localClock(w.start, KYIV)).toMatchObject({ date: '2026-03-29' });
    expect(w.end > w.start).toBe(true);
  });
});

describe('nextRun', () => {
  it('is today while the window has not closed, then tomorrow', () => {
    expect(
      nextRun(DEFAULT_SETTINGS, 'morning', KYIV, utc('2026-11-12T05:00:00Z')),
    ).toEqual({ localDate: '2026-11-12', at: utc('2026-11-12T06:00:00Z') });
    // Inside the window: due right away (at is in the past).
    expect(
      nextRun(DEFAULT_SETTINGS, 'morning', KYIV, utc('2026-11-12T07:59:00Z')),
    ).toEqual({ localDate: '2026-11-12', at: utc('2026-11-12T06:00:00Z') });
    expect(
      nextRun(DEFAULT_SETTINGS, 'morning', KYIV, utc('2026-11-12T08:00:00Z')),
    ).toEqual({ localDate: '2026-11-13', at: utc('2026-11-13T06:00:00Z') });
  });

  it('skips dates already sent', () => {
    expect(
      nextRun(
        DEFAULT_SETTINGS,
        'morning',
        KYIV,
        utc('2026-11-12T06:30:00Z'),
        new Set(['2026-11-12']),
      ),
    ).toEqual({ localDate: '2026-11-13', at: utc('2026-11-13T06:00:00Z') });
  });

  it('finds the weekly review up to a week ahead, nothing when disabled', () => {
    // Monday 2026-11-16 morning -> next Sunday.
    expect(
      nextRun(DEFAULT_SETTINGS, 'weekly', KYIV, utc('2026-11-16T06:00:00Z')),
    ).toEqual({ localDate: '2026-11-22', at: utc('2026-11-22T16:00:00Z') });
    const off = { ...DEFAULT_SETTINGS, weeklyEnabled: false };
    expect(
      nextRun(off, 'weekly', KYIV, utc('2026-11-16T06:00:00Z')),
    ).toBeNull();
  });
});

describe('briefing prompts', () => {
  it('marks the prompt as automated and states the local time', () => {
    const clock = at('2026-11-12T06:05:00Z');
    expect(briefingTitle('morning', clock)).toBe(
      'Morning briefing · 2026-11-12',
    );
    expect(briefingPrompt('morning', clock)).toMatch(
      /^\[Automated request .* Thursday 2026-11-12 08:05\.\]/,
    );
  });

  it("writes in the user's chosen language, or guesses without one", () => {
    const clock = at('2026-11-12T06:05:00Z');
    expect(briefingPrompt('morning', clock, 'uk')).toContain(
      'Write in Ukrainian',
    );
    expect(briefingPrompt('morning', clock)).toContain(
      "Write in the language the user's profile",
    );
    expect(briefingPrompt('morning', clock)).not.toContain('{language}');
  });
});
