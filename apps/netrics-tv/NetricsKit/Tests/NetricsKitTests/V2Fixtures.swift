import Foundation

@testable import NetricsKit

// Schema 2 payloads as the server writes them (deviceDashboardV2ResponseSchema,
// apps/server/src/devices/dashboard.ts), plus what a newer server may add.

let logoBytes = Data("logo-png-bytes".utf8)
let backgroundBytes = Data("background-jpeg-bytes".utf8)
let logoHash = ImageHash.sha256(logoBytes)
let backgroundHash = ImageHash.sha256(backgroundBytes)
let logoID = "11111111-1111-4111-8111-111111111111"
let backgroundID = "22222222-2222-4222-8222-222222222222"
let slideA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
let slideB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

func v2JSON(version: String = "v2-1", slides: String? = nil, images: String? = nil) -> String {
    """
    {
      "version": "\(version)",
      "schema": 2,
      "refreshAfterSec": 60,
      "timeZone": "Europe/Berlin",
      "futureField": {"anything": [1, 2, 3]},
      "dashboard": {"id": "4c1e2d3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f", "name": "Wurfel", "showHeader": true,
                    "logo": {"imageId": "\(logoID)"}},
      "theme": {"name": "Midnight", "tokens": {
        "background": "#0B1020", "surface": "#121a33", "border": "#24305a", "text": "#eef2ff",
        "label": "#c7d2fe", "muted": "#94a3c8", "accent": "#ffcc00", "up": "#86efac", "down": "#fca5a5",
        "warning": "#fbbf24", "chartLine": "#64748b", "chartFill": "#3b82f6", "fontScale": 1.15}},
      "rotation": {"autoAdvance": true, "transition": "fade"},
      "grid": {"columns": 12, "rows": 8},
      "slides": \(slides ?? defaultSlides),
      "images": \(images ?? defaultImages)
    }
    """
}

let defaultImages = """
    [
      {"id": "\(logoID)", "sha256": "\(logoHash)", "contentType": "image/png", "width": 512, "height": 512,
       "bytes": \(logoBytes.count), "url": "/v1/device/images/\(logoID)?v=\(logoHash)"},
      {"id": "\(backgroundID)", "sha256": "\(backgroundHash)", "contentType": "image/jpeg", "width": 1920,
       "height": 1080, "bytes": \(backgroundBytes.count), "url": "/v1/device/images/\(backgroundID)?v=\(backgroundHash)"},
      {"id": "33333333-3333-4333-8333-333333333333", "sha256": "../../etc/passwd", "contentType": "image/png",
       "width": 1, "height": 1, "bytes": 1, "url": "/v1/device/images/x"}
    ]
    """

let defaultSlides = """
    [
      {
        "id": "\(slideA)", "name": "Sales", "durationSec": 20,
        "background": {"imageId": "\(backgroundID)", "dim": 40},
        "widgets": [
          {"id": "w-metric", "type": "metric", "x": 0, "y": 0, "w": 4, "h": 3,
           "label": "Downloads · Wurfel", "options": {"showSparkline": true, "showChange": false},
           "data": {"period": "last_7_days", "aggregation": "sum", "value": 1284, "unit": "count",
                    "conversion": null, "kind": "flow", "granularity": "day", "better": "higher",
                    "change": {"previousValue": 1000, "delta": 284, "ratio": 0.284},
                    "spark": [1, 2, null, 4], "status": "ok", "updatedAt": "2026-10-04T08:00:00.000Z"}},
          {"id": "w-line", "type": "line", "x": 4, "y": 0, "w": 8, "h": 4,
           "label": "Revenue · All apps", "options": {"showPrevious": true, "showAxis": false},
           "data": {"period": "last_7_days", "aggregation": "sum", "value": 9900, "unit": "EUR_minor",
                    "conversion": {"displayCurrency": "EUR", "source": "ECB euro foreign exchange reference rates",
                                   "unconverted": []},
                    "kind": "flow", "granularity": "day", "better": "lower",
                    "change": {"previousValue": null, "delta": null, "ratio": null},
                    "buckets": ["2026-09-28T00:00:00.000Z", "2026-09-29T00:00:00.000Z"],
                    "values": [100, null], "previous": [50, 60], "status": "stale", "updatedAt": null}},
          {"id": "w-bar", "type": "bar", "x": 0, "y": 3, "w": 4, "h": 5,
           "label": "Downloads", "options": {"groupBy": "territory", "limit": 5},
           "data": {"period": "last_30_days", "aggregation": "sum", "unit": "count", "conversion": null,
                    "kind": "flow", "granularity": "day", "better": "higher", "groupBy": "territory",
                    "bars": [{"key": "DE", "label": "Germany", "value": 812}, {"key": "US", "label": "United States", "value": 400},
                             {"broken": true}],
                    "others": {"label": "Others", "value": 77, "groups": 12}, "status": "ok",
                    "updatedAt": "2026-10-04T08:00:00.000Z"}},
          {"id": "w-gauge", "type": "heatmap", "x": 4, "y": 4, "w": 2, "h": 2, "label": "A newer widget",
           "options": {"needle": true}, "data": {"value": 3}},
          {"id": "w-broken", "type": "metric", "x": 6, "y": 4, "w": 2, "h": 2, "label": "Broken",
           "data": "not an object"},
          {"id": "w-outside", "type": "text", "x": 11, "y": 7, "w": 4, "h": 4, "label": null, "text": "x"},
          {"type": "text", "x": 0, "y": 0, "w": 2, "h": 1, "text": "no id"}
        ]
      },
      {
        "id": "\(slideB)", "name": null, "durationSec": 10, "background": null,
        "widgets": [
          {"id": "w-image", "type": "image", "x": 0, "y": 0, "w": 3, "h": 3, "label": null,
           "imageId": "\(logoID)", "options": {"fit": "cover", "align": "end"}},
          {"id": "w-text", "type": "text", "x": 3, "y": 0, "w": 5, "h": 3, "label": null,
           "text": "## Wurfel\\nDaily **numbers** <b>not html</b>", "options": {"size": "huge", "align": "center"}},
          {"id": "w-clock", "type": "clock", "x": 8, "y": 0, "w": 4, "h": 2, "label": null,
           "options": {"showDate": true, "hour12": false, "timeZone": "America/New_York"}}
        ]
      },
      {"id": 42, "widgets": []}
    ]
    """

func v2Payload(version: String = "v2-1", slides: String? = nil, images: String? = nil) -> DeviceDashboardV2 {
    try! JSONDecoder().decode(DeviceDashboardV2.self, from: Data(v2JSON(version: version, slides: slides, images: images).utf8))
}

func v2Response(version: String = "v2-1", slides: String? = nil, images: String? = nil, etag: String? = nil)
    -> HTTPResponse
{
    HTTPResponse(
        status: 200, headers: ["etag": etag ?? "\"\(version)\""],
        body: Data(v2JSON(version: version, slides: slides, images: images).utf8))
}

func serverInfo(schemas: [Int]?) -> HTTPResponse {
    var object: [String: Any] = [
        "product": "netrics", "deviceApiVersion": 1, "version": "1.0.0",
        "pairingUrl": "https://kiosk.test/devices/approve",
    ]
    if let schemas { object["dashboardSchemas"] = schemas }
    return jsonObject(object, status: 200)
}
