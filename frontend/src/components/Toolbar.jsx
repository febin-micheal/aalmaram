import SearchBox from './SearchBox.jsx'
import { personName } from '../graph/person.js'

function HistoryButton({ onClick, disabled, label, hint, glyph, action }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      // Stable hook: aria-label is translated, so the checks cannot key on it.
      data-action={action}
      aria-label={label}
      title={`${label} (${hint})`}
      // 40px so this is a thumb target on a phone, and visibly inert when there is
      // nothing to undo rather than silently doing nothing.
      className="h-10 w-10 rounded border border-[var(--card-border)] text-base disabled:cursor-not-allowed disabled:opacity-35"
    >
      {glyph}
    </button>
  )
}

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
  onUndo,
  onRedo,
  canUndo,
  canRedo,
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

      {/* Undo/redo sit next to the search box rather than in a menu: they are the two
          controls a data-entry session reaches for most, and a disabled button is also how
          you find out there is nothing to undo. */}
      <div className="flex items-center gap-1">
        <HistoryButton
          onClick={onUndo}
          disabled={!canUndo}
          label={t('toolbar.undo')}
          hint="Ctrl+Z"
          glyph="↶"
          action="undo"
        />
        <HistoryButton
          onClick={onRedo}
          disabled={!canRedo}
          label={t('toolbar.redo')}
          hint="Ctrl+Y"
          glyph="↷"
          action="redo"
        />
      </div>

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
