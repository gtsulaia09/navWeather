import UIKit
import WebKit
import CoreLocation
import AVFoundation

class ViewController: UIViewController, WKScriptMessageHandler, CLLocationManagerDelegate {
    private var webView: WKWebView!
    private let locationManager = CLLocationManager()
    private let speechSynthesizer = AVSpeechSynthesizer()
    private let selectionFeedback = UISelectionFeedbackGenerator()
    private let impactFeedback = UIImpactFeedbackGenerator(style: .medium)
    private let notificationFeedback = UINotificationFeedbackGenerator()
    private var isWatchingLocation = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        setupLocationManager()
        setupWebView()
        loadApp()
    }

    private func setupLocationManager() {
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        locationManager.distanceFilter = 2
        locationManager.allowsBackgroundLocationUpdates = true
        locationManager.pausesLocationUpdatesAutomatically = false
        locationManager.requestWhenInUseAuthorization()
    }

    private func setupWebView() {
        let contentController = WKUserContentController()
        contentController.add(self, name: "nativeLocation")
        contentController.add(self, name: "nativeHaptics")
        contentController.add(self, name: "nativeWakeLock")
        contentController.add(self, name: "nativeTTS")

        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        if let distURL = Bundle.main.url(forResource: "dist", withExtension: nil) {
            let schemeHandler = LocalSchemeHandler(baseDirectory: distURL)
            config.setURLSchemeHandler(schemeHandler, forURLScheme: "navweather")
        }

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = .clear

        view.addSubview(webView)
    }

    private func loadApp() {
        if let url = URL(string: "navweather://localhost/index.html") {
            webView.load(URLRequest(url: url))
        }
    }

    // MARK: - WKScriptMessageHandler
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }

        switch message.name {
        case "nativeLocation":
            handleLocationMessage(body)
        case "nativeHaptics":
            handleHapticsMessage(body)
        case "nativeWakeLock":
            handleWakeLockMessage(body)
        case "nativeTTS":
            handleTTSMessage(body)
        default:
            break
        }
    }

    private func handleLocationMessage(_ body: [String: Any]) {
        let action = body["action"] as? String
        if action == "startWatch" || action == "getCurrentPosition" {
            locationManager.startUpdatingLocation()
            isWatchingLocation = true
        } else if action == "stopWatch" {
            locationManager.stopUpdatingLocation()
            isWatchingLocation = false
        }
    }

    private func handleHapticsMessage(_ body: [String: Any]) {
        let kind = body["kind"] as? String
        DispatchQueue.main.async { [weak self] in
            switch kind {
            case "selection":
                self?.selectionFeedback.selectionChanged()
            case "warning":
                self?.notificationFeedback.notificationOccurred(.warning)
            case "alert":
                self?.notificationFeedback.notificationOccurred(.error)
            default:
                self?.impactFeedback.impactOccurred()
            }
        }
    }

    private func handleWakeLockMessage(_ body: [String: Any]) {
        let active = body["active"] as? Bool ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = active
        }
    }

    private func handleTTSMessage(_ body: [String: Any]) {
        guard let text = body["text"] as? String, !text.isEmpty else { return }
        let lang = body["lang"] as? String ?? "en-US"
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: lang)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        DispatchQueue.main.async { [weak self] in
            self?.speechSynthesizer.stopSpeaking(at: .immediate)
            self?.speechSynthesizer.speak(utterance)
        }
    }

    // MARK: - CLLocationManagerDelegate
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }

        let payload: [String: Any] = [
            "coords": [
                "longitude": loc.coordinate.longitude,
                "latitude": loc.coordinate.latitude,
                "accuracy": loc.horizontalAccuracy,
                "heading": loc.course >= 0 ? loc.course : NSNull(),
                "speed": loc.speed >= 0 ? loc.speed : NSNull()
            ],
            "timestamp": Int(loc.timestamp.timeIntervalSince1970 * 1000)
        ]

        if let json = try? JSONSerialization.data(withJSONObject: payload),
           let jsonString = String(data: json, encoding: .utf8) {
            let script = "window.__navweather_native_location_update && window.__navweather_native_location_update(\(jsonString));"
            DispatchQueue.main.async { [weak self] in
                self?.webView.evaluateJavaScript(script, completionHandler: nil)
            }
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let errorPayload: [String: Any] = ["code": 1]
        if let json = try? JSONSerialization.data(withJSONObject: errorPayload),
           let jsonString = String(data: json, encoding: .utf8) {
            let script = "window.__navweather_native_location_error && window.__navweather_native_location_error(\(jsonString));"
            DispatchQueue.main.async { [weak self] in
                self?.webView.evaluateJavaScript(script, completionHandler: nil)
            }
        }
    }
}
