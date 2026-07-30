import { useEffect, useRef, useState } from 'react'

/**
 * The name box that opens where the new person will be.
 *
 * An HTML input positioned over the SVG in screen coordinates, rather than a
 * `foreignObject` inside the zoom transform. Two reasons: native input behaviour (IME for
 * Malayalam, autocorrect, caret handling) is reliable this way, and the box stays a
 * readable size regardless of zoom instead of shrinking with the graph.
 *
 * Keys: Enter commits, Tab commits and opens the next sibling, Escape cancels. m and f set
 * gender when the field is empty — a single keystroke rather than a control to aim at.
 */
export default function InlineInput({ screenX, screenY, busy, hint, onCommit, onCancel, t }) {
  const [value, setValue] = useState('')
  const [gender, setGender] = useState('unknown')
  const input = useRef(null)

  useEffect(() => {
    input.current?.focus()
  }, [])

  const submit = (andSibling) => {
    if (!value.trim()) {
      onCancel()
      return
    }
    onCommit(value.trim(), { gender, andSibling })
    setValue('')
    setGender('unknown')
  }

  return (
    <div
      className="absolute z-40"
      style={{ left: screenX, top: screenY }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-1 rounded-lg border-2 border-[var(--accent-strong)] bg-[var(--card-bg)] p-1 shadow-xl">
        <input
          ref={input}
          value={value}
          disabled={busy}
          placeholder={t('edit.namePlaceholder')}
          aria-label={t('edit.namePlaceholder')}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit(false)
            } else if (event.key === 'Tab') {
              event.preventDefault()
              submit(true)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              onCancel()
            } else if (!value && (event.key === 'm' || event.key === 'f')) {
              // Only while the name is empty, so it never eats a letter of a real name.
              event.preventDefault()
              setGender(event.key === 'm' ? 'male' : 'female')
            }
          }}
          className="w-40 bg-transparent px-2 py-1.5 text-sm outline-none"
        />
        <GenderToggle value={gender} onChange={setGender} t={t} />
      </div>
      <p className="mt-1 rounded bg-[var(--card-bg)] px-2 py-0.5 text-[11px] opacity-70 shadow">
        {hint ?? t('edit.hint')}
      </p>
    </div>
  )
}

function GenderToggle({ value, onChange, t }) {
  return (
    <div className="flex gap-0.5" role="group" aria-label={t('quickAdd.gender')}>
      {[
        ['male', 'M'],
        ['female', 'F'],
      ].map(([key, label]) => (
        <button
          key={key}
          type="button"
          // 40px minimum so this is tappable on a phone, not just clickable.
          className={`h-10 w-10 rounded text-sm font-semibold ${
            value === key
              ? 'bg-[var(--accent-strong)] text-white'
              : 'border border-[var(--card-border)]'
          }`}
          onMouseDown={(event) => event.preventDefault()} // keep focus in the input
          onClick={() => onChange(value === key ? 'unknown' : key)}
          aria-pressed={value === key}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
