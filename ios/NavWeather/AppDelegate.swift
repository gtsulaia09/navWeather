import UIKit
import AVFoundation
import CarPlay

/// Shared runtime owning the single WKWebView + CoreLocation + AVSpeechSynthesizer engine so CarPlay works
/// immediately even when connected while the iPhone screen is locked and no phone UIWindowScene has opened yet.
@MainActor
final class AppRuntime {
    static let shared = AppRuntime()

    lazy var viewController: ViewController = {
        let vc = ViewController()
        vc.loadViewIfNeeded()
        return vc
    }()

    private init() {}
}

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        // Voice guidance keeps speaking in the background and over CarPlay's voice channel while ducking music/podcasts.
        // Only the category is set here: activating at launch blocked the main thread; ViewController activates per prompt.
        do {
            try AVAudioSession.sharedInstance().setCategory(
                .playback,
                mode: .spokenAudio,
                options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers]
            )
        } catch {
            print("Failed to set AVAudioSession category: \(error)")
        }
        return true
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        if connectingSceneSession.role == .carTemplateApplication {
            let carConfig = UISceneConfiguration(name: "CarPlay Configuration", sessionRole: connectingSceneSession.role)
            carConfig.delegateClass = CarPlaySceneDelegate.self
            return carConfig
        }
        let configuration = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

/// Apps built with the iOS 27 SDK must use the UIScene life cycle or they fail to launch (TN3187),
/// so the window lives in the scene rather than in the app delegate.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = AppRuntime.shared.viewController
        window.makeKeyAndVisible()
        self.window = window
    }
}
