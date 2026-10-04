import Foundation
import Testing

@testable import NetricsKit

// The latest-review widget (ADR 0019 section 12): decoding (lenient, as
// every widget), the author line and the surface texts.

private func review(_ id: String, data: String, imageId: String = #""img-1""#) -> String {
    """
    {"id": "\(id)", "type": "review", "x": 0, "y": 0, "w": 4, "h": 3, "min": {"w": 4, "h": 3},
     "label": "Latest review · Wurfel", "imageId": \(imageId),
     "options": {"minRating": 4, "requireText": true, "showAuthor": false},
     "data": \(data)}
    """
}

private let withReview = """
    {"status": "ok", "updatedAt": "2026-10-04T09:00:00.000Z",
     "review": {"rating": 5, "title": "Finally", "body": "Finally a dashboard.", "author": null,
                "territory": "DE", "createdAt": "2026-10-04T07:02:00.000Z"}}
    """

private func slides(_ widgets: String) -> String {
    #"[{"id": "\#(slideA)", "durationSec": 20, "background": null, "widgets": [\#(widgets)], "layouts": []}]"#
}

@Suite struct ReviewWidgetTests {
    @Test func decodesAReview() throws {
        let payload = v3Payload(primaryFormat: "16x9", slides: slides(review("r", data: withReview)))
        let widget = try #require(payload.slides.first?.widgets.first)
        #expect(widget.minimum == StudioMinimum(w: 4, h: 3))
        #expect(widget.label == "Latest review · Wurfel")
        guard case .review(let imageId, let options, let data) = widget.content else {
            Issue.record("review")
            return
        }
        #expect(imageId == "img-1")
        #expect(options == ReviewWidgetOptions(minRating: 4, requireText: true, showAuthor: false))
        #expect(data.status == .ok)
        #expect(
            data.review
                == WidgetReview(
                    rating: 5, title: "Finally", body: "Finally a dashboard.", author: nil, territory: "DE",
                    createdAt: "2026-10-04T07:02:00.000Z"))
    }

    @Test func decodesTheStatesWithoutAReview() throws {
        let paused = #"{"status": "auth_failed", "updatedAt": null, "review": null}"#
        let unknown = #"{"status": "brand_new", "updatedAt": null, "review": null}"#
        let payload = v3Payload(
            primaryFormat: "16x9",
            slides: slides([review("a", data: paused, imageId: "null"), review("b", data: unknown)].joined(separator: ",")))
        let widgets = try #require(payload.slides.first?.widgets)
        guard case .review(let imageId, _, let data) = widgets[0].content else {
            Issue.record("review")
            return
        }
        #expect(imageId == nil)
        #expect(data == ReviewWidgetData(status: .authFailed))
        guard case .review(_, _, let later) = widgets[1].content else {
            Issue.record("review")
            return
        }
        // An unknown status falls back, as for every widget.
        #expect(later.status == .ok)
        #expect(later.review == nil)
    }

    @Test func aReviewWithoutDataIsAnEmptyCell() throws {
        let broken = #"{"id": "x", "type": "review", "x": 0, "y": 0, "w": 4, "h": 3, "label": "L", "options": {}}"#
        let payload = v3Payload(primaryFormat: "16x9", slides: slides(broken))
        let widget = try #require(payload.slides.first?.widgets.first)
        #expect(widget.content == .unsupported)
    }

    @Test func authorLine() {
        let now = ISODate.parse("2026-10-04T09:02:00.000Z")!
        let review = WidgetReview(
            rating: 5, author: "Marta P.", territory: "DE", createdAt: "2026-10-04T07:02:00.000Z")
        let english = ReviewText.authorLine(review, now: now, language: .en)
        #expect(english.hasPrefix("Marta P. · Germany · "))
        #expect(english.contains("2"))
        let german = ReviewText.authorLine(
            WidgetReview(rating: 5, author: "  ", territory: "DE", createdAt: "2026-10-04T07:02:00.000Z"),
            now: now, language: .de)
        #expect(german.hasPrefix("Deutschland · "))
        #expect(ReviewText.territoryName("usa", language: .en) == nil)
    }

    @Test func surfaceTexts() {
        let paused = ReviewText.surfaceTexts(.authFailed, language: .en)
        #expect(paused.headline == "App Store reviews paused — upload a new reviews key")
        #expect(ReviewText.surfaceTexts(.noData, language: .de).hint == "Noch keine Bewertungen")
        #expect(StudioLayout.minimumSize(.review) == (4, 3))
    }
}
