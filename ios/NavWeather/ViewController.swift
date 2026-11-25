import UIKit
import WebKit
import CoreLocation
import AVFoundation

@MainActor
class ViewController: UIViewController, WKScriptMessageHandler, CLLocationManagerDelegate, AVSpeechSynthesizerDelegate {
    private var webView: WKWebView!
    private let locationManager = CLLocationManager()
    private let speechSynthesizer = AVSpeechSynthesizer()
    private let selectionFeedback = UISelectionFeedbackGenerator()
    private let impactFeedback = UIImpactFeedbackGenerator(style: .medium)
    private let notificationFeedback = UINotificationFeedbackGenerator()
    private var isWatchingLocation = false
    private var utteranceIds: [ObjectIdentifier: Int] = [:]
    /// AVAudioSession activation can take a noticeable time; never do it on the main thread.
    private let audioQueue = DispatchQueue(label: "app.wayther.audio-session", qos: .userInitiated)
    /// The prompt waiting for the audio session to come up. A newer prompt replaces it, as it interrupts a spoken one.
    private var pendingUtterance: AVSpeechUtterance?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        speechSynthesizer.delegate = self
        setupLocationManager()
        setupWebView()
        loadApp()
    }

    private func setupLocationManager() {
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        locationManager.activityType = .automotiveNavigation
        locationManager.distanceFilter = 2.0
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
        #if DEBUG
        // Lets Safari › Develop › <iPhone> inspect and profile the page in debug builds.
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        #endif

        view.addSubview(webView)
    }

    private func loadApp() {
        if let url = URL(string: "navweather://localhost/index.html") {
            webView.load(URLRequest(url: url))
        }
    }

    // MARK: - WKScriptMessageHandler
    // WebKit delivers script messages on the main thread; handling them right here (instead of reading the
    // main-actor WKScriptMessage from a nonisolated method and hopping through a Task) is what Swift expects.
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
            let status = locationManager.authorizationStatus
            if status == .denied || status == .restricted {
                sendLocationError(code: 1)
                return
            }
            if status == .notDetermined {
                locationManager.requestWhenInUseAuthorization()
            }
            locationManager.startUpdatingLocation()
            isWatchingLocation = true
        } else if action == "stopWatch" {
            locationManager.stopUpdatingLocation()
            isWatchingLocation = false
        }
    }

    private func handleHapticsMessage(_ body: [String: Any]) {
        let kind = body["kind"] as? String
        switch kind {
        case "selection":
            selectionFeedback.selectionChanged()
        case "warning":
            notificationFeedback.notificationOccurred(.warning)
        case "alert":
            notificationFeedback.notificationOccurred(.error)
        default:
            impactFeedback.impactOccurred()
        }
    }

    private func handleWakeLockMessage(_ body: [String: Any]) {
        let active = body["active"] as? Bool ?? false
        UIApplication.shared.isIdleTimerDisabled = active
    }

    private func handleTTSMessage(_ body: [String: Any]) {
        let action = body["action"] as? String ?? "speak"
        if action == "cancel" {
            dropPendingUtterance()
            speechSynthesizer.stopSpeaking(at: .immediate)
            deactivateAudioSessionIfIdle()
            return
        }

        let utteranceId = body["id"] as? Int
        guard let text = body["text"] as? String, !text.isEmpty else {
            if let utteranceId {
                notifyTtsEnd(id: utteranceId)
            }
            return
        }

        let lang = body["lang"] as? String ?? "en-US"
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: lang)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate

        if speechSynthesizer.isSpeaking {
            speechSynthesizer.stopSpeaking(at: .immediate)
        }
        dropPendingUtterance()
        if let utteranceId {
            utteranceIds[ObjectIdentifier(utterance)] = utteranceId
        }
        pendingUtterance = utterance
        audioQueue.async { [weak self] in
            try? AVAudioSession.sharedInstance().setActive(true)
            DispatchQueue.main.async { [weak self] in
                guard let self = self, let next = self.pendingUtterance else { return }
                self.pendingUtterance = nil
                self.speechSynthesizer.speak(next)
            }
        }
    }

    /// Forgets a prompt that never reached the synthesizer, telling the page it is over.
    private func dropPendingUtterance() {
        guard let dropped = pendingUtterance else { return }
        pendingUtterance = nil
        if let id = utteranceIds.removeValue(forKey: ObjectIdentifier(dropped)) {
            notifyTtsEnd(id: id)
        }
    }

    /// Gives the audio back to other apps (music un-ducks) once nothing is being spoken.
    private func deactivateAudioSessionIfIdle() {
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard let self, !self.speechSynthesizer.isSpeaking, self.pendingUtterance == nil else { return }
            self.audioQueue.async {
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            }
        }
    }

    private func notifyTtsEnd(id: Int) {
        let script = "window.__navweather_native_tts_end && window.__navweather_native_tts_end(\(id));"
        webView?.evaluateJavaScript(script, completionHandler: nil)
    }

    private func sendLocationError(code: Int) {
        let errorPayload: [String: Any] = ["code": code]
        if let json = try? JSONSerialization.data(withJSONObject: errorPayload),
           let jsonString = String(data: json, encoding: .utf8) {
            let script = "window.__navweather_native_location_error && window.__navweather_native_location_error(\(jsonString));"
            webView?.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    // MARK: - AVSpeechSynthesizerDelegate
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let key = ObjectIdentifier(utterance)
        Task { @MainActor in
            if let id = self.utteranceIds.removeValue(forKey: key) {
                self.notifyTtsEnd(id: id)
            }
            self.deactivateAudioSessionIfIdle()
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let key = ObjectIdentifier(utterance)
        Task { @MainActor in
            if let id = self.utteranceIds.removeValue(forKey: key) {
                self.notifyTtsEnd(id: id)
            }
            self.deactivateAudioSessionIfIdle()
        }
    }

    // MARK: - CLLocationManagerDelegate
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            guard self.isWatchingLocation else { return }
            if status == .denied || status == .restricted {
                self.locationManager.stopUpdatingLocation()
                self.isWatchingLocation = false
                self.sendLocationError(code: 1)
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }

        let payload: [String: Any] = [
            "coords": [
                "longitude": loc.coordinate.longitude,
                "latitude": loc.coordinate.latitude,
                "accuracy": loc.horizontalAccuracy,
                "heading": loc.course >= 0 ? loc.course as Any : NSNull(),
                "speed": loc.speed >= 0 ? loc.speed as Any : NSNull()
            ],
            "timestamp": Int(loc.timestamp.timeIntervalSince1970 * 1000)
        ]

        if let json = try? JSONSerialization.data(withJSONObject: payload),
           let jsonString = String(data: json, encoding: .utf8) {
            let script = "window.__navweather_native_location_update && window.__navweather_native_location_update(\(jsonString));"
            Task { @MainActor in
                self.webView?.evaluateJavaScript(script, completionHandler: nil)
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // W3C GeolocationPositionError codes: 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT.
        let code: Int
        if let clError = error as? CLError {
            switch clError.code {
            case .denied:
                code = 1
            default:
                code = 2
            }
        } else {
            code = 2
        }

        Task { @MainActor in
            self.sendLocationError(code: code)
        }
    }
}
