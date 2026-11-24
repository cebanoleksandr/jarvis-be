import type { GoogleClientService } from '../google-client.service.js';
import { calendarTools } from './calendar.tools.js';
import { tasksTools } from './tasks.tools.js';

// Stand-ins for the Google API clients: each test sets what get() returns.
const events = {
  get: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  insert: vi.fn(),
};
const tasks = {
  get: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  insert: vi.fn(),
};
vi.mock('@googleapis/calendar', () => ({
  calendar_v3: {
    Calendar: class {
      events = events;
    },
  },
}));
vi.mock('@googleapis/tasks', () => ({
  tasks_v1: {
    Tasks: class {
      tasks = tasks;
    },
  },
}));

const google = {
  forUser: vi.fn().mockResolvedValue({}),
} as unknown as GoogleClientService;
const [, , updateEvent, deleteEvent] = calendarTools(google);
const [, , updateTask, deleteTask] = tasksTools(google);
const ctx = { userId: 'u1', timezone: 'Europe/Kyiv' };

const standup = {
  id: 'ev1',
  status: 'confirmed',
  summary: 'Standup',
  location: 'Zoom',
  description: null,
  start: { dateTime: '2026-11-24T09:30:00+02:00', timeZone: 'Europe/Kyiv' },
  end: { dateTime: '2026-11-24T10:00:00+02:00', timeZone: 'Europe/Kyiv' },
  reminders: { useDefault: true },
  htmlLink: 'https://calendar/ev1',
};

beforeEach(() => {
  vi.clearAllMocks();
  events.get.mockResolvedValue({ data: standup });
  events.patch.mockImplementation(async ({ requestBody }) => ({
    data: { ...standup, ...requestBody },
  }));
  events.delete.mockResolvedValue({});
  events.insert.mockResolvedValue({ data: { id: 'ev2' } });
});

describe('update_event', () => {
  it('needs a change, and start/end together', () => {
    const ok = (v: object) => updateEvent.input.safeParse(v).success;
    expect(ok({ eventId: 'ev1', title: 'Sync' })).toBe(true);
    expect(ok({ eventId: 'ev1' })).toBe(false);
    expect(ok({ eventId: 'ev1', start: '2026-11-24T11:00' })).toBe(false);
    expect(
      ok({
        eventId: 'ev1',
        start: '2026-11-24T11:00',
        end: '2026-11-24T10:00',
      }),
    ).toBe(false);
    expect(ok({ eventId: '../x', title: 'Sync' })).toBe(false);
  });

  it('shows the real event and what changes on the card', async () => {
    const v = updateEvent.input.parse({
      eventId: 'ev1',
      start: '2026-11-24T11:00',
      end: '2026-11-24T11:30',
    });
    const before = await updateEvent.lookup!(ctx, v);
    expect(events.get).toHaveBeenCalledWith({
      calendarId: 'primary',
      eventId: 'ev1',
      timeZone: 'Europe/Kyiv',
    });
    expect(updateEvent.summarize!(v, before)).toEqual({
      title: 'Change calendar event',
      details: {
        Event: 'Standup',
        When: '2026-11-24 09:30 – 2026-11-24 10:00 → 2026-11-24 11:00 – 2026-11-24 11:30',
      },
    });
  });

  it('treats a deleted event as missing', async () => {
    events.get.mockResolvedValue({ data: { ...standup, status: 'cancelled' } });
    await expect(
      updateEvent.lookup!(ctx, { eventId: 'ev1', title: 'x' }),
    ).rejects.toThrow(/deleted/);
  });

  it('patches only the given fields and undo puts the old ones back', async () => {
    const result = await updateEvent.execute(ctx, {
      eventId: 'ev1',
      title: 'Sync',
      start: '2026-11-25',
      end: '2026-11-25',
    });
    expect(events.patch).toHaveBeenCalledWith({
      calendarId: 'primary',
      eventId: 'ev1',
      requestBody: {
        summary: 'Sync',
        description: undefined,
        location: undefined,
        start: { date: '2026-11-25', dateTime: null, timeZone: null },
        end: { date: '2026-11-26', dateTime: null, timeZone: null },
        reminders: undefined,
      },
    });

    await updateEvent.undo!(ctx, result);
    expect(events.patch).toHaveBeenLastCalledWith({
      calendarId: 'primary',
      eventId: 'ev1',
      requestBody: {
        summary: 'Standup',
        description: '',
        location: 'Zoom',
        start: {
          date: null,
          dateTime: standup.start.dateTime,
          timeZone: 'Europe/Kyiv',
        },
        end: {
          date: null,
          dateTime: standup.end.dateTime,
          timeZone: 'Europe/Kyiv',
        },
        reminders: { useDefault: true, overrides: [] },
      },
    });
  });
});

