import { calendar_v3 } from '@googleapis/calendar';
import { z } from 'zod';
import { defineTool } from '../../agent/tool.js';
import { addDays, zonedToUtc } from '../../common/time.js';
import {
  callGoogle,
  createdId,
  type GoogleClientService,
  removeFromGoogle,
  SCOPE_CALENDAR_EVENTS,
} from '../google-client.service.js';

const MAX_RANGE_DAYS = 31;
/** Google Calendar allows reminders up to four weeks ahead. */
const MAX_REMINDER_MINUTES = 40320;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_OR_DATETIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;

const truncate = (s: string | null | undefined, n: number) =>
  s && s.length > n ? `${s.slice(0, n)}…` : (s ?? undefined);

/** A range of days in the user's timezone; shared by the tool and the REST endpoint. */
export const eventsRangeSchema = z
  .object({
    from: z.string().regex(DATE).describe('First day, YYYY-MM-DD'),
    to: z.string().regex(DATE).describe('Last day (inclusive), YYYY-MM-DD'),
  })
  .strict()
  .refine((v) => v.to >= v.from, 'to must not be before from')
  .refine(
    // zod still runs object refinements after a field failed its regex.
    (v) => !DATE.test(v.from) || v.to <= addDays(v.from, MAX_RANGE_DAYS - 1),
    `Range is limited to ${MAX_RANGE_DAYS} days`,
  );

export interface CalendarEvent {
  id: string;
  title: string;
  /** Local date-time with offset, or `YYYY-MM-DD` for all-day events. */
  start: string;
  /** For all-day events the day after the last one (Google's exclusive end). */
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  link?: string;
}

/** Events of the primary calendar, ordered by start, at most 100. */
export async function fetchEvents(
  google: GoogleClientService,
  userId: string,
  timezone: string,
  { from, to }: z.output<typeof eventsRangeSchema>,
): Promise<{ timezone: string; events: CalendarEvent[]; truncated: boolean }> {
  const cal = new calendar_v3.Calendar({
    auth: await google.forUser(userId, SCOPE_CALENDAR_EVENTS),
  });
  const res = await callGoogle(() =>
    cal.events.list({
      calendarId: 'primary',
      timeMin: zonedToUtc(from, timezone).toISOString(),
      timeMax: zonedToUtc(addDays(to, 1), timezone).toISOString(),
      timeZone: timezone,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100,
    }),
  );
  return {
    timezone,
    events: (res.data.items ?? []).map((e) => ({
      id: e.id ?? '',
      title: e.summary ?? '(no title)',
      start: e.start?.dateTime ?? e.start?.date ?? '',
      end: e.end?.dateTime ?? e.end?.date ?? '',
      allDay: Boolean(e.start?.date),
      location: e.location ?? undefined,
      description: truncate(e.description, 500),
      link: e.htmlLink ?? undefined,
    })),
    truncated: Boolean(res.data.nextPageToken),
  };
}

export function calendarTools(google: GoogleClientService) {
  const api = async (userId: string) =>
    new calendar_v3.Calendar({
      auth: await google.forUser(userId, SCOPE_CALENDAR_EVENTS),
    });

  const getEvents = defineTool({
    name: 'get_events',
    description:
      "List events from the user's primary Google Calendar for a range of days. " +
      "Days are in the user's timezone; times in the result are local to that timezone. " +
      `At most ${MAX_RANGE_DAYS} days per call.`,
    mutating: false,
    input: eventsRangeSchema,
    execute: ({ userId, timezone }, range) =>
      fetchEvents(google, userId, timezone, range),
  });

  const createEvent = defineTool({
    name: 'create_event',
    description:
      "Create an event in the user's primary Google Calendar. Requires the user's confirmation " +
      'before it runs. Use local wall-clock times in the user timezone (YYYY-MM-DDTHH:MM). ' +
      'For an all-day event give dates only (YYYY-MM-DD); end is the last day, inclusive. ' +
      'Set reminderMinutes only when the user asks for a reminder; otherwise the calendar default applies.',
    mutating: true,
    input: z
      .object({
        title: z.string().trim().min(1).max(300),
        start: z
          .string()
          .regex(DATE_OR_DATETIME)
          .describe('YYYY-MM-DDTHH:MM or YYYY-MM-DD'),
        end: z
          .string()
          .regex(DATE_OR_DATETIME)
          .describe('YYYY-MM-DDTHH:MM or YYYY-MM-DD'),
        description: z.string().max(4000).optional(),
        location: z.string().max(500).optional(),
        reminderMinutes: z
          .number()
          .int()
          .min(0)
          .max(MAX_REMINDER_MINUTES)
          .optional()
          .describe('Popup reminder this many minutes before the start'),
      })
      .strict()
      .refine(
        (v) => (v.start.length === 10) === (v.end.length === 10),
        'start and end must both be dates (all-day) or both date-times',
      )
      .refine(
        (v) => (v.start.length === 10 ? v.end >= v.start : v.end > v.start),
        'end must be after start',
      ),
    summarize: (v) => ({
      title: 'Create calendar event',
      details: {
        Title: v.title,
        When:
          v.start.length === 10
            ? v.start === v.end
              ? `${v.start} (all day)`
              : `${v.start} – ${v.end} (all day)`
            : `${v.start.replace('T', ' ')} – ${v.end.replace('T', ' ')}`,
        ...(v.location ? { Location: v.location } : {}),
        ...(v.description ? { Description: v.description } : {}),
        ...(v.reminderMinutes !== undefined
          ? { Reminder: `${v.reminderMinutes} min before` }
          : {}),
      },
    }),
    async execute({ userId, timezone }, v) {
      const cal = await api(userId);
      const allDay = v.start.length === 10;
      const res = await callGoogle(() =>
        cal.events.insert({
          calendarId: 'primary',
          requestBody: {
            summary: v.title,
            description: v.description,
            location: v.location,
            start: allDay
              ? { date: v.start }
              : { dateTime: `${v.start}:00`, timeZone: timezone },
            // Google's all-day end date is exclusive.
            end: allDay
              ? { date: addDays(v.end, 1) }
              : { dateTime: `${v.end}:00`, timeZone: timezone },
            reminders:
              v.reminderMinutes === undefined
                ? undefined
                : {
                    useDefault: false,
                    overrides: [
                      { method: 'popup', minutes: v.reminderMinutes },
                    ],
                  },
          },
        }),
      );
      return {
        id: res.data.id,
        title: res.data.summary,
        start: res.data.start?.dateTime ?? res.data.start?.date,
        end: res.data.end?.dateTime ?? res.data.end?.date,
        link: res.data.htmlLink,
      };
    },
    async undo({ userId }, result) {
      const eventId = createdId(result);
      const cal = await api(userId);
      await removeFromGoogle(() =>
        cal.events.delete({ calendarId: 'primary', eventId }),
      );
    },
  });

  return [getEvents, createEvent] as const;
}
