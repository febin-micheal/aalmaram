/**
 * What the owner sees after `make reset-db`: an empty database.
 *
 * The primary action starts the **canvas** flow — one person placed on the sheet, grown
 * outwards with the same + partner / + child / + parents affordances used everywhere else.
 * Sending someone to a form here would teach them the wrong thing about how the app works,
 * and they would have to unlearn it the moment they added a second household.
 *
 * The bulk form stays reachable, second, for when you already have a list of names.
 */
export default function EmptyState({ t, onAddFirstPerson, onUseForm }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-6 px-6 text-center">
      <div className="space-y-2">
        <h1 className="text-4xl font-semibold">{t('app.name')}</h1>
        <p className="text-lg opacity-70">{t('app.tagline')}</p>
      </div>

      <div className="space-y-3">
        <h2 className="text-2xl font-medium">{t('empty.heading')}</h2>
        <p className="opacity-70">{t('empty.body')}</p>
      </div>

      <button
        type="button"
        onClick={onAddFirstPerson}
        className="mx-auto rounded-lg bg-[var(--accent-strong)] px-6 py-4 text-lg font-medium text-white"
      >
        {t('empty.cta')}
      </button>

      <button
        type="button"
        onClick={onUseForm}
        className="mx-auto text-sm underline opacity-70 hover:opacity-100"
      >
        {t('empty.useForm')}
      </button>

      <p className="text-sm opacity-60">{t('empty.hint')}</p>
    </main>
  )
}
