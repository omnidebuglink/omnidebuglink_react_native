import Foundation
import UIKit
import React
import Network

/**
 * OmniDebugLink platform bridge (iOS).
 *
 * Coordinates: inbound coordinates from JS are normalized [0,1] relative to
 * the key window (origin top-left). Outbound uiTree coordinates are absolute
 * window-space points, also top-left origin.
 *
 * Touch injection synthesizes UITouch objects via KVC on the underscored
 * instance fields (_phase/_window/_locationInWindow/...) and delivers them
 * through UIWindow.sendEvent — the same technique used by in-process
 * automation tools. It relies on private UITouch/UIEvent ivars, so a major
 * iOS release may require adapting the KVC keys below.
 */
@objc(OmlReactModule)
class OmlReactModule: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { false }

  private let MAX_TREE_NODES = 3000
  private let TAP_UP_DELAY = 0.08
  /// Captured by omlCaptureFirstResponder via the responder-chain trick
  private static weak var currentFirstResponder: UIResponder?

  private var perfStamps: [CFTimeInterval] = []
  private var perfDisplayLink: CADisplayLink?

  // ── helpers ─────────────────────────────────────────────────────────────

  private func mainWindow() -> UIWindow? {
    if #available(iOS 13.0, *) {
      for scene in UIApplication.shared.connectedScenes {
        guard let windowScene = scene as? UIWindowScene else { continue }
        if #available(iOS 15.0, *), let key = windowScene.keyWindow {
          return key
        }
        if let key = windowScene.windows.first(where: { $0.isKeyWindow }) {
          return key
        }
      }
    }
    if let window = UIApplication.shared.delegate?.window, let unwrapped = window {
      return unwrapped
    }
    return nil
  }

  /// UIApplication.sendAction(to: nil) dispatches up the responder chain
  /// starting at the first responder — the object whose omlCaptureFirstResponder
  /// runs IS the first responder (no private API, Apple-SDK verified pattern).
  static func captureFirstResponder() {
    UIApplication.shared.sendAction(
      #selector(UIResponder.omlCaptureFirstResponder), to: nil, from: nil, for: nil)
  }

  private func setPhase(_ touch: UITouch, _ phase: UITouch.Phase) {
    touch.setValue(phase.rawValue, forKey: "_phase")
  }

  private func moveTouch(_ touch: UITouch, to point: CGPoint) {
    touch.setValue(NSValue(cgPoint: point), forKey: "_locationInWindow")
  }

  private func makeTouch(at point: CGPoint, window: UIWindow) -> UITouch {
    let touch = UITouch()
    touch.setValue(window, forKey: "_window")
    touch.setValue(window.hitTest(point, with: nil), forKey: "_view")
    touch.setValue(NSValue(cgPoint: point), forKey: "_locationInWindow")
    touch.setValue(1, forKey: "_tapCount")
    touch.setValue(0.0, forKey: "_timestamp")
    setPhase(touch, .began)
    return touch
  }

  private func makeEvent(touches: [UITouch]) -> UIEvent {
    let event = UIEvent()
    event.setValue(NSSet(array: touches), forKey: "_touches")
    event.setValue(0, forKey: "_type") // UIEventType.touches
    return event
  }

  private func sendTouch(_ touch: UITouch, _ phase: UITouch.Phase,
                         at point: CGPoint, window: UIWindow) {
    moveTouch(touch, to: point)
    setPhase(touch, phase)
    touch.setValue(Date().timeIntervalSinceReferenceDate, forKey: "_timestamp")
    window.sendEvent(makeEvent(touches: [touch]))
  }

  // ── screenshot ──────────────────────────────────────────────────────────

  @objc(screenshot:reject:)
  func screenshot(_ resolve: @escaping RCTPromiseResolveBlock,
                  reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      guard let window = self.mainWindow() else {
        return reject("NO_WINDOW", "no key window", nil)
      }
      let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
      var image = renderer.image { _ in
        window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
      }
      var quality: CGFloat = 0.8
      var data = image.jpegData(compressionQuality: quality)
      var downsamples = 0
      // 675KB source keeps the base64 frame under the 900KB server limit.
      // Degrade quality first; once quality bottoms out, downscale 3/4 and
      // restore quality (≤3 rounds).
      while (data?.count ?? 0) > 675_000 && downsamples < 3 {
        if quality > 0.3 {
          quality -= 0.15
        } else {
          let format = UIGraphicsImageRendererFormat()
          format.scale = max(1, image.scale * 0.75)
          image = UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
            image.draw(at: .zero)
          }
          downsamples += 1
          quality = 0.6
        }
        data = image.jpegData(compressionQuality: quality)
      }
      guard let jpeg = data else {
        return reject("COMPRESS_FAILED", "jpeg encoding failed", nil)
      }
      resolve([
        "width": Int(image.size.width * image.scale),
        "height": Int(image.size.height * image.scale),
        "data": jpeg.base64EncodedString(),
      ])
    }
  }

  // ── ui_tree ─────────────────────────────────────────────────────────────

  @objc(uiTree:reject:)
  func uiTree(_ resolve: @escaping RCTPromiseResolveBlock,
              reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      guard let window = self.mainWindow() else {
        return reject("NO_WINDOW", "no key window", nil)
      }
      var counter = 0
      let root = self.dumpView(window, counter: &counter)
      resolve([
        "windowWidth": Int(window.bounds.width),
        "windowHeight": Int(window.bounds.height),
        "root": root,
      ])
    }
  }

  private func dumpView(_ v: UIView, counter: inout Int) -> [String: Any] {
    counter += 1
    var node: [String: Any] = [
      // RN views carry their reactTag; native views fall back to view.tag
      "id": v.reactTag?.intValue ?? v.tag,
      "type": String(describing: type(of: v)),
    ]
    let text = (v as? UILabel)?.text ?? (v as? UITextView)?.text ?? (v as? UITextField)?.text
    if let text = text, !text.isEmpty { node["text"] = text }
    if let placeholder = (v as? UITextField)?.placeholder, !placeholder.isEmpty {
      node["hint"] = placeholder
    }
    if let desc = v.accessibilityLabel { node["desc"] = desc }
    if v.isUserInteractionEnabled { node["clickable"] = true }
    let frame = v.convert(v.bounds, to: nil)
    node["x"] = Int(frame.origin.x)
    node["y"] = Int(frame.origin.y)
    node["width"] = Int(frame.width)
    node["height"] = Int(frame.height)
    if !v.subviews.isEmpty {
      var children: [[String: Any]] = []
      for sub in v.subviews {
        if counter >= MAX_TREE_NODES {
          node["truncated"] = true
          break
        }
        children.append(dumpView(sub, counter: &counter))
      }
      node["children"] = children
    }
    return node
  }

  // ── tap_screen ──────────────────────────────────────────────────────────

  @objc(tap:y:reject:resolve:)
  func tap(_ x: NSNumber, y: NSNumber,
           reject: @escaping RCTPromiseRejectBlock,
           resolve: @escaping RCTPromiseResolveBlock) {
    DispatchQueue.main.async {
      guard let window = self.mainWindow() else {
        return reject("NO_WINDOW", "no key window", nil)
      }
      let point = CGPoint(x: CGFloat(truncating: x) * window.bounds.width,
                          y: CGFloat(truncating: y) * window.bounds.height)
      let touch = self.makeTouch(at: point, window: window)
      self.sendTouch(touch, .began, at: point, window: window)
      // Recognizers need a real gap between began and ended to register a tap
      DispatchQueue.main.asyncAfter(deadline: .now() + self.TAP_UP_DELAY) {
        self.sendTouch(touch, .ended, at: point, window: window)
        resolve(NSNull())
      }
    }
  }

  // ── long_press ──────────────────────────────────────────────────────────

  @objc(longPress:y:durationMs:reject:resolve:)
  func longPress(_ x: NSNumber, y: NSNumber, durationMs: NSNumber,
                 reject: @escaping RCTPromiseRejectBlock,
                 resolve: @escaping RCTPromiseResolveBlock) {
    DispatchQueue.main.async {
      guard let window = self.mainWindow() else {
        return reject("NO_WINDOW", "no key window", nil)
      }
      let hold = max(0.1, min(10, Double(truncating: durationMs) / 1000.0))
      let point = CGPoint(x: CGFloat(truncating: x) * window.bounds.width,
                          y: CGFloat(truncating: y) * window.bounds.height)
      let touch = self.makeTouch(at: point, window: window)
      self.sendTouch(touch, .began, at: point, window: window)
      DispatchQueue.main.asyncAfter(deadline: .now() + hold) {
        self.sendTouch(touch, .ended, at: point, window: window)
        resolve(NSNull())
      }
    }
  }

  // ── swipe ───────────────────────────────────────────────────────────────

  @objc(swipe:y1:x2:y2:durationMs:reject:resolve:)
  func swipe(_ x1: NSNumber, y1: NSNumber, x2: NSNumber, y2: NSNumber,
             durationMs: NSNumber,
             reject: @escaping RCTPromiseRejectBlock,
             resolve: @escaping RCTPromiseResolveBlock) {
    DispatchQueue.main.async {
      guard let window = self.mainWindow() else {
        return reject("NO_WINDOW", "no key window", nil)
      }
      let start = CGPoint(x: CGFloat(truncating: x1) * window.bounds.width,
                          y: CGFloat(truncating: y1) * window.bounds.height)
      let end = CGPoint(x: CGFloat(truncating: x2) * window.bounds.width,
                        y: CGFloat(truncating: y2) * window.bounds.height)
      let duration = max(50, min(10_000, CGFloat(truncating: durationMs)))
      let steps = max(2, min(60, Int(duration / 16)))
      let touch = self.makeTouch(at: start, window: window)
      self.sendTouch(touch, .began, at: start, window: window)
      for i in 1...steps {
        let delay = Double(i) / Double(steps) * Double(duration) / 1000.0
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
          let t = CGFloat(i) / CGFloat(steps)
          let p = CGPoint(x: start.x + (end.x - start.x) * t,
                          y: start.y + (end.y - start.y) * t)
          self.sendTouch(touch, .moved, at: p, window: window)
          if i == steps {
            DispatchQueue.main.asyncAfter(deadline: .now() + self.TAP_UP_DELAY) {
              self.sendTouch(touch, .ended, at: end, window: window)
              resolve(NSNull())
            }
          }
        }
      }
    }
  }

  // ── ui_click ────────────────────────────────────────────────────────────

  @objc(clickView:reject:resolve:)
  func clickView(_ fieldId: NSNumber,
                 reject: @escaping RCTPromiseRejectBlock,
                 resolve: @escaping RCTPromiseResolveBlock) {
    DispatchQueue.main.async {
      guard let window = self.mainWindow() else {
        return reject("NO_WINDOW", "no key window", nil)
      }
      let tag = fieldId.intValue
      guard let target = Self.findView(window, tag: tag) else {
        return reject("VIEW_NOT_FOUND", "no view with reactTag/tag \(tag)", nil)
      }
      let frame = target.convert(target.bounds, to: nil)
      if frame.width <= 0 || frame.height <= 0 {
        return reject("VIEW_INVISIBLE", "target view has no size", nil)
      }
      let center = CGPoint(x: frame.midX, y: frame.midY)
      let touch = self.makeTouch(at: center, window: window)
      self.sendTouch(touch, .began, at: center, window: window)
      DispatchQueue.main.asyncAfter(deadline: .now() + self.TAP_UP_DELAY) {
        self.sendTouch(touch, .ended, at: center, window: window)
        resolve(true)
      }
    }
  }

  private static func findView(_ v: UIView, tag: Int) -> UIView? {
    if v.reactTag?.intValue == tag { return v }
    if v.reactTag == nil && v.tag == tag { return v }
    for sub in v.subviews {
      if let found = findView(sub, tag: tag) { return found }
    }
    return nil
  }

  // ── input_text ──────────────────────────────────────────────────────────

  @objc(inputText:text:reject:resolve:)
  func inputText(_ fieldId: NSNumber, text: String,
                 reject: @escaping RCTPromiseRejectBlock,
                 resolve: @escaping RCTPromiseResolveBlock) {
    DispatchQueue.main.async {
      guard let window = self.mainWindow() else {
        return reject("NO_WINDOW", "no key window", nil)
      }
      let tag = fieldId.intValue
      guard let target = Self.findView(window, tag: tag) else {
        return reject("VIEW_NOT_FOUND", "no view with reactTag/tag \(tag)", nil)
      }
      if let textField = target as? UITextField {
        textField.text = text
        // fire the editing stream so RN's onChange → onChangeText fires and
        // JS state stays in sync with the native mutation
        textField.sendActions(for: .editingChanged)
        return resolve(NSNull())
      }
      if let textView = target as? UITextView {
        textView.text = text
        textView.delegate?.textViewDidChange?(textView)
        return resolve(NSNull())
      }
      reject("NOT_A_TEXT_FIELD",
             "target is \(String(describing: type(of: target))), not a text field", nil)
    }
  }

  // ── send_key ────────────────────────────────────────────────────────────

  @objc(sendKey:reject:resolve:)
  func sendKey(_ key: String,
               reject: @escaping RCTPromiseRejectBlock,
               resolve: @escaping RCTPromiseResolveBlock) {
    DispatchQueue.main.async {
      Self.captureFirstResponder()
      let first = Self.currentFirstResponder
      switch key {
      case "enter":
        if let textField = first as? UITextField {
          // triggers RN onSubmitEditing via the RCT delegate path
          _ = textField.delegate?.textFieldShouldReturn?(textField)
          resolve(true)
        } else if let textView = first as? UITextView {
          textView.insertText("\n")
          resolve(true)
        } else {
          resolve(false) // no first responder — not an error
        }
      case "backspace":
        if let input = first as? UIKeyInput {
          input.deleteBackward()
          resolve(true)
        } else {
          resolve(false)
        }
      case "escape":
        first?.resignFirstResponder() // dismiss keyboard
        resolve(true)
      case "tab", "space":
        if let input = first as? UIKeyInput {
          input.insertText(key == "space" ? " " : "\t")
          resolve(true)
        } else {
          resolve(false)
        }
      default:
        reject("KEY_UNSUPPORTED",
               "iOS supports enter/escape/backspace/tab/space (hardware keys are not injectable)", nil)
      }
    }
  }

  // ── get_state ───────────────────────────────────────────────────────────

  @objc(getState:reject:)
  func getState(_ resolve: @escaping RCTPromiseResolveBlock,
                reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      guard let window = self.mainWindow() else {
        return reject("NO_WINDOW", "no key window", nil)
      }
      var vcs: [String] = []
      if let root = window.rootViewController {
        Self.dumpVcStack(root, out: &vcs)
      }
      var result: [String: Any] = [
        "screen": [
          "width": Int(window.bounds.width),
          "height": Int(window.bounds.height),
          "scale": Double(window.screen.scale),
        ],
        "viewControllers": vcs,
      ]
      Self.probeNetwork { network in
        result["network"] = network
        resolve(result)
      }
    }
  }

  private static func dumpVcStack(_ vc: UIViewController, out: inout [String]) {
    var name = String(describing: type(of: vc))
    if let nav = vc as? UINavigationController {
      name += ": " + nav.viewControllers
        .map { String(describing: type(of: $0)) }
        .joined(separator: " > ")
    }
    out.append(name)
    if let tab = vc as? UITabBarController {
      for child in tab.children { dumpVcStack(child, out: &out) }
    }
    if let presented = vc.presentedViewController {
      out.append("↳ presented: " + String(describing: type(of: presented)))
      dumpVcStack(presented, out: &out)
    }
  }

  /// NWPathMonitor is callback-only; wait for the first path update with a
  /// 500ms timeout so get_state stays responsive.
  private static func probeNetwork(_ completion: @escaping ([String: Any]) -> Void) {
    let monitor = NWPathMonitor()
    let lock = NSLock()
    var done = false
    let finish: ([String: Any]) -> Void = { info in
      lock.lock()
      let first = !done
      done = true
      lock.unlock()
      if first { monitor.cancel(); completion(info) }
    }
    monitor.pathUpdateHandler = { path in
      finish([
        "connected": path.status == .satisfied,
        "type": path.usesInterfaceType(.wifi) ? "wifi"
            : path.usesInterfaceType(.cellular) ? "cellular" : "other",
      ])
    }
    monitor.start(queue: .global())
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
      finish(["connected": false, "type": "unknown"])
    }
  }

  // ── get_perf ────────────────────────────────────────────────────────────

  @objc(getPerf:reject:)
  func getPerf(_ resolve: @escaping RCTPromiseResolveBlock,
               reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      self.perfStamps = []
      let link = CADisplayLink(target: self, selector: #selector(self.perfFrame(_:)))
      self.perfDisplayLink = link
      link.add(to: .main, forMode: .default)
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.05) {
        link.invalidate()
        self.perfDisplayLink = nil
        var fps: [String: Any] = [:]
        if self.perfStamps.count >= 2 {
          let dur = self.perfStamps.last! - self.perfStamps.first!
          let gaps = zip(self.perfStamps, self.perfStamps.dropFirst())
            .map { ($1 - $0) * 1000.0 }.sorted()
          func pct(_ p: Double) -> Double { gaps[Int((Double(gaps.count - 1) * p))] }
          fps["fps"] = Double(self.perfStamps.count - 1) / dur
          fps["sampledFrames"] = self.perfStamps.count
          fps["frameMs"] = ["p50": pct(0.5), "p95": pct(0.95), "p99": pct(0.99)]
        } else {
          fps["fps"] = 0
          fps["sampledFrames"] = self.perfStamps.count
          fps["hint"] = "0 frames sampled — screen idle or no rendering during the 1s window"
        }
        resolve([
          "fps": fps,
          "memory": [
            "resident": Double(Self.residentSize()),
            "available": Double(os_proc_available_memory()),
            "physical": Double(ProcessInfo.processInfo.physicalMemory),
          ] as [String: Any],
        ])
      }
    }
  }

  @objc private func perfFrame(_ link: CADisplayLink) {
    perfStamps.append(link.timestamp)
  }

  private static func residentSize() -> Int {
    var info = mach_task_basic_info()
    var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / 4)
    let kr = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
      }
    }
    return kr == KERN_SUCCESS ? Int(info.resident_size) : 0
  }

  // ── view_component ──────────────────────────────────────────────────────

  @objc(viewComponent:reject:resolve:)
  func viewComponent(_ fieldId: NSNumber,
                     reject: @escaping RCTPromiseRejectBlock,
                     resolve: @escaping RCTPromiseResolveBlock) {
    DispatchQueue.main.async {
      guard let window = self.mainWindow() else {
        return reject("NO_WINDOW", "no key window", nil)
      }
      let tag = fieldId.intValue
      guard let v = Self.findView(window, tag: tag) else {
        return reject("VIEW_NOT_FOUND", "no view with reactTag/tag \(tag)", nil)
      }
      let frame = v.convert(v.bounds, to: nil)
      var m: [String: Any] = [
        "id": tag,
        "type": String(describing: type(of: v)),
        "alpha": Double(v.alpha),
        "visibility": v.isHidden ? "invisible" : "visible",
        "enabled": v.isUserInteractionEnabled,
        "clickable": v.isUserInteractionEnabled,
        "focused": v.isFirstResponder,
        "x": Int(frame.origin.x),
        "y": Int(frame.origin.y),
        "width": Int(frame.width),
        "height": Int(frame.height),
      ]
      if let textField = v as? UITextField {
        m["text"] = textField.text ?? ""
        if let placeholder = textField.placeholder { m["hint"] = placeholder }
        m["textSize"] = Double(fontPt(textField.font))
      } else if let label = v as? UILabel {
        m["text"] = label.text ?? ""
        if let hint = label.accessibilityLabel { m["hint"] = hint }
        m["textSize"] = Double(fontPt(label.font))
      }
      resolve(m)
    }
  }

  private func fontPt(_ font: UIFont?) -> CGFloat {
    font?.pointSize ?? 0
  }

  // ── prefs ───────────────────────────────────────────────────────────────

  private let defaults = UserDefaults.standard

  private func prefEntry(_ value: Any?) -> [String: Any] {
    switch value {
    case let v as String: return ["value": v, "valueType": "string"]
    case let v as Bool: return ["value": v, "valueType": "bool"]
    case let v as Int: return ["value": v, "valueType": "int"]
    case let v as Double: return ["value": v, "valueType": "float"]
    default: return ["value": NSNull(), "valueType": "string"]
    }
  }

  @objc(prefsGet:reject:)
  func prefsGet(_ key: String,
                reject: @escaping RCTPromiseRejectBlock,
                resolve: @escaping RCTPromiseResolveBlock) {
    let raw = defaults.object(forKey: key)
    if raw == nil { return resolve(NSNull()) }
    resolve(prefEntry(raw))
  }

  @objc(prefsSet:reject:resolve:)
  func prefsSet(_ opts: [String: Any],
                reject: @escaping RCTPromiseRejectBlock,
                resolve: @escaping RCTPromiseResolveBlock) {
    guard let key = opts["key"] as? String else {
      return reject("PREFS_INVALID", "key required", nil)
    }
    let valueType = opts["valueType"] as? String ?? "string"
    switch valueType {
    case "bool":
      defaults.set((opts["value"] as? NSNumber)?.boolValue ?? false, forKey: key)
    case "int", "long":
      let n = (opts["value"] as? NSNumber)?.int64Value
        ?? Int64(opts["value"] as? String ?? "0") ?? 0
      defaults.set(n, forKey: key)
    case "float":
      let d = (opts["value"] as? NSNumber)?.doubleValue
        ?? Double(opts["value"] as? String ?? "0") ?? 0
      defaults.set(d, forKey: key)
    default:
      defaults.set(String(describing: opts["value"] ?? NSNull()), forKey: key)
    }
    resolve(NSNull())
  }

  @objc(prefsDelete:reject:resolve:)
  func prefsDelete(_ key: String,
                   reject: @escaping RCTPromiseRejectBlock,
                   resolve: @escaping RCTPromiseResolveBlock) {
    let had = defaults.object(forKey: key) != nil
    defaults.removeObject(forKey: key)
    resolve(had)
  }

  @objc(prefsList:reject:)
  func prefsList(_ resolve: @escaping RCTPromiseResolveBlock,
                 reject: @escaping RCTPromiseRejectBlock) {
    var out: [String: Any] = [:]
    for (k, v) in defaults.dictionaryRepresentation() {
      out[k] = prefEntry(v)
    }
    resolve(out)
  }
}

/// Responder-chain hook: when UIApplication.sendAction(to: nil) dispatches
/// omlCaptureFirstResponder, the instance that runs it IS the first responder.
extension UIResponder {
  @objc func omlCaptureFirstResponder() {
    OmlReactModule.currentFirstResponder = self
  }
}
