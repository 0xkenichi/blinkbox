// Combines the rendered video, voiceover lines and music into one MP4.
// The music ducks under the voice.
// Usage: swift demo/mix.swift <video.mp4> <music.wav> <vo-dir> <offsets.txt> <out.mp4>
import AVFoundation
import Foundation

let a = CommandLine.arguments
let videoURL = URL(fileURLWithPath: a[1]), musicURL = URL(fileURLWithPath: a[2])
let voDir = URL(fileURLWithPath: a[3]), outURL = URL(fileURLWithPath: a[5])
let offsets = try! String(contentsOfFile: a[4], encoding: .utf8).split(separator: "\n").map { Double($0)! / 1000 }

func sec(_ s: Double) -> CMTime { CMTime(seconds: s, preferredTimescale: 600) }

let comp = AVMutableComposition()
let video = AVURLAsset(url: videoURL)
let vTrack = video.tracks(withMediaType: .video)[0]
let duration = video.duration
let compVideo = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
try! compVideo.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: vTrack, at: .zero)

let music = AVURLAsset(url: musicURL)
let compMusic = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
let musicLen = CMTimeMinimum(music.duration, duration)
try! compMusic.insertTimeRange(CMTimeRange(start: .zero, duration: musicLen), of: music.tracks(withMediaType: .audio)[0], at: .zero)

let compVoice = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
var spans: [(Double, Double)] = []
for (i, offset) in offsets.enumerated() {
  // Each voice line is l<N>.aiff or l<N>.mp3 in the voice folder.
  let aiff = voDir.appendingPathComponent("l\(i + 1).aiff")
  let line = AVURLAsset(url: FileManager.default.fileExists(atPath: aiff.path) ? aiff : voDir.appendingPathComponent("l\(i + 1).mp3"))
  try! compVoice.insertTimeRange(CMTimeRange(start: .zero, duration: line.duration), of: line.tracks(withMediaType: .audio)[0], at: sec(offset))
  spans.append((offset, offset + CMTimeGetSeconds(line.duration)))
}

// Music sits at 0.34, dropping to 0.14 while the voice speaks.
let musicParams = AVMutableAudioMixInputParameters(track: compMusic)
let high: Float = 0.34, low: Float = 0.14, ramp = 0.35
musicParams.setVolume(high, at: .zero)
for (s, e) in spans {
  musicParams.setVolumeRamp(fromStartVolume: high, toEndVolume: low, timeRange: CMTimeRange(start: sec(max(0, s - ramp)), duration: sec(ramp)))
  musicParams.setVolumeRamp(fromStartVolume: low, toEndVolume: high, timeRange: CMTimeRange(start: sec(e + 0.1), duration: sec(ramp * 2)))
}
let voiceParams = AVMutableAudioMixInputParameters(track: compVoice)
voiceParams.setVolume(1.0, at: .zero)
let mix = AVMutableAudioMix()
mix.inputParameters = [musicParams, voiceParams]

try? FileManager.default.removeItem(at: outURL)
let export = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetHighestQuality)!
export.outputURL = outURL
export.outputFileType = .mp4
export.audioMix = mix
let done = DispatchSemaphore(value: 0)
export.exportAsynchronously { done.signal() }
done.wait()
print("export status \(export.status.rawValue) \(export.error?.localizedDescription ?? "ok") -> \(outURL.path)")
exit(export.status == .completed ? 0 : 1)
