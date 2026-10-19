// Synthesizes a light ambient background track (pad, arpeggio, bass) to a WAV.
// Original and generated locally, so it is free to use anywhere.
// Usage: swift demo/music.swift <output.wav> <seconds>
import AVFoundation
import Foundation

let out = URL(fileURLWithPath: CommandLine.arguments[1])
let seconds = Double(CommandLine.arguments[2])!
let sr = 44_100.0
let n = Int(seconds * sr)
var left = [Float](repeating: 0, count: n)
var right = [Float](repeating: 0, count: n)

func hz(_ midi: Double) -> Double { 440 * pow(2, (midi - 69) / 12) }

// Cmaj9 → Am9 → Fmaj7 → G6, two bars each at 70 bpm.
let chords: [[Double]] = [
  [48, 55, 59, 62, 64],
  [45, 52, 55, 59, 60],
  [41, 48, 52, 55, 60],
  [43, 50, 55, 59, 64],
]
let beat = 60.0 / 70.0
let chordLen = beat * 8

func add(_ i: Int, _ l: Float, _ r: Float) {
  guard i >= 0, i < n else { return }
  left[i] += l
  right[i] += r
}

// Pad: detuned soft tones with slow swells, one per chord.
var t0 = 0.0
var c = 0
while t0 < seconds {
  let notes = chords[c % chords.count]
  for (k, m) in notes.enumerated() {
    let f = hz(m + 12)
    let pan = Float(k) / Float(notes.count - 1)
    let start = Int(t0 * sr), len = Int((chordLen + 1.5) * sr)
    for j in 0..<len {
      let t = Double(j) / sr
      let env = min(1, t / 1.6) * min(1, max(0, (chordLen + 1.5 - t) / 1.5))
      let s = sin(2 * .pi * f * t) + 0.35 * sin(2 * .pi * f * 1.004 * t) + 0.12 * sin(2 * .pi * f * 2 * t)
      let v = Float(s * env * 0.035)
      add(start + j, v * (1 - pan * 0.6), v * (0.4 + pan * 0.6))
    }
  }
  // Bass: root note, soft and round.
  let root = hz(notes[0] - 12)
  let bStart = Int(t0 * sr), bLen = Int(chordLen * sr)
  for j in 0..<bLen {
    let t = Double(j) / sr
    let env = min(1, t / 0.08) * exp(-t * 0.35)
    let v = Float((sin(2 * .pi * root * t) + 0.2 * sin(4 * .pi * root * t)) * env * 0.09)
    add(bStart + j, v, v)
  }
  // Arpeggio: plucked bell tones on eighth notes, with a light echo.
  let arp = [notes[1], notes[2], notes[3], notes[4], notes[3], notes[2], notes[3], notes[4]].map { $0 + 12 }
  for step in 0..<16 {
    let ts = t0 + Double(step) * beat / 2
    if ts >= seconds { break }
    let f = hz(arp[step % arp.count])
    let pan: Float = step % 2 == 0 ? 0.35 : 0.65
    for echo in 0..<3 {
      let gain = [1.0, 0.35, 0.12][echo]
      let start = Int((ts + Double(echo) * 0.32) * sr), len = Int(1.6 * sr)
      for j in 0..<len {
        let t = Double(j) / sr
        let env = min(1, t / 0.004) * exp(-t * 3.2)
        let v = Float((sin(2 * .pi * f * t) + 0.25 * sin(2 * .pi * f * 3 * t) * exp(-t * 6)) * env * 0.05 * gain)
        let p = echo % 2 == 0 ? pan : 1 - pan
        add(start + j, v * (1 - p), v * p)
      }
    }
  }
  t0 += chordLen
  c += 1
}

// Gentle low-pass, fades, and normalization to a quiet bed level.
var lp: (Float, Float) = (0, 0)
let a: Float = 0.18
var peak: Float = 0
for i in 0..<n {
  lp.0 += a * (left[i] - lp.0)
  lp.1 += a * (right[i] - lp.1)
  let t = Double(i) / sr
  let fade = Float(min(1, t / 2.5) * min(1, max(0, (seconds - t) / 3.5)))
  left[i] = lp.0 * fade
  right[i] = lp.1 * fade
  peak = max(peak, abs(left[i]), abs(right[i]))
}
let scale = 0.6 / max(peak, 0.0001)

let format = AVAudioFormat(standardFormatWithSampleRate: sr, channels: 2)!
let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(n))!
buffer.frameLength = AVAudioFrameCount(n)
for i in 0..<n {
  buffer.floatChannelData![0][i] = left[i] * scale
  buffer.floatChannelData![1][i] = right[i] * scale
}
try? FileManager.default.removeItem(at: out)
do {
  // Scoped so the file is closed and its header written before exit.
  let file = try AVAudioFile(forWriting: out, settings: format.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
  try file.write(from: buffer)
}
print("wrote \(out.path), \(seconds)s")
