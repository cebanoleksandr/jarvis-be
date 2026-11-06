import { tasks_v1 } from '@googleapis/tasks';
import { z } from 'zod';
import { defineTool } from '../../agent/tool.js';
import {
  callGoogle,
  type GoogleClientService,
  SCOPE_TASKS,
} from '../google-client.service.js';

const truncate = (s: string | null | undefined, n: number) =>
  s && s.length > n ? `${s.slice(0, n)}…` : (s ?? undefined);

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
    async execute({ userId }, { includeCompleted }) {
      const api_ = await api(userId);
      const res = await callGoogle(() =>
        api_.tasks.list({
          tasklist: '@default',
          showCompleted: includeCompleted,
          showHidden: includeCompleted,
          maxResults: 100,
        }),
      );
      return {
        tasks: (res.data.items ?? []).map((t) => ({
          id: t.id,
          title: t.title ?? '(no title)',
          notes: truncate(t.notes, 500),
          // Google Tasks keeps only the date part of `due`.
          due: t.due?.slice(0, 10),
          status: t.status,
        })),
        truncated: Boolean(res.data.nextPageToken),
      };
    },
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
  });

  return [listTasks, createTask];
}
