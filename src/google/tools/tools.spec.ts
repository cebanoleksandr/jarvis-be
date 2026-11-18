import { toJsonSchema } from '../../agent/tool.js';
import type { GoogleClientService } from '../google-client.service.js';
import { calendarTools } from './calendar.tools.js';
import { tasksTools } from './tasks.tools.js';

const google = {} as GoogleClientService;
const [getEvents, createEvent] = calendarTools(google);
const [listTasks, createTask] = tasksTools(google);

describe('calendar tools', () => {
  it('get_events accepts a range up to 31 days and rejects longer or reversed ones', () => {
    expect(
      getEvents.input.safeParse({ from: '2026-11-01', to: '2026-12-01' })
        .success,
    ).toBe(true);
    expect(
      getEvents.input.safeParse({ from: '2026-11-01', to: '2026-12-02' })
        .success,
    ).toBe(false);
    expect(
      getEvents.input.safeParse({ from: '2026-11-05', to: '2026-11-04' })
        .success,
    ).toBe(false);
  });

  it('get_events rejects malformed dates without throwing', () => {
    expect(
      getEvents.input.safeParse({ from: 'tomorrow', to: '2026-11-01' }).success,
    ).toBe(false);
  });

  it('create_event validates times and summarizes for the confirmation card', () => {
    const ok = createEvent.input.safeParse({
      title: 'Dentist',
      start: '2026-11-07T10:00',
      end: '2026-11-07T11:00',
      location: 'Clinic',
    });
    expect(ok.success).toBe(true);
    expect(createEvent.summarize!(ok.data)).toEqual({
      title: 'Create calendar event',
      details: {
        Title: 'Dentist',
        When: '2026-11-07 10:00 – 2026-11-07 11:00',
        Location: 'Clinic',
      },
    });

    const bad = [
      { title: 'x', start: '2026-11-07T11:00', end: '2026-11-07T10:00' },
      { title: 'x', start: '2026-11-07', end: '2026-11-07T10:00' },
      {
        title: 'x',
        start: '2026-11-07T10:00:00+02:00',
        end: '2026-11-07T11:00',
      },
      {
        title: 'x',
        start: '2026-11-07T10:00',
        end: '2026-11-07T11:00',
        calendarId: 'other',
      },
    ];
    for (const input of bad)
      expect(createEvent.input.safeParse(input).success).toBe(false);
  });

  it('create_event supports all-day events', () => {
    const v = createEvent.input.parse({
      title: 'Trip',
      start: '2026-11-07',
      end: '2026-11-09',
    });
    expect(createEvent.summarize!(v).details.When).toBe(
      '2026-11-07 – 2026-11-09 (all day)',
    );
  });
});

describe('tasks tools', () => {
  it('list_tasks defaults includeCompleted to false', () => {
    expect(listTasks.input.parse({})).toEqual({ includeCompleted: false });
  });

  it('create_task requires a title and a date-only due', () => {
    expect(
      createTask.input.safeParse({ title: 'Call mom', due: '2026-11-08' })
        .success,
    ).toBe(true);
    expect(createTask.input.safeParse({ title: '' }).success).toBe(false);
    expect(
      createTask.input.safeParse({ title: 'x', due: '2026-11-08T10:00' })
        .success,
    ).toBe(false);
  });
});

describe('mutability', () => {
  it('only create_* tools are mutating', () => {
    expect(
      [getEvents, createEvent, listTasks, createTask].map((t) => [
        t.name,
        t.mutating,
      ]),
    ).toEqual([
      ['get_events', false],
      ['create_event', true],
      ['list_tasks', false],
      ['create_task', true],
    ]);
  });
});

describe('toJsonSchema', () => {
  it('produces a closed object schema without $schema', () => {
    const schema = toJsonSchema(createTask.input);
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['title'],
    });
    expect(schema).not.toHaveProperty('$schema');
  });
});
