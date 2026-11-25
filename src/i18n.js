// UI localization. Strings the REPL prints are looked up through t(key);
// languages: en (default), ru. User selects with `language = "ru"` in
// config.toml or /language ru. Missing keys fall back to English.
export const CATALOGS = {
  en: null, // source strings
  ru: {
    "help: commands": "команды",
    "working": "работаю",
    "conversation is already small": "диалог уже компактный",
    "no todos": "задач нет",
    "session saved": "сессия сохранена",
    "error: no such session": "ошибка: сессия не найдена",
    "allowed tools:": "разрешённые инструменты:",
    "interrupted": "прервано",
    "goodbye": "до связи",
  },
};

let lang = "en";

export function setLanguage(l) {
  if (l !== "en" && l !== "ru") throw new Error(`unsupported language: ${l} (en, ru)`);
  lang = l;
}

export function getLanguage() {
  return lang;
}

export function t(text) {
  if (lang === "en") return text;
  return CATALOGS[lang]?.[text] ?? text;
}
