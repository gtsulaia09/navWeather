import UIKit
import CarPlay
import MapKit

/// Coordinates CarPlay templates (`CPMapTemplate`, `CPNavigationSession`, `CPListTemplate`, `CPNavigationAlert`)
/// and the CarPlay map canvas with the shared deterministic TypeScript engine in `AppRuntime.shared.viewController`.
@MainActor
final class CarPlayCoordinator: NSObject, CPMapTemplateDelegate {
    static let shared = CarPlayCoordinator()

    private weak var interfaceController: CPInterfaceController?
    private weak var carWindow: CPWindow?
    private var mapTemplate: CPMapTemplate?
    private var mapViewController: CarPlayMapViewController?
    private var navigationSession: CPNavigationSession?
    private var activeTrip: CPTrip?
    private var activeAlertId: String?
    private var isPanning = false
    private var webReady = false

    private var lastSnapshot: [String: Any] = [:]
    private var locale: String = "en"
    private var useImperial = false

    // Route geometry is sent only when it changes (`routeKey`); updates in between reuse it.
    private var routeKey: String?
    private var routeCoordinates: Any?
    private var weatherSegments: Any?

    // CarPlay templates are only touched when what they show changes: re-presenting trip previews, rebuilding the
    // bar buttons or replacing the maneuver on every position update made the car screen flicker and stutter.
    private var tripSignature = ""
    private var barSignature = ""
    private var maneuverSignature = ""
    private var currentManeuver: CPManeuver?

    private override init() {
        super.init()
    }

    var isConnected: Bool {
        interfaceController != nil
    }

    func connect(interfaceController: CPInterfaceController, window: CPWindow?) {
        self.interfaceController = interfaceController
        self.carWindow = window
        tripSignature = ""
        barSignature = ""
        maneuverSignature = ""
        currentManeuver = nil

        // Ensure the shared WebView + CoreLocation + AVSpeechSynthesizer engine is running even if iPhone is locked.
        let vc = AppRuntime.shared.viewController

        if let window {
            let mapVC = CarPlayMapViewController()
            window.rootViewController = mapVC
            window.makeKeyAndVisible()
            self.mapViewController = mapVC
        }

        let template = CPMapTemplate()
        template.mapDelegate = self
        template.automaticallyHidesNavigationBar = false
        template.guidanceBackgroundColor = UIColor(red: 0.08, green: 0.09, blue: 0.11, alpha: 0.96)
        self.mapTemplate = template
        updateBarButtons()

        interfaceController.setRootTemplate(template, animated: false, completion: nil)

        if webReady {
            vc.notifyCarPlayStatus(connected: true)
            vc.sendCarPlayCommand(["action": "requestSync"])
        }
    }

    func disconnect() {
        navigationSession?.finishTrip()
        navigationSession = nil
        activeTrip = nil
        tripSignature = ""
        barSignature = ""
        maneuverSignature = ""
        currentManeuver = nil
        routeKey = nil
        activeAlertId = nil
        isPanning = false
        mapTemplate = nil
        mapViewController = nil
        carWindow = nil
        interfaceController = nil
        if webReady {
            AppRuntime.shared.viewController.notifyCarPlayStatus(connected: false)
        }
    }

    // MARK: - JS → CarPlay

    func handleWebMessage(_ body: [String: Any]) {
        let action = body["action"] as? String ?? ""
        if action == "ready" {
            webReady = true
            if isConnected {
                AppRuntime.shared.viewController.notifyCarPlayStatus(connected: true)
                AppRuntime.shared.viewController.sendCarPlayCommand(["action": "requestSync"])
            }
            return
        }
        if action == "endNavigation" {
            endNavigationSession()
            updateBarButtons()
            return
        }
        if action == "sync", let snap = body["snapshot"] as? [String: Any] {
            applySnapshot(snap)
        }
    }

    private func applySnapshot(_ incoming: [String: Any]) {
        var snap = incoming
        let key = incoming["routeKey"] as? String
        if incoming["routeCoordinates"] != nil || key != routeKey {
            routeKey = key
            routeCoordinates = incoming["routeCoordinates"]
            weatherSegments = incoming["weatherSegments"]
        }
        if let coords = routeCoordinates { snap["routeCoordinates"] = coords }
        if let segs = weatherSegments { snap["weatherSegments"] = segs }
        lastSnapshot = snap
        if let loc = snap["locale"] as? String { locale = loc }
        if let u = snap["units"] as? String { useImperial = (u == "imperial") }

        let active = snap["active"] as? Bool ?? false
        let destName = snap["destinationName"] as? String
        let originName = snap["originName"] as? String
        let weatherSummary = snap["weatherSummary"] as? String

        mapViewController?.applySnapshot(snap)

        if active {
            ensureNavigationSession(originName: originName, destinationName: destName, weatherSummary: weatherSummary, snap: snap)
            updateActiveGuidance(snap)
            updateWeatherAlert(snap)
        } else {
            if navigationSession != nil {
                endNavigationSession()
            }
            updateRoutePreview(originName: originName, destinationName: destName, weatherSummary: weatherSummary, snap: snap)
        }
        updateBarButtons()
    }

