// Obsidian link: elements keep the vault path of their note; a click opens it through
// obsidian://open, and the note's frontmatter (only what is really in the file) is read as data.
import { signal } from '@preact/signals'
import { parse } from 'yaml'
import { platform, type VaultNote } from '../platform'
import type { Project } from './types'

export const vaultNotes = signal<VaultNote[] | null>(null)
export const vaultError = signal<string | null>(null)

export function vaultName(p: Project) {
  if (p.obsidian.vaultName) return p.obsidian.vaultName
  return p.obsidian.vaultPath.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

export function obsidianUrl(p: Project, notePath: string) {
  const file = notePath.replace(/\.md$/i, '')
  return `obsidian://open?vault=${encodeURIComponent(vaultName(p))}&file=${encodeURIComponent(file)}`
}

export async function refreshVault(p: Project) {
  if (!p.obsidian.vaultPath) {
    vaultNotes.value = null
    return
  }
  try {
    vaultNotes.value = await platform.vaultList(p.obsidian.vaultPath)
    vaultError.value = null
  } catch (error) {
    vaultNotes.value = null
    vaultError.value = String(error)
  }
}

/** the YAML block between the leading '---' lines, or null when the note has none */
export function frontmatter(text: string): Record<string, unknown> | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/)
  if (!match) return null
  try {
    const data = parse(match[1])
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const cache = new Map<string, { at: number; data: Record<string, unknown> | null }>()

export async function readFrontmatter(p: Project, notePath: string, fresh = false) {
  const key = `${p.obsidian.vaultPath}|${notePath}`
  const hit = cache.get(key)
  if (hit && !fresh && Date.now() - hit.at < 10_000) return hit.data
  const data = frontmatter(await platform.vaultRead(p.obsidian.vaultPath, notePath))
  cache.set(key, { at: Date.now(), data })
  return data
}

export function formatValue(value: unknown): string {
  if (value == null) return ''
  if (Array.isArray(value)) return value.map(formatValue).join(', ')
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
