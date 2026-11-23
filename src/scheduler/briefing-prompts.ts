import type { LocalClock } from '../common/time.js';
import { type Language, LANGUAGE_NAMES } from '../users/languages.js';
import type { BriefingKind } from './schedule.js';

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const TITLES: Record<BriefingKind, string> = {
  morning: 'Morning briefing',
  evening: 'Evening check-in',
  weekly: 'Weekly review',
};

const TASKS: Record<BriefingKind, string> = {
  morning: `Write the user's morning briefing. First look up today's calendar events and their open tasks. Then cover:
- today's schedule in order, with the free slots worth using;
- one to three priorities for today, tied to their goals where it fits;
- tasks that are due today or overdue.`,
  evening: `Write the user's evening check-in. First look up today's calendar events and their tasks. Then:
- sum up briefly what was on today's plan;
- ask how the day went and what got done, with one or two specific questions rather than a generic one;
- mention what is already scheduled for tomorrow, if anything.`,
  weekly: `Write the user's weekly review. First look up the calendar for the past seven days and the coming seven, and their tasks. Then cover:
- what the past week was spent on and which tasks were completed;
- where each active goal stands, and which ones got no attention;
- two or three concrete suggestions for the coming week;
- one question that helps the user reflect on the week.`,
};

const LANGUAGE_RULE = `Write in the language the user's profile, goals and notes are written in; use English if that is unclear.`;

const RULES = `Keep it short and easy to scan. {language} If the calendar or tasks cannot be read, say so in one line and work from the goals and notes alone. Do not call tools that create or change anything here: suggest changes in the text and let the user ask for them.`;

export function briefingTitle(kind: BriefingKind, clock: LocalClock): string {
  return `${TITLES[kind]} · ${clock.date}`;
}

/** The opening (synthetic) message of a scheduled conversation. */
export function briefingPrompt(
  kind: BriefingKind,
  clock: LocalClock,
  language: Language | null = null,
): string {
  const hh = String(Math.floor(clock.minutes / 60)).padStart(2, '0');
  const mm = String(clock.minutes % 60).padStart(2, '0');
  const when = `${WEEKDAY_NAMES[clock.weekday]} ${clock.date} ${hh}:${mm}`;
  return `[Automated request from the scheduler, not typed by the user. User's local time: ${when}.]\n\n${TASKS[kind]}\n\n${RULES.replace(
    '{language}',
    language
      ? `Write in ${LANGUAGE_NAMES[language]}, the language the user chose for the app.`
      : LANGUAGE_RULE,
  )}`;
}
