#!/usr/bin/env bash
# Compile the two native macOS audio-capture helpers.
set -euo pipefail
cd "$(dirname "$0")/../native"

echo "→ building systemaudio (ScreenCaptureKit)…"
swiftc -O SystemAudioCapture.swift -o systemaudio

echo "→ building miccapture (AVAudioEngine)…"
swiftc -O MicCapture.swift -o miccapture

echo "✓ native helpers built: native/systemaudio, native/miccapture"
