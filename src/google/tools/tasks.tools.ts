import { tasks_v1 } from '@googleapis/tasks';
import { z } from 'zod';
import { type ActionSummary, defineTool, ToolError } from '../../agent/tool.js';
import {
  callGoogle,
  createdId,
  type GoogleClientService,
  removeFromGoogle,
  SCOPE_TASKS,
} from '../google-client.service.js';

const truncate = (s: string | null | undefined, n: number) =>
  s && s.length > n ? `${s.slice(0, n)}…` : (s ?? undefined);

export interface Task {
  id: string;
  title: string;
  notes?: string;
  /** Google Tasks keeps only the date part of `due`. */
  due?: string;
  status: 'needsAction' | 'completed';
  completedAt?: string;
  link?: string;
}

/** Tasks of the default list, at most 100. Open tasks only unless includeCompleted. */
export async function fetchTasks(
  google: GoogleClientService,
  userId: string,
  includeCompleted: boolean,
): Promise<{ tasks: Task[]; truncated: boolean }> {
  const api = new tasks_v1.Tasks({
    auth: await google.forUser(userId, SCOPE_TASKS),
  });
  const res = await callGoogle(() =>
    api.tasks.list({
      tasklist: '@default',
      showCompleted: includeCompleted,
      showHidden: includeCompleted,
      maxResults: 100,
    }),
  );
  return {
    tasks: (res.data.items ?? []).map(toTask),
    truncated: Boolean(res.data.nextPageToken),
  };
}

function toTask(t: tasks_v1.Schema$Task): Task {
  return {
    id: t.id ?? '',
    title: t.title ?? '(no title)',
    notes: truncate(t.notes, 500),
    due: t.due?.slice(0, 10),
    status: t.status === 'completed' ? 'completed' : 'needsAction',
    completedAt: t.completed ?? undefined,
    link: t.webViewLink ?? undefined,
  };
}

const DUE = /^\d{4}-\d{2}-\d{2}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,1024}$/;
const taskIdSchema = z
  .string()
  .regex(TASK_ID)
  .describe('Task id from list_tasks');

/** Google Tasks stores only the date of `due`, as midnight UTC. */
const dueToGoogle = (due: string | null) =>
  due === null ? null : `${due}T00:00:00.000Z`;

/** The fields update_task can change, as they were, to put them back on undo. */
interface TaskSnapshot {
  title: string | null;
  notes: string | null;
  due: string | null;
  status: string | null;
}

const snapshot = (t: tasks_v1.Schema$Task): TaskSnapshot => ({
  title: t.title ?? null,
  notes: t.notes ?? null,
  due: t.due ?? null,
  status: t.status ?? null,
});

const statusLabel = (s: string | undefined) =>
  s === 'completed' ? 'done' : 'open';

