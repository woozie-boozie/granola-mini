#!/usr/bin/env bash
# Downloads a whisper.cpp GGML model for local (on-device) transcription.
# Default: base.en (~148MB, good accuracy/size balance). Override: ./download-model.sh small.en
set -euo pipefail

MODEL="${1:-base.en}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/models"
FILE="$DIR/ggml-${MODEL}.bin"
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL}.bin"

mkdir -p "$DIR"
if [ -f "$FILE" ]; then
  echo "✓ model already present: $FILE"
  exit 0
fi

echo "↓ downloading ggml-${MODEL}.bin from HuggingFace…"
curl -L --fail --progress-bar "$URL" -o "$FILE"
echo "✓ saved: $FILE"
