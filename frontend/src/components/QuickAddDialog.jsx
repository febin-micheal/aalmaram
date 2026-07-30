import { useEffect, useRef, useState } from 'react'

import { quickAdd } from '../api.js'
import { personName } from '../graph/person.js'

const BLANK = {
  partner_1_name: '',
  partner_1_gender: 'male',
  partner_2_name: '',
  partner_2_gender: 'female',
  house_name: '',
  union_type: 'marriage',
  union_year: '',
  union_place: '',
  children: '',
}

/**
 * Add a whole household without leaving the graph.
 *
 * Mirrors the admin quick-add screen, including its children text block, because that
 * format is what makes bulk entry fast: one line per child, oldest first, and the line
 * order becomes the recorded birth order.
 *
 * `anchor`, when given, pre-fills partner 1 with an existing person — that is how you
 * add a marriage and children onto someone already in the tree.
 */
export default function QuickAddDialog({ t, locale, anchor, onClose, onCreated }) {
  const [form, setForm] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const firstField = useRef(null)

  useEffect(() => {
    firstField.current?.focus()
    const onKey = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const set = (field) => (event) => setForm((state) => ({ ...state, [field]: event.target.value }))

  const submit = async (event) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const payload = { ...form }
      if (anchor) {
        payload.partner_1_id = anchor.id
        delete payload.partner_1_name
        delete payload.partner_1_gender
      }
      if (payload.union_year === '') delete payload.union_year
      const created = await quickAdd(payload)
      onCreated(created)
    } catch (err) {
      setError(err.detail ?? err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={t('quickAdd.title')}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-lg space-y-4 rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-xl font-semibold">{t('quickAdd.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('panel.close')}
            className="rounded px-2 text-lg leading-none opacity-60 hover:opacity-100"
          >
            ×
          </button>
        </div>

        <p className="text-sm opacity-70">{t('quickAdd.intro')}</p>

        {anchor ? (
          <p className="rounded-lg bg-[var(--chip-bg)] px-3 py-2 text-sm">
            {t('quickAdd.anchoredTo', { name: personName(anchor, locale) })}
          </p>
        ) : (
          <Field label={t('quickAdd.partner1')}>
            <div className="flex gap-2">
              <input
                ref={firstField}
                value={form.partner_1_name}
                onChange={set('partner_1_name')}
                className="flex-1 rounded-lg border border-[var(--card-border)] bg-transparent px-3 py-2"
              />
              <GenderSelect value={form.partner_1_gender} onChange={set('partner_1_gender')} t={t} />
            </div>
          </Field>
        )}

        <Field label={t('quickAdd.partner2')}>
          <div className="flex gap-2">
            <input
              value={form.partner_2_name}
              onChange={set('partner_2_name')}
              className="flex-1 rounded-lg border border-[var(--card-border)] bg-transparent px-3 py-2"
            />
            <GenderSelect value={form.partner_2_gender} onChange={set('partner_2_gender')} t={t} />
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('quickAdd.house')}>
            <input
              value={form.house_name}
              onChange={set('house_name')}
              className="w-full rounded-lg border border-[var(--card-border)] bg-transparent px-3 py-2"
            />
          </Field>
          <Field label={t('quickAdd.year')}>
            <input
              value={form.union_year}
              onChange={set('union_year')}
              inputMode="numeric"
              className="w-full rounded-lg border border-[var(--card-border)] bg-transparent px-3 py-2"
            />
          </Field>
        </div>

        <Field label={t('quickAdd.children')} help={t('quickAdd.childrenHelp')}>
          <textarea
            value={form.children}
            onChange={set('children')}
            rows={6}
            placeholder={t('quickAdd.childrenPlaceholder')}
            className="w-full rounded-lg border border-[var(--card-border)] bg-transparent px-3 py-2 font-mono text-sm"
          />
        </Field>

        {error && <p className="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-900">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[var(--card-border)] px-4 py-2"
          >
            {t('quickAdd.cancel')}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-[var(--accent-strong)] px-4 py-2 font-medium text-white disabled:opacity-60"
          >
            {saving ? t('quickAdd.saving') : t('quickAdd.save')}
          </button>
        </div>
      </form>
    </div>
  )
}

function Field({ label, help, children }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {help && <span className="block text-xs opacity-60">{help}</span>}
    </label>
  )
}

function GenderSelect({ value, onChange, t }) {
  return (
    <select
      value={value}
      onChange={onChange}
      aria-label={t('quickAdd.gender')}
      className="rounded-lg border border-[var(--card-border)] bg-transparent px-2 py-2"
    >
      <option value="male">{t('gender.male')}</option>
      <option value="female">{t('gender.female')}</option>
      <option value="other">{t('gender.other')}</option>
      <option value="unknown">{t('gender.unknown')}</option>
    </select>
  )
}