describe('delete_event', () => {
  it('deletes and undo recreates the event', async () => {
    const result = await deleteEvent.execute(ctx, { eventId: 'ev1' });
    expect(events.delete).toHaveBeenCalledWith({
      calendarId: 'primary',
      eventId: 'ev1',
    });
    expect(result).toMatchObject({ deleted: true, title: 'Standup' });

    await deleteEvent.undo!(ctx, result);
    expect(events.insert).toHaveBeenCalledWith({
      calendarId: 'primary',
      requestBody: expect.objectContaining({
        summary: 'Standup',
        location: 'Zoom',
        start: standup.start,
        end: standup.end,
      }),
    });
  });

  it('summarizes from the looked-up event, not the model', async () => {
    const before = await deleteEvent.lookup!(ctx, { eventId: 'ev1' });
    expect(deleteEvent.summarize!({ eventId: 'ev1' }, before)).toEqual({
      title: 'Delete calendar event',
      details: {
        Title: 'Standup',
        When: '2026-11-24 09:30 – 2026-11-24 10:00',
        Location: 'Zoom',
      },
    });
  });
});

describe('update_task / delete_task', () => {
  const bill = {
    id: 'k1',
    title: 'Pay the bill',
    notes: null,
    due: '2026-11-24T00:00:00.000Z',
    status: 'needsAction',
  };
  beforeEach(() => {
    tasks.get.mockResolvedValue({ data: bill });
    tasks.patch.mockImplementation(async ({ requestBody }) => ({
      data: { ...bill, ...requestBody },
    }));
    tasks.delete.mockResolvedValue({});
    tasks.insert.mockResolvedValue({ data: { id: 'k2' } });
  });

  it('completes a task and undo reopens it', async () => {
    const v = updateTask.input.parse({ taskId: 'k1', status: 'completed' });
    const before = await updateTask.lookup!(ctx, v);
    expect(updateTask.summarize!(v, before)).toEqual({
      title: 'Complete task',
      details: { Task: 'Pay the bill', Status: 'open → done' },
    });

    const result = await updateTask.execute(ctx, v);
    expect(tasks.patch).toHaveBeenCalledWith({
      tasklist: '@default',
      task: 'k1',
      requestBody: {
        title: undefined,
        notes: undefined,
        due: undefined,
        status: 'completed',
      },
    });
    await updateTask.undo!(ctx, result);
    expect(tasks.patch).toHaveBeenLastCalledWith({
      tasklist: '@default',
      task: 'k1',
      requestBody: {
        title: 'Pay the bill',
        notes: '',
        due: bill.due,
        status: 'needsAction',
        completed: null,
      },
    });
  });

  it('due: null clears the due date', async () => {
    await updateTask.execute(ctx, { taskId: 'k1', due: null });
    expect(tasks.patch.mock.calls[0][0].requestBody.due).toBeNull();
  });

  it('a deleted task counts as missing', async () => {
    tasks.get.mockResolvedValue({ data: { ...bill, deleted: true } });
    await expect(deleteTask.lookup!(ctx, { taskId: 'k1' })).rejects.toThrow(
      /deleted/,
    );
  });

  it('deletes and undo recreates the task', async () => {
    const result = await deleteTask.execute(ctx, { taskId: 'k1' });
    expect(tasks.delete).toHaveBeenCalledWith({
      tasklist: '@default',
      task: 'k1',
    });
    await deleteTask.undo!(ctx, result);
    expect(tasks.insert).toHaveBeenCalledWith({
      tasklist: '@default',
      requestBody: {
        title: 'Pay the bill',
        notes: null,
        due: bill.due,
        status: 'needsAction',
      },
    });
  });
});
