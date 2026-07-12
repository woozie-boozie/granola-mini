import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { resolve } from 'path'
import { config as loadEnv } from 'dotenv'
import { DeepgramStream, type DeepgramCallbacks } from './deepgram'
import {
  WhisperServer,
  LocalWhisperStream,
  resolveWhisperBin,
  resolveWhisperModel
} from './whisper'
import { NativeAudioSource, resolveHelper } from './audioSource'
import { wordErrorRate, LatencyTracker } from './evals'
import { generateNotes } from './notes'

loadEnv({ path: resolve(process.cwd(), '.env') })

const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL ?? 'nova-2'

let win: BrowserWindow | null = null
const latency = new LatencyTracker()

type Provider = 'deepgram' | 'whisper'

// Deepgram (cloud streaming) and LocalWhisperStream (on-device) share this shape,
// so the audio capture layer feeds whichever is selected without knowing the difference.
interface TranscriberStream {
  send(pcm: Buffer): void
  close(): void
}

interface Session {
  micSource?: NativeAudioSource
  sysSource?: NativeAudioSource
  micStream?: TranscriberStream
  sysStream?: TranscriberStream
  whisper?: WhisperServer
}
let session: Session = {}

function send(channel: string, payload: unknown) {
  win?.webContents.send(channel, payload)
}

function status(msg: string) {
  send('status', { msg, latencyAvg: latency.average, latencyP95: latency.p95 })
}

// Shared callbacks for either provider: forward transcripts (with live latency tiles)
// and feed the latency tracker.
function makeCallbacks(): DeepgramCallbacks {
  return {
    onTranscript: (e) =>
      send('transcript', { ...e, latencyAvg: latency.average, latencyP95: latency.p95 }),
    onStatus: status,
    onLatency: (ms) => latency.add(ms)
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 760,
    title: 'Granola Mini',
    backgroundColor: '#0e0f12',
    webPreferences: {
      preload: resolve(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(resolve(__dirname, '../renderer/index.html'))
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

async function startCapture(provider: Provider = 'deepgram'): Promise<{ ok: boolean; error?: string }> {
  const sysBin = resolveHelper('systemaudio')
  const micBin = resolveHelper('miccapture')
  if (!sysBin || !micBin) {
    return { ok: false, error: 'Native helpers not found. Run `npm run build:native`.' }
  }

  stopCapture() // clean slate
  latency.reset() // fresh numbers per session, so a cloud→local switch reads cleanly

  // --- pick the transcriber: cloud (Deepgram) or local (Whisper) ---
  if (provider === 'whisper') {
    const bin = resolveWhisperBin()
    const model = resolveWhisperModel()
    if (!bin) return { ok: false, error: 'whisper-server not found — run `brew install whisper-cpp`.' }
    if (!model) return { ok: false, error: 'Whisper model not found — run `npm run download-model`.' }

    const server = new WhisperServer(bin, model, (m) => status(`whisper-server: ${m}`))
    session.whisper = server
    status('whisper: loading local model…')
    try {
      await server.start()
    } catch (e: unknown) {
      return { ok: false, error: `whisper-server failed to start: ${(e as Error)?.message ?? e}` }
    }
    session.micStream = new LocalWhisperStream('you', makeCallbacks(), server.url)
    session.sysStream = new LocalWhisperStream('them', makeCallbacks(), server.url)
  } else {
    const apiKey = process.env.DEEPGRAM_API_KEY
    if (!apiKey) {
      return { ok: false, error: 'DEEPGRAM_API_KEY missing — add it to .env (see .env.example).' }
    }
    session.micStream = new DeepgramStream(apiKey, 'you', makeCallbacks(), {
      diarize: false,
      model: DEEPGRAM_MODEL
    })
    session.sysStream = new DeepgramStream(apiKey, 'them', makeCallbacks(), {
      diarize: true,
      model: DEEPGRAM_MODEL
    })
  }

  // --- audio capture (identical for both providers) ---
  session.micSource = new NativeAudioSource(micBin, {
    onPCM: (b) => session.micStream?.send(b),
    onLog: (line) => status(`mic: ${line}`)
  })
  session.sysSource = new NativeAudioSource(sysBin, {
    onPCM: (b) => session.sysStream?.send(b),
    onLog: (line) => status(`system: ${line}`)
  })
  session.micSource.start()
  session.sysSource.start()
  status(
    provider === 'whisper'
      ? 'capture started — local Whisper, on-device'
      : 'capture started — Deepgram, cloud'
  )
  return { ok: true }
}

function stopCapture() {
  session.micSource?.stop()
  session.sysSource?.stop()
  session.micStream?.close()
  session.sysStream?.close()
  session.whisper?.stop()
  session = {}
}

ipcMain.handle('capture:start', (_e, provider: Provider = 'deepgram') => startCapture(provider))
ipcMain.handle('capture:stop', () => {
  stopCapture()
  status('capture stopped')
  return { ok: true }
})
ipcMain.handle('evals:wer', (_e, reference: string, hypothesis: string) =>
  wordErrorRate(reference, hypothesis)
)
ipcMain.handle('notes:generate', (_e, transcript: string) => generateNotes(transcript))

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  stopCapture()
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
