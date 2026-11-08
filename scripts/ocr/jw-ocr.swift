// Prints the words in a picture with Apple's Vision. Built for the macOS packages; needs no permission.
import AppKit
import Foundation
import Vision

// The picture named on the command line.
guard CommandLine.arguments.count > 1,
      let image = NSImage(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])),
      let picture = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(1) }
// Chinese and English, as accurately as Vision goes.
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
do {
    try VNImageRequestHandler(cgImage: picture).perform([request])
} catch {
    exit(1)
}
// One line per piece of text.
for observation in request.results ?? [] {
    if let best = observation.topCandidates(1).first { print(best.string) }
}
