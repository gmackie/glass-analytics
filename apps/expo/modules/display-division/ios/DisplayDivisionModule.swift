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

  override func didMoveToWindow() {
    super.didMoveToWindow()
    setNeedsUpdateConstraints()
  }

  // UIKit invalidates this pass when the reserved region changes, even when
  // moving from fully open to partially open keeps the same window size.
  override func updateConstraints() {
    if #available(iOS 27.1, *) {
      let frame = reservedRegions(kind: .division).first?.frame.intersection(bounds) ?? .null
      if frame != lastFrame {
        lastFrame = frame
        let region: [String: CGFloat]? = frame.isNull ? nil : [
          "x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height
        ]
        onDivisionChange(["region": region as Any])
      }
    }
    super.updateConstraints()
  }
}
