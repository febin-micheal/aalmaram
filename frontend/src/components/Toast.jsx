import { useEffect } from 'react'

/**
 * A short message about something that just happened, or just failed.
 *
 * Errors carry an Undo affordance where one applies, because the moment after a mutation
 * is exactly when someone wants to take it back — and because an optimistic UI owes an
 * explanation whenever the thing it drew turns out not to have stuck.
 */
export default function Toast({ toast, onDismiss, onUndo, t }) {
  useEffect(() => {
    if (!toast) return undefined
    // Errors linger; confirmations get out of the way.
    const timeout = setTimeout(onDismiss, toast.tone === 'error' ? 8000 : 4000)
    return () => clearTimeout(timeout)
  }, [toast, onDismiss])

  if (!toast) return null

  const isError = toast.tone === 'error'
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-auto fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg px-4 py-3 text-sm shadow-2xl"
      style={{
        background: isError ? '#7f1d1d' : 'var(--accent-strong)',
        color: '#fff',
        maxWidth: 'min(90vw, 32rem)',
      }}
    >
      <span className="flex-1">{toast.message}</span>
      {onUndo && (
        <button
          type="button"
          onClick={onUndo}
          className="shrink-0 rounded border border-white/40 px-3 py-1 font-medium hover:bg-white/10"
        >
          {t('edit.undo')}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('panel.close')}
        className="shrink-0 px-1 text-lg leading-none opacity-70 hover:opacity-100"
      >
        ×
      </button>
    </div>
  )
}
