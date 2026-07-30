import { personName } from '../graph/person.js'

/**
 * The relate-mode strip along the bottom.
 *
 * It always shows the full path from the API, even when part of that path is not
 * currently drawn — the answer to "how are we related?" should not depend on how much of
 * the graph happens to be loaded. The nodes that *are* loaded get highlighted on the
 * canvas, and a button loads the rest.
 */
export default function RelateBar({ t, locale, state, onClear, onCenterAncestor, onSelect }) {
  if (!state.active) return null

  const { a, b, result, working, allLoaded } = state

  return (
    <footer className="z-20 border-t border-[var(--card-border)] bg-[var(--card-bg)] px-4 py-3 text-sm">
      {!a && <p className="font-medium">{t('relate.pickA')}</p>}
      {a && !b && (
        <p className="font-medium">
          <Chip label="A" name={personName(a, locale)} /> {t('relate.pickB')}
        </p>
      )}
      {working && <p className="opacity-70">{t('relate.working')}</p>}

      {result && !working && (
        <div className="space-y-2">
          <p className="text-base font-semibold">
            {result.is_related
              ? t('relate.result', {
                  other: personName(result.b, locale),
                  subject: personName(result.a, locale),
                  label: result.labels[locale] || result.labels.en,
                })
              : t('relate.none', {
                  subject: personName(result.a, locale),
                  other: personName(result.b, locale),
                })}
          </p>

          {result.is_related && result.labels.en !== result.labels.ml && (
            <p className="opacity-70">
              {locale === 'ml' ? result.labels.en : result.labels.ml}
            </p>
          )}

          {result.common_ancestors.map((common) => (
            <div key={common.person.id} className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60">
                {t('relate.commonAncestor')}: {personName(common.person, locale)}
              </p>
              <PathLine path={common.path_subject} locale={locale} onSelect={onSelect} />
              <PathLine path={common.path_other} locale={locale} onSelect={onSelect} />
            </div>
          ))}

          {result.is_related && !allLoaded && (
            <p className="text-xs opacity-70">{t('relate.partialPath')}</p>
          )}
        </div>
      )}

      <div className="mt-2 flex gap-2">
        {result?.is_related && (
          <button
            type="button"
            onClick={onCenterAncestor}
            className="rounded-md border border-[var(--card-border)] px-3 py-1 text-sm"
          >
            {t('relate.centerOnAncestor')}
          </button>
        )}
        <button
          type="button"
          onClick={onClear}
          className="rounded-md border border-[var(--card-border)] px-3 py-1 text-sm"
        >
          {t('relate.clear')}
        </button>
      </div>
    </footer>
  )
}

function PathLine({ path, locale, onSelect }) {
  return (
    <p className="flex flex-wrap items-center gap-1">
      {path.map((step, index) => (
        <span key={step.id} className="flex items-center gap-1">
          {index > 0 && <span className="opacity-40">→</span>}
          <button
            type="button"
            onClick={() => onSelect(step)}
            className="rounded bg-[var(--chip-bg)] px-2 py-0.5 hover:underline"
          >
            {personName(step, locale)}
          </button>
        </span>
      ))}
    </p>
  )
}

function Chip({ label, name }) {
  return (
    <span className="mr-1 inline-flex items-center gap-1">
      <span className="rounded-full bg-[var(--accent-strong)] px-1.5 text-xs font-bold text-white">
        {label}
      </span>
      {name}
    </span>
  )
}
