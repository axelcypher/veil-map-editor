// Small form and layout pieces shared by all panels.
import type { ComponentChildren } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'

export function Field({ label, children, hint, wide }: { label: string; children: ComponentChildren; hint?: string; wide?: boolean }) {
  return (
    <label class={`field${wide ? ' wide' : ''}`}>
      <span class="field-label">{label}</span>
      <span class="field-input">{children}</span>
      {hint && <span class="field-hint">{hint}</span>}
    </label>
  )
}

export function Text({ value, onInput, placeholder, multiline }: { value: string; onInput: (v: string) => void; placeholder?: string; multiline?: boolean }) {
  return multiline ? (
    <textarea rows={4} value={value} placeholder={placeholder} onInput={e => onInput((e.target as HTMLTextAreaElement).value)} />
  ) : (
    <input type="text" value={value} placeholder={placeholder} onInput={e => onInput((e.target as HTMLInputElement).value)} />
  )
}

export function Num({ value, onChange, min, max, step, placeholder }: { value: number | null; onChange: (v: number) => void; min?: number; max?: number; step?: number; placeholder?: string }) {
  const [draft, setDraft] = useState(value == null ? '' : String(value))
  useEffect(() => setDraft(value == null ? '' : String(value)), [value])
  return (
    <input
      type="number"
      value={draft}
      min={min}
      max={max}
      step={step ?? 'any'}
      placeholder={placeholder}
      onInput={e => {
        const text = (e.target as HTMLInputElement).value
        setDraft(text)
        const n = Number(text.replace(',', '.'))
        if (text !== '' && Number.isFinite(n)) onChange(n)
      }}
    />
  )
}

export function Range({ value, onChange, min, max, step }: { value: number; onChange: (v: number) => void; min: number; max: number; step: number }) {
  return (
    <span class="range">
      <input type="range" value={value} min={min} max={max} step={step} onInput={e => onChange(Number((e.target as HTMLInputElement).value))} />
      <output>{Number.isInteger(step) ? value : value.toFixed(2)}</output>
    </span>
  )
}