    // MARK: - Trip Preview & Active Session

    private func makeTrip(originName: String?, destinationName: String?, weatherSummary: String?, snap: [String: Any]) -> CPTrip? {
        guard let destName = destinationName, !destName.isEmpty else { return nil }
        let coords = parseCoordinates(snap["routeCoordinates"])
        let startCoord = coords.first ?? CLLocationCoordinate2D(latitude: 41.7151, longitude: 44.8271)
        let endCoord = coords.last ?? startCoord

        let originItem = MKMapItem(placemark: MKPlacemark(coordinate: startCoord))
        originItem.name = originName ?? tr("Current Location", "Моё местоположение", "ჩემი მდებარეობა")
        let destItem = MKMapItem(placemark: MKPlacemark(coordinate: endCoord))
        destItem.name = destName

        let rawOptions = snap["routeOptions"] as? [[String: Any]] ?? []
        var choices: [CPRouteChoice] = []
        if rawOptions.isEmpty {
            let summary = weatherSummary ?? destName
            let choice = CPRouteChoice(
                summaryVariants: [destName],
                additionalInformationVariants: [summary],
                selectionSummaryVariants: [summary]
            )
            choice.userInfo = 0
            choices.append(choice)
        } else {
            for opt in rawOptions {
                let idx = opt["index"] as? Int ?? 0
                let name = (opt["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                let wx = (opt["weatherNote"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                let title = (name?.isEmpty == false ? name! : destName)
                let info = [wx, weatherSummary].compactMap { $0 }.first { !$0.isEmpty } ?? title
                let choice = CPRouteChoice(
                    summaryVariants: [title],
                    additionalInformationVariants: [info],
                    selectionSummaryVariants: [info]
                )
                choice.userInfo = idx
                choices.append(choice)
            }
        }
        return CPTrip(origin: originItem, destination: destItem, routeChoices: choices)
    }

    private func updateRoutePreview(originName: String?, destinationName: String?, weatherSummary: String?, snap: [String: Any]) {
        guard let template = mapTemplate else { return }
        let options = (snap["routeOptions"] as? [[String: Any]] ?? []).map { opt in
            "\(opt["index"] ?? ""):\(opt["name"] ?? ""):\(opt["durationS"] ?? ""):\(opt["weatherNote"] ?? "")"
        }.joined(separator: "|")
        let signature = "\(routeKey ?? "-")|\(originName ?? "")|\(destinationName ?? "")|\(weatherSummary ?? "")|\(options)|\(locale)|\(useImperial)"
        if signature == tripSignature { return }
        tripSignature = signature
        guard let trip = makeTrip(originName: originName, destinationName: destinationName, weatherSummary: weatherSummary, snap: snap) else {
            template.hideTripPreviews()
            activeTrip = nil
            return
        }
        activeTrip = trip
        let textConfig = CPTripPreviewTextConfiguration(
            startButtonTitle: tr("Start", "Старт", "დაწყება"),
            additionalRoutesButtonTitle: tr("Routes", "Маршруты", "მარშრუტები"),
            overviewButtonTitle: tr("Overview", "Обзор", "მიმოხილვა")
        )
        template.showTripPreviews([trip], textConfiguration: textConfig)

        if let remDist = snap["remainingDistanceM"] as? Double ?? (snap["routeOptions"] as? [[String: Any]])?.first?["distanceM"] as? Double,
           let remDur = snap["remainingDurationS"] as? Double ?? (snap["routeOptions"] as? [[String: Any]])?.first?["durationS"] as? Double {
            let estimates = makeEstimates(distanceM: remDist, durationS: remDur)
            template.updateEstimates(estimates, for: trip)
        }
    }

    private func ensureNavigationSession(originName: String?, destinationName: String?, weatherSummary: String?, snap: [String: Any]) {
        guard let template = mapTemplate, navigationSession == nil else { return }
        template.hideTripPreviews()
        let trip = activeTrip ?? makeTrip(originName: originName, destinationName: destinationName, weatherSummary: weatherSummary, snap: snap)
        guard let trip else { return }
        activeTrip = trip
        tripSignature = ""
        maneuverSignature = ""
        currentManeuver = nil
        navigationSession = template.startNavigationSession(for: trip)
    }

    private func updateActiveGuidance(_ snap: [String: Any]) {
        guard let template = mapTemplate, let session = navigationSession, let trip = activeTrip else { return }
        let remDist = (snap["remainingDistanceM"] as? NSNumber)?.doubleValue ?? 0
        let remDur = (snap["remainingDurationS"] as? NSNumber)?.doubleValue ?? 0
        let tripEstimates = makeEstimates(distanceM: remDist, durationS: remDur)
        template.updateEstimates(tripEstimates, for: trip)

        if let next = snap["nextManeuver"] as? [String: Any] {
            let instruction = next["instruction"] as? String ?? ""
            let type = next["type"] as? String ?? "continue"
            let modifier = next["modifier"] as? String
            let stepDist = (next["distanceM"] as? NSNumber)?.doubleValue ?? 0

            let stepEst = makeEstimates(distanceM: stepDist, durationS: max(0, stepDist / 14.0))
            let signature = "\(instruction)|\(type)|\(modifier ?? "")"
            if signature != maneuverSignature || currentManeuver == nil {
                // A new maneuver: the guidance card changes once.
                let maneuver = CPManeuver()
                maneuver.instructionVariants = [instruction]
                if let img = maneuverSymbol(type: type, modifier: modifier) {
                    maneuver.symbolImage = img
                }
                maneuver.initialTravelEstimates = stepEst
                session.upcomingManeuvers = [maneuver]
                currentManeuver = maneuver
                maneuverSignature = signature
            }
            // The same maneuver getting closer: only its distance and time count down.
            if let maneuver = currentManeuver {
                session.updateEstimates(stepEst, for: maneuver)
            }
        } else if currentManeuver != nil {
            session.upcomingManeuvers = []
            currentManeuver = nil
            maneuverSignature = ""
        }
    }

    /// Driver distraction rule (MOBILE_STRATEGY §5): strictly ONE weather alert banner at a time on CarPlay.
    private func updateWeatherAlert(_ snap: [String: Any]) {
        guard let template = mapTemplate else { return }
        guard let alertDict = snap["alert"] as? [String: Any],
              let id = alertDict["id"] as? String,
              let headline = alertDict["headline"] as? String, !headline.isEmpty else {
            if activeAlertId != nil {
                template.dismissNavigationAlert(animated: true) { _ in }
                activeAlertId = nil
            }
            return
        }
        if activeAlertId == id { return }
        activeAlertId = id

        let detail = alertDict["detail"] as? String
        let severity = alertDict["severity"] as? String ?? "medium"
        let symbolName = severity == "critical" ? "exclamationmark.triangle.fill" : "cloud.heavyrain.fill"
        let icon = UIImage(systemName: symbolName)
        let dismissAction = CPAlertAction(title: tr("OK", "ОК", "კარგი"), style: .default) { [weak self] _ in
            self?.activeAlertId = nil
            AppRuntime.shared.viewController.sendCarPlayCommand(["action": "dismissAlert"])
        }
        let navAlert = CPNavigationAlert(
            titleVariants: [headline],
            subtitleVariants: detail != nil && !detail!.isEmpty ? [detail!] : [],
            image: icon,
            primaryAction: dismissAction,
            secondaryAction: nil,
            duration: 12
        )
        template.present(navigationAlert: navAlert, animated: true)
    }

    private func endNavigationSession() {
        navigationSession?.finishTrip()
        navigationSession = nil
        currentManeuver = nil
        maneuverSignature = ""
        tripSignature = ""
        if activeAlertId != nil {
            mapTemplate?.dismissNavigationAlert(animated: false) { _ in }
            activeAlertId = nil
        }
    }

    // MARK: - Bar Buttons & Lists

    private func updateBarButtons() {
        guard let template = mapTemplate else { return }
        let active = lastSnapshot["active"] as? Bool ?? false
        let signature = "\(active)|\(isPanning)|\(locale)"
        if signature == barSignature { return }
        barSignature = signature

        let destBtn = CPBarButton(title: tr("Places", "Куда", "ადგილები")) { [weak self] _ in
            self?.presentDestinationsList()
        }
        let nearbyBtn = CPBarButton(title: tr("Nearby", "Рядом", "ახლოს")) { [weak self] _ in
            self?.presentNearbyCategories()
        }
        template.leadingNavigationBarButtons = active ? [nearbyBtn] : [destBtn, nearbyBtn]

        if isPanning {
            let doneBtn = CPBarButton(title: tr("Done", "Готово", "მზადაა")) { [weak self] _ in
                guard let self else { return }
                self.isPanning = false
                self.mapTemplate?.dismissPanningInterface(animated: true)
                self.mapViewController?.recenter()
                self.updateBarButtons()
            }
            template.trailingNavigationBarButtons = [doneBtn]
        } else if active {
            let panBtn = CPBarButton(title: tr("Pan", "Карта", "რუკა")) { [weak self] _ in
                guard let self else { return }
                self.isPanning = true
                self.mapTemplate?.showPanningInterface(animated: true)
                self.updateBarButtons()
            }
            let endBtn = CPBarButton(title: tr("End", "Стоп", "დასრულება")) { _ in
                AppRuntime.shared.viewController.sendCarPlayCommand(["action": "stopNavigation"])
            }
            template.trailingNavigationBarButtons = [panBtn, endBtn]
        } else {
            let panBtn = CPBarButton(title: tr("Pan", "Карта", "რუკა")) { [weak self] _ in
                guard let self else { return }
                self.isPanning = true
                self.mapTemplate?.showPanningInterface(animated: true)
                self.updateBarButtons()
            }
            template.trailingNavigationBarButtons = [panBtn]
        }
    }

    private func presentDestinationsList() {
        guard let ic = interfaceController else { return }
        let saved = lastSnapshot["savedPlaces"] as? [[String: Any]] ?? []
        var savedItems: [CPListItem] = []

        for p in saved {
            guard let id = p["id"] as? String,
                  let name = p["name"] as? String,
                  let coords = p["coordinate"] as? [NSNumber], coords.count >= 2 else { continue }
            let subtitle = p["subtitle"] as? String ?? ""
            let slot = p["slot"] as? String ?? "recent"
            let iconName: String
            switch slot {
            case "home": iconName = "house.fill"
            case "work": iconName = "briefcase.fill"
            case "favorite": iconName = "star.fill"
            case "parking": iconName = "parkingsign.circle.fill"
            default: iconName = "clock.fill"
            }
            let item = CPListItem(text: name, detailText: subtitle, image: UIImage(systemName: iconName))
            let lon = coords[0].doubleValue
            let lat = coords[1].doubleValue
            item.handler = { [weak ic] _, completion in
                AppRuntime.shared.viewController.sendCarPlayCommand([
                    "action": "routeTo",
                    "place": ["id": id, "name": name, "label": subtitle.isEmpty ? name : subtitle, "coordinate": [lon, lat]]
                ])
                ic?.popToRootTemplate(animated: true, completion: nil)
                completion()
            }
            savedItems.append(item)
        }

        let georgiaPresets: [(String, String, String, Double, Double)] = [
            ("ge:tbilisi", tr("Tbilisi", "Тбилиси", "თბილისი"), tr("Capital · Georgia", "Столица · Грузия", "დედაქალაქი"), 44.8014, 41.6936),
            ("ge:batumi", tr("Batumi", "Батуми", "ბათუმი"), tr("Adjara · Black Sea", "Аджария · Чёрное море", "აჭარა"), 41.6367, 41.6461),
            ("ge:kutaisi", tr("Kutaisi", "Кутаиси", "ქუთაისი"), tr("Imereti", "Имеретия", "იმერეთი"), 42.7056, 42.2679),
            ("ge:gudauri", tr("Gudauri", "Гудаури", "გუდაური"), tr("Greater Caucasus", "Большой Кавказ", "კავკასიონი"), 44.4792, 42.4770),
            ("ge:kazbegi", tr("Stepantsminda", "Степанцминда", "სტეფანწმინდა"), tr("Kazbegi", "Казбеги", "ყაზბეგი"), 44.6433, 42.6567),
            ("ge:telavi", tr("Telavi", "Телави", "თელავი"), tr("Kakheti", "Кахетия", "კახეთი"), 45.4731, 41.9198),
            ("ge:borjomi", tr("Borjomi", "Боржоми", "ბორჯომი"), tr("Samtskhe-Javakheti", "Самцхе-Джавахети", "სამცხე-ჯავახეთი"), 43.3831, 41.8419),
            ("ge:mestia", tr("Mestia", "Местиа", "მესტია"), tr("Svaneti", "Сванетия", "სვანეთი"), 42.7278, 43.0444)
        ]

        let presetItems: [CPListItem] = georgiaPresets.map { id, name, sub, lon, lat in
            let item = CPListItem(text: name, detailText: sub, image: UIImage(systemName: "mappin.and.ellipse"))
            item.handler = { [weak ic] _, completion in
                AppRuntime.shared.viewController.sendCarPlayCommand([
                    "action": "routeTo",
                    "place": ["id": id, "name": name, "label": "\(name), \(sub)", "coordinate": [lon, lat]]
                ])
                ic?.popToRootTemplate(animated: true, completion: nil)
                completion()
            }
            return item
        }

        var sections: [CPListSection] = []
        if !savedItems.isEmpty {
            sections.append(CPListSection(items: savedItems, header: tr("Saved & Recent", "Сохранённые и недавние", "შენახული და ბოლო"), sectionIndexTitle: nil))
        }
        sections.append(CPListSection(items: presetItems, header: tr("Georgia Destinations", "Направления в Грузии", "საქართველოს მიმართულებები"), sectionIndexTitle: nil))

        let list = CPListTemplate(title: tr("Destinations", "Куда поехать", "მიმართულებები"), sections: sections)
        ic.pushTemplate(list, animated: true, completion: nil)
    }

    private func presentNearbyCategories() {
        guard let ic = interfaceController else { return }
        let cats: [(String, String, String)] = [
            ("fuel", tr("Fuel stations", "АЗС", "ბენზინგასამართი"), "fuelpump.fill"),
            ("ev_charging", tr("EV charging", "Электрозарядки", "დამტენი"), "bolt.car.fill"),
            ("car_wash", tr("Car washes", "Автомойки", "სამრეცხაოები"), "drop.fill"),
            ("supermarket", tr("Supermarkets (Fresco…)", "Супермаркеты (Fresco…)", "სუპერმარკეტები (Fresco…)"), "cart.fill"),
            ("cafe", tr("Cafes", "Кафе", "კაფე"), "cup.and.saucer.fill"),
            ("restaurant", tr("Restaurants", "Рестораны", "რესტორანი"), "fork.knife"),
            ("pharmacy", tr("Pharmacies", "Аптеки", "აფთიაქი"), "cross.case.fill"),
            ("parking", tr("Parking", "Парковки", "პარკინგი"), "parkingsign")
        ]
        let items: [CPListItem] = cats.map { key, label, icon in
            let item = CPListItem(text: label, detailText: nil, image: UIImage(systemName: icon))
            item.handler = { [weak ic] _, completion in
                AppRuntime.shared.viewController.sendCarPlayCommand(["action": "searchNearby", "category": key])
                ic?.popToRootTemplate(animated: true, completion: nil)
                completion()
            }
            return item
        }
        let list = CPListTemplate(title: tr("Nearby", "Рядом", "ახლოს"), sections: [CPListSection(items: items)])
        ic.pushTemplate(list, animated: true, completion: nil)
    }

    // MARK: - CPMapTemplateDelegate

    nonisolated func mapTemplate(_ mapTemplate: CPMapTemplate, startedTrip trip: CPTrip, using routeChoice: CPRouteChoice) {
        let idx = routeChoice.userInfo as? Int ?? 0
        Task { @MainActor in
            if idx > 0 {
                AppRuntime.shared.viewController.sendCarPlayCommand(["action": "selectRouteOption", "index": idx])
            }
            AppRuntime.shared.viewController.sendCarPlayCommand(["action": "startNavigation"])
        }
    }

    nonisolated func mapTemplate(_ mapTemplate: CPMapTemplate, selectedPreviewFor trip: CPTrip, using routeChoice: CPRouteChoice) {
        let idx = routeChoice.userInfo as? Int ?? 0
        Task { @MainActor in
            AppRuntime.shared.viewController.sendCarPlayCommand(["action": "selectRouteOption", "index": idx])
        }
    }

    nonisolated func mapTemplate(_ mapTemplate: CPMapTemplate, panWith direction: CPMapTemplate.PanDirection) {
        Task { @MainActor in
            self.mapViewController?.pan(direction: direction)
        }
    }

    // MARK: - Helpers

    private func makeEstimates(distanceM: Double, durationS: Double) -> CPTravelEstimates {
        let measurement: Measurement<UnitLength>
        if useImperial {
            let miles = distanceM / 1609.344
            measurement = Measurement(value: (miles * 10).rounded() / 10, unit: .miles)
        } else if distanceM < 1000 {
            measurement = Measurement(value: (distanceM / 10).rounded() * 10, unit: .meters)
        } else {
            let km = distanceM / 1000.0
            measurement = Measurement(value: (km * 10).rounded() / 10, unit: .kilometers)
        }
        return CPTravelEstimates(distanceRemaining: measurement, timeRemaining: max(0, durationS))
    }

    private func maneuverSymbol(type: String, modifier: String?) -> UIImage? {
        let mod = modifier ?? ""
        let name: String
        switch type {
        case "arrive":
            name = "flag.checkered"
        case "roundabout", "rotary":
            name = "arrow.triangle.2.circlepath"
        case "uturn":
            name = "arrow.uturn.left"
        case "merge":
            name = "arrow.merge"
        case "fork", "off ramp", "on ramp", "turn", "end of road":
            if mod.contains("sharp left") { name = "arrow.turn.down.left" }
            else if mod.contains("left") { name = "arrow.turn.up.left" }
            else if mod.contains("sharp right") { name = "arrow.turn.down.right" }
            else if mod.contains("right") { name = "arrow.turn.up.right" }
            else { name = "arrow.up" }
        default:
            if mod.contains("left") { name = "arrow.up.left" }
            else if mod.contains("right") { name = "arrow.up.right" }
            else { name = "arrow.up" }
        }
        let cfg = UIImage.SymbolConfiguration(pointSize: 30, weight: .bold)
        return UIImage(systemName: name, withConfiguration: cfg)
    }

    private func tr(_ en: String, _ ru: String, _ ka: String) -> String {
        if locale == "ru" { return ru }
        if locale == "ka" { return ka }
        return en
    }

    fileprivate func parseCoordinates(_ raw: Any?) -> [CLLocationCoordinate2D] {
        guard let arr = raw as? [[NSNumber]] else { return [] }
        return arr.compactMap { pair in
            guard pair.count >= 2 else { return nil }
            return CLLocationCoordinate2D(latitude: pair[1].doubleValue, longitude: pair[0].doubleValue)
        }
    }
}

// MARK: - CarPlay Scene Delegate

class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController,
        to window: CPWindow
    ) {
        Task { @MainActor in
            CarPlayCoordinator.shared.connect(interfaceController: interfaceController, window: window)
        }
    }

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController
    ) {
        Task { @MainActor in
            CarPlayCoordinator.shared.connect(interfaceController: interfaceController, window: nil)
        }
    }

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didDisconnect interfaceController: CPInterfaceController,
        from window: CPWindow
    ) {
        Task { @MainActor in
            CarPlayCoordinator.shared.disconnect()
        }
    }

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didDisconnectInterfaceController interfaceController: CPInterfaceController
    ) {
        Task { @MainActor in
            CarPlayCoordinator.shared.disconnect()
        }
    }
}

