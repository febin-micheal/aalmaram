/**
 * What the owner sees after `make reset-db`: an empty database.
 *
 * This is the screen that turns "I have nothing" into "I have one household", so it does
 * exactly one thing loudly and explains what the first step actually is.
 */
export default function EmptyState({ t, onAddHousehold }) {
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
        onClick={onAddHousehold}
        className="mx-auto rounded-lg bg-[var(--accent-strong)] px-6 py-4 text-lg font-medium text-white"
      >
        {t('empty.cta')}
      </button>

      <p className="text-sm opacity-60">{t('empty.hint')}</p>
    </main>
  )
}
