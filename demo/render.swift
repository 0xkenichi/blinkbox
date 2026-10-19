// Renders demo/explainer.html to an MP4, frame by frame, in an offscreen
// WebKit view. Needs no screen-recording permission.
// Usage: swift demo/render.swift <url> <output.mp4> [fps]
import AVFoundation
import Cocoa
import WebKit

let width = 1920, height = 1080
let args = CommandLine.arguments
let pageURL = URL(string: args[1])!
let outURL = URL(fileURLWithPath: args[2])
let fps = args.count > 3 ? Int32(args[3])! : 30
let holdMs = 1500.0

final class Renderer: NSObject, WKNavigationDelegate {
  let window: NSWindow
  let web: WKWebView
  var writer: AVAssetWriter!
  var input: AVAssetWriterInput!
  var adaptor: AVAssetWriterInputPixelBufferAdaptor!
  var frame = 0
  var frames = 0
  let started = Date()

  override init() {
    let rect = NSRect(x: -4000, y: -4000, width: width, height: height)
    window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
    web = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height))
    super.init()
    window.contentView = web
    window.orderFrontRegardless()
    web.navigationDelegate = self
    web.load(URLRequest(url: pageURL))
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    // Give web fonts time to arrive, then read the timeline length.
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
      webView.evaluateJavaScript("totalMs()") { value, error in
        guard let total = value as? Double else { fatalError("page not ready: \(String(describing: error))") }
        self.frames = Int(((total + holdMs) / 1000.0) * Double(fps))
        print("timeline \(total) ms, \(self.frames) frames")
        self.setUpWriter()
        self.next()
      }
    }
  }

  func setUpWriter() {
    try? FileManager.default.removeItem(at: outURL)
    writer = try! AVAssetWriter(outputURL: outURL, fileType: .mp4)
    input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
      AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 12_000_000, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel],
    ])
    input.expectsMediaDataInRealTime = false
    adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
      kCVPixelBufferWidthKey as String: width,
      kCVPixelBufferHeightKey as String: height,
    ])
    writer.add(input)
    writer.startWriting()
    writer.startSession(atSourceTime: .zero)
  }

  func next() {
    if frame >= frames { return finish() }
    let ms = Double(frame) * 1000.0 / Double(fps)
    web.evaluateJavaScript("renderAt(\(ms)); 1") { _, _ in
      // Let layout and paint settle before the snapshot.
      DispatchQueue.main.async {
        let config = WKSnapshotConfiguration()
        config.rect = NSRect(x: 0, y: 0, width: width, height: height)
        config.snapshotWidth = NSNumber(value: width)
        config.afterScreenUpdates = true
        self.web.takeSnapshot(with: config) { image, error in
          guard let image, let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            fatalError("snapshot failed: \(String(describing: error))")
          }
          self.append(cg, at: CMTime(value: CMTimeValue(self.frame), timescale: fps))
          self.frame += 1
          if self.frame % (Int(fps) * 5) == 0 { print("frame \(self.frame)/\(self.frames)") }
          self.next()
        }
      }
    }
  }

  func append(_ image: CGImage, at time: CMTime) {
    while !input.isReadyForMoreMediaData { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
    var buffer: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer)
    guard let buffer else { fatalError("no pixel buffer") }
    CVPixelBufferLockBaseAddress(buffer, [])
    let ctx = CGContext(
      data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height, bitsPerComponent: 8,
      bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    CVPixelBufferUnlockBaseAddress(buffer, [])
    adaptor.append(buffer, withPresentationTime: time)
  }

  func finish() {
    input.markAsFinished()
    writer.finishWriting {
      print("done: \(outURL.path) in \(Int(Date().timeIntervalSince(self.started)))s, status \(self.writer.status.rawValue)")
      exit(self.writer.status == .completed ? 0 : 1)
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let renderer = Renderer()
app.run()
