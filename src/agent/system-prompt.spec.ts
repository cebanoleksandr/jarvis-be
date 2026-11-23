import type { Goal } from '../memory/goal.entity.js';
import type { ProfileView } from '../users/users.service.js';
import {
  buildSystemPrompt,
  type PromptContext,
  renderGoals,
} from './system-prompt.js';

const profile: ProfileView = {
  name: 'Ann',
  email: 'ann@example.com',
  timezone: 'Pacific/Auckland',
  language: null,
  about: 'Backend developer, two kids.',
  preferences: { workHours: '9-17', focus: 'mornings' },
};

let seq = 0;
const goal = (title: string, extra: Partial<Goal> = {}) =>
  ({
    id: `g${++seq}`,
    parentId: null,
    title,
    notes: '',
    status: 'active',
    deadline: null,
    ...extra,
  }) as Goal;

describe('buildSystemPrompt', () => {
  const ctx: PromptContext = {
    profile,
    goals: [],
    memories: [{ text: 'Allergic to nuts' }],
  };

  it('uses the local date in the user timezone', () => {
    // 2026-11-06 20:00 UTC is already 2026-11-07 in Auckland.
    const prompt = buildSystemPrompt(ctx, new Date('2026-11-06T20:00:00Z'));
    expect(prompt).toContain('Today: Saturday, 2026-11-07');
    expect(prompt).toContain('Name: Ann');
  });

  it('includes profile, sorted preferences and memories', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('About: Backend developer, two kids.');
    expect(prompt).toMatch(/- focus: mornings\n- workHours: 9-17/);
    expect(prompt).toContain('<memories>\n- Allergic to nuts\n</memories>');
    expect(prompt).toContain('<goals>\n(none yet)\n</goals>');
  });

  it('marks directive memories as rules', () => {
    const prompt = buildSystemPrompt({
      ...ctx,
      memories: [
        { text: 'No calls before 10', category: 'directive' },
        { text: 'Has a cat', category: 'people' },
      ],
    });
    expect(prompt).toContain(
      '<memories>\n- [rule] No calls before 10\n- Has a cat\n</memories>',
    );
  });

  it('is identical within the same local day (cache-stable)', () => {
    const a = buildSystemPrompt(ctx, new Date('2026-11-06T12:00:00Z'));
    const b = buildSystemPrompt(ctx, new Date('2026-11-06T13:30:00Z'));
    expect(a).toBe(b);
  });

  it('puts the date after all stored context', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt.indexOf('<user_context>')).toBeGreaterThan(
      prompt.indexOf('<memories>'),
    );
  });
});

describe('renderGoals', () => {
  it('renders the tree, hides dropped items and finished top-level goals', () => {
    const run = goal('Run a marathon', {
      deadline: '2027-04-01',
      notes: 'Spring race',
    });
    const plan = goal('Training plan', { parentId: run.id });
    const shoes = goal('Buy shoes', { parentId: plan.id, status: 'done' });
    const dropped = goal('Swim', { parentId: run.id, status: 'dropped' });
    const finished = goal('Old goal', { status: 'done' });
    const paused = goal('Learn piano', { status: 'paused' });

    expect(renderGoals([run, plan, shoes, dropped, finished, paused])).toEqual([
      '- [active, due 2027-04-01] Run a marathon',
      '  notes: Spring race',
      '  - [active] Training plan',
      '    - [done] Buy shoes',
      '- [paused] Learn piano',
    ]);
  });
});
