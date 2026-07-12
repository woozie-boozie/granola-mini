// Transcription evals: Word Error Rate (WER) via word-level edit distance.
//
// WER = (substitutions + deletions + insertions) / reference_word_count
// It's the standard metric for judging a speech-to-text system, and the JD
// explicitly asks for "logging and evals so we know whether all this is working."

function normalise(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[.,!?;:"“”'`()\[\]]/g, '')
    .split(/\s+/)
    .filter(Boolean)
}

export interface WerResult {
  wer: number
  substitutions: number
  deletions: number
  insertions: number
  referenceWords: number
  hits: number
}

export function wordErrorRate(reference: string, hypothesis: string): WerResult {
  const ref = normalise(reference)
  const hyp = normalise(hypothesis)
  const n = ref.length
  const m = hyp.length

  // Levenshtein DP over words, tracking operation counts via backpointers.
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 0; i <= n; i++) d[i][0] = i
  for (let j = 0; j <= m; j++) d[0][j] = j

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1
      d[i][j] = Math.min(
        d[i - 1][j] + 1,        // deletion
        d[i][j - 1] + 1,        // insertion
        d[i - 1][j - 1] + cost  // substitution / match
      )
    }
  }

  // Backtrace to count each operation type.
  let i = n, j = m
  let sub = 0, del = 0, ins = 0, hits = 0
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1] && d[i][j] === d[i - 1][j - 1]) {
      hits++; i--; j--
    } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) {
      sub++; i--; j--
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      del++; i--
    } else {
      ins++; j--
    }
  }

  return {
    wer: n === 0 ? 0 : (sub + del + ins) / n,
    substitutions: sub,
    deletions: del,
    insertions: ins,
    referenceWords: n,
    hits
  }
}

// Rolling latency tracker: how long after audio is sent does a final
// transcript come back. A crude but honest streaming-latency signal.
export class LatencyTracker {
  private samples: number[] = []
  private readonly cap = 50

  add(ms: number): void {
    if (ms <= 0 || ms > 10_000) return
    this.samples.push(ms)
    if (this.samples.length > this.cap) this.samples.shift()
  }

  /** Clear samples — called on each new capture so provider switches read cleanly. */
  reset(): void {
    this.samples = []
  }

  get average(): number {
    if (!this.samples.length) return 0
    return Math.round(this.samples.reduce((a, b) => a + b, 0) / this.samples.length)
  }

  get p95(): number {
    if (!this.samples.length) return 0
    const sorted = [...this.samples].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  }
}
