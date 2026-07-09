// Spawns a native Swift capture helper and forwards its raw PCM stdout.
// stderr carries human-readable logs (permission hints, start/stop).

import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { resolve } from 'path'

export type HelperName = 'systemaudio' | 'miccapture'

/** Resolve a helper binary across dev (native/) and packaged (resources/) layouts. */
export function resolveHelper(name: HelperName): string | null {
  const candidates = [
    resolve(__dirname, '../../native', name),        // electron-vite dev: out/main → native
    resolve(process.cwd(), 'native', name),          // running from project root
    resolve(process.resourcesPath ?? '', 'native', name) // packaged app
  ]
  return candidates.find(existsSync) ?? null
}

export class NativeAudioSource {
  private proc?: ChildProcess
  private stderrBuf = ''

  constructor(
    private binPath: string,
    private handlers: { onPCM: (b: Buffer) => void; onLog: (line: string) => void }
  ) {}

  start(): void {
    const proc = spawn(this.binPath, [], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.proc = proc
    proc.stdout?.on('data', (b: Buffer) => this.handlers.onPCM(b))
    proc.stderr?.on('data', (b: Buffer) => {
      this.stderrBuf += b.toString()
      let idx: number
      while ((idx = this.stderrBuf.indexOf('\n')) >= 0) {
        const line = this.stderrBuf.slice(0, idx).trim()
        this.stderrBuf = this.stderrBuf.slice(idx + 1)
        if (line) this.handlers.onLog(line)
      }
    })
    proc.on('exit', (code) => {
      if (code && code !== 0) this.handlers.onLog(`helper exited with code ${code}`)
    })
    proc.on('error', (err) => this.handlers.onLog(`helper failed to spawn: ${err.message}`))
  }

  stop(): void {
    this.proc?.kill('SIGINT')
    this.proc = undefined
  }
}
