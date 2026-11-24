import { calendar_v3 } from '@googleapis/calendar';
import { z } from 'zod';
import { type ActionSummary, defineTool, ToolError } from '../../agent/tool.js';
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
/** Event ids are base32hex; occurrences of a recurring event add `_<start>`. */
const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;

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
    events: (res.data.items ?? []).map(toCalendarEvent),
    truncated: Boolean(res.data.nextPageToken),
  };
}

function toCalendarEvent(e: calendar_v3.Schema$Event): CalendarEvent {
  return {
    id: e.id ?? '',
    title: e.summary ?? '(no title)',
    start: e.start?.dateTime ?? e.start?.date ?? '',
    end: e.end?.dateTime ?? e.end?.date ?? '',
    allDay: Boolean(e.start?.date),
    location: e.location ?? undefined,
    description: truncate(e.description, 500),
    link: e.htmlLink ?? undefined,
  };
}

/** `2026-11-07T10:00:00+02:00` -> `2026-11-07 10:00`; all-day dates as they are. */
const shortTime = (s: string) => s.slice(0, 16).replace('T', ' ');

/** Human-readable span of an event; `end` of an all-day event is exclusive. */
export function describeWhen(
  e: Pick<CalendarEvent, 'start' | 'end' | 'allDay'>,
) {
  if (!e.allDay) return `${shortTime(e.start)} – ${shortTime(e.end)}`;
  const last = addDays(e.end, -1);
  return last <= e.start
    ? `${e.start} (all day)`
    : `${e.start} – ${last} (all day)`;
}

/**
 * Start/end for a write: local wall-clock time in the user's zone, or a date
 * for all-day events (inclusive `end`). The other field is cleared, since a
 * patch merges objects and Google rejects both `date` and `dateTime`.
 */
function eventTimes(start: string, end: string, timezone: string) {
  return start.length === 10
    ? {
        start: { date: start, dateTime: null, timeZone: null },
        end: { date: addDays(end, 1), dateTime: null, timeZone: null },
      }
    : {
        start: { date: null, dateTime: `${start}:00`, timeZone: timezone },
        end: { date: null, dateTime: `${end}:00`, timeZone: timezone },
      };
}

type EventReminders = NonNullable<calendar_v3.Schema$Event['reminders']>;

const reminderPatch = (minutes: number): EventReminders => ({
  useDefault: false,
  overrides: [{ method: 'popup', minutes }],
});

/** The fields update_event can change, as they were, to put them back on undo. */
interface EventSnapshot {
  summary: string | null;
  description: string | null;
  location: string | null;
  start: calendar_v3.Schema$EventDateTime;
  end: calendar_v3.Schema$EventDateTime;
  reminders: EventReminders | null;
}

const snapshot = (e: calendar_v3.Schema$Event): EventSnapshot => ({
  summary: e.summary ?? null,
  description: e.description ?? null,
  location: e.location ?? null,
  start: e.start ?? {},
  end: e.end ?? {},
  reminders: e.reminders ?? null,
});

/** A full date/time object, so a patch replaces rather than merges it. */
const fullTime = (t: calendar_v3.Schema$EventDateTime) => ({
  date: t.date ?? null,
  dateTime: t.dateTime ?? null,
  timeZone: t.timeZone ?? null,
});

const restoreReminders = (r: EventReminders | null): EventReminders =>
  !r || r.useDefault !== false
    ? { useDefault: true, overrides: [] }
    : { useDefault: false, overrides: r.overrides ?? [] };

const eventIdSchema = z
  .string()
  .regex(EVENT_ID)
  .describe('Event id from get_events');

const timesRefinements = <
  T extends z.ZodType<{ start?: string; end?: string }>,
