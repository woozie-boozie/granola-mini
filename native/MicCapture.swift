// MicCapture.swift
//
// Captures the local microphone (your voice) via AVAudioEngine, resamples to
// 16 kHz mono, and streams raw 16-bit little-endian PCM to stdout. Pairs with
// SystemAudioCapture.swift (the far side of the call) so the app has both halves
// of a meeting.
//
// Logs → stderr, PCM → stdout.
//
// Build:  swiftc -O MicCapture.swift -o miccapture
// Run:    ./miccapture      (first run prompts for Microphone permission)

import Foundation
import AVFoundation

let TARGET_SAMPLE_RATE: Double = 16_000

func log(_ msg: String) {
    FileHandle.standardError.write(Data(("[miccapture] " + msg + "\n").utf8))
}

final class MicCapture {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: TARGET_SAMPLE_RATE,
        channels: 1, interleaved: true)!

    func start() {
        let input = engine.inputNode
        // Note: AVAudioEngine's Voice Processing I/O (setVoiceProcessingEnabled) does
        // acoustic echo cancellation, but on macOS it takes over the shared audio device
        // and ducks the system output — which mutes and starves the far-side channel this
        // app captures via ScreenCaptureKit. Proper AEC for a meeting app needs software
        // cancellation using the captured system audio as the reference signal; see README.
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else {
            log("no microphone input available"); exit(1)
        }
        converter = AVAudioConverter(from: inputFormat, to: targetFormat)

        input.installTap(onBus: 0, bufferSize: 1600, format: inputFormat) { [weak self] buffer, _ in
            self?.handle(buffer)
        }

        do {
            try engine.start()
            log("mic capture started (\(Int(inputFormat.sampleRate))Hz → \(Int(TARGET_SAMPLE_RATE))Hz mono)")
        } catch {
            log("failed to start engine: \(error.localizedDescription)")
            log("→ grant Microphone permission in System Settings › Privacy & Security, then retry.")
            exit(2)
        }
    }

    private func handle(_ inBuffer: AVAudioPCMBuffer) {
        guard let converter else { return }
        let ratio = TARGET_SAMPLE_RATE / inBuffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(inBuffer.frameLength) * ratio + 512)
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity)
        else { return }

        var fed = false
        var err: NSError?
        converter.convert(to: outBuffer, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return inBuffer
        }
        if let err { log("convert error: \(err.localizedDescription)"); return }

        guard let ch = outBuffer.int16ChannelData, outBuffer.frameLength > 0 else { return }
        let data = Data(bytes: ch[0], count: Int(outBuffer.frameLength) * MemoryLayout<Int16>.size)
        FileHandle.standardOutput.write(data)
    }
}

let mic = MicCapture()
mic.start()
signal(SIGINT) { _ in log("interrupted"); exit(0) }
RunLoop.main.run()
