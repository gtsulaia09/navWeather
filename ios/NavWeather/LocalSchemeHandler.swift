import Foundation
import WebKit

class LocalSchemeHandler: NSObject, WKURLSchemeHandler {
    let baseDirectory: URL

    init(baseDirectory: URL) {
        self.baseDirectory = baseDirectory.standardizedFileURL
        super.init()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(NSError(domain: "LocalSchemeHandler", code: 400, userInfo: nil))
            return
        }

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
            respondNotFound(url: url, task: urlSchemeTask)
            return
        }

        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: fileURL.path, isDirectory: &isDir)

        guard exists, !isDir.boolValue, let data = try? Data(contentsOf: fileURL) else {
            // SPA fallback ONLY for client-side navigation routes (e.g. /live/abc123).
            // Missing static data, assets, API paths, or any path with a file extension must return 404.
            if shouldFallbackToIndex(relativePath: relativePath, fileURL: fileURL) {
                let indexURL = baseDirectory.appendingPathComponent("index.html")
                if let indexData = try? Data(contentsOf: indexURL) {
                    respondOK(
                        url: url,
                        data: indexData,
                        mimeType: "text/html; charset=utf-8",
                        cacheControl: "no-cache",
                        task: urlSchemeTask
                    )
                    return
                }
            }

            respondNotFound(url: url, task: urlSchemeTask)
            return
        }

        let mimeType = mimeTypeForPath(fileURL.pathExtension)
        let cacheControl = (relativePath.hasPrefix("assets/") || relativePath.hasPrefix("data/"))
            ? "public, max-age=31536000, immutable"
            : "no-cache"

        respondOK(
            url: url,
            data: data,
            mimeType: mimeType,
            cacheControl: cacheControl,
            task: urlSchemeTask
        )
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func shouldFallbackToIndex(relativePath: String, fileURL: URL) -> Bool {
        if relativePath.hasPrefix("data/") || relativePath == "data" { return false }
        if relativePath.hasPrefix("assets/") || relativePath == "assets" { return false }
        if relativePath.hasPrefix("api/") || relativePath == "api" { return false }
        if !fileURL.pathExtension.isEmpty { return false }
        return true
    }

    private func respondOK(url: URL, data: Data, mimeType: String, cacheControl: String, task: WKURLSchemeTask) {
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
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    private func respondNotFound(url: URL, task: WKURLSchemeTask) {
        let body = Data("404 Not Found".utf8)
        let notFound = HTTPURLResponse(
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
        task.didReceive(notFound)
        task.didReceive(body)
        task.didFinish()
    }

    private func mimeTypeForPath(_ ext: String) -> String {
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
