import ExpoModulesCore
import UIKit

public final class DisplayDivisionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DisplayDivision")
    View(DisplayDivisionView.self) {
      Events("onDivisionChange")
    }
  }
}

final class DisplayDivisionView: ExpoView {
  let onDivisionChange = EventDispatcher()
  private var lastFrame: CGRect = .null

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    if #available(iOS 27.1, *) {
      addInteraction(UIHingeInteraction { [weak self] _, _ in
        // A pose change can leave the inner display's window size unchanged.
        self?.setNeedsUpdateConstraints()
      })
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if #available(iOS 27.1, *) { publishDivision() }
  }

  // Reading reserved regions here also requests UIKit's automatic invalidation.
  override func updateConstraints() {
    if #available(iOS 27.1, *) { publishDivision() }
    super.updateConstraints()
  }

  @available(iOS 27.1, *)
  private func publishDivision() {
    let frame = reservedRegions(kind: .division).first?.frame.intersection(bounds) ?? .null
    guard frame != lastFrame else { return }
    lastFrame = frame
    guard !frame.isNull else {
      onDivisionChange(["region": NSNull()])
      return
    }
    onDivisionChange(["region": ["x": frame.minX, "y": frame.minY,
                                  "width": frame.width, "height": frame.height]])
  }
}
