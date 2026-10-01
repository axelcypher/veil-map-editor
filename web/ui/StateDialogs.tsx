// What belongs to a state and is edited in a dialog opened from its inspector: diplomacy,
// provinces and military.
import { signal } from '@preact/signals'
import { Fragment } from 'preact'
import { useState } from 'preact/hooks'
import { cityMembership, militaryTotals, provinceStats, stateStats } from '../model/derive'
import { formatInt } from '../model/geo'
import { commit, patchProject, project, removeEntity, selection, tool, updateEntity } from '../model/store'
import type { EntityKind, Province, Regiment } from '../model/types'
import { regimentTotal } from '../map/styles'
import { mapView } from './mapRef'
import { Color, Modal, Num, Swatch } from './components'

export type StateDialogKind = 'diplomacy' | 'provinces' | 'military'
/** the open dialog; stateId '' = elements without a state */
export const stateDialog = signal<{ kind: StateDialogKind; stateId: string } | null>(null)

export const openStateDialog = (kind: StateDialogKind, stateId: string) => (stateDialog.value = { kind, stateId })

const TITLES: Record<StateDialogKind, string> = { diplomacy: 'Diplomatie', provinces: 'Provinzen', military: 'Militär' }

/** shows an element on the map; the dialog closes so the map is visible */
function show(kind: EntityKind, id: string) {
  stateDialog.value = null
  selection.value = { kind, id }
  mapView.current?.focus(kind, id)
}

const input = (handler: (v: string) => void) => (e: Event) => handler((e.target as HTMLInputElement).value)