export function Select<T extends string>({ value, onChange, options, empty }: { value: T; onChange: (v: T) => void; options: { id: T; name: string }[]; empty?: string }) {
  return (
    <select value={value} onChange={e => onChange((e.target as HTMLSelectElement).value as T)}>
      {empty !== undefined && <option value="">{empty}</option>}
      {options.map(o => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  )
}

export function Color({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#888888'} onInput={e => onChange((e.target as HTMLInputElement).value)} />
}

export function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label class="check">
      <input type="checkbox" checked={checked} onChange={e => onChange((e.target as HTMLInputElement).checked)} />
      <span>{label}</span>
    </label>
  )
}

export function Section({ title, children, open = true, actions }: { title: string; children: ComponentChildren; open?: boolean; actions?: ComponentChildren }) {
  const [expanded, setExpanded] = useState(open)
  return (
    <section class={`section${expanded ? '' : ' collapsed'}`}>
      <header onClick={() => setExpanded(!expanded)}>
        <span class="chevron">{expanded ? '▾' : '▸'}</span>
        <h3>{title}</h3>
        {actions && <span class="section-actions" onClick={e => e.stopPropagation()}>{actions}</span>}
      </header>
      {expanded && <div class="section-body">{children}</div>}
    </section>
  )
}

export function Tabs<T extends string>({ tabs, active, onChange }: { tabs: { id: T; name: string; badge?: number }[]; active: T; onChange: (id: T) => void }) {
  return (
    <nav class="tabs">
      {tabs.map(t => (
        <button key={t.id} class={t.id === active ? 'active' : ''} onClick={() => onChange(t.id)}>
          {t.name}
          {t.badge ? <span class="badge">{t.badge}</span> : null}
        </button>
      ))}
    </nav>
  )
}

export function Modal({ title, children, onClose, wide, footer }: { title: string; children: ComponentChildren; onClose: () => void; wide?: boolean; footer?: ComponentChildren }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div class="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div class={`modal${wide ? ' wide' : ''}`} role="dialog" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button class="icon" onClick={onClose} aria-label="Schließen">
            ✕
          </button>
        </header>
        <div class="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  )
}

export interface Column<T> {
  id: string
  name: string
  value: (row: T) => string | number
  render?: (row: T) => ComponentChildren
  numeric?: boolean
  width?: string
}

/** sortable, filterable table; group by a column if asked */
export function Table<T extends { id: string }>({
  rows,
  columns,
  onRow,
  selectedId,
  filterPlaceholder = 'Filtern …',
  groupBy,
  initialSort,
}: {
  rows: T[]
  columns: Column<T>[]
  onRow?: (row: T) => void
  selectedId?: string | null
  filterPlaceholder?: string
  groupBy?: Column<T>[]
  initialSort?: { id: string; desc: boolean }
}) {
  const [sort, setSort] = useState(initialSort ?? { id: columns[0]?.id ?? '', desc: false })
  const [filter, setFilter] = useState('')
  const [group, setGroup] = useState('')
  const sorted = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const column = columns.find(c => c.id === sort.id)
    const filtered = needle ? rows.filter(r => columns.some(c => String(c.value(r)).toLowerCase().includes(needle))) : rows
    if (!column) return filtered
    return [...filtered].sort((a, b) => {
      const va = column.value(a)
      const vb = column.value(b)
      const order = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'de')
      return sort.desc ? -order : order
    })
  }, [rows, columns, sort, filter])
  const grouping = groupBy?.find(g => g.id === group)
  const groups = useMemo(() => {
    if (!grouping) return [{ key: '', rows: sorted }]
    const map = new Map<string, T[]>()
    for (const row of sorted) {
      const key = String(grouping.value(row) || '—')
      map.set(key, [...(map.get(key) ?? []), row])
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de')).map(([key, rows]) => ({ key, rows }))
  }, [sorted, grouping])
  const selectedRow = useRef<HTMLTableRowElement>(null)
  useEffect(() => selectedRow.current?.scrollIntoView({ block: 'nearest' }), [selectedId])
  return (
    <div class="table-wrap">
      <div class="table-tools">
        <input type="search" placeholder={filterPlaceholder} value={filter} onInput={e => setFilter((e.target as HTMLInputElement).value)} />
        {groupBy && (
          <select value={group} onChange={e => setGroup((e.target as HTMLSelectElement).value)} title="Gruppieren">
            <option value="">keine Gruppen</option>
            {groupBy.map(g => (
              <option key={g.id} value={g.id}>
                nach {g.name}
              </option>
            ))}
          </select>
        )}
        <span class="count">{sorted.length}</span>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              {columns.map(c => (
                <th key={c.id} class={c.numeric ? 'num' : ''} style={c.width ? { width: c.width } : undefined} onClick={() => setSort({ id: c.id, desc: sort.id === c.id ? !sort.desc : !!c.numeric })}>
                  {c.name}
                  {sort.id === c.id ? (sort.desc ? ' ▾' : ' ▴') : ''}
                </th>
              ))}
            </tr>
          </thead>
          {groups.map(g => (
            <tbody key={g.key}>
              {grouping && (
                <tr class="group-row">
                  <td colSpan={columns.length}>
                    {g.key} <span class="muted">({g.rows.length})</span>
                  </td>
                </tr>
              )}
              {g.rows.map(row => (
                <tr key={row.id} ref={row.id === selectedId ? selectedRow : undefined} class={row.id === selectedId ? 'selected' : ''} onClick={() => onRow?.(row)}>
                  {columns.map(c => (
                    <td key={c.id} class={c.numeric ? 'num' : ''}>
                      {c.render ? c.render(row) : c.value(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
        {!sorted.length && <p class="empty">Keine Einträge.</p>}
      </div>
    </div>
  )
}

export const Swatch = ({ color }: { color: string }) => <span class="swatch" style={{ background: color }} />
