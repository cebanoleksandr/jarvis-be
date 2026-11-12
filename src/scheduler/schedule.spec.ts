import { localClock } from '../common/time.js';
import { briefingPrompt, briefingTitle } from './briefing-prompts.js';
import { DEFAULT_SETTINGS, dueKinds } from './schedule.js';

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

describe('dueKinds', () => {
  it('opens the morning window at the configured local time', () => {
    expect(dueKinds(DEFAULT_SETTINGS, at('2026-11-12T05:59:00Z'))).toEqual([]);
    expect(dueKinds(DEFAULT_SETTINGS, at('2026-11-12T06:00:00Z'))).toEqual([
      'morning',
    ]);
  });

  it('closes the window after the grace period', () => {
    expect(dueKinds(DEFAULT_SETTINGS, at('2026-11-12T07:59:00Z'))).toEqual([
      'morning',
    ]);
    expect(dueKinds(DEFAULT_SETTINGS, at('2026-11-12T08:00:00Z'))).toEqual([]);
  });

  it('uses the user zone, not UTC', () => {
    // 08:00 in New York (UTC-5) is 13:00 UTC.
    const ny = at('2026-11-12T13:00:00Z', 'America/New_York');
    expect(dueKinds(DEFAULT_SETTINGS, ny)).toEqual(['morning']);
  });

  it('sends the weekly review only on its weekday', () => {
    // Sunday 2026-11-15, 18:30 in Kyiv.
    expect(dueKinds(DEFAULT_SETTINGS, at('2026-11-15T16:30:00Z'))).toEqual([
      'weekly',
    ]);
    expect(dueKinds(DEFAULT_SETTINGS, at('2026-11-14T16:30:00Z'))).toEqual([]);
  });

  it('respects disabled kinds and overlapping windows', () => {
    const s = {
      ...DEFAULT_SETTINGS,
      morningEnabled: false,
      eveningTime: '18:00',
    };
    expect(dueKinds(s, at('2026-11-12T06:00:00Z'))).toEqual([]);
    expect(dueKinds(s, at('2026-11-15T16:30:00Z'))).toEqual([
      'evening',
      'weekly',
    ]);
  });

  it('does not carry a late window past midnight', () => {
    const s = { ...DEFAULT_SETTINGS, eveningTime: '23:30' };
    expect(dueKinds(s, at('2026-11-12T21:45:00Z'))).toEqual(['evening']);
    // 00:10 the next local day.
    expect(dueKinds(s, at('2026-11-12T22:10:00Z'))).toEqual([]);
  });

  it('still fires when the configured time is skipped by DST', () => {
    // Kyiv jumps 03:00 -> 04:00 on 2026-03-29; 03:30 never exists.
    const s = { ...DEFAULT_SETTINGS, morningTime: '03:30' };
    expect(dueKinds(s, at('2026-03-29T01:00:00Z'))).toEqual(['morning']);
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
});
