// The connection to the own sync server and which projects live there; opened from the file menu.
import { useEffect, useState } from 'preact/hooks'
import { confirmDialog } from '../model/actions'
import { dirty, project } from '../model/store'
import { DEFAULT_SYNC_URL, configured, deleteRemote, linkProject, listRemote, newCode, openRemote, syncNow, syncSettings, syncStatus, testConnection, unlinkProject, type RemoteItem, type SyncSettings } from '../model/sync'
import { formatInt } from '../model/geo'
import { Check, Field, Modal, Section } from './components'
import { CloudIcon } from './icons'

const when = (ms: number) => new Date(ms).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })
const size = (bytes: number) => (bytes > 1e6 ? `${(bytes / 1e6).toFixed(1).replace('.', ',')} MB` : `${formatInt(Math.max(1, Math.round(bytes / 1e3)))} kB`)

function Connection() {
  const s = syncSettings.value
  const [draft, setDraft] = useState<SyncSettings>(s)
  const [report, setReport] = useState('')
  const [showCode, setShowCode] = useState(false)
  const changed = JSON.stringify(draft) !== JSON.stringify(s)
  const set = (patch: Partial<SyncSettings>) => setDraft({ ...draft, ...patch })
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft.code)
      setReport('Code kopiert.')
    } catch {
      setShowCode(true)
      setReport('Kopieren nicht möglich – Code ist jetzt sichtbar.')
    }
  }
  return (
    <Section title="Verbindung">
      <Field label="Server-Adresse">
        <input type="url" placeholder={DEFAULT_SYNC_URL} value={draft.url} onInput={e => set({ url: (e.target as HTMLInputElement).value })} />
      </Field>
      <Field label="Code" hint="Wie ein Passwort: derselbe Code auf allen Geräten öffnet denselben Bereich.">
        <span class="inline">
          <input type={showCode ? 'text' : 'password'} value={draft.code} placeholder="mindestens 24 Zeichen" onInput={e => set({ code: (e.target as HTMLInputElement).value })} autoComplete="off" spellcheck={false} />
          <button class="small" title={showCode ? 'Verbergen' : 'Anzeigen'} onClick={() => setShowCode(!showCode)}>
            {showCode ? '◉' : '○'}
          </button>
          <button class="small" title="In die Zwischenablage" disabled={!draft.code} onClick={copy}>
            ⧉
          </button>
          <button
            class="small"
            title="Neuen zufälligen Code erzeugen"
            onClick={async () => {
              if (draft.code && !(await confirmDialog('Einen neuen Code erzeugen? Mit dem neuen Code beginnt ein leerer Bereich; der alte bleibt auf dem Server, ist aber nur mit dem alten Code erreichbar.', { yes: 'Neuen Code erzeugen' }))) return
              setShowCode(true)
              set({ code: newCode() })
            }}
          >
            Neu
          </button>
        </span>
      </Field>
      <Field label="Server-Schlüssel" hint="Nur nötig, wenn der Server ihn verlangt – und nur einmal, beim Anlegen des Bereichs.">
        <input type="password" value={draft.serverKey} placeholder="optional" onInput={e => set({ serverKey: (e.target as HTMLInputElement).value })} autoComplete="off" />
      </Field>
      <Check checked={draft.auto} onChange={auto => set({ auto })} label="Automatisch synchronisieren (Änderungen hochladen, neue Stände holen)" />
      <div class="list-actions">
        <button class="primary" disabled={!changed} onClick={() => (syncSettings.value = { ...draft, url: draft.url.trim(), code: draft.code.trim(), serverKey: draft.serverKey.trim() })}>
          Übernehmen
        </button>
        <button
          onClick={async () => {
            setReport('Prüfe …')
            setReport(await testConnection(draft))
          }}
          disabled={!draft.url.trim()}
        >
          Verbindung testen
        </button>
        {report && <span class="muted">{report}</span>}
      </div>
    </Section>
  )
}

