export type SupportedLanguage = 'en' | 'es';

export type LanguagePreference = 'system' | SupportedLanguage;

export interface LanguageInfo {
  code: SupportedLanguage;
  nativeLabel: string;
  englishLabel: string;
  dir: 'ltr' | 'rtl';
  numberLocale: string;
  dateLocale: string;
  aliases: string[];
  fontFamily?: string;
}

export const LANGUAGES: LanguageInfo[] = [
  { code: 'en', nativeLabel: 'English', englishLabel: 'English', dir: 'ltr', numberLocale: 'en-US', dateLocale: 'en-US', aliases: ['en'] },
  { code: 'es', nativeLabel: 'Español', englishLabel: 'Spanish', dir: 'ltr', numberLocale: 'es-ES', dateLocale: 'es-ES', aliases: ['es'] },
];

export function findLanguageInfo(code: string): LanguageInfo | undefined {
  const normalized = code ? code.trim().toLowerCase() : 'en';
  const exact = LANGUAGES.find(language => (
    language.code.toLowerCase() === normalized
    || language.aliases.some(alias => alias.toLowerCase() === normalized)
  ));
  if (exact) return exact;
  const prefixMatch = LANGUAGES
    .flatMap(language => language.aliases.map(alias => ({ language, alias })))
    .filter(({ alias }) => normalized.startsWith(`${alias.toLowerCase()}-`))
    .sort((left, right) => right.alias.length - left.alias.length)[0];
  return prefixMatch?.language;
}

export function getLanguageInfo(code: string): LanguageInfo {
  return findLanguageInfo(code) || LANGUAGES[0];
}
