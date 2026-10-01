import { signal } from '@preact/signals'

/** the big dialogs opened from the file menu */
export const appDialog = signal<'sync' | 'project' | null>(null)
