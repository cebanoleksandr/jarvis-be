import { addDays, zonedToUtc } from './time.js';

describe('zonedToUtc', () => {
  it('converts local midnight in winter and summer', () => {
    expect(zonedToUtc('2026-11-07', 'Europe/Kyiv').toISOString()).toBe(
      '2026-11-06T22:00:00.000Z',
    );
    expect(zonedToUtc('2026-07-01T09:30', 'Europe/Kyiv').toISOString()).toBe(
      '2026-07-01T06:30:00.000Z',
    );
  });

  it('handles DST transition days', () => {
    // Kyiv springs forward 2026-03-29 03:00 -> 04:00.
    expect(zonedToUtc('2026-03-29', 'Europe/Kyiv').toISOString()).toBe(
      '2026-03-28T22:00:00.000Z',
    );
    expect(zonedToUtc('2026-03-29T12:00', 'Europe/Kyiv').toISOString()).toBe(
      '2026-03-29T09:00:00.000Z',
    );
  });

  it('works west of UTC and for UTC', () => {
    // US DST ended on 2026-11-01, so New York is UTC-5 here...
    expect(zonedToUtc('2026-11-07', 'America/New_York').toISOString()).toBe(
      '2026-11-07T05:00:00.000Z',
    );
    // ...and UTC-4 in summer.
    expect(zonedToUtc('2026-07-01', 'America/New_York').toISOString()).toBe(
      '2026-07-01T04:00:00.000Z',
    );
    expect(zonedToUtc('2026-11-07', 'UTC').toISOString()).toBe(
      '2026-11-07T00:00:00.000Z',
    );
  });

  it('rejects malformed input', () => {
    expect(() => zonedToUtc('07.11.2026', 'UTC')).toThrow();
  });
});

describe('addDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
