/**
 * Debug panel — overlay with toggleable client-side knobs.
 *
 * Important: nothing in this panel changes anything on the sim or PL —
 * it only exposes client and server-side behaviour we can turn on/off.
 * The sim is the hardware stand-in; we don't tune it from the browser.
 *
 * Each toggle is wired by App.tsx via the `flags` prop. The panel itself
 * is pure presentation — no hooks, no side effects, easy to reason about.
 */

export interface DebugFlags {
  fpsOverlay: boolean
  minimaps: boolean
}

export const DEFAULT_DEBUG_FLAGS: DebugFlags = {
  fpsOverlay: false,
  minimaps: true,
}

interface Props {
  open: boolean
  onClose: () => void
  flags: DebugFlags
  onChange: (next: DebugFlags) => void
}

export function DebugPanel({
  open,
  onClose,
  flags,
  onChange,
}: Props) {
  const set = <K extends keyof DebugFlags>(k: K, v: DebugFlags[K]) =>
    onChange({ ...flags, [k]: v })

  return (
    <>
      {open && <div className="debug-backdrop" onClick={onClose} />}
      <aside
        className={`debug-panel ${open ? 'open' : ''}`}
        aria-hidden={!open}
      >
        <header className="debug-header">
          <h2>Debug</h2>
          <button
            className="debug-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <section className="debug-section">
          <h3>Diagnostics</h3>
          <Toggle
            label="FPS overlay"
            value={flags.fpsOverlay}
            onChange={(v) => set('fpsOverlay', v)}
            hint="Show paint / move / frame rates in the corner."
          />
        </section>

        <section className="debug-section">
          <h3>Rendering</h3>
          <Toggle
            label="Minimaps"
            value={flags.minimaps}
            onChange={(v) => set('minimaps', v)}
            hint="Render overview panels as low-priority sim / FPGA work."
          />
        </section>
      </aside>
    </>
  )
}

function Toggle({
  label,
  value,
  onChange,
  hint,
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
  hint?: string
}) {
  return (
    <div className="debug-row">
      <label className="debug-toggle">
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="debug-toggle-track" />
        <span className="debug-row-label">{label}</span>
      </label>
      {hint && <p className="debug-row-hint">{hint}</p>}
    </div>
  )
}
