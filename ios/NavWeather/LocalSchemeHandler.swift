import Foundation
import WebKit

class LocalSchemeHandler: NSObject, WKURLSchemeHandler {
    let baseDirectory: URL

    init(baseDirectory: URL) {
        self.baseDirectory = baseDirectory
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

        let fileURL = baseDirectory.appendingPathComponent(relativePath)

        guard let data = try? Data(contentsOf: fileURL) else {
            // Fallback for client-side routing: if file doesn't exist, try index.html
            let indexURL = baseDirectory.appendingPathComponent("index.html")
            if let indexData = try? Data(contentsOf: indexURL) {
                let response = HTTPURLResponse(
                    url: url,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: [
                        "Content-Type": "text/html; charset=utf-8",
                        "Content-Length": "\(indexData.count)",
                        "Access-Control-Allow-Origin": "*",
                        "Cache-Control": "no-cache"
                    ]
                )!
                urlSchemeTask.didReceive(response)
                urlSchemeTask.didReceive(indexData)
                urlSchemeTask.didFinish()
                return
            }

            let notFound = HTTPURLResponse(
                url: url,
                statusCode: 404,
                httpVersion: "HTTP/1.1",
                headerFields: ["Access-Control-Allow-Origin": "*"]
            )!
            urlSchemeTask.didReceive(notFound)
            urlSchemeTask.didReceive(Data("404 Not Found".utf8))
            urlSchemeTask.didFinish()
            return
        }

        let mimeType = mimeTypeForPath(fileURL.pathExtension)
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": mimeType,
                "Content-Length": "\(data.count)",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": relativePath.hasPrefix("assets/") ? "public, max-age=31536000, immutable" : "no-cache"
            ]
        )!

        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func mimeTypeForPath(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "application/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "svg": return "image/svg+xml"
        case "wasm": return "application/wasm"
        case "woff2": return "font/woff2"
        case "webmanifest": return "application/manifest+json"
        case "pbf": return "application/x-protobuf"
        default: return "application/octet-stream"
        }
    }
}
