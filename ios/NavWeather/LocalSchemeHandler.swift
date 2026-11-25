import Foundation
import WebKit

/// Serves the bundled web app (`dist/`) to WKWebView under `navweather://`.
///
/// WebKit calls `start` on the main thread for every request — the page, scripts, map tile packs and data files.
/// Files are read on a background queue so a large map or weather file never blocks the UI (the old synchronous
/// `Data(contentsOf:)` here froze scrolling and the map while big files loaded). Answers go back on the main thread,
/// and only for tasks WebKit has not stopped: answering a stopped task raises an exception and crashes the app.
class LocalSchemeHandler: NSObject, WKURLSchemeHandler {
    let baseDirectory: URL

    private let ioQueue = DispatchQueue(label: "app.wayther.scheme-io", qos: .userInitiated, attributes: .concurrent)
    private let lock = NSLock()
    private var activeTasks = Set<ObjectIdentifier>()

    init(baseDirectory: URL) {
        self.baseDirectory = baseDirectory.standardizedFileURL
        super.init()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let key = ObjectIdentifier(urlSchemeTask)
        markActive(key)

        guard let url = urlSchemeTask.request.url else {
            if takeActive(key) {
                urlSchemeTask.didFailWithError(NSError(domain: "LocalSchemeHandler", code: 400, userInfo: nil))
            }
            return
        }

        let baseDirectory = self.baseDirectory
        ioQueue.async { [weak self] in
            let answer = LocalSchemeHandler.makeAnswer(url: url, baseDirectory: baseDirectory)
            DispatchQueue.main.async {
                // WebKit may have stopped the task (page reload, map tile cancelled) while the file was read.
                guard let self, self.takeActive(key) else { return }
                urlSchemeTask.didReceive(answer.response)
                urlSchemeTask.didReceive(answer.body)
                urlSchemeTask.didFinish()
            }
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        _ = takeActive(ObjectIdentifier(urlSchemeTask))
    }

    // MARK: - Task bookkeeping

    private func markActive(_ key: ObjectIdentifier) {
        lock.lock()
        activeTasks.insert(key)
        lock.unlock()
    }

    /// Removes the task and says whether it was still active (true at most once per task).
    private func takeActive(_ key: ObjectIdentifier) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return activeTasks.remove(key) != nil
    }

    // MARK: - Reading files (background queue)

    private struct Answer {
        let response: HTTPURLResponse
        let body: Data
    }

    private static func makeAnswer(url: URL, baseDirectory: URL) -> Answer {
        var relativePath = url.path
        if relativePath.isEmpty || relativePath == "/" {
            relativePath = "/index.html"
        }
        if relativePath.hasPrefix("/") {
            relativePath = String(relativePath.dropFirst())
        }

        let fileURL = baseDirectory.appendingPathComponent(relativePath).standardizedFileURL
        let basePrefix = baseDirectory.path.hasSuffix("/") ? baseDirectory.path : baseDirectory.path + "/"
        guard fileURL.path.hasPrefix(basePrefix) || fileURL.path == baseDirectory.path else {
            return notFound(url: url)
        }

        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: fileURL.path, isDirectory: &isDir)

        // Memory-mapped: big data files are paged in by the system instead of copied up front.
        guard exists, !isDir.boolValue, let data = try? Data(contentsOf: fileURL, options: .mappedIfSafe) else {
            // SPA fallback ONLY for client-side navigation routes (e.g. /live/abc123).
            // Missing static data, assets, API paths, or any path with a file extension must return 404.
            if shouldFallbackToIndex(relativePath: relativePath, fileURL: fileURL) {
                let indexURL = baseDirectory.appendingPathComponent("index.html")
                if let indexData = try? Data(contentsOf: indexURL) {
                    return ok(url: url, data: indexData, mimeType: "text/html; charset=utf-8", cacheControl: "no-cache")
                }
            }
            return notFound(url: url)
        }

        let mimeType = mimeTypeForPath(fileURL.pathExtension)
        let cacheControl = (relativePath.hasPrefix("assets/") || relativePath.hasPrefix("data/"))
            ? "public, max-age=31536000, immutable"
            : "no-cache"
        return ok(url: url, data: data, mimeType: mimeType, cacheControl: cacheControl)
    }

    private static func shouldFallbackToIndex(relativePath: String, fileURL: URL) -> Bool {
        if relativePath.hasPrefix("data/") || relativePath == "data" { return false }
        if relativePath.hasPrefix("assets/") || relativePath == "assets" { return false }
        if relativePath.hasPrefix("api/") || relativePath == "api" { return false }
        if !fileURL.pathExtension.isEmpty { return false }
        return true
    }

    private static func ok(url: URL, data: Data, mimeType: String, cacheControl: String) -> Answer {
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": mimeType,
                "Content-Length": "\(data.count)",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": cacheControl
            ]
        )!
        return Answer(response: response, body: data)
    }

    private static func notFound(url: URL) -> Answer {
        let body = Data("404 Not Found".utf8)
        let response = HTTPURLResponse(
            url: url,
            statusCode: 404,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Length": "\(body.count)",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-cache"
            ]
        )!
        return Answer(response: response, body: body)
    }

    private static func mimeTypeForPath(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "application/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "txt": return "text/plain; charset=utf-8"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "svg": return "image/svg+xml"
        case "wasm": return "application/wasm"
        case "woff2": return "font/woff2"
        case "webmanifest": return "application/manifest+json"
        case "pbf": return "application/x-protobuf"
        case "gz", "pack", "bin": return "application/octet-stream"
        default: return "application/octet-stream"
        }
    }
}
