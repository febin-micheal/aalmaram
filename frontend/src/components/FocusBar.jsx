import { personName } from '../graph/person.js'

/**
 * Whose point of view the graph is drawn from.
 *
 * "Me" is always chip #1 and cannot be removed here — it is an answer about you, not a
 * bookmark, and it is the field the privacy radius will measure from. Pins are the working
 * set: the two or three people you are currently reasoning between.
 *
 * Tapping a chip switches the perspective; every relationship label on the canvas is
 * relative to whichever is active.
 */
export default function FocusBar({ t, locale, chips, activeId, onActivate, onUnpin, onPin, onCenter, canPin, loading }) {
  if (!chips.length && !canPin) return null

  return (
    <div className="z-20 flex items-center gap-2 overflow-x-auto border-b border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-1.5">
      <span className="shrink-0 text-xs font-semibold uppercase tracking-wide opacity-50">
        {t('focus.label')}
      </span>

      {chips.map((chip) => {
        const active = chip.id === activeId
        return (
          <span
            key={chip.id}
            className={`flex shrink-0 items-center gap-1 rounded-full border px-1 text-sm transition-colors ${
              active
                ? 'border-[var(--accent-strong)] bg-[var(--accent-strong)] text-white'
                : 'border-[var(--card-border)]'
            }`}
          >
            <button
              type="button"
              onClick={() => onActivate(chip.id)}
              // 40px tall so a chip is a real touch target, not a hairline.
              className="flex h-10 items-center gap-1 rounded-full px-2"
              aria-pressed={active}
              title={t('focus.switchTo', { name: personName(chip, locale) })}
            >
              {chip.isMe && <span aria-hidden="true">★</span>}
              <span className="max-w-32 truncate">
                {chip.isMe ? t('focus.me') : personName(chip, locale)}
              </span>
            </button>
            {chip.removable && (
              <button
                type="button"
                onClick={() => onUnpin(chip.id)}
                aria-label={t('focus.unpin', { name: personName(chip, locale) })}
                className="h-10 w-6 shrink-0 text-base leading-none opacity-60 hover:opacity-100"
              >
                ×
              </button>
            )}
          </span>
        )
      })}

      {canPin && (
        <button
          type="button"
          onClick={onPin}
          className="h-10 shrink-0 rounded-full border border-dashed border-[var(--card-border)] px-3 text-sm"
        >
          {t('focus.pin')}
        </button>
      )}

      <span className="flex-1" />

      {loading && <span className="shrink-0 text-xs opacity-60">{t('focus.loading')}</span>}

      {activeId && (
        <button
          type="button"
          onClick={onCenter}
          className="h-10 shrink-0 rounded-md border border-[var(--card-border)] px-3 text-sm"
        >
          {t('focus.center')}
        </button>
      )}
    </div>
  )
}
