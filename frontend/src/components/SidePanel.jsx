import { useState } from 'react'

import { accentFor, personName, personSecondaryName } from '../graph/person.js'

/**
 * Details for the selected person, read entirely out of the already-loaded subgraph —
 * clicking a card never costs a request.
 */
export default function SidePanel({
  layout,
  person,
  locale,
  t,
  onClose,
  onSetCenter,
  onRelateFrom,
  onAddHousehold,
  onEdit,
  onSelect,
}) {
  const [editing, setEditing] = useState(false)
  if (!person) return null

  const ego = egoFrom(layout, person.id)

  return (
    <aside className="absolute right-0 top-0 z-10 flex h-full w-80 flex-col gap-4 overflow-y-auto border-l border-[var(--card-border)] bg-[var(--card-bg)] p-5 shadow-xl">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-xl font-semibold leading-tight">{personName(person, locale)}</h2>
          {personSecondaryName(person, locale) && (
            <p className="opacity-60">{personSecondaryName(person, locale)}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('panel.close')}
          className="rounded px-2 py-1 text-lg leading-none opacity-60 hover:opacity-100"
        >
          ×
        </button>
      </div>

      <div className="h-1 w-16 rounded" style={{ background: accentFor(person) }} aria-hidden="true" />

      {editing ? (
        <InlineFields
          key={person.id}
          person={person}
          t={t}
          onCancel={() => setEditing(false)}
          onSave={async (fields) => {
            setEditing(false)
            await onEdit?.(person, fields)
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="self-start rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm"
        >
          {t('edit.editDetails')}
        </button>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {person.house_name && (
          <>
            <dt className="opacity-60">{t('panel.house')}</dt>
            <dd>{person.house_name}</dd>
          </>
        )}
        <dt className="opacity-60">{t('panel.born')}</dt>
        <dd>{person.birth_display}</dd>
        <dt className="opacity-60">{t('panel.died')}</dt>
        <dd>{person.is_living ? t('panel.living') : person.death_display}</dd>
        {person.place_origin && (
          <>
            <dt className="opacity-60">{t('panel.place')}</dt>
            <dd>{person.place_origin}</dd>
          </>
        )}
      </dl>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => onSetCenter(person)}
          className="rounded-lg bg-[var(--accent-strong)] px-3 py-2 text-sm font-medium text-white"
        >
          {t('panel.setCenter')}
        </button>
        <button
          type="button"
          onClick={() => onRelateFrom(person)}
          className="rounded-lg border border-[var(--card-border)] px-3 py-2 text-sm font-medium"
        >
          {t('panel.relateFrom')}
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => onAddHousehold(person)}
            className="rounded-lg border border-[var(--card-border)] px-3 py-2 text-sm font-medium"
          >
            {t('panel.addHousehold')}
          </button>
          {/* Editing a person's own fields still belongs to the admin; in-graph editing
              is a later phase, and a wrong link is worse than an honest handoff. */}
          <a
            href={`/admin/genealogy/person/${person.id}/change/`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-[var(--card-border)] px-3 py-2 text-center text-sm font-medium"
          >
            {t('panel.edit')}
          </a>
        </div>
      </div>

      <Relations title={t('panel.parents')} people={ego.parents} {...{ locale, t, onSelect }} />
      <Relations title={t('panel.siblings')} people={ego.siblings} {...{ locale, t, onSelect }} />
      <Relations title={t('panel.partners')} people={ego.partners} {...{ locale, t, onSelect }} />
      <Relations title={t('panel.children')} people={ego.children} {...{ locale, t, onSelect }} />
    </aside>
  )
}

function Relations({ title, people, locale, t, onSelect }) {
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-60">{title}</h3>
      {people.length === 0 ? (
        <p className="text-sm italic opacity-50">{t('panel.none')}</p>
      ) : (
        <ul className="space-y-0.5">
          {people.map(({ person, note }) => (
            <li key={person.id}>
              <button
                type="button"
                onClick={() => onSelect(person)}
                className="w-full rounded px-1 py-0.5 text-left text-sm hover:bg-[var(--chip-bg)]"
              >
                {personName(person, locale)}
                {note && <span className="ml-1 text-xs uppercase opacity-50">{t(`kind.${note}`)}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Parents / siblings / partners / children for one person, derived from the loaded
 * layout. Sibling kind is recomputed here the same way the backend does it: same union
 * means full, one shared parent means half.
 */
function egoFrom(layout, personId) {
  const empty = { parents: [], siblings: [], partners: [], children: [] }
  if (!layout) return empty

  const { persons, partnersOf, childrenOf, unionsAsChild } = layout
  const birthUnions = unionsAsChild.get(personId) ?? []

  const parentIds = new Set()
  for (const unionId of birthUnions) {
    for (const parentId of partnersOf.get(unionId) ?? []) parentIds.add(parentId)
  }

  const siblings = new Map()
  for (const unionId of birthUnions) {
    for (const kid of childrenOf.get(unionId) ?? []) {
      if (kid.person !== personId) siblings.set(kid.person, 'full')
    }
  }
  // Half-siblings: children of a parent's other unions.
  for (const parentId of parentIds) {
    for (const [unionId, parents] of partnersOf) {
      if (!parents.includes(parentId) || birthUnions.includes(unionId)) continue
      for (const kid of childrenOf.get(unionId) ?? []) {
        if (kid.person !== personId && !siblings.has(kid.person)) siblings.set(kid.person, 'half')
      }
    }
  }

  const partners = new Set()
  const children = new Map()
  for (const [unionId, parents] of partnersOf) {
    if (!parents.includes(personId)) continue
    for (const other of parents) if (other !== personId) partners.add(other)
    for (const kid of childrenOf.get(unionId) ?? []) {
      children.set(kid.person, kid.relation_type === 'biological' ? null : kid.relation_type)
    }
  }

  const hydrate = (entries) =>
    [...entries]
      .map(([id, note]) => ({ person: persons.get(id), note }))
      .filter((entry) => entry.person)

  return {
    parents: hydrate([...parentIds].map((id) => [id, null])),
    // Only half-siblings get a badge; "full" is the unremarkable case.
    siblings: hydrate([...siblings].map(([id, kind]) => [id, kind === 'full' ? null : kind])),
    partners: hydrate([...partners].map((id) => [id, null])),
    children: hydrate(children.entries()),
  }
}


/**
 * Inline editing of the fields a card shows.
 *
 * Years are free text on purpose — "1930s" and "?" are answers, and forcing a number here
 * would push people into inventing one. The server parses and rejects what it cannot read.
 */
function InlineFields({ person, t, onSave, onCancel }) {
  const [fields, setFields] = useState({
    name_en: person.name_en ?? '',
    name_ml: person.name_ml ?? '',
    gender: person.gender ?? 'unknown',
    birth: person.birth_display === '?' ? '' : (person.birth_display ?? ''),
  })
  const set = (key) => (event) => setFields((f) => ({ ...f, [key]: event.target.value }))

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSave(fields)
      }}
      className="space-y-2 rounded-lg border border-[var(--card-border)] p-3"
    >
      <Labelled label={t('edit.nameEn')}>
        <input value={fields.name_en} onChange={set('name_en')} className={FIELD} autoFocus />
      </Labelled>
      <Labelled label={t('edit.nameMl')}>
        <input value={fields.name_ml} onChange={set('name_ml')} className={FIELD} lang="ml" />
      </Labelled>
      <Labelled label={t('quickAdd.gender')}>
        <select value={fields.gender} onChange={set('gender')} className={FIELD}>
          <option value="male">{t('gender.male')}</option>
          <option value="female">{t('gender.female')}</option>
          <option value="other">{t('gender.other')}</option>
          <option value="unknown">{t('gender.unknown')}</option>
        </select>
      </Labelled>
      <Labelled label={t('panel.born')} help={t('edit.yearHelp')}>
        <input
          value={fields.birth}
          onChange={set('birth')}
          placeholder={t('edit.yearPlaceholder')}
          className={FIELD}
        />
      </Labelled>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="rounded border border-[var(--card-border)] px-3 py-1 text-sm">
          {t('quickAdd.cancel')}
        </button>
        <button type="submit" className="rounded bg-[var(--accent-strong)] px-3 py-1 text-sm font-medium text-white">
          {t('quickAdd.save')}
        </button>
      </div>
    </form>
  )
}

const FIELD =
  'w-full rounded border border-[var(--card-border)] bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[var(--accent-strong)]'

function Labelled({ label, help, children }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium opacity-70">{label}</span>
      {children}
      {help && <span className="block text-[11px] opacity-50">{help}</span>}
    </label>
  )
}
