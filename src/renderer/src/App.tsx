import { useEffect, useMemo, useRef, useState } from 'react'

interface Segment {
  id: number
  channel: 'you' | 'them'
  speaker?: number
  text: string
}

interface Interim {
  you: string
  them: string
}

function speakerLabel(seg: { channel: 'you' | 'them'; speaker?: number }): string {
  if (seg.channel === 'you') return 'You'
  if (seg.speaker !== undefined) return `Speaker ${seg.speaker + 1}`
  return 'Them'
}

let SEG_ID = 0

export function App() {
  const [capturing, setCapturing] = useState(false)
  const [segments, setSegments] = useState<Segment[]>([])
  const [interim, setInterim] = useState<Interim>({ you: '', them: '' })
  const [statusLine, setStatusLine] = useState('idle — press Start to capture this meeting')
  const [latency, setLatency] = useState({ avg: 0, p95: 0 })
  const [reference, setReference] = useState('')
  const [wer, setWer] = useState<null | {
    wer: number; substitutions: number; deletions: number; insertions: number; referenceWords: number
  }>(null)

  const transcriptRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const offT = window.granola.onTranscript((e) => {
      if (e.isFinal) {
        setSegments((prev) => [...prev, { id: SEG_ID++, channel: e.channel, speaker: e.speaker, text: e.text }])
        setInterim((prev) => ({ ...prev, [e.channel]: '' }))
      } else {
        setInterim((prev) => ({ ...prev, [e.channel]: e.text }))
      }
    })
    const offS = window.granola.onStatus((s) => {
      setStatusLine(s.msg)
      setLatency({ avg: s.latencyAvg, p95: s.latencyP95 })
    })
    return () => {
      offT()
      offS()
    }
  }, [])

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight })
  }, [segments, interim])

  const fullTranscript = useMemo(
    () => segments.map((s) => `${speakerLabel(s)}: ${s.text}`).join('\n'),
    [segments]
  )

  async function toggleCapture() {
    if (capturing) {
      await window.granola.stop()
      setCapturing(false)
      return
    }
    const res = await window.granola.start()
    if (res.ok) {
      setCapturing(true)
    } else {
      setStatusLine(res.error ?? 'failed to start')
    }
  }

  async function scoreTranscript() {
    const hyp = segments.map((s) => s.text).join(' ')
    const result = await window.granola.scoreWER(reference, hyp)
    setWer(result)
  }

  function clearAll() {
    setSegments([])
    setInterim({ you: '', them: '' })
    setWer(null)
  }

  const hasInterim = interim.you || interim.them

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" data-live={capturing} />
          <h1>Granola Mini</h1>
          <span className="subtitle">system + mic transcription · macOS</span>
        </div>
        <div className="controls">
          <button className={capturing ? 'btn stop' : 'btn start'} onClick={toggleCapture}>
            {capturing ? '■ Stop' : '● Start'}
          </button>
          <button className="btn ghost" onClick={clearAll} disabled={capturing}>
            Clear
          </button>
        </div>
      </header>

      <div className="metrics">
        <div className="metric">
          <div className="metric-val">{latency.avg}<span>ms</span></div>
          <div className="metric-label">avg latency</div>
        </div>
        <div className="metric">
          <div className="metric-val">{latency.p95}<span>ms</span></div>
          <div className="metric-label">p95 latency</div>
        </div>
        <div className="metric">
          <div className="metric-val">{segments.length}</div>
          <div className="metric-label">segments</div>
        </div>
        <div className="metric wide">
          <div className="status">{statusLine}</div>
        </div>
      </div>

      <main className="transcript" ref={transcriptRef}>
        {segments.length === 0 && !hasInterim && (
          <div className="empty">
            <p>No transcript yet.</p>
            <p className="hint">
              Press <b>Start</b>, then play any audio (a YouTube video, a call) and speak into your
              mic. The far side is captured from system audio; your voice from the microphone.
            </p>
          </div>
        )}
        {segments.map((s) => (
          <div key={s.id} className={`line ${s.channel}`}>
            <span className={`who ${s.channel}`}>{speakerLabel(s)}</span>
            <span className="words">{s.text}</span>
          </div>
        ))}
        {interim.them && (
          <div className="line them interim">
            <span className="who them">Them</span>
            <span className="words">{interim.them}</span>
          </div>
        )}
        {interim.you && (
          <div className="line you interim">
            <span className="who you">You</span>
            <span className="words">{interim.you}</span>
          </div>
        )}
      </main>

      <section className="evals">
        <div className="evals-head">
          <h2>Evals · Word Error Rate</h2>
          <p>Paste a ground-truth transcript to score how accurate the capture was.</p>
        </div>
        <textarea
          placeholder="Paste the reference (ground-truth) transcript here…"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
        <div className="evals-actions">
          <button className="btn small" onClick={scoreTranscript} disabled={!reference || !segments.length}>
            Score against transcript
          </button>
          {wer && (
            <div className="wer">
              <span className="wer-score" data-good={wer.wer < 0.15}>
                WER {(wer.wer * 100).toFixed(1)}%
              </span>
              <span className="wer-detail">
                {wer.substitutions} sub · {wer.deletions} del · {wer.insertions} ins ·{' '}
                {wer.referenceWords} ref words
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
