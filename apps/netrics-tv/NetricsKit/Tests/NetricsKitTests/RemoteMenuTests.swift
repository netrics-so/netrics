import Foundation
import Synchronization
import Testing

@testable import NetricsKit

/** The clickpad menu on Apple TV (#737). */
@Suite struct RemoteMenuTests {
    @Test func aSinglePressShowsItAndItHidesFiveSecondsAfterTheLastPress() {
        var menu = RemoteMenu()
        #expect(!menu.isShown)
        #expect(menu.hidesAt == nil)

        menu.show(now: T0)
        #expect(menu.isShown)
        #expect(menu.hidesAt == T0.addingTimeInterval(5))
        let hid1 = menu.expire(now: T0.addingTimeInterval(4.9))
        #expect(!hid1)
        #expect(menu.isShown)

        // A move or Pause in the menu starts its time again.
        menu.pressed(now: T0.addingTimeInterval(4))
        let hid2 = menu.expire(now: T0.addingTimeInterval(8.9))
        #expect(!hid2)
        let hid3 = menu.expire(now: T0.addingTimeInterval(9))
        #expect(hid3)
        #expect(!menu.isShown)
    }

    @Test func aPressWhileHiddenDoesNotShowIt() {
        var menu = RemoteMenu()
        menu.pressed(now: T0)
        #expect(!menu.isShown)
        let hid4 = menu.expire(now: T0.addingTimeInterval(60))
        #expect(!hid4)
    }

    @Test func backClosesTheMenuAndOnlyThenIsTakenFromTheSystem() {
        var menu = RemoteMenu()
        // Hidden: Back is not the app's, so it leaves the app as always.
        let closed5 = menu.back()
        #expect(!closed5)
        menu.show(now: T0)
        // Shown: Back closes the menu and the app stays.
        let closed6 = menu.back()
        #expect(closed6)
        #expect(!menu.isShown)
        let closed7 = menu.back()
        #expect(!closed7)
    }

    @Test func pauseIsOfferedOnlyWhenTheSlidesRotate() {
        #expect(RemoteMenu.items(canPause: true) == [.pauseResume, .settings])
        #expect(RemoteMenu.items(canPause: false) == [.settings])
    }

    @Test func hideAgainAfterShowingAgain() {
        var menu = RemoteMenu()
        menu.show(now: T0)
        menu.hide()
        #expect(!menu.isShown)
        menu.show(now: T0.addingTimeInterval(30))
        #expect(menu.hidesAt == T0.addingTimeInterval(35))
    }
}

/** "Press the clickpad for the menu": after pairing and once per app version (#737). */
@Suite struct MenuHintTests {
    final class Store: Sendable {
        let value = Mutex<String?>(nil)
        var hint: MenuHint {
            MenuHint(read: { self.value.withLock { $0 } }, write: { new in self.value.withLock { $0 = new } })
        }
    }

    @Test func showsOncePerVersion() {
        let store = Store()
        let hint = store.hint
        let version = MenuHint.versionKey(version: "0.3.1", build: "12")
        #expect(version == "0.3.1 (12)")
        // The first launch of this version.
        #expect(hint.take(version: version, justPaired: false))
        // Every later launch of it: no hint.
        #expect(!hint.take(version: version, justPaired: false))
        #expect(!hint.take(version: version, justPaired: false))
        // An update (a new build counts): once again.
        let update = MenuHint.versionKey(version: "0.3.1", build: "13")
        #expect(hint.take(version: update, justPaired: false))
        #expect(!hint.take(version: update, justPaired: false))
        #expect(hint.take(version: "0.4.0 (1)", justPaired: false))
    }

    @Test func showsAfterEveryPairing() {
        let store = Store()
        let hint = store.hint
        #expect(hint.take(version: "0.3.1 (12)", justPaired: true))
        // Paired again (after an unpair) in the same version: shown again.
        #expect(hint.take(version: "0.3.1 (12)", justPaired: true))
        // A plain relaunch afterwards: not.
        #expect(!hint.take(version: "0.3.1 (12)", justPaired: false))
    }

    @Test func isDueDoesNotRecord() {
        let store = Store()
        let hint = store.hint
        #expect(hint.isDue(version: "1 (1)", justPaired: false))
        #expect(hint.isDue(version: "1 (1)", justPaired: false))
        #expect(store.value.withLock { $0 } == nil)
    }
}

/** When the hint shows in a session: never behind the settings, and not lost to them. */
@Suite struct PendingHintTests {
    @Test func showsWhenItsDelayIsOver() {
        var pending = PendingHint()
        #expect(pending.wait(now: T0, blocked: false) == nil)
        pending.arm(now: T0)
        #expect(pending.wait(now: T0, blocked: false) == 8)
        #expect(pending.wait(now: T0.addingTimeInterval(8), blocked: false) == 0)
        pending.shown()
        #expect(pending.wait(now: T0.addingTimeInterval(9), blocked: false) == nil)
    }

    @Test func settingsOpenWhenItIsDueKeepItForAfterTheyClose() {
        var pending = PendingHint()
        pending.arm(now: T0)
        // The settings are open when the 8 s are over: not now, but still pending.
        #expect(pending.wait(now: T0.addingTimeInterval(8), blocked: true) == nil)
        #expect(pending.isArmed)
        // Closed later: it follows a moment after, not at once over the closing sheet.
        #expect(pending.wait(now: T0.addingTimeInterval(20), blocked: false) == PendingHint.afterSettings)
        // Closed before its time: it keeps its time.
        var early = PendingHint()
        early.arm(now: T0)
        #expect(early.wait(now: T0.addingTimeInterval(3), blocked: false) == 5)
    }

    @Test func armingAgainKeepsTheFirstTime() {
        var pending = PendingHint()
        pending.arm(now: T0)
        pending.arm(now: T0.addingTimeInterval(5))
        #expect(pending.wait(now: T0.addingTimeInterval(5), blocked: false) == 3)
        pending.cancel()
        #expect(!pending.isArmed)
    }
}
