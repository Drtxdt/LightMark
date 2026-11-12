import AppKit
import CoreServices
import UniformTypeIdentifiers

let candidate = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
for path in CommandLine.arguments.dropFirst(2) {
    let note = URL(fileURLWithPath: path)
    guard let type = UTType(filenameExtension: note.pathExtension) else { fatalError("No type for \(path)") }
    let status = LSSetDefaultRoleHandlerForContentType(type.identifier as CFString, .all, "com.lightmark.desktop" as CFString)
    guard status == noErr else { fatalError("Default handler failed: \(status)") }
    guard NSWorkspace.shared.urlForApplication(toOpen: note)?.standardizedFileURL == candidate else {
        fatalError("Launch Services did not select candidate for \(path)")
    }
}
