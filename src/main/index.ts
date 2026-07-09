import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { resolve } from 'path'
import { config as loadEnv } from 'dotenv'
import { DeepgramStream } from './deepgram'
import { NativeAudioSource, resolveHelper } from './audioSource'
import { wordErrorRate, LatencyTracker } from './evals'

loadEnv({ path: resolve(process.cwd(), '.env') })

const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL ?? 'nova-2'

let win: BrowserWindow | null = null
const latency = new LatencyTracker()

interface Session {
  micSource?: NativeAudioSource
  sysSource?: NativeAudioSource
  micStream?: DeepgramStream
  sysStream?: DeepgramStream
}
let session: Session = {}

function send(channel: string, payload: unknown) {
  win?.webContents.send(channel, payload)
}

function status(msg: string) {
  send('status', { msg, latencyAvg: latency.average, latencyP95: latency.p95 })
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

function startCapture(): { ok: boolean; error?: string } {
  const apiKey = process.env.DEEPGRAM_API_KEY
  if (!apiKey) {
    return { ok: false, error: 'DEEPGRAM_API_KEY missing — add it to .env (see .env.example).' }
  }

  const sysBin = resolveHelper('systemaudio')
  const micBin = resolveHelper('miccapture')
  if (!sysBin || !micBin) {
    return { ok: false, error: 'Native helpers not found. Run `npm run build:native`.' }
  }

  stopCapture() // clean slate

  // --- "you": microphone ---
  session.micStream = new DeepgramStream(apiKey, 'you', {
    onTranscript: (e) => send('transcript', e),
    onStatus: status,
    onLatency: (ms) => latency.add(ms)
  }, { diarize: false, model: DEEPGRAM_MODEL })

  session.micSource = new NativeAudioSource(micBin, {
    onPCM: (b) => session.micStream?.send(b),
    onLog: (line) => status(`mic: ${line}`)
  })

  // --- "them": system audio (the far side of the call) ---
  session.sysStream = new DeepgramStream(apiKey, 'them', {
    onTranscript: (e) => send('transcript', e),
    onStatus: status,
    onLatency: (ms) => latency.add(ms)
  }, { diarize: true, model: DEEPGRAM_MODEL })

  session.sysSource = new NativeAudioSource(sysBin, {
    onPCM: (b) => session.sysStream?.send(b),
    onLog: (line) => status(`system: ${line}`)
  })

  session.micSource.start()
  session.sysSource.start()
  status('capture started — grant Microphone + Screen Recording if macOS prompts')
  return { ok: true }
}

function stopCapture() {
  session.micSource?.stop()
  session.sysSource?.stop()
  session.micStream?.close()
  session.sysStream?.close()
  session = {}
}

ipcMain.handle('capture:start', () => startCapture())
ipcMain.handle('capture:stop', () => {
  stopCapture()
  status('capture stopped')
  return { ok: true }
})
ipcMain.handle('evals:wer', (_e, reference: string, hypothesis: string) =>
  wordErrorRate(reference, hypothesis)
)

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  stopCapture()
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
