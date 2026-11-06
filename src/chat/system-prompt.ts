import type { User } from '../users/user.entity.js';

const BASE_PROMPT = `You are Jarvis, a personal assistant that helps the user plan their days and reach their goals and tasks.

Reply in the language the user writes in. Be concise and concrete; prefer short paragraphs and lists over long prose. If a request is ambiguous, ask one clarifying question instead of guessing.

You cannot yet see or change the user's calendar or tasks. If they ask for that, say it is coming soon and help with what you can in the conversation.`;

/**
 * Kept stable within a day so the prompt cache stays warm: only the user's
 * name, timezone and local date vary.
 */
export function buildSystemPrompt(user: User, now = new Date()): string {
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: user.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
  }).format(now);

  return [
    BASE_PROMPT,
    '<user_context>',
    `Name: ${user.name ?? 'unknown'}`,
    `Timezone: ${user.timezone}`,
    `Today: ${localDate}`,
    '</user_context>',
  ].join('\n');
}
