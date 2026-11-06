import type { User } from '../users/user.entity.js';
import { buildSystemPrompt } from './system-prompt.js';

describe('buildSystemPrompt', () => {
  const user = { name: 'Ann', timezone: 'Pacific/Auckland' } as User;

  it('uses the local date in the user timezone', () => {
    // 2026-11-06 20:00 UTC is already 2026-11-07 in Auckland.
    const prompt = buildSystemPrompt(user, new Date('2026-11-06T20:00:00Z'));
    expect(prompt).toContain('Today: Saturday, 2026-11-07');
    expect(prompt).toContain('Name: Ann');
  });

  it('is identical within the same local day (cache-stable)', () => {
    const a = buildSystemPrompt(user, new Date('2026-11-06T12:00:00Z'));
    const b = buildSystemPrompt(user, new Date('2026-11-06T13:30:00Z'));
    expect(a).toBe(b);
  });
});