>(
  schema: T,
) =>
  schema
    .refine(
      (v) => (v.start === undefined) === (v.end === undefined),
      'start and end must be changed together',
    )
    .refine(
      (v) =>
        !v.start || !v.end || (v.start.length === 10) === (v.end.length === 10),
      'start and end must both be dates (all-day) or both date-times',
    )
    .refine(
      (v) =>
        !v.start ||
        !v.end ||
        (v.start.length === 10 ? v.end >= v.start : v.end > v.start),
      'end must be after start',
    );

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

  /** The event as the user sees it; deleted (cancelled) ones count as missing. */
  const loadEvent = async (
    userId: string,
    timezone: string,
    eventId: string,
  ) => {
    const cal = await api(userId);
    const res = await callGoogle(() =>
      cal.events.get({ calendarId: 'primary', eventId, timeZone: timezone }),
    );
    if (res.data.status === 'cancelled') {
      throw new ToolError('Not found in Google: the event was deleted.');
    }
    return { cal, event: res.data };
  };

  const updateEvent = defineTool({
    name: 'update_event',
    description:
      "Change an existing event in the user's primary Google Calendar: title, time, location, " +
      "description or reminder. Requires the user's confirmation before it runs. Get the eventId " +
      'from get_events first and pass only the fields that change; start and end go together, ' +
      'in the same format as create_event. For a recurring event this changes only that occurrence.',
    mutating: true,
    input: timesRefinements(
      z
        .object({
          eventId: eventIdSchema,
          title: z.string().trim().min(1).max(300).optional(),
          start: z
            .string()
            .regex(DATE_OR_DATETIME)
            .optional()
            .describe('YYYY-MM-DDTHH:MM or YYYY-MM-DD'),
          end: z
            .string()
            .regex(DATE_OR_DATETIME)
            .optional()
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
        .strict(),
    ).refine(
      (v) => Object.keys(v).some((k) => k !== 'eventId'),
      'Nothing to change',
    ),
    lookup: async ({ userId, timezone }, v) =>
      toCalendarEvent((await loadEvent(userId, timezone, v.eventId)).event),
    summarize(v, before) {
      const old = before as CalendarEvent | undefined;
      const change = (from: string | undefined, to: string) =>
        from === undefined || from === to ? to : `${from} → ${to}`;
      return {
        title: 'Change calendar event',
        details: {
          Event: old?.title ?? v.eventId,
          ...(v.title ? { Title: change(old?.title, v.title) } : {}),
          ...(v.start && v.end
            ? {
                When: change(
                  old && describeWhen(old),
                  describeWhen({
                    start: v.start,
                    end: v.start.length === 10 ? addDays(v.end, 1) : v.end,
                    allDay: v.start.length === 10,
                  }),
                ),
              }
            : {}),
          ...(v.location !== undefined
            ? { Location: change(old?.location ?? '', v.location) }
            : {}),
          ...(v.description !== undefined
            ? { Description: v.description }
            : {}),
          ...(v.reminderMinutes !== undefined
            ? { Reminder: `${v.reminderMinutes} min before` }
            : {}),
        },
      };
    },
    async execute({ userId, timezone }, v) {
      const { cal, event } = await loadEvent(userId, timezone, v.eventId);
      const res = await callGoogle(() =>
        cal.events.patch({
          calendarId: 'primary',
          eventId: v.eventId,
          requestBody: {
            summary: v.title,
            description: v.description,
            location: v.location,
            ...(v.start && v.end ? eventTimes(v.start, v.end, timezone) : {}),
            reminders:
              v.reminderMinutes === undefined
                ? undefined
                : reminderPatch(v.reminderMinutes),
          },
        }),
      );
      return {
        id: res.data.id,
        title: res.data.summary,
        start: res.data.start?.dateTime ?? res.data.start?.date,
        end: res.data.end?.dateTime ?? res.data.end?.date,
        link: res.data.htmlLink,
        previous: snapshot(event),
      };
    },
    async undo({ userId }, result) {
      const eventId = createdId(result);
      const prev = (result as { previous?: EventSnapshot }).previous;
      if (!prev)
        throw new ToolError('There is nothing to undo for this action.');
      const cal = await api(userId);
      await callGoogle(() =>
        cal.events.patch({
          calendarId: 'primary',
          eventId,
          requestBody: {
            summary: prev.summary ?? '',
            description: prev.description ?? '',
            location: prev.location ?? '',
            start: fullTime(prev.start),
            end: fullTime(prev.end),
            reminders: restoreReminders(prev.reminders),
          },
        }),
      );
    },
  });

  const deleteEvent = defineTool({
    name: 'delete_event',
    description:
      "Delete an event from the user's primary Google Calendar. Requires the user's confirmation " +
      'before it runs. Get the eventId from get_events first. For a recurring event this deletes ' +
      'only that occurrence.',
    mutating: true,
    input: z.object({ eventId: eventIdSchema }).strict(),
    lookup: async ({ userId, timezone }, v) =>
      toCalendarEvent((await loadEvent(userId, timezone, v.eventId)).event),
    summarize(v, before): ActionSummary {
      const old = before as CalendarEvent | undefined;
      return {
        title: 'Delete calendar event',
        details: old
          ? {
              Title: old.title,
              When: describeWhen(old),
              ...(old.location ? { Location: old.location } : {}),
            }
          : { Event: v.eventId },
      };
    },
    async execute({ userId, timezone }, v) {
      const { cal, event } = await loadEvent(userId, timezone, v.eventId);
      await removeFromGoogle(() =>
        cal.events.delete({ calendarId: 'primary', eventId: v.eventId }),
      );
      return {
        deleted: true,
        title: event.summary ?? '(no title)',
        start: event.start?.dateTime ?? event.start?.date,
        end: event.end?.dateTime ?? event.end?.date,
        // What undo needs to put it back (as a new event).
        previous: {
          ...snapshot(event),
          colorId: event.colorId ?? null,
          transparency: event.transparency ?? null,
          visibility: event.visibility ?? null,
        },
      };
    },
    async undo({ userId }, result) {
      const prev = (
        result as {
          previous?: EventSnapshot & {
            colorId: string | null;
            transparency: string | null;
            visibility: string | null;
          };
        } | null
      )?.previous;
      if (!prev)
        throw new ToolError('There is nothing to undo for this action.');
      const cal = await api(userId);
      await callGoogle(() =>
        cal.events.insert({
          calendarId: 'primary',
          requestBody: {
            summary: prev.summary,
            description: prev.description,
            location: prev.location,
            start: prev.start,
            end: prev.end,
            reminders: restoreReminders(prev.reminders),
            colorId: prev.colorId,
            transparency: prev.transparency,
            visibility: prev.visibility,
          },
        }),
      );
    },
  });

  return [getEvents, createEvent, updateEvent, deleteEvent] as const;
}
