/**
 * How a person is displayed.
 *
 * The UI language decides which script is *preferred*, never which script is *required*:
 * a person entered only in Malayalam still shows their Malayalam name in the English UI,
 * because a blank card would be worse than a mixed-script one. Only the interface
 * chrome is translated; the data shows whatever exists.
 */

export function personName(person, locale) {
  if (!person) return ''
  const preferred = locale === 'ml' ? person.name_ml : person.name_en
  const fallback = locale === 'ml' ? person.name_en : person.name_ml
  return preferred || fallback || person.display_name || '—'
}

/** The other script, shown as a subtitle when it differs from the primary name. */
export function personSecondaryName(person, locale) {
  if (!person) return ''
  const other = locale === 'ml' ? person.name_en : person.name_ml
  return other && other !== personName(person, locale) ? other : ''
}

export const GENDER_ACCENT = {
  female: '#b0578d',
  male: '#3b6ea5',
  other: '#6b7f5a',
  unknown: '#8a8177',
}

export function accentFor(person) {
  return GENDER_ACCENT[person?.gender] ?? GENDER_ACCENT.unknown
}
