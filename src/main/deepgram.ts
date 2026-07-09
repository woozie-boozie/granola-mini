// Thin wrapper around a Deepgram streaming (websocket) connection.
// One instance per audio channel — "you" (mic) and "them" (system audio) —
// so speaker attribution is trivially correct at the source, and Deepgram's
// diarisation further splits multiple far-side speakers on the "them" channel.

import { createClient, LiveTranscriptionEvents, type ListenLiveClient } from '@deepgram/sdk'

export type Channel = 'you' | 'them'

export interface TranscriptEvent {
  channel: Channel
  text: string
  isFinal: boolean
  speaker?: number
  latencyMs?: number
}

export interface DeepgramCallbacks {
  onTranscript: (e: TranscriptEvent) => void
  onStatus: (msg: string) => void
  onLatency: (ms: number) => void
}

export class DeepgramStream {
  private conn: ListenLiveClient
  private firstSendAt = 0
  private keepAlive?: NodeJS.Timeout

  constructor(
    apiKey: string,
    private channel: Channel,
    private cb: DeepgramCallbacks,
    opts: { diarize: boolean; model: string }
  ) {
    const dg = createClient(apiKey)
    this.conn = dg.listen.live({
      model: opts.model,
      language: 'en',
      encoding: 'linear16',
      sample_rate: 16_000,
      channels: 1,
      interim_results: true,
      punctuate: true,
      smart_format: true,
      diarize: opts.diarize
    })

    this.conn.on(LiveTranscriptionEvents.Open, () => {
      this.cb.onStatus(`deepgram: ${channel} channel connected`)
      // Deepgram closes idle sockets; keep it warm between utterances.
      this.keepAlive = setInterval(() => this.conn.keepAlive(), 8_000)
    })

    this.conn.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      const alt = data?.channel?.alternatives?.[0]
      const text: string = alt?.transcript ?? ''
      if (!text.trim()) return
      const speaker: number | undefined = alt?.words?.[0]?.speaker

      // True streaming latency = how far behind real-time this transcript is.
      // Deepgram gives audio-stream timestamps (start + duration, in seconds);
      // compare the wall-clock now to when that audio was actually captured.
      let latencyMs: number | undefined
      if (data.is_final && this.firstSendAt) {
        const audioEndMs = ((data.start ?? 0) + (data.duration ?? 0)) * 1000
        const lag = Date.now() - (this.firstSendAt + audioEndMs)
        if (lag > 0 && lag < 10_000) {
          latencyMs = Math.round(lag)
          this.cb.onLatency(latencyMs)
        }
      }
      this.cb.onTranscript({ channel, text, isFinal: !!data.is_final, speaker, latencyMs })
    })

    this.conn.on(LiveTranscriptionEvents.Error, (err: any) => {
      this.cb.onStatus(`deepgram error (${channel}): ${err?.message ?? err}`)
    })

    this.conn.on(LiveTranscriptionEvents.Close, () => {
      this.cb.onStatus(`deepgram: ${channel} channel closed`)
      if (this.keepAlive) clearInterval(this.keepAlive)
    })
  }

  send(pcm: Buffer): void {
    if (!this.firstSendAt) this.firstSendAt = Date.now()
    try {
      // Deepgram's send() wants an ArrayBuffer/Blob; hand it the exact byte range.
      const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer
      this.conn.send(ab)
    } catch {
      /* socket not open yet; drop the frame */
    }
  }

  close(): void {
    if (this.keepAlive) clearInterval(this.keepAlive)
    try {
      this.conn.requestClose()
    } catch {
      /* already closed */
    }
  }
}
