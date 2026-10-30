// Switchboard's notification helper for macOS. It posts a banner that opens a
// link when clicked: a link back to VS Code, which brings the session's tab
// forward. osascript can't do this (a click on its banner opens Script
// Editor), so the extension ships this small app and runs it instead.
//
//   Switchboard post <title> <message> <link>
//     Posts a banner. Exit 0: posted. 3: notifications are off for
//     Switchboard. 4: macOS refused the banner. 5: no answer to the
//     permission prompt in time (the prompt stays up). 2: wrong arguments.
//   Switchboard status
//     Prints the permission state, for the extension's log.
//
// Started with no arguments (macOS does this when a banner is clicked after
// the helper has quit), it waits for the click and opens its link.

import AppKit
import UserNotifications

let linkKey = "link"
let answerTimeout: TimeInterval = 8
let clickTimeout: TimeInterval = 10

final class Helper: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  let args = Array(CommandLine.arguments.dropFirst())
  let center = UNUserNotificationCenter.current()
  /** The permission prompt was answered, or its wait ran out: whichever comes first wins. */
  var settled = false

  func applicationWillFinishLaunching(_ notification: Notification) {
    // Set before launch finishes, so a click that started this process is delivered.
    center.delegate = self
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    switch args.first {
    case "post" where args.count == 4: post(title: args[1], message: args[2], link: args[3])
    case "status": status()
    case nil: after(clickTimeout) { self.quit(0) }
    default: fail(2, "usage: Switchboard post <title> <message> <link> | status")
    }
  }

  func post(title: String, message: String, link: String) {
    after(answerTimeout) {
      guard !self.settled else { return }
      self.settled = true
      self.fail(5, "no answer to the notification prompt yet")
    }
    center.requestAuthorization(options: [.alert]) { granted, _ in
      DispatchQueue.main.async {
        // An answer after the wait ran out posts nothing: the extension has shown the banner another way.
        guard !self.settled else { return }
        self.settled = true
        guard granted else {
          self.fail(3, "notifications are off for Switchboard (System Settings > Notifications)")
          return
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = message
        content.userInfo = [linkKey: link]
        self.center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) { error in
          if let error { self.fail(4, error.localizedDescription) } else { self.quit(0) }
        }
      }
    }
  }

  func status() {
    center.getNotificationSettings { s in
      let states = [0: "not asked yet", 1: "denied", 2: "allowed", 3: "provisional", 4: "ephemeral"]
      print(states[s.authorizationStatus.rawValue] ?? "unknown")
      self.quit(0)
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler done: @escaping () -> Void
  ) {
    if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
      let s = response.notification.request.content.userInfo[linkKey] as? String,
      let url = URL(string: s), url.scheme != nil, !url.isFileURL
    {
      NSWorkspace.shared.open(url)
    }
    done()
    // A click can reach a helper that is posting another banner: that one quits when its post is done.
    if args.isEmpty { quit(0) }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    done([.banner, .list])
  }

  func after(_ seconds: TimeInterval, _ f: @escaping () -> Void) {
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: f)
  }

  func fail(_ code: Int32, _ why: String) {
    FileHandle.standardError.write(Data((why + "\n").utf8))
    quit(code)
  }

  func quit(_ code: Int32) {
    DispatchQueue.main.async { exit(code) }
  }
}

let app = NSApplication.shared
let helper = Helper()
app.delegate = helper
app.setActivationPolicy(.accessory)
app.run()
