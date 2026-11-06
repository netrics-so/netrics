import Foundation
import Testing

@testable import NetricsKit

// Settings on a turned TV (#298): the rotation transform the app applies,
// and focus moved by the press in the content's frame.

private let screen = StudioCanvas(width: 1920, height: 1080)

private func near(_ a: (x: Double, y: Double), _ b: (x: Double, y: Double)) -> Bool {
    abs(a.x - b.x) < 1e-9 && abs(a.y - b.y) < 1e-9
}

@Suite struct RotationTransformTests {
    @Test func theContentsCornersLandWhereAClockwiseTurnPutsThem() {
        // 0°: as laid out.
        #expect(near(ScreenRotation.none.screenPoint(x: 0, y: 0, screen: screen), (0, 0)))
        #expect(near(ScreenRotation.none.screenPoint(x: 1920, y: 1080, screen: screen), (1920, 1080)))
        // 90°: content 1080 × 1920; its top left goes to the panel's top right,
        // its bottom left to the top left.
        #expect(near(ScreenRotation.quarter.screenPoint(x: 0, y: 0, screen: screen), (1920, 0)))
        #expect(near(ScreenRotation.quarter.screenPoint(x: 0, y: 1920, screen: screen), (0, 0)))
        #expect(near(ScreenRotation.quarter.screenPoint(x: 1080, y: 1920, screen: screen), (0, 1080)))
        // 180°: upside down.
        #expect(near(ScreenRotation.half.screenPoint(x: 0, y: 0, screen: screen), (1920, 1080)))
        // 270°: content's top left goes to the panel's bottom left.
        #expect(near(ScreenRotation.threeQuarters.screenPoint(x: 0, y: 0, screen: screen), (0, 1080)))
        #expect(near(ScreenRotation.threeQuarters.screenPoint(x: 1080, y: 0, screen: screen), (0, 0)))
        // The centre stays.
        for rotation in ScreenRotation.allCases {
            let content = rotation.viewport(screen)
            #expect(near(rotation.screenPoint(x: content.width / 2, y: content.height / 2, screen: screen), (960, 540)))
        }
    }

    @Test func directionsTurnWithTheContent() {
        #expect(FocusDirection.allCases.map { ScreenRotation.none.screenDirection(ofContent: $0) } == [.up, .down, .left, .right])
        // 90°: the content's up points to the panel's right.
        #expect(FocusDirection.allCases.map { ScreenRotation.quarter.screenDirection(ofContent: $0) } == [.right, .left, .up, .down])
        #expect(FocusDirection.allCases.map { ScreenRotation.half.screenDirection(ofContent: $0) } == [.down, .up, .right, .left])
        #expect(FocusDirection.allCases.map { ScreenRotation.threeQuarters.screenDirection(ofContent: $0) } == [.left, .right, .down, .up])
        for rotation in ScreenRotation.allCases {
            for direction in FocusDirection.allCases {
                #expect(rotation.contentDirection(ofScreen: rotation.screenDirection(ofContent: direction)) == direction)
            }
        }
    }

    @Test func directionsAgreeWithTheTurnOfPoints() {
        // A step in the content, turned, is a step on the panel in screenDirection.
        for rotation in ScreenRotation.allCases {
            let content = rotation.viewport(screen)
            let centre = (x: content.width / 2, y: content.height / 2)
            let from = rotation.screenPoint(x: centre.x, y: centre.y, screen: screen)
            for direction in FocusDirection.allCases {
                let v = direction.vector
                let to = rotation.screenPoint(x: centre.x + 100 * v.x, y: centre.y + 100 * v.y, screen: screen)
                #expect(FocusDirection.from(to.x - from.x, to.y - from.y) == rotation.screenDirection(ofContent: direction))
            }
        }
    }

    @Test func onlyATurnedScreenMovesFocusItself() {
        #expect(!ScreenRotation.none.remapsFocus)
        #expect(ScreenRotation.quarter.remapsFocus)
        #expect(ScreenRotation.half.remapsFocus)
        #expect(ScreenRotation.threeQuarters.remapsFocus)
    }
}

@Suite struct FocusRemappingTests {
    /** Settings: Done and Unpair side by side; a grid with a second row for the vertical moves. */
    private let settings = FocusGrid([["done", "unpair"]])
    private let twoRows = FocusGrid([["a", "b", "c"], ["d", "e"]])

    @Test func pressesMoveInTheContentsFrame() {
        #expect(settings.target(from: "done", press: .right) == "unpair")
        #expect(settings.target(from: "unpair", press: .left) == "done")
        // Edges keep focus, as the focus engine does.
        #expect(settings.target(from: "done", press: .left) == nil)
        #expect(settings.target(from: "unpair", press: .right) == nil)
        #expect(settings.target(from: "done", press: .up) == nil)
        #expect(settings.target(from: "done", press: .down) == nil)
        #expect(twoRows.target(from: "b", press: .down) == "e")
        #expect(twoRows.target(from: "c", press: .down) == "e")
        #expect(twoRows.target(from: "e", press: .up) == "b")
        #expect(twoRows.target(from: "unknown", press: .up) == "a")
        #expect(FocusGrid<String>([[], ["x"]]).rows == [["x"]])
    }

    @Test func onATurnedScreenAPressMovesWhereTheViewerLooks() {
        // The viewer holds the remote upright in front of the turned TV, so a
        // press is a direction in the content. On the panel the move then goes
        // along the turned direction, which the focus engine would not pick:
        // it reads the press along the panel (checked in the simulator: at
        // 90° it moved Done → Unpair on "down", and not on "right").
        for rotation in ScreenRotation.allCases {
            let content = rotation.viewport(screen)
            // Done and Unpair as laid out: side by side, Done on the left.
            let done = rotation.screenPoint(x: 300, y: content.height - 200, screen: screen)
            let unpair = rotation.screenPoint(x: 600, y: content.height - 200, screen: screen)
            #expect(settings.target(from: "done", press: .right) == "unpair")
            let seen = FocusDirection.from(unpair.x - done.x, unpair.y - done.y)
            #expect(seen == rotation.screenDirection(ofContent: .right))
            // The press the focus engine would need for the same move.
            #expect(rotation.contentDirection(ofScreen: seen) == .right)
        }
        #expect(ScreenRotation.quarter.screenDirection(ofContent: .right) == .down)
        #expect(ScreenRotation.threeQuarters.screenDirection(ofContent: .right) == .up)
    }

    @Test func settingsTurnOnlyOncePaired() throws {
        var state = DeviceState()
        state.phase = .pairing
        #expect(ScreenView.settingsRotation(state) == .none)
        state.phase = .paired
        #expect(ScreenView.settingsRotation(state) == .none)
        state.payload = .v2(v3Payload(rotation: "90"))
        #expect(ScreenView.settingsRotation(state) == .quarter)
        state.payload = .v2(v3Payload(rotation: "270"))
        #expect(ScreenView.settingsRotation(state) == .threeQuarters)
        // The pairing screen stays upright, whatever the last payload said.
        state.phase = .pairing
        #expect(ScreenView.settingsRotation(state) == .none)
    }
}
