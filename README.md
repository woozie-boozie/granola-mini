# Granola Mini

The transcription stack of a meeting app, built end-to-end:

- **Native system-audio capture on macOS** (ScreenCaptureKit) — the far side of a call, straight out of the OS
- **Native microphone capture** (AVAudioEngine) — your voice
- **Two transcription backends behind one interface** — **Deepgram** (cloud streaming) or **whisper.cpp** (fully on-device), switchable live in the UI
- **Speaker attribution** — mic = "You", system = "Them", with Deepgram diarisation splitting multiple far-side speakers
- **Live transcript UI** in Electron + React
- **AI meeting notes** — one click turns the transcript into a Granola-style summary (TL;DR · key points · decisions · action items) with Claude, closing the loop from capture → transcribe → **notes**
- **Evals** — Word Error Rate against a reference transcript, plus rolling latency (avg + p95)

## Demo

**See it work in ~2 minutes:** `npm install && npm run dev`, hit **Start**, play any audio and talk over it — both channels (mic + system audio) transcribe live, with speaker attribution and WER/latency scoring. Full steps in [Setup](#setup) below.

**▶ [Watch the 2-minute demo video](https://www.loom.com/share/4e9cbb4005264c168d890e80c5932d49)** — capture, live transcription, backend switch, notes, and evals.

## Implementation

| Capability | Where |
| --- | --- |
| Audio capture on macOS | `native/SystemAudioCapture.swift` (ScreenCaptureKit) + `native/MicCapture.swift` (AVAudioEngine) |
| Echo cancellation | Next step — needs software AEC using the captured system audio as the reference (naive AVAudioEngine Voice Processing I/O does AEC but ducks the far-side output we capture; headphones sidestep the bleed today) |
| Connections to transcription providers/models | `src/main/deepgram.ts` (cloud streaming) — one socket per channel |
| Local transcription models | ✅ `src/main/whisper.ts` — on-device via `whisper.cpp` (`whisper-server`, model resident on the GPU); swap live in the UI |
| Diarisation / attribution | mic = "You", system = "Them"; Deepgram `diarize` splits far-side speakers |
| Transcription UI/UX on desktop | `src/renderer` — Electron + React live transcript, Cloud/Local toggle |
| Logging and evals | `src/main/evals.ts` — Word Error Rate + streaming-latency (avg/p95) |

Both backends implement the same tiny interface (`send(pcm)` / `close()`), so the audio-capture layer is provider-agnostic — the PCM-over-stdout pipeline doesn't know which one is running.

Latency is measured as **true lag behind real-time** (Deepgram's audio timestamps vs wall clock), not a round-trip fudge.

## Architecture

```
 ┌─────────────────────┐   PCM (16k mono)   ┌──────────────────┐   ws   ┌──────────┐
 │ SystemAudioCapture   │ ─────────────────▶ │  Electron main    │ ─────▶ │ Deepgram │  "them" (+ diarise)
 │ .swift (SCKit)       │      stdout        │  (Node)           │        └──────────┘
 └─────────────────────┘                     │                   │        ┌──────────┐
 ┌─────────────────────┐   PCM (16k mono)    │  DeepgramStream×2  │ ─────▶ │ Deepgram │  "you"
 │ MicCapture.swift     │ ─────────────────▶ │  evals (WER/latency)│       └──────────┘
 │ (AVAudioEngine)      │      stdout        └─────────┬─────────┘
 └─────────────────────┘                           IPC │ transcript + status
                                              ┌─────────▼─────────┐
                                              │ React renderer     │  live transcript · metrics · evals
                                              └───────────────────┘
```

The native helpers write raw PCM to **stdout** and logs to **stderr**, so Node just pipes stdout into whichever backend is selected — **Deepgram** over a WebSocket (cloud) or a resident **whisper.cpp** `whisper-server` (local). Same `send(pcm)` interface either way.

## Setup

```bash
npm install
npm run build:native          # compiles the two Swift helpers
cp .env.example .env          # then paste your Deepgram key
```

Get a free key at [console.deepgram.com](https://console.deepgram.com). For the **Generate notes** button, also add `ANTHROPIC_API_KEY` to `.env` ([console.anthropic.com](https://console.anthropic.com)) — optional; capture, transcription, and evals all work without it.

**Optional — local (on-device) transcription** with whisper.cpp:

```bash
brew install whisper-cpp      # provides the `whisper-server` binary
npm run download-model        # fetches ggml-base.en (~148MB, gitignored)
```

Then pick **Local · Whisper** in the app instead of **Cloud · Deepgram** — no API key or network required; the model runs on your GPU.

## Run

**Full app (system + mic + UI):**
```bash
npm run dev
```
Press **Start**. macOS will prompt for **Microphone** and **Screen & System Audio Recording** — click Allow (this is the same permission Granola itself requires). Play any audio and speak; both sides transcribe live. Use the **Cloud · Deepgram / Local · Whisper** toggle to switch backends and watch the latency change — cloud streams in ~200ms; the local model windows audio into chunks, so it runs a few seconds behind but never leaves your machine.

**Quick pipeline check (mic only, no GUI):**
```bash
npm run cli
```
Only needs Microphone permission — the fastest way to confirm the transcription path works.

## Notes / next steps

- **Echo cancellation:** cancel the far-side bleed from the mic in software, using the captured system audio as the reference signal. AVAudioEngine's Voice Processing I/O does hardware AEC but on macOS it ducks the system output — starving the very channel this app captures — so it needs a custom reference-based canceller rather than the built-in unit. Headphones sidestep the bleed today.
- **Windows:** the same architecture with a WASAPI loopback helper in place of ScreenCaptureKit.
- **Local diarisation:** the local path is one speaker per channel today; a tinydiarize model would split multiple far-side speakers on-device the way Deepgram does in the cloud.
- **Streaming local model:** whisper is windowed here (~4.5s chunks); a VAD-gated or `whisper-stream` approach would cut the local latency.

Built by Akhil Madan · [keedastudios.com](https://keedastudios.com)
