// Local, on-device transcription via whisper.cpp's `whisper-server`.
//
// This mirrors DeepgramStream's interface (send / close + the same callbacks), so
// the app can swap the cloud provider for a fully local model with no other changes
// — the "local transcription models" bullet, for real. The PCM-over-stdout capture
// layer doesn't know or care which one is running.
//
// Whisper is NOT a streaming model, so we can't get word-by-word interim results the
// way Deepgram does. Instead we window the 16 kHz mono PCM into ~4.5s chunks and
// transcribe each one. `whisper-server` keeps the model resident (loaded once, on the
// GPU via Metal), so each chunk is just a fast localhost round-trip — not a reload.
// The tradeoff is honest and visible: local latency is measured from the start of the
// chunk, so the UI shows it running several seconds behind the cloud path.

import { spawn, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { resolve } from 'path'
import type { Channel, DeepgramCallbacks } from './deepgram'

const SAMPLE_RATE = 16_000
const BYTES_PER_SAMPLE = 2
const CHUNK_SECONDS = 4.5
const CHUNK_BYTES = Math.floor(CHUNK_SECONDS * SAMPLE_RATE) * BYTES_PER_SAMPLE
const SILENCE_RMS = 300 // skip near-silent chunks so whisper doesn't hallucinate on them
const WHISPER_PORT = 8178

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function resolveWhisperBin(): string | null {
  const candidates = [
    process.env.WHISPER_SERVER_BIN,
    '/opt/homebrew/bin/whisper-server',
    '/usr/local/bin/whisper-server'
  ].filter(Boolean) as string[]
  return candidates.find((p) => existsSync(p)) ?? null
}

export function resolveWhisperModel(): string | null {
  const candidates = [
    process.env.WHISPER_MODEL,
    resolve(process.cwd(), 'models/ggml-base.en.bin')
  ].filter(Boolean) as string[]
  return candidates.find((p) => existsSync(p)) ?? null
}

/** A single whisper-server process, shared by both channels — loads the model once. */
export class WhisperServer {
  private proc?: ChildProcess
  readonly url = `http://127.0.0.1:${WHISPER_PORT}`

  constructor(
    private bin: string,
    private model: string,
    private onLog: (msg: string) => void
  ) {}

  async start(): Promise<void> {
    this.proc = spawn(this.bin, [
      '-m', this.model,
      '--host', '127.0.0.1',
      '--port', String(WHISPER_PORT),
      '-nt', // no timestamps in output
      '-t', '4'
    ])
    this.proc.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim()
      if (/error|failed|listening/i.test(line)) this.onLog(line.split('\n').pop() ?? line)
    })
    this.proc.on('exit', (code) => {
      if (code && code !== 0) this.onLog(`whisper-server exited (code ${code})`)
    })
    await this.waitReady()
  }

  private async waitReady(timeoutMs = 30_000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      try {
        await fetch(this.url, { method: 'GET' }) // any HTTP response = model loaded & listening
        return
      } catch {
        await sleep(300)
      }
    }
    throw new Error('did not become ready within 30s')
  }

  stop(): void {
    try {
      this.proc?.kill()
    } catch {
      /* already gone */
    }
    this.proc = undefined
  }
}

/** Per-channel transcriber that windows PCM and posts each chunk to whisper-server. */
export class LocalWhisperStream {
  private parts: Buffer[] = []
  private bytes = 0
  private chunkStartAt = 0
  private busy = false
  private closed = false

  constructor(
    private channel: Channel,
    private cb: DeepgramCallbacks,
    private serverUrl: string
  ) {
    this.cb.onStatus(`whisper: ${channel} channel ready (local, on-device)`)
  }

  send(pcm: Buffer): void {
    if (this.closed) return
    if (this.bytes === 0) this.chunkStartAt = Date.now()
    this.parts.push(pcm)
    this.bytes += pcm.byteLength
    if (this.bytes >= CHUNK_BYTES) void this.flush()
  }

  private async flush(): Promise<void> {
    if (this.busy || this.bytes === 0) return
    const chunk = Buffer.concat(this.parts)
    const startedAt = this.chunkStartAt
    this.parts = []
    this.bytes = 0
    this.busy = true
    try {
      if (rms(chunk) < SILENCE_RMS) return // silence → skip, avoids whisper hallucinations
      const wavBytes = new Uint8Array(pcmToWav(chunk)) // fresh ArrayBuffer → valid BlobPart
      const form = new FormData()
      form.append('file', new Blob([wavBytes], { type: 'audio/wav' }), 'chunk.wav')
      form.append('response_format', 'text')
      const res = await fetch(`${this.serverUrl}/inference`, { method: 'POST', body: form })
      const text = cleanTranscript(await res.text())
      if (text && !this.closed) {
        // Latency = how far behind real-time this transcript is, measured from the
        // *start* of the chunk — so it honestly reflects the windowing cost of a
        // non-streaming local model (seconds), vs the cloud streaming path (~200ms).
        const latencyMs = Date.now() - startedAt
        if (latencyMs > 0 && latencyMs < 10_000) this.cb.onLatency(latencyMs)
        this.cb.onTranscript({ channel: this.channel, text, isFinal: true, latencyMs })
      }
    } catch (err: unknown) {
      this.cb.onStatus(`whisper error (${this.channel}): ${(err as Error)?.message ?? err}`)
    } finally {
      this.busy = false
    }
  }

  close(): void {
    this.closed = true
    this.parts = []
    this.bytes = 0
  }
}

function rms(pcm: Buffer): number {
  const n = Math.floor(pcm.byteLength / 2)
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2)
    sum += s * s
  }
  return Math.sqrt(sum / n)
}

/** Whisper emits non-speech markers like "[BLANK_AUDIO]" or "(music)" on silence/music. */
function cleanTranscript(raw: string): string {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^[[(].*[\])]$/.test(l))
    .join(' ')
    .trim()
}

/** Wrap raw 16 kHz mono 16-bit PCM in a minimal 44-byte WAV header. */
function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44)
  const dataLen = pcm.byteLength
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataLen, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28)
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32)
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(dataLen, 40)
  return Buffer.concat([header, pcm])
}
