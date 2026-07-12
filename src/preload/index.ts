import { contextBridge, ipcRenderer } from 'electron'

export interface TranscriptEvent {
  channel: 'you' | 'them'
  text: string
  isFinal: boolean
  speaker?: number
  latencyMs?: number
  // Rolling aggregates, attached to every transcript so the UI tiles update live
  // (not just when an occasional status message fires).
  latencyAvg?: number
  latencyP95?: number
}

export interface StatusEvent {
  msg: string
  latencyAvg: number
  latencyP95: number
}

export interface WerResult {
  wer: number
  substitutions: number
  deletions: number
  insertions: number
  referenceWords: number
  hits: number
}

export interface NotesResult {
  ok: boolean
  notes?: string
  error?: string
}

const api = {
  start: (provider: 'deepgram' | 'whisper' = 'deepgram'): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('capture:start', provider),
  stop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('capture:stop'),
  scoreWER: (reference: string, hypothesis: string): Promise<WerResult> =>
    ipcRenderer.invoke('evals:wer', reference, hypothesis),
  generateNotes: (transcript: string): Promise<NotesResult> =>
    ipcRenderer.invoke('notes:generate', transcript),
  onTranscript: (cb: (e: TranscriptEvent) => void) => {
    const h = (_e: unknown, data: TranscriptEvent) => cb(data)
    ipcRenderer.on('transcript', h)
    return () => ipcRenderer.removeListener('transcript', h)
  },
  onStatus: (cb: (e: StatusEvent) => void) => {
    const h = (_e: unknown, data: StatusEvent) => cb(data)
    ipcRenderer.on('status', h)
    return () => ipcRenderer.removeListener('status', h)
  }
}

contextBridge.exposeInMainWorld('granola', api)

export type GranolaAPI = typeof api
