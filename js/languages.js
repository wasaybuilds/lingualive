// Language table.
//
// `speech` is the BCP-47 tag handed to the Web Speech API for recognition and
// synthesis. `mt` is the short code used by the translation backends, which
// only ever want the base language, never the region.

export const LANGUAGES = [
  { mt: 'en', speech: 'en-US', name: 'English',    native: 'English' },
  { mt: 'ur', speech: 'ur-PK', name: 'Urdu',       native: 'اردو' },
  { mt: 'hi', speech: 'hi-IN', name: 'Hindi',      native: 'हिन्दी' },
  { mt: 'ar', speech: 'ar-SA', name: 'Arabic',     native: 'العربية' },
  { mt: 'de', speech: 'de-DE', name: 'German',     native: 'Deutsch' },
  { mt: 'es', speech: 'es-ES', name: 'Spanish',    native: 'Español' },
  { mt: 'fr', speech: 'fr-FR', name: 'French',     native: 'Français' },
  { mt: 'it', speech: 'it-IT', name: 'Italian',    native: 'Italiano' },
  { mt: 'pt', speech: 'pt-BR', name: 'Portuguese', native: 'Português' },
  { mt: 'nl', speech: 'nl-NL', name: 'Dutch',      native: 'Nederlands' },
  { mt: 'pl', speech: 'pl-PL', name: 'Polish',     native: 'Polski' },
  { mt: 'ru', speech: 'ru-RU', name: 'Russian',    native: 'Русский' },
  { mt: 'uk', speech: 'uk-UA', name: 'Ukrainian',  native: 'Українська' },
  { mt: 'tr', speech: 'tr-TR', name: 'Turkish',    native: 'Türkçe' },
  { mt: 'fa', speech: 'fa-IR', name: 'Persian',    native: 'فارسی' },
  { mt: 'bn', speech: 'bn-BD', name: 'Bengali',    native: 'বাংলা' },
  { mt: 'zh', speech: 'zh-CN', name: 'Chinese',    native: '中文' },
  { mt: 'ja', speech: 'ja-JP', name: 'Japanese',   native: '日本語' },
  { mt: 'ko', speech: 'ko-KR', name: 'Korean',     native: '한국어' },
  { mt: 'vi', speech: 'vi-VN', name: 'Vietnamese', native: 'Tiếng Việt' },
  { mt: 'id', speech: 'id-ID', name: 'Indonesian', native: 'Bahasa Indonesia' },
  { mt: 'th', speech: 'th-TH', name: 'Thai',       native: 'ไทย' },
  { mt: 'ro', speech: 'ro-RO', name: 'Romanian',   native: 'Română' },
  { mt: 'el', speech: 'el-GR', name: 'Greek',      native: 'Ελληνικά' },
  { mt: 'cs', speech: 'cs-CZ', name: 'Czech',      native: 'Čeština' },
  { mt: 'sv', speech: 'sv-SE', name: 'Swedish',    native: 'Svenska' },
  { mt: 'da', speech: 'da-DK', name: 'Danish',     native: 'Dansk' },
  { mt: 'fi', speech: 'fi-FI', name: 'Finnish',    native: 'Suomi' },
  { mt: 'he', speech: 'he-IL', name: 'Hebrew',     native: 'עברית' },
];

// Languages written right-to-left, so captions can be aligned correctly.
const RTL = new Set(['ur', 'ar', 'fa', 'he']);

export const isRTL = (mt) => RTL.has(mt);

export const byMt = (mt) => LANGUAGES.find((l) => l.mt === mt) || LANGUAGES[0];

export const speechTag = (mt) => byMt(mt).speech;

export const displayName = (mt) => {
  const l = byMt(mt);
  return l.name === l.native ? l.name : `${l.name} (${l.native})`;
};
