/** UI languages; briefings are written in the user's choice. */
export const LANGUAGES = ['uk', 'en', 'pl', 'es', 'ru'] as const;
export type Language = (typeof LANGUAGES)[number];

/** English names, as the model is instructed in English. */
export const LANGUAGE_NAMES: Record<Language, string> = {
  uk: 'Ukrainian',
  en: 'English',
  pl: 'Polish',
  es: 'Spanish',
  ru: 'Russian',
};
