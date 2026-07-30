import SearchBox from './SearchBox.jsx'
import { personName } from '../graph/person.js'

export default function Toolbar({
  t,
  locale,
  onToggleLocale,
  mode,
  center,
  stats,
  personCount,
  unionCount,
  renderMode,
  relateActive,
  onToggleRelate,
  onFit,
  onZoomIn,
  onZoomOut,
  onOverview,
  onAddHousehold,
  onHighlight,
  onPick,
  loading,
}) {
  return (
    <header className="z-30 flex flex-wrap items-center gap-2 border-b border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2">
      <button
        type="button"
        onClick={onOverview}
        className="text-lg font-semibold"
        title={t('toolbar.overview')}
      >
        {t('app.name')}
      </button>

      <SearchBox t={t} locale={locale} onHighlight={onHighlight} onPick={onPick} />

      <span className="hidden text-xs opacity-70 lg:inline">
        {mode === 'overview'
          ? t('graph.wholeArchive', {
              persons: stats?.persons ?? 0,
              families: stats?.components ?? 0,
            })
          : t('graph.centeredOn', { name: center ? personName(center, locale) : '' })}
        {' · '}
        {t(renderMode === 'dots' ? 'graph.modeDots' : 'graph.modeCards')}
      </span>

      <span className="flex-1" />

      {loading && <span className="text-sm opacity-60">{t('toolbar.loading')}</span>}

      <ToolButton onClick={onZoomOut} label="−" title={t('toolbar.zoomOut')} />
      <ToolButton onClick={onZoomIn} label="+" title={t('toolbar.zoomIn')} />
      <ToolButton onClick={onFit} label="⤢" title={t('toolbar.fit')} />

      {mode !== 'overview' && <ToolButton onClick={onOverview} label={t('toolbar.overview')} />}
      <ToolButton
        onClick={onToggleRelate}
        label={relateActive ? t('toolbar.relateCancel') : t('toolbar.relate')}
        active={relateActive}
      />
      <ToolButton onClick={onAddHousehold} label={t('toolbar.addHousehold')} primary />
      <ToolButton onClick={onToggleLocale} label={t('language.switch')} />
    </header>
  )
}

function ToolButton({ onClick, label, title, active, primary }) {
  const tone = active
    ? 'border-[var(--accent-strong)] bg-[var(--accent-strong)] text-white'
    : primary
      ? 'border-[var(--accent-strong)] text-[var(--accent-strong)] font-semibold'
      : 'border-[var(--card-border)] hover:bg-[var(--chip-bg)]'
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      aria-pressed={active ? 'true' : undefined}
      className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${tone}`}
    >
      {label}
    </button>
  )
}
