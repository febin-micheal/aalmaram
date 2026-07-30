/**
 * The translation layer, wired from day one.
 *
 * Malayalam is the default: the people this app is built for are elderly relatives on
 * WhatsApp, and English is the fallback, not the baseline. Every user-visible string in
 * the app goes through `t()` — never inline text in a component — so that a missing
 * Malayalam translation shows up as an English string in the UI rather than as an
 * English string hard-coded past the point where translation could reach it.
 */

import en from './en.json'
import ml from './ml.json'

const CATALOGS = { ml, en }
export const DEFAULT_LOCALE = 'ml'
export const FALLBACK_LOCALE = 'en'
export const AVAILABLE_LOCALES = Object.keys(CATALOGS)

export function detectLocale(navigatorLanguages = navigator.languages ?? []) {
  const stored = globalThis.localStorage?.getItem('aalmaram.locale')
  if (stored && CATALOGS[stored]) return stored
  const match = navigatorLanguages.find((tag) => CATALOGS[tag.split('-')[0]])
  return match ? match.split('-')[0] : DEFAULT_LOCALE
}

export function setLocale(locale) {
  if (!CATALOGS[locale]) return DEFAULT_LOCALE
  globalThis.localStorage?.setItem('aalmaram.locale', locale)
  document.documentElement.lang = locale
  return locale
}

/** Look up `key`, falling back to English and finally to the key itself. */
export function translate(locale, key, values = {}) {
  const template = CATALOGS[locale]?.[key] ?? CATALOGS[FALLBACK_LOCALE][key] ?? key
  return template.replace(/\{(\w+)\}/g, (_match, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : `{${name}}`,
  )
}

export function translatorFor(locale) {
  return (key, values) => translate(locale, key, values)
}
