# Granola Mini

The transcription stack of a meeting app, built end-to-end:

- **Native system-audio capture on macOS** (ScreenCaptureKit) — the far side of a call, straight out of the OS
- **Native microphone capture** (AVAudioEngine) — your voice
- **Streaming speech-to-text** via Deepgram, one connection per channel
- **Speaker attribution** — mic = "You", system = "Them", with Deepgram diarisation splitting multiple far-side speakers
- **Live transcript UI** in Electron + React
- **Evals** — Word Error Rate against a reference transcript, plus rolling latency (avg + p95)

## Demo

> 📹 **[90-second demo video](DEMO_LINK)** — live two-channel transcription (mic + system audio), speaker attribution, and WER scoring.

_(Replace `DEMO_LINK` with the hosted recording.)_

## Implementation

| Capability | Where |
| --- | --- |
| Audio capture on macOS | `native/SystemAudioCapture.swift` (ScreenCaptureKit) + `native/MicCapture.swift` (AVAudioEngine) |
| Connections to transcription providers | `src/main/deepgram.ts` — Deepgram streaming, one socket per channel |
| Diarisation / attribution | mic = "You", system = "Them"; Deepgram `diarize` splits far-side speakers |
| Transcription UI/UX on desktop | `src/renderer` — Electron + React live transcript |
| Logging and evals | `src/main/evals.ts` — Word Error Rate + streaming-latency (avg/p95) |
| Local transcription models | model-agnostic PCM-over-stdout interface; swap Deepgram for `whisper.cpp` (next step, not yet built) |
| Echo cancellation | noted next step — route the mic tap through AVAudioEngine's voice-processing I/O unit |

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

The native helpers write raw PCM to **stdout** and logs to **stderr**, so Node just pipes stdout into the transcription provider — the same shape you'd use with a local model (whisper.cpp) instead of a cloud provider.

## Setup

```bash
npm install
npm run build:native          # compiles the two Swift helpers
cp .env.example .env          # then paste your Deepgram key
```

Get a free key at [console.deepgram.com](https://console.deepgram.com).

## Run

**Full app (system + mic + UI):**
```bash
npm run dev
```
Press **Start**. macOS will prompt for **Microphone** and **Screen & System Audio Recording** — click Allow (this is the same permission Granola itself requires). Play any audio and speak; both sides transcribe live.

**Quick pipeline check (mic only, no GUI):**
```bash
npm run cli
```
Only needs Microphone permission — the fastest way to confirm the transcription path works.

## Notes / next steps

- **Local model:** swap `DeepgramStream` for a `whisper.cpp` process to get fully on-device transcription (the "local transcription models" bullet). The PCM-over-stdout interface is already model-agnostic.
- **Echo cancellation:** the mic tap can run through `AVAudioEngine`'s voice-processing I/O unit to cancel far-side bleed.
- **Windows:** the same architecture with a WASAPI loopback helper in place of ScreenCaptureKit.

Built by Akhil Madan · [keedastudios.com](https://keedastudios.com)
