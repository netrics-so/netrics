import Foundation

// Focus on a turned screen (ADR 0017, section 7; #298). Everything after
// pairing, settings included, turns by the device's rotation setting. The
// tvOS focus engine moves focus along the panel, but the viewer holds the
// Siri Remote upright in front of a TV hung on its side: pressing up means
// up in the turned content. So on a turned screen the app moves focus
// itself, by the press taken in the content's frame. Pure, so it is tested
// on a Mac.

/** A press on the Siri Remote's clickpad, or a direction on the panel or in the content. */
public enum FocusDirection: Sendable, Equatable, CaseIterable {
    case up, down, left, right

    /** The unit vector, y pointing down as on screen. */
    var vector: (x: Double, y: Double) {
        switch self {
        case .up: return (0, -1)
        case .down: return (0, 1)
        case .left: return (-1, 0)
        case .right: return (1, 0)
        }
    }

    static func from(_ x: Double, _ y: Double) -> FocusDirection {
        abs(x) >= abs(y) ? (x < 0 ? .left : .right) : (y < 0 ? .up : .down)
    }
}

extension ScreenRotation {
    /**
     * The turn the app applies: content laid out at `viewport(screen)`,
     * turned clockwise by the setting about the screen's centre. Returns
     * where a point of the content lands on the panel.
     */
    public func screenPoint(x: Double, y: Double, screen: StudioCanvas) -> (x: Double, y: Double) {
        let content = viewport(screen)
        let dx = x - content.width / 2
        let dy = y - content.height / 2
        let turned = Self.turn(dx, dy, degrees: rawValue)
        return (turned.x + screen.width / 2, turned.y + screen.height / 2)
    }

    /** Where a direction of the content points on the panel. */
    public func screenDirection(ofContent direction: FocusDirection) -> FocusDirection {
        let v = direction.vector
        let turned = Self.turn(v.x, v.y, degrees: rawValue)
        return FocusDirection.from(turned.x, turned.y)
    }

    /**
     * The direction in the content that lies along a direction on the
     * panel: where the tvOS focus engine would move on a press, since it
     * reads presses along the panel.
     */
    public func contentDirection(ofScreen direction: FocusDirection) -> FocusDirection {
        let v = direction.vector
        let turned = Self.turn(v.x, v.y, degrees: (360 - rawValue) % 360)
        return FocusDirection.from(turned.x, turned.y)
    }

    /** True when presses must be moved by the app: the panel's directions are not the content's. */
    public var remapsFocus: Bool { self != .none }

    /** Clockwise on screen (y down), in exact quarter turns. */
    static func turn(_ x: Double, _ y: Double, degrees: Int) -> (x: Double, y: Double) {
        switch (degrees % 360 + 360) % 360 {
        case 90: return (-y, x)
        case 180: return (-x, -y)
        case 270: return (y, -x)
        default: return (x, y)
        }
    }
}

/**
 * The focusable items of a screen as the content lays them out: rows from
 * top to bottom, items from left to right. Moves focus by a press taken in
 * the content's frame, which on a turned screen is the viewer's frame.
 */
public struct FocusGrid<ID: Hashable & Sendable>: Sendable, Equatable {
    public var rows: [[ID]]

    public init(_ rows: [[ID]]) {
        self.rows = rows.filter { !$0.isEmpty }
    }

    func position(of id: ID) -> (row: Int, column: Int)? {
        for (row, items) in rows.enumerated() {
            if let column = items.firstIndex(of: id) { return (row, column) }
        }
        return nil
    }

    /**
     * The item a press moves focus to, or nil at an edge (focus stays, as
     * the tvOS focus engine does). Up and down go to the next row, to the
     * item at the same place in it or its last one. An unknown item moves
     * to the first.
     */
    public func target(from id: ID, press: FocusDirection) -> ID? {
        guard let (row, column) = position(of: id) else { return rows.first?.first }
        switch press {
        case .left: return column > 0 ? rows[row][column - 1] : nil
        case .right: return column + 1 < rows[row].count ? rows[row][column + 1] : nil
        case .up, .down:
            let next = row + (press == .up ? -1 : 1)
            guard rows.indices.contains(next) else { return nil }
            return rows[next][min(column, rows[next].count - 1)]
        }
    }
}

extension ScreenView {
    /**
     * The rotation of the settings screen: the dashboard's once paired, so
     * settings turn with the content; upright while pairing (the pairing
     * screen stays upright) or blocked.
     */
    public static func settingsRotation(_ state: DeviceState) -> ScreenRotation {
        state.phase == .paired ? rotation(state.dashboardV2) : .none
    }
}
