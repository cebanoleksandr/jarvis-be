import { BadRequestException } from '@nestjs/common';
import type { Goal } from './goal.entity.js';
import { assertPlacement } from './goals.service.js';

const g = (id: string, parentId: string | null = null) =>
  ({ id, parentId }) as Goal;

describe('assertPlacement', () => {
  // goal -> project -> task, plus a lone goal
  const all = [
    g('goal'),
    g('project', 'goal'),
    g('task', 'project'),
    g('lone'),
  ];

  it('allows a new task under a project', () => {
    expect(() => assertPlacement(all, null, 'project')).not.toThrow();
  });

  it('rejects a fourth level', () => {
    expect(() => assertPlacement(all, null, 'task')).toThrow(
      /at most 3 levels/,
    );
  });

  it('rejects an unknown (or foreign) parent', () => {
    expect(() => assertPlacement(all, null, 'someone-elses')).toThrow(
      /not found/,
    );
  });

  it('rejects cycles', () => {
    expect(() => assertPlacement(all, 'goal', 'task')).toThrow(
      BadRequestException,
    );
    expect(() => assertPlacement(all, 'goal', 'goal')).toThrow(/under itself/);
  });

  it('accounts for the height of a moved subtree', () => {
    // goal (height 3) under lone would make 4 levels.
    expect(() => assertPlacement(all, 'goal', 'lone')).toThrow(
      /at most 3 levels/,
    );
    // project (height 2) under lone is fine.
    expect(() => assertPlacement(all, 'project', 'lone')).not.toThrow();
  });
});
