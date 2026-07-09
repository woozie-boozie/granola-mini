// Headless mic → Deepgram transcription, printed live in the terminal.
// The fastest way to verify the transcription pipeline end-to-end without the
// GUI (needs only Microphone permission, not Screen Recording).
//
//   npm run cli
//
import { config } from 'dotenv'
import { resolve } from 'path'
import { DeepgramStream } from '../src/main/deepgram'
import { NativeAudioSource, resolveHelper } from '../src/main/audioSource'

config({ path: resolve(process.cwd(), '.env') })

const key = process.env.DEEPGRAM_API_KEY
if (!key) {
  console.error('✗ DEEPGRAM_API_KEY missing — add it to .env (see .env.example)')
  process.exit(1)
}

const bin = resolveHelper('miccapture')
if (!bin) {
  console.error('✗ miccapture not built — run `npm run build:native`')
  process.exit(1)
}

console.error('● listening on your microphone — speak, Ctrl-C to stop\n')

const stream = new DeepgramStream(
  key,
  'you',
  {
    onTranscript: (e) => {
      if (e.isFinal) process.stdout.write(`\r${e.text}\n`)
      else process.stdout.write(`\r\x1b[2m${e.text}\x1b[0m`)
    },
    onStatus: (msg) => console.error(`\x1b[2m[${msg}]\x1b[0m`),
    onLatency: (ms) => { /* tracked in the GUI; ignored here */ }
  },
  { diarize: false, model: process.env.DEEPGRAM_MODEL ?? 'nova-2' }
)

const mic = new NativeAudioSource(bin, {
  onPCM: (b) => stream.send(b),
  onLog: (line) => console.error(`\x1b[2m[mic] ${line}\x1b[0m`)
})

mic.start()
process.on('SIGINT', () => {
  mic.stop()
  stream.close()
  console.error('\n○ stopped')
  process.exit(0)
})
