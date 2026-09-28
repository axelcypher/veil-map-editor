import { useEffect, useMemo, useState } from 'preact/hooks'
import { formatValue, obsidianUrl, readFrontmatter, refreshVault, vaultError, vaultNotes } from '../model/obsidian'
import { notify, project } from '../model/store'
import { platform } from '../platform'
import { Modal } from './components'

/** choose a note from the vault */
export function NotePicker({ onPick, onClose, suggestion }: { onPick: (path: string) => void; onClose: () => void; suggestion?: string }) {
  const [query, setQuery] = useState(suggestion ?? '')
  useEffect(() => {
    if (!vaultNotes.value) refreshVault(project.value)
  }, [])
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return (vaultNotes.value ?? []).filter(n => words.every(w => n.path.toLowerCase().includes(w))).slice(0, 200)
  }, [query, vaultNotes.value])
  return (
    <Modal title="Note verknüpfen" onClose={onClose}>
      {!project.value.obsidian.vaultPath ? (
        <p>Erst unter „Projekt → Obsidian“ den Vault-Ordner freigeben.</p>
      ) : vaultError.value ? (
        <p class="error-text">{vaultError.value}</p>
      ) : (
        <>
          <input type="search" autoFocus placeholder="Note suchen …" value={query} onInput={e => setQuery((e.target as HTMLInputElement).value)} />
          <ul class="note-list">
            {matches.map(n => {
              const parts = n.path.replace(/\.md$/i, '').split('/')
              return (
                <li key={n.path} onClick={() => onPick(n.path)}>
                  <strong>{parts.pop()}</strong>
                  <span class="muted">{parts.join(' / ')}</span>
                </li>
              )
            })}
          </ul>
          {vaultNotes.value && <p class="muted">{vaultNotes.value.length} Notes im Vault</p>}
        </>
      )}
    </Modal>
  )
}

/** the link of an element to its note: pick, open, and what the frontmatter says */
export function NoteLink({ note, name, onChange }: { note: string; name: string; onChange: (path: string) => void }) {
  const [picking, setPicking] = useState(false)
  const [data, setData] = useState<Record<string, unknown> | null | 'error'>(null)
  const p = project.value
  useEffect(() => {
    setData(null)
    if (!note || !p.obsidian.vaultPath) return
    let live = true
    readFrontmatter(p, note)
      .then(result => live && setData(result))
      .catch(() => live && setData('error'))
    return () => {
      live = false
    }
  }, [note, p.obsidian.vaultPath])
  return (
    <div class="note-link">
      {note ? (
        <>
          <div class="note-path" title={note}>
            📝 {note.replace(/\.md$/i, '').split('/').pop()}
          </div>
          <div class="button-row">
            <button onClick={() => platform.openExternal(obsidianUrl(p, note)).catch(e => notify(String(e), 'error'))}>In Obsidian öffnen</button>
            <button onClick={() => setPicking(true)}>Ändern</button>
            <button onClick={() => onChange('')}>Lösen</button>
          </div>
          {data === 'error' && <p class="error-text">Note nicht lesbar (verschoben oder gelöscht?)</p>}
          {data && data !== 'error' && (
            <table class="frontmatter">
              <tbody>
                {Object.entries(data).map(([key, value]) => (
                  <tr key={key}>
                    <th>{key}</th>
                    <td>{formatValue(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data === null && p.obsidian.vaultPath && <p class="muted">Kein Frontmatter.</p>}
        </>
      ) : (
        <button onClick={() => setPicking(true)}>Note verknüpfen …</button>
      )}
      {picking && (
        <NotePicker
          suggestion={name}
          onClose={() => setPicking(false)}
          onPick={path => {
            onChange(path)
            setPicking(false)
          }}
        />
      )}
    </div>
  )
}