// MARK: - CarPlay Map Canvas (route, weather stretches, vehicle heading camera, weather badge)

private final class WeatherSegmentPolyline: MKPolyline {
    var weatherClass: String = "clear"
}

private final class VehicleAnnotation: NSObject, MKAnnotation {
    dynamic var coordinate: CLLocationCoordinate2D
    var headingDeg: Double = 0
    init(coordinate: CLLocationCoordinate2D) {
        self.coordinate = coordinate
        super.init()
    }
}

@MainActor
final class CarPlayMapViewController: UIViewController, MKMapViewDelegate {
    private let mapView = MKMapView()
    private let weatherPill = UILabel()
    private var routeOverlay: MKPolyline?
    private var weatherOverlays: [WeatherSegmentPolyline] = []
    private var endpointAnnotations: [MKPointAnnotation] = []
    private var vehicleAnnotation: VehicleAnnotation?
    private var followVehicle = true
    private var lastRouteSignature = ""
    private var lastVehicleUpdate: CFTimeInterval = 0
    private var lastWeatherText = ""

    override func viewDidLoad() {
        super.viewDidLoad()
        mapView.frame = view.bounds
        mapView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        mapView.delegate = self
        mapView.showsCompass = true
        mapView.showsScale = true
        mapView.pointOfInterestFilter = .includingAll
        // Initial camera over Tbilisi / Georgia
        let initial = MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: 41.7151, longitude: 44.7930),
            span: MKCoordinateSpan(latitudeDelta: 0.14, longitudeDelta: 0.14)
        )
        mapView.setRegion(initial, animated: false)
        view.addSubview(mapView)

        weatherPill.translatesAutoresizingMaskIntoConstraints = false
        weatherPill.backgroundColor = UIColor.black.withAlphaComponent(0.76)
        weatherPill.textColor = .white
        weatherPill.font = .systemFont(ofSize: 13, weight: .semibold)
        weatherPill.layer.cornerRadius = 12
        weatherPill.layer.masksToBounds = true
        weatherPill.numberOfLines = 1
        weatherPill.isHidden = true
        view.addSubview(weatherPill)

        NSLayoutConstraint.activate([
            weatherPill.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 12),
            weatherPill.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -10),
            weatherPill.trailingAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            weatherPill.heightAnchor.constraint(greaterThanOrEqualToConstant: 28)
        ])
    }

    func applySnapshot(_ snap: [String: Any]) {
        let active = snap["active"] as? Bool ?? false
        let wx = (snap["weatherSummary"] as? String) ?? ""
        if wx != lastWeatherText {
            lastWeatherText = wx
            UIView.transition(with: weatherPill, duration: 0.25, options: [.transitionCrossDissolve, .beginFromCurrentState]) {
                self.weatherPill.text = wx.isEmpty ? nil : "  \(wx)  "
                self.weatherPill.isHidden = wx.isEmpty
            }
        }

        let signature = (snap["routeKey"] as? String) ?? {
            let coords = CarPlayCoordinator.shared.parseCoordinates(snap["routeCoordinates"])
            return coords.isEmpty ? "" : "\(coords.count):\(coords.first!.latitude),\(coords.first!.longitude)-\(coords.last!.latitude),\(coords.last!.longitude)"
        }()
        if signature != lastRouteSignature {
            lastRouteSignature = signature
            let coords = CarPlayCoordinator.shared.parseCoordinates(snap["routeCoordinates"])
            rebuildRouteOverlays(coords: coords, weatherSegments: snap["weatherSegments"] as? [[String: Any]] ?? [])
            if !active, let poly = routeOverlay {
                mapView.setVisibleMapRect(poly.boundingMapRect, edgePadding: UIEdgeInsets(top: 44, left: 44, bottom: 56, right: 44), animated: true)
            }
        }

        if let veh = snap["vehicle"] as? [String: Any],
           let pair = veh["coordinate"] as? [NSNumber], pair.count >= 2 {
            let coord = CLLocationCoordinate2D(latitude: pair[1].doubleValue, longitude: pair[0].doubleValue)
            let heading = (veh["headingDeg"] as? NSNumber)?.doubleValue ?? 0
            // Glide over the time this update took to arrive, linearly: the car reaches each fix as the next one
            // comes in, instead of hopping and stopping (and the camera moves with it, on the same curve).
            let now = CACurrentMediaTime()
            let gap = lastVehicleUpdate > 0 ? now - lastVehicleUpdate : 0
            lastVehicleUpdate = now
            let duration = min(1.2, max(0.25, gap))
            let follow = active && followVehicle
            if let existing = vehicleAnnotation {
                existing.headingDeg = heading
                UIView.animate(withDuration: duration, delay: 0, options: [.curveLinear, .beginFromCurrentState, .allowUserInteraction]) {
                    existing.coordinate = coord
                    if follow {
                        self.mapView.camera = MKMapCamera(lookingAtCenter: coord, fromDistance: 850, pitch: 45, heading: heading)
                    }
                }
            } else {
                let ann = VehicleAnnotation(coordinate: coord)
                ann.headingDeg = heading
                vehicleAnnotation = ann
                mapView.addAnnotation(ann)
                if follow {
                    mapView.setCamera(MKMapCamera(lookingAtCenter: coord, fromDistance: 850, pitch: 45, heading: heading), animated: true)
                }
            }
            updateVehicleArrow()
        }
    }

    /// The car's arrow points along its heading on the map (straight up while the camera follows it heading-up).
    private func updateVehicleArrow() {
        guard let ann = vehicleAnnotation, let view = mapView.view(for: ann) else { return }
        let degrees = ann.headingDeg - mapView.camera.heading
        UIView.animate(withDuration: 0.3, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) {
            view.transform = CGAffineTransform(rotationAngle: CGFloat(degrees * .pi / 180))
        }
    }

    func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
        updateVehicleArrow()
    }

    func pan(direction: CPMapTemplate.PanDirection) {
        followVehicle = false
        var region = mapView.region
        let latStep = region.span.latitudeDelta * 0.32
        let lonStep = region.span.longitudeDelta * 0.32
        if direction.contains(.up) { region.center.latitude += latStep }
        if direction.contains(.down) { region.center.latitude -= latStep }
        if direction.contains(.left) { region.center.longitude -= lonStep }
        if direction.contains(.right) { region.center.longitude += lonStep }
        mapView.setRegion(region, animated: true)
    }

    func recenter() {
        followVehicle = true
        if let veh = vehicleAnnotation {
            let cam = MKMapCamera(lookingAtCenter: veh.coordinate, fromDistance: 850, pitch: 45, heading: veh.headingDeg)
            mapView.setCamera(cam, animated: true)
        } else if let poly = routeOverlay {
            mapView.setVisibleMapRect(poly.boundingMapRect, edgePadding: UIEdgeInsets(top: 44, left: 44, bottom: 56, right: 44), animated: true)
        }
    }

    private func rebuildRouteOverlays(coords: [CLLocationCoordinate2D], weatherSegments: [[String: Any]]) {
        if let old = routeOverlay { mapView.removeOverlay(old); routeOverlay = nil }
        if !weatherOverlays.isEmpty { mapView.removeOverlays(weatherOverlays); weatherOverlays.removeAll() }
        if !endpointAnnotations.isEmpty { mapView.removeAnnotations(endpointAnnotations); endpointAnnotations.removeAll() }

        guard coords.count >= 2 else { return }

        for seg in weatherSegments {
            let segCoords = CarPlayCoordinator.shared.parseCoordinates(seg["coordinates"])
            guard segCoords.count >= 2 else { continue }
            var mut = segCoords
            let poly = WeatherSegmentPolyline(coordinates: &mut, count: mut.count)
            poly.weatherClass = seg["cls"] as? String ?? "clear"
            weatherOverlays.append(poly)
        }
        if !weatherOverlays.isEmpty {
            mapView.addOverlays(weatherOverlays, level: .aboveRoads)
        }

        var mutRoute = coords
        let mainPoly = MKPolyline(coordinates: &mutRoute, count: mutRoute.count)
        routeOverlay = mainPoly
        mapView.addOverlay(mainPoly, level: .aboveRoads)

        let startAnn = MKPointAnnotation()
        startAnn.coordinate = coords.first!
        let endAnn = MKPointAnnotation()
        endAnn.coordinate = coords.last!
        endpointAnnotations = [startAnn, endAnn]
        mapView.addAnnotations(endpointAnnotations)
    }

    func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
        if let wx = overlay as? WeatherSegmentPolyline {
            let r = MKPolylineRenderer(polyline: wx)
            r.lineWidth = 14
            r.lineCap = .round
            r.lineJoin = .round
            switch wx.weatherClass {
            case "heavy-rain": r.strokeColor = UIColor.systemBlue.withAlphaComponent(0.55)
            case "rain": r.strokeColor = UIColor.systemCyan.withAlphaComponent(0.48)
            case "snow", "sleet": r.strokeColor = UIColor(red: 0.65, green: 0.86, blue: 1.0, alpha: 0.72)
            case "thunderstorm": r.strokeColor = UIColor.systemPurple.withAlphaComponent(0.58)
            case "fog": r.strokeColor = UIColor.systemGray.withAlphaComponent(0.5)
            default: r.strokeColor = .clear
            }
            return r
        }
        if let poly = overlay as? MKPolyline {
            let r = MKPolylineRenderer(polyline: poly)
            r.strokeColor = UIColor(red: 0.04, green: 0.39, blue: 0.91, alpha: 1.0)
            r.lineWidth = 6
            r.lineCap = .round
            r.lineJoin = .round
            return r
        }
        return MKOverlayRenderer(overlay: overlay)
    }

    func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
        if annotation is VehicleAnnotation {
            let id = "vehicle"
            let v = mapView.dequeueReusableAnnotationView(withIdentifier: id) ?? MKAnnotationView(annotation: annotation, reuseIdentifier: id)
            v.annotation = annotation
            v.image = UIImage(systemName: "location.north.circle.fill")?.withTintColor(.systemBlue, renderingMode: .alwaysOriginal)
            v.layer.shadowColor = UIColor.black.cgColor
            v.layer.shadowOpacity = 0.3
            v.layer.shadowRadius = 3
            v.layer.shadowOffset = CGSize(width: 0, height: 1)
            v.bounds = CGRect(x: 0, y: 0, width: 30, height: 30)
            return v
        }
        return nil
    }
}