export function StateDialogs() {
  const d = stateDialog.value
  const p = project.value
  if (!d) return null
  const state = p.states.find(s => s.id === d.stateId)
  // a deleted state (undo) closes the dialog
  if (d.stateId && !state) {
    queueMicrotask(() => (stateDialog.value = null))
    return null
  }
  const choose = (stateId: string) => {
    stateDialog.value = { ...d, stateId }
    if (stateId) selection.value = { kind: 'state', id: stateId }
  }
  return (
    <Modal title={`${TITLES[d.kind]} – ${state?.name ?? 'ohne Staat'}`} onClose={() => (stateDialog.value = null)} wide>
      <div class="dialog-bar">
        <select value={d.stateId} onChange={input(choose)} aria-label="Staat">
          {p.states.map(s => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          {d.kind !== 'diplomacy' && <option value="">ohne Staat</option>}
        </select>
        <span class="dialog-switch">
          {(Object.keys(TITLES) as StateDialogKind[]).map(k => (
            <button key={k} class={`small${k === d.kind ? ' active' : ''}`} disabled={k === 'diplomacy' && !state} onClick={() => (stateDialog.value = { ...d, kind: k })}>
              {TITLES[k]}
            </button>
          ))}
        </span>
      </div>
      {d.kind === 'diplomacy' && state && <Diplomacy stateId={state.id} />}
      {d.kind === 'provinces' && <Provinces stateId={d.stateId} />}
      {d.kind === 'military' && <Military stateId={d.stateId} />}
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------

function Diplomacy({ stateId }: { stateId: string }) {
  const p = project.value
  const [filter, setFilter] = useState('')
  const relations = p.catalog.relations
  const others = p.states.filter(s => s.id !== stateId && s.name.toLowerCase().includes(filter.trim().toLowerCase()))
  const set = (b: string, relation: string) => {
    const mirror = relations.find(r => r.id === relation)?.mirror ?? relation
    commit({ ...p, diplomacy: { ...p.diplomacy, [`${stateId}>${b}`]: relation, [`${b}>${stateId}`]: mirror } })
  }
  const setAll = (relation: string) => {
    const mirror = relations.find(r => r.id === relation)?.mirror ?? relation
    const diplomacy = { ...p.diplomacy }
    for (const s of others) {
      diplomacy[`${stateId}>${s.id}`] = relation
      diplomacy[`${s.id}>${stateId}`] = mirror
    }
    commit({ ...p, diplomacy })
  }
  const nameOf = (id: string) => relations.find(r => r.id === id)?.name ?? id
  const focused = p.display.diplomacyFocus === stateId
  if (p.states.length < 2) return <p class="empty">Mindestens zwei Staaten anlegen.</p>
  return (
    <>
      <div class="list-actions">
        <button class={focused ? 'active' : ''} onClick={() => patchProject({ display: { ...p.display, diplomacyFocus: focused ? '' : stateId } })}>
          {focused ? '✓ Karte zeigt diese Sicht' : 'Karte aus dieser Sicht einfärben'}
        </button>
        {p.states.length > 8 && <input type="search" placeholder="Staat suchen …" value={filter} onInput={input(setFilter)} />}
        <select
          value=""
          onChange={e => {
            const v = (e.target as HTMLSelectElement).value
            if (v) setAll(v)
          }}
          title="Setzt die Beziehung zu allen angezeigten Staaten"
        >
          <option value="">Alle setzen auf …</option>
          {relations.map(r => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
      <ul class="relation-list">
        {others.map(s => {
          const value = p.diplomacy[`${stateId}>${s.id}`] ?? 'neutral'
          const back = p.diplomacy[`${s.id}>${stateId}`] ?? 'neutral'
          const relation = relations.find(r => r.id === value)
          return (
            <li key={s.id} style={{ borderLeftColor: relation?.color ?? '#ccc' }}>
              <span class="relation-name">
                <Swatch color={s.color} /> {s.name}
              </span>
              <select value={value} onChange={input(v => set(s.id, v))}>
                {relations.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <span class="muted relation-back" title="Sicht der Gegenseite">
                ↔ {nameOf(back)}
              </span>
            </li>
          )
        })}
      </ul>
      <p class="hint">Die Gegenseite wird gespiegelt (Vasall ↔ Lehnsherr).</p>
    </>
  )
}

// ---------------------------------------------------------------------------------------------

function Provinces({ stateId }: { stateId: string }) {
  const p = project.value
  const stats = provinceStats.value
  const members = cityMembership.value
  const rows = p.provinces.filter(x => x.stateId === stateId)
  const up = (id: string, patch: Partial<Province>, merge?: string) => updateEntity('province', id, patch, merge)
  const draw = () => {
    stateDialog.value = null
    if (stateId) selection.value = { kind: 'state', id: stateId }
    tool.value = { id: 'area-new', kind: 'province' }
  }
  return (
    <>
      <div class="list-actions">
        <button class="primary" onClick={draw} title="Umriss auf der Karte zeichnen (Umschalt = freihand)">
          ＋ Provinz zeichnen
        </button>
        <span class="muted">{rows.length} Provinzen</span>
      </div>
      {!rows.length ? (
        <p class="empty">Keine Provinzen.</p>
      ) : (
        <div class="table-scroll">
          <table class="edit-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Bezeichnung</th>
                <th>Hauptort</th>
                <th class="num" title="Landbevölkerung je km², leer = wie der Staat">Ew./km²</th>
                <th class="num">km²</th>
                <th class="num">Einwohner</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(x => {
                const s = stats.get(x.id)
                return (
                  <tr key={x.id}>
                    <td class="name-cell">
                      <Color value={x.color} onChange={v => up(x.id, { color: v }, 'color')} />
                      <input type="text" value={x.name} onInput={input(v => up(x.id, { name: v }, 'name'))} />
                    </td>
                    <td>
                      <input type="text" value={x.form} placeholder="Provinz, Mark …" onInput={input(v => up(x.id, { form: v }, 'form'))} />
                    </td>
                    <td>
                      <select value={x.capitalId} onChange={input(v => up(x.id, { capitalId: v }))}>
                        <option value="">—</option>
                        {p.cities
                          .filter(c => members.get(c.id)?.province === x.id)
                          .map(c => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                    </td>
                    <td class="num narrow">
                      <Num value={x.ruralDensity} min={0} placeholder="Staat" onChange={v => up(x.id, { ruralDensity: v }, 'density')} />
                    </td>
                    <td class="num">{formatInt(s?.areaKm2 ?? 0)}</td>
                    <td class="num">{formatInt((s?.urban ?? 0) + (s?.rural ?? 0))}</td>
                    <td class="row-actions">
                      <button class="icon" title="Auf der Karte zeigen" onClick={() => show('province', x.id)}>
                        ⌖
                      </button>
                      <button class="icon danger" title="Löschen" onClick={() => removeEntity('province', x.id)}>
                        🗑
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p class="hint">Neue Provinzen gehören zum gewählten Staat. Den Umriss bearbeitest du über ⌖ und den Inspector.</p>
    </>
  )
}

// ---------------------------------------------------------------------------------------------

function Military({ stateId }: { stateId: string }) {
  const p = project.value
  const units = p.catalog.unitTypes
  const rows = p.regiments.filter(r => r.stateId === stateId)
  const totals = militaryTotals.value.get(stateId) ?? {}
  const sum = Object.values(totals).reduce((a, b) => a + b, 0)
  const stats = stateStats.value.get(stateId)
  const pop = stats ? stats.urban + stats.rural : 0
  const up = (id: string, patch: Partial<Regiment>, merge?: string) => updateEntity('regiment', id, patch, merge)
  const place = () => {
    stateDialog.value = null
    tool.value = { id: 'place', kind: 'regiment' }
  }
  return (
    <>
      <div class="list-actions">
        <button class="primary" onClick={place} title="Regiment auf der Karte setzen; der Staat ergibt sich aus dem Ort">
          ＋ Regiment setzen
        </button>
      </div>
      <dl class="stats military-sum">
        {units
          .filter(u => totals[u.id])
          .map(u => (
            <Fragment key={u.id}>
              <dt>
                {u.symbol} {u.name}
              </dt>
              <dd>{formatInt(totals[u.id])}</dd>
            </Fragment>
          ))}
        <dt>Gesamt</dt>
        <dd>
          <strong>{formatInt(sum)}</strong>
        </dd>
        {pop > 0 && (
          <>
            <dt>je 1.000 Einwohner</dt>
            <dd>{((sum / pop) * 1000).toFixed(1).replace('.', ',')}</dd>
          </>
        )}
      </dl>
      {!rows.length ? (
        <p class="empty">Keine Regimenter.</p>
      ) : (
        <div class="regiments">
          {rows.map(r => (
            <section key={r.id} class="regiment-card">
              <header>
                <input type="text" value={r.name} onInput={input(v => up(r.id, { name: v }, 'name'))} aria-label="Name" />
                <select value={r.naval ? 'naval' : 'land'} onChange={input(v => up(r.id, { naval: v === 'naval' }))} aria-label="Art">
                  <option value="land">Heer</option>
                  <option value="naval">Flotte</option>
                </select>
                <strong class="regiment-total">{formatInt(regimentTotal(r))}</strong>
                <button class="icon" title="Auf der Karte zeigen" onClick={() => show('regiment', r.id)}>
                  ⌖
                </button>
                <button class="icon danger" title="Löschen" onClick={() => removeEntity('regiment', r.id)}>
                  🗑
                </button>
              </header>
              <div class="regiment-fields">
                <label>
                  <span>Befehlshaber</span>
                  <input type="text" value={r.commander} onInput={input(v => up(r.id, { commander: v }, 'commander'))} />
                </label>
                <label>
                  <span>Staat</span>
                  <select value={r.stateId} onChange={input(v => up(r.id, { stateId: v }))}>
                    <option value="">—</option>
                    {p.states.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                {units
                  .filter(u => u.naval === r.naval || r.units[u.id])
                  .map(u => (
                    <label key={u.id}>
                      <span>
                        {u.symbol} {u.name}
                      </span>
                      <Num value={r.units[u.id] ?? 0} min={0} step={10} onChange={v => up(r.id, { units: { ...r.units, [u.id]: Math.round(v) } }, `unit-${u.id}`)} />
                    </label>
                  ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  )
}
