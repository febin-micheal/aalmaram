import { personName } from '../graph/person.js'

/**
 * "Is this the other parent, or a second marriage?"
 *
 * The two answers record completely different facts and cannot be told apart afterwards
 * by looking at the graph: a mother attached as a separate marriage looks exactly like a
 * stranger the father married. So the question is asked once, plainly, with each candidate
 * union described by *its children* — because "the union Febin belongs to" is something a
 * person can answer, and a union id is not.
 */
export default function SeatChooser({ t, locale, name, seats, onJoin, onNewMarriage, onCancel }) {
  return (
    <div
      className="absolute inset-0 z-40 flex items-start justify-center bg-black/25 pt-20"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
      role="dialog"
      aria-modal="true"
    >
      <div className="w-96 max-w-[92vw] space-y-3 rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] p-5 shadow-2xl">
        <h2 className="text-lg font-semibold">{t('seat.title', { name })}</h2>
        <p className="text-sm opacity-70">{t('seat.body')}</p>

        <div className="space-y-2">
          {seats.map((seat) => (
            <button
              key={seat.union}
              type="button"
              onClick={() => onJoin(seat.union)}
              className="w-full rounded-lg border border-[var(--accent-strong)] px-3 py-3 text-left"
            >
              <span className="block font-medium">{t('seat.join')}</span>
              <span className="block text-sm opacity-70">
                {seat.children.length
                  ? t('seat.withChildren', { children: seat.children.join(', ') })
                  : t('seat.noChildren')}
                {seat.year ? ` · ${seat.year}` : ''}
              </span>
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={onNewMarriage}
          className="w-full rounded-lg border border-[var(--card-border)] px-3 py-3 text-left"
        >
          <span className="block font-medium">{t('seat.newMarriage')}</span>
          <span className="block text-sm opacity-70">{t('seat.newMarriageHint')}</span>
        </button>

        <button
          type="button"
          onClick={onCancel}
          className="w-full rounded-lg px-3 py-2 text-sm opacity-70 hover:opacity-100"
        >
          {t('quickAdd.cancel')}
        </button>
      </div>
    </div>
  )
}
