// SystemAudioCapture.swift
//
// A standalone macOS helper that captures *system audio* (everything the machine
// is playing — i.e. the other participants in a call) using ScreenCaptureKit,
// resamples it to 16 kHz mono, and streams raw 16-bit little-endian PCM to stdout.
//
// This is the hard 20% of a meeting-transcription app: getting the far-side audio
// out of the OS. The mic is easy; the loopback is not. Downstream, Node pipes this
// PCM straight into a streaming speech-to-text provider.
//
// Logs go to stderr so stdout stays a clean PCM stream.
//
// Build:  swiftc -O SystemAudioCapture.swift -o systemaudio
// Run:    ./systemaudio            (first run prompts for Screen Recording permission)

import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia

let TARGET_SAMPLE_RATE: Double = 16_000
let TARGET_CHANNELS: AVAudioChannelCount = 1

func log(_ msg: String) {
    FileHandle.standardError.write(Data(("[systemaudio] " + msg + "\n").utf8))
}

final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var converter: AVAudioConverter?
    private var targetFormat: AVAudioFormat?
    private let sampleQueue = DispatchQueue(label: "com.keeda.granolamini.audio")

    func start() async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false)
            guard let display = content.displays.first else {
                log("no display available; cannot start capture")
                exit(1)
            }

            // Audio-only: filter on a display but we never read the video frames.
            let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])

            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.excludesCurrentProcessAudio = true      // don't capture our own output
            config.sampleRate = Int(TARGET_SAMPLE_RATE)
            config.channelCount = Int(TARGET_CHANNELS)
            // Keep the (unused) video path cheap.
            config.width = 2
            config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            config.queueDepth = 6

            let stream = SCStream(filter: filter, configuration: config, delegate: self)
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
            // A video output is required for the stream to run on some macOS versions.
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
            self.stream = stream

            try await stream.startCapture()
            log("capture started @ \(Int(TARGET_SAMPLE_RATE))Hz mono — streaming PCM to stdout")
        } catch {
            log("failed to start capture: \(error.localizedDescription)")
            log("→ grant Screen Recording permission in System Settings › Privacy & Security, then retry.")
            exit(2)
        }
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid else { return }
        guard let pcm = pcmBuffer(from: sampleBuffer) else { return }
        writeInt16PCM(pcm)
    }

    // Convert a CMSampleBuffer of audio into an AVAudioPCMBuffer at our target format.
    private func pcmBuffer(from sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let fmtDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(fmtDesc)
        else { return nil }

        var asbd = asbdPtr.pointee
        guard let inputFormat = AVAudioFormat(streamDescription: &asbd) else { return nil }

        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard frames > 0,
              let inBuffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: frames)
        else { return nil }
        inBuffer.frameLength = frames

        // Copy CMSampleBuffer bytes into the input AVAudioPCMBuffer.
        CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer, at: 0, frameCount: Int32(frames),
            into: inBuffer.mutableAudioBufferList)

        // Lazily build a converter to 16 kHz mono Int16.
        if targetFormat == nil {
            targetFormat = AVAudioFormat(
                commonFormat: .pcmFormatInt16, sampleRate: TARGET_SAMPLE_RATE,
                channels: TARGET_CHANNELS, interleaved: true)
        }
        guard let outFormat = targetFormat else { return nil }

        if converter == nil || converter?.inputFormat != inputFormat {
            converter = AVAudioConverter(from: inputFormat, to: outFormat)
        }
        guard let converter = converter else { return nil }

        let ratio = outFormat.sampleRate / inputFormat.sampleRate
        let outCapacity = AVAudioFrameCount(Double(frames) * ratio + 1024)
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: outCapacity)
        else { return nil }

        var fed = false
        var convError: NSError?
        converter.convert(to: outBuffer, error: &convError) { _, statusPtr in
            if fed {
                statusPtr.pointee = .noDataNow
                return nil
            }
            fed = true
            statusPtr.pointee = .haveData
            return inBuffer
        }
        if let convError { log("convert error: \(convError.localizedDescription)"); return nil }
        return outBuffer
    }

    private func writeInt16PCM(_ buffer: AVAudioPCMBuffer) {
        guard let channelData = buffer.int16ChannelData else { return }
        let count = Int(buffer.frameLength)
        guard count > 0 else { return }
        let ptr = channelData[0]
        let data = Data(bytes: ptr, count: count * MemoryLayout<Int16>.size)
        FileHandle.standardOutput.write(data)
    }

    // MARK: SCStreamDelegate
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("stream stopped: \(error.localizedDescription)")
        exit(3)
    }
}

// Entry point
let capture = SystemAudioCapture()
Task { await capture.start() }
signal(SIGINT) { _ in log("interrupted"); exit(0) }
RunLoop.main.run()