function ThisProject() {
  const p = project.value
  const status = syncStatus.value
  const ready = configured()
  if (!p.sync) {
    return (
      <Section title="Dieses Projekt">
        <p class="hint">„{p.name}“ wird noch nicht synchronisiert. Beim Verknüpfen wird es hochgeladen; danach halten sich alle Geräte mit demselben Code gegenseitig auf Stand. Gelände und Bilder bleiben auf jedem Gerät lokal.</p>
        <button class="primary" disabled={!ready} onClick={() => linkProject()}>
          <CloudIcon /> Mit dem Server verknüpfen
        </button>
        {!ready && <p class="hint">Erst Server-Adresse und Code eintragen und übernehmen.</p>}
      </Section>
    )
  }
  return (
    <Section title="Dieses Projekt">
      <dl class="stats">
        <dt>Eintrag</dt>
        <dd>{p.sync.item}</dd>
        <dt>Status</dt>
        <dd class={`sync-${status.state}`}>{status.text}</dd>
        {status.rev ? (
          <>
            <dt>Revision</dt>
            <dd>{status.rev}</dd>
          </>
        ) : null}
        {status.at ? (
          <>
            <dt>Zuletzt</dt>
            <dd>{when(status.at)}</dd>
          </>
        ) : null}
      </dl>
      <div class="list-actions">
        <button disabled={!ready} onClick={() => syncNow()}>
          Jetzt synchronisieren
        </button>
        <button
          onClick={async () => {
            if (await confirmDialog('Die Verknüpfung lösen? Das Projekt bleibt auf dem Server und hier erhalten, wird aber nicht mehr abgeglichen.', { yes: 'Lösen' })) unlinkProject()
          }}
        >
          Verknüpfung lösen
        </button>
      </div>
    </Section>
  )
}

function OnServer() {
  const [items, setItems] = useState<RemoteItem[] | null>(null)
  const [error, setError] = useState('')
  const ready = configured()
  const load = () => {
    setError('')
    listRemote()
      .then(setItems)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(() => {
    if (ready) load()
  }, [ready, syncSettings.value.url, syncSettings.value.code])
  const current = project.value.sync?.item
  if (!ready) return null
  return (
    <Section title="Auf dem Server" actions={<button class="small" onClick={load}>↻</button>}>
      {error && <p class="warn-text">{error}</p>}
      {items && !items.length && <p class="empty">Noch nichts hochgeladen.</p>}
      {items && items.length > 0 && (
        <ul class="remote-items">
          {items.map(item => (
            <li key={item.name}>
              <span class="remote-name">
                {item.name}
                {item.name === current && <span class="muted"> · offen</span>}
              </span>
              <span class="muted">
                {size(item.size)} · {when(item.updated)}
              </span>
              <button
                class="small"
                disabled={item.name === current}
                onClick={async () => {
                  if (dirty.value && !(await confirmDialog('Ungespeicherte Änderungen am offenen Projekt verwerfen und das Projekt vom Server öffnen?', { yes: 'Öffnen' }))) return
                  await openRemote(item.name)
                }}
              >
                Öffnen
              </button>
              <button
                class="small icon danger"
                title="Vom Server löschen, samt allen alten Ständen"
                onClick={async () => {
                  const open = item.name === current
                  const text = `„${item.name}“ mit allen gespeicherten Ständen vom Server löschen? Das kann nicht rückgängig gemacht werden.${open ? ' Das offene Projekt bleibt hier erhalten, wird aber nicht mehr synchronisiert.' : ''} Andere Geräte, die es offen haben, verlieren die Verbindung.`
                  if (!(await confirmDialog(text, { title: 'Vom Server löschen', yes: 'Löschen' }))) return
                  if (await deleteRemote(item.name, item.rev)) load()
                }}
              >
                🗑
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

export function SyncDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Synchronisierung" onClose={onClose}>
      <div class="dialog-panel">
        <Connection />
        <ThisProject />
        <OnServer />
      </div>
    </Modal>
  )
}

/** the cloud next to the project name: state at a glance, a click opens the dialog */
export function SyncBadge({ onClick }: { onClick: () => void }) {
  const p = project.value
  const status = syncStatus.value
  if (!p.sync) return null
  return (
    <button class={`icon sync-badge sync-${status.state}`} title={`Synchronisierung: ${status.text}`} onClick={onClick}>
      <CloudIcon />
    </button>
  )
}