export function tasksTools(google: GoogleClientService) {
  const api = async (userId: string) =>
    new tasks_v1.Tasks({ auth: await google.forUser(userId, SCOPE_TASKS) });

  const listTasks = defineTool({
    name: 'list_tasks',
    description:
      "List tasks from the user's default Google Tasks list. Open tasks only unless includeCompleted is true.",
    mutating: false,
    input: z
      .object({
        includeCompleted: z
          .boolean()
          .default(false)
          .describe('Also return completed tasks'),
      })
      .strict(),
    execute: ({ userId }, { includeCompleted }) =>
      fetchTasks(google, userId, includeCompleted),
  });

  const createTask = defineTool({
    name: 'create_task',
    description:
      "Create a task in the user's default Google Tasks list. Requires the user's confirmation before it runs.",
    mutating: true,
    input: z
      .object({
        title: z.string().trim().min(1).max(300),
        notes: z.string().max(4000).optional(),
        due: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('Due date, YYYY-MM-DD'),
      })
      .strict(),
    summarize: (v) => ({
      title: 'Create task',
      details: {
        Title: v.title,
        ...(v.due ? { Due: v.due } : {}),
        ...(v.notes ? { Notes: v.notes } : {}),
      },
    }),
    async execute({ userId }, v) {
      const api_ = await api(userId);
      const res = await callGoogle(() =>
        api_.tasks.insert({
          tasklist: '@default',
          requestBody: {
            title: v.title,
            notes: v.notes,
            due: v.due ? `${v.due}T00:00:00.000Z` : undefined,
          },
        }),
      );
      return {
        id: res.data.id,
        title: res.data.title,
        due: res.data.due?.slice(0, 10),
        link: res.data.webViewLink,
      };
    },
    async undo({ userId }, result) {
      const task = createdId(result);
      const api_ = await api(userId);
      await removeFromGoogle(() =>
        api_.tasks.delete({ tasklist: '@default', task }),
      );
    },
  });

  /** Deleted tasks can still be fetched for a while; they count as missing. */
  const loadTask = async (userId: string, task: string) => {
    const api_ = await api(userId);
    const res = await callGoogle(() =>
      api_.tasks.get({ tasklist: '@default', task }),
    );
    if (res.data.deleted) {
      throw new ToolError('Not found in Google: the task was deleted.');
    }
    return { api_, task: res.data };
  };

  const updateTask = defineTool({
    name: 'update_task',
    description:
      "Change a task in the user's default Google Tasks list: title, notes, due date, or mark it " +
      "done / open again. Requires the user's confirmation before it runs. Get the taskId from " +
      'list_tasks first and pass only the fields that change; due: null removes the due date.',
    mutating: true,
    input: z
      .object({
        taskId: taskIdSchema,
        title: z.string().trim().min(1).max(300).optional(),
        notes: z.string().max(4000).optional(),
        due: z
          .string()
          .regex(DUE)
          .nullable()
          .optional()
          .describe('Due date, YYYY-MM-DD; null removes it'),
        status: z
          .enum(['needsAction', 'completed'])
          .optional()
          .describe('completed marks it done, needsAction reopens it'),
      })
      .strict()
      .refine(
        (v) => Object.keys(v).some((k) => k !== 'taskId'),
        'Nothing to change',
      ),
    lookup: async ({ userId }, v) =>
      toTask((await loadTask(userId, v.taskId)).task),
    summarize(v, before): ActionSummary {
      const old = before as Task | undefined;
      const change = (from: string | undefined, to: string) =>
        from === undefined || from === to ? to : `${from} → ${to}`;
      return {
        title:
          v.status === 'completed' && Object.keys(v).length === 2
            ? 'Complete task'
            : 'Change task',
        details: {
          Task: old?.title ?? v.taskId,
          ...(v.title ? { Title: change(old?.title, v.title) } : {}),
          ...(v.due !== undefined
            ? { Due: change(old && (old.due ?? 'none'), v.due ?? 'none') }
            : {}),
          ...(v.status
            ? {
                Status: change(
                  old && statusLabel(old.status),
                  statusLabel(v.status),
                ),
              }
            : {}),
          ...(v.notes !== undefined ? { Notes: v.notes } : {}),
        },
      };
    },
    async execute({ userId }, v) {
      const { api_, task } = await loadTask(userId, v.taskId);
      const res = await callGoogle(() =>
        api_.tasks.patch({
          tasklist: '@default',
          task: v.taskId,
          requestBody: {
            title: v.title,
            notes: v.notes,
            due: v.due === undefined ? undefined : dueToGoogle(v.due),
            status: v.status,
            // Reopening needs the completion time cleared as well.
            ...(v.status === 'needsAction' ? { completed: null } : {}),
          },
        }),
      );
      return {
        id: res.data.id,
        title: res.data.title,
        due: res.data.due?.slice(0, 10),
        status: res.data.status,
        link: res.data.webViewLink,
        previous: snapshot(task),
      };
    },
    async undo({ userId }, result) {
      const task = createdId(result);
      const prev = (result as { previous?: TaskSnapshot }).previous;
      if (!prev)
        throw new ToolError('There is nothing to undo for this action.');
      const api_ = await api(userId);
      await callGoogle(() =>
        api_.tasks.patch({
          tasklist: '@default',
          task,
          requestBody: {
            title: prev.title ?? '',
            notes: prev.notes ?? '',
            due: prev.due,
            status: prev.status ?? 'needsAction',
            ...(prev.status !== 'completed' ? { completed: null } : {}),
          },
        }),
      );
    },
  });

  const deleteTask = defineTool({
    name: 'delete_task',
    description:
      "Delete a task from the user's default Google Tasks list. Requires the user's confirmation " +
      'before it runs. Get the taskId from list_tasks first. To mark a task done, use update_task instead.',
    mutating: true,
    input: z.object({ taskId: taskIdSchema }).strict(),
    lookup: async ({ userId }, v) =>
      toTask((await loadTask(userId, v.taskId)).task),
    summarize(v, before): ActionSummary {
      const old = before as Task | undefined;
      return {
        title: 'Delete task',
        details: old
          ? { Title: old.title, ...(old.due ? { Due: old.due } : {}) }
          : { Task: v.taskId },
      };
    },
    async execute({ userId }, v) {
      const { api_, task } = await loadTask(userId, v.taskId);
      await removeFromGoogle(() =>
        api_.tasks.delete({ tasklist: '@default', task: v.taskId }),
      );
      return {
        deleted: true,
        title: task.title ?? '(no title)',
        due: task.due?.slice(0, 10),
        // What undo needs to put it back (as a new task).
        previous: snapshot(task),
      };
    },
    async undo({ userId }, result) {
      const prev = (result as { previous?: TaskSnapshot } | null)?.previous;
      if (!prev)
        throw new ToolError('There is nothing to undo for this action.');
      const api_ = await api(userId);
      await callGoogle(() =>
        api_.tasks.insert({
          tasklist: '@default',
          requestBody: {
            title: prev.title,
            notes: prev.notes,
            due: prev.due,
            status: prev.status ?? 'needsAction',
          },
        }),
      );
    },
  });

  return [listTasks, createTask, updateTask, deleteTask] as const;
}
