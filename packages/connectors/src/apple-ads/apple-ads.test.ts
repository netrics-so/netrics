import {
  assertManifestCompatible,
  CURRENCY_MINOR_UNIT,
  observationKey,
  observationSchema,
} from "@netrics/connector-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  AMOUNT_ROUNDED_NOTE,
  APPLE_ADS_AD_GROUP_METRIC_KEYS,
  APPLE_ADS_METRIC_KEYS,
  AppleAdsReportError,
  appleAdsDimensions,
  appleAdsManifest,
  dayObservations,
  noteOnce,
  OTHERS,
  reportDayTimestamp,
} from "./index.js";

/** One day of `AppsMetrics` as Apple documents it (#370 confirms). */
function day(overrides: Record<string, unknown> = {}) {
  return {
    date: "2026-10-27",
    localSpend: { amount: "123.45", currency: "EUR" },
    impressions: 10_000,
    taps: 400,
    ttr: 0.04,
    cpt: { amount: "0.31", currency: "EUR" },
    tapInstalls: 90,
    viewInstalls: 10,
    totalInstalls: 100,
    tapNewDownloads: 70,
    viewNewDownloads: 8,
    totalNewDownloads: 78,
    tapRedownloads: 20,
    viewRedownloads: 2,
    totalRedownloads: 22,
    totalAvgCPI: { amount: "1.23", currency: "EUR" },
    tapPreOrdersPlaced: 0,
    ...overrides,
  };
}

const CAMPAIGN = { app: "1234567890", campaign: 542370539, country: "us" };
const options = (note = vi.fn()) => ({ accountCurrency: "EUR", note });

function valueOf(
  observations: ReturnType<typeof dayObservations>,
  metricKey: string,
  dimensions: Record<string, string> = {},
): number {
  return observations
    .filter(
      (o) =>
        o.metricKey === metricKey &&
        Object.entries(dimensions).every(([k, v]) => o.dimensions[k] === v),
    )
    .reduce((sum, o) => sum + o.value, 0);
}

describe("Apple Ads manifest", () => {
  it("validates against the SDK", () => {
    expect(assertManifestCompatible(appleAdsManifest)).toEqual(
      appleAdsManifest,
    );
  });

  it("has the six ADR 0020 metrics by country, then the same six by ad group in keys of their own", () => {
    const main = ["resource", "campaign", "country"];
    const byAdGroup = ["resource", "campaign", "ad_group"];
    expect(
      appleAdsManifest.metrics.map((metric) => [
        metric.key,
        metric.unit,
        metric.dimensions,
      ]),
    ).toEqual([
      ["apple_ads.spend", CURRENCY_MINOR_UNIT, [...main, "currency"]],
      ["apple_ads.impressions", "impressions", main],
      ["apple_ads.taps", "taps", main],
      ["apple_ads.installs", "installs", [...main, "attribution"]],
      ["apple_ads.new_downloads", "downloads", [...main, "attribution"]],
      ["apple_ads.redownloads", "downloads", [...main, "attribution"]],
      [
        "apple_ads.spend_by_ad_group",
        CURRENCY_MINOR_UNIT,
        [...byAdGroup, "currency"],
      ],
      ["apple_ads.impressions_by_ad_group", "impressions", byAdGroup],
      ["apple_ads.taps_by_ad_group", "taps", byAdGroup],
      [
        "apple_ads.installs_by_ad_group",
        "installs",
        [...byAdGroup, "attribution"],
      ],
      [
        "apple_ads.new_downloads_by_ad_group",
        "downloads",
        [...byAdGroup, "attribution"],
      ],
      [
        "apple_ads.redownloads_by_ad_group",
        "downloads",
        [...byAdGroup, "attribution"],
      ],
    ]);
    // Each ad-group key mirrors its main key's unit and attribution.
    for (const [field, key] of Object.entries(APPLE_ADS_AD_GROUP_METRIC_KEYS)) {
      const mainKey =
        APPLE_ADS_METRIC_KEYS[field as keyof typeof APPLE_ADS_METRIC_KEYS];
      expect(key).toBe(`${mainKey}_by_ad_group`);
    }
    for (const metric of appleAdsManifest.metrics) {
      expect(metric.kind, metric.key).toBe("delta");
      expect(metric.granularity, metric.key).toBe("day");
      expect(metric.aggregations[0], metric.key).toBe("sum");
    }
  });

  it("stores no ratios and no pre-orders", () => {
    const keys = appleAdsManifest.metrics.map((metric) => metric.key);
    for (const ratio of [
      "ttr",
      "cpt",
      "cpm",
      "cpi",
      "install_rate",
      "pre_order",
    ]) {
      expect(keys.some((key) => key.includes(ratio))).toBe(false);
    }
  });

  it("reaches only the Platform API; the token host is the host's", () => {
    expect(appleAdsManifest.outboundDomains).toEqual(["api.ads.apple.com"]);
    expect(appleAdsManifest.authStrategies).toEqual([
      { strategy: "signed-key", provider: "apple-ads" },
    ]);
  });
});

describe("reportDayTimestamp", () => {
  it("stamps Apple's day D as D T00:00:00Z", () => {
    expect(reportDayTimestamp("2026-10-27")).toBe("2026-10-27T00:00:00.000Z");
  });

  it.each(["2026-02-30", "2026-10-27 05", "27.10.2026", "", "2026-1-2"])(
    "refuses %j",
    (date) => {
      expect(() => reportDayTimestamp(date)).toThrow(AppleAdsReportError);
    },
  );
});

describe("appleAdsDimensions", () => {
  it("uses Apple's IDs, never names, as identity", () => {
    expect(appleAdsDimensions(CAMPAIGN)).toEqual({
      resource: "1234567890",
      campaign: "542370539",
      country: "US",
    });
    expect(
      appleAdsDimensions({ app: 1234567890, campaign: "1", adGroup: "0042" }),
    ).toEqual({ resource: "1234567890", campaign: "1", ad_group: "42" });
    expect(
      appleAdsDimensions({ app: "1", campaign: "2", country: OTHERS }),
    ).toEqual({ resource: "1", campaign: "2", country: "Others" });
  });

  it("is the same for a number and a string ID", () => {
    expect(appleAdsDimensions({ app: 7, campaign: 542370539 })).toEqual(
      appleAdsDimensions({ app: "7", campaign: "542370539" }),
    );
  });

  it.each([
    [{ app: "x", campaign: 1 }],
    [{ app: 1, campaign: -1 }],
    [{ app: 1, campaign: 1.5 }],
    // Beyond 2^53 a JSON number has lost digits already.
    [{ app: 1, campaign: 2 ** 53 + 2 }],
    [{ app: 1, campaign: 1, country: "USA" }],
    [{ app: 1, campaign: 1, country: "U1" }],
    [{ app: 1, campaign: 1, adGroup: 2, country: "US" }],
  ])("refuses %j", (identity) => {
    expect(() => appleAdsDimensions(identity)).toThrow(AppleAdsReportError);
  });
});

describe("dayObservations", () => {
  it("turns one day into spend, impressions, taps and attributed installs", () => {
    const observations = dayObservations(CAMPAIGN, day(), options());
    for (const observation of observations) {
      expect(observationSchema.parse(observation)).toEqual(observation);
      expect(observation.sourceTimestamp).toBe("2026-10-27T00:00:00.000Z");
    }
    const base = {
      resource: "1234567890",
      campaign: "542370539",
      country: "US",
    };
    expect(observations).toEqual([
      {
        metricKey: APPLE_ADS_METRIC_KEYS.spend,
        sourceTimestamp: "2026-10-27T00:00:00.000Z",
        value: 12_345,
        dimensions: { ...base, currency: "EUR" },
      },
      expect.objectContaining({
        metricKey: "apple_ads.impressions",
        value: 10_000,
        dimensions: base,
      }),
      expect.objectContaining({
        metricKey: "apple_ads.taps",
        value: 400,
        dimensions: base,
      }),
      expect.objectContaining({
        metricKey: "apple_ads.installs",
        value: 90,
        dimensions: { ...base, attribution: "tap" },
      }),
      expect.objectContaining({
        metricKey: "apple_ads.installs",
        value: 10,
        dimensions: { ...base, attribution: "view" },
      }),
      expect.objectContaining({
        metricKey: "apple_ads.new_downloads",
        value: 70,
        dimensions: { ...base, attribution: "tap" },
      }),
      expect.objectContaining({
        metricKey: "apple_ads.new_downloads",
        value: 8,
        dimensions: { ...base, attribution: "view" },
      }),
      expect.objectContaining({
        metricKey: "apple_ads.redownloads",
        value: 20,
        dimensions: { ...base, attribution: "tap" },
      }),
      expect.objectContaining({
        metricKey: "apple_ads.redownloads",
        value: 2,
        dimensions: { ...base, attribution: "view" },
      }),
    ]);
  });

  it("makes the headline total the sum over attribution", () => {
    const observations = dayObservations(CAMPAIGN, day(), options());
    expect(valueOf(observations, APPLE_ADS_METRIC_KEYS.installs)).toBe(100);
    expect(valueOf(observations, APPLE_ADS_METRIC_KEYS.newDownloads)).toBe(78);
    expect(valueOf(observations, APPLE_ADS_METRIC_KEYS.redownloads)).toBe(22);
    expect(
      valueOf(observations, APPLE_ADS_METRIC_KEYS.installs, {
        attribution: "view",
      }),
    ).toBe(10);
  });

  it("gives every observation its own identity, stable across replays", () => {
    const first = dayObservations(CAMPAIGN, day(), options());
    const keys = first.map(observationKey);
    expect(new Set(keys).size).toBe(keys.length);
    // A revised day (attribution settled) has the same keys, new values.
    const revised = dayObservations(
      CAMPAIGN,
      day({ tapInstalls: 95, totalInstalls: 105 }),
      options(),
    );
    expect(revised.map(observationKey)).toEqual(keys);
    // A renamed campaign is the same series: names are not identity.
    const renamed = dayObservations(
      { ...CAMPAIGN },
      day({ campaignName: "Renamed" }),
      options(),
    );
    expect(renamed.map(observationKey)).toEqual(keys);
  });

  it("keeps credits negative and the account's currency exponent", () => {
    const credit = dayObservations(
      CAMPAIGN,
      day({ localSpend: { amount: "-4.20", currency: "EUR" } }),
      options(),
    );
    expect(valueOf(credit, APPLE_ADS_METRIC_KEYS.spend)).toBe(-420);
    const yen = dayObservations(
      CAMPAIGN,
      day({ localSpend: { amount: "1500", currency: "JPY" } }),
      { accountCurrency: "JPY", note: vi.fn() },
    );
    expect(yen[0]).toMatchObject({
      value: 1500,
      dimensions: { currency: "JPY" },
    });
    const dinar = dayObservations(
      CAMPAIGN,
      day({ localSpend: { amount: "1.234", currency: "KWD" } }),
      { accountCurrency: "KWD", note: vi.fn() },
    );
    expect(dinar[0]).toMatchObject({
      value: 1234,
      dimensions: { currency: "KWD" },
    });
  });

  it("rounds extra decimals half to even and notes it once per sync", () => {
    const log = vi.fn();
    const note = noteOnce(log);
    const a = dayObservations(
      CAMPAIGN,
      day({ localSpend: { amount: "0.125", currency: "EUR" } }),
      { accountCurrency: "EUR", note },
    );
    const b = dayObservations(
      CAMPAIGN,
      day({ localSpend: { amount: "0.135", currency: "EUR" } }),
      { accountCurrency: "EUR", note },
    );
    expect(valueOf(a, APPLE_ADS_METRIC_KEYS.spend)).toBe(12);
    expect(valueOf(b, APPLE_ADS_METRIC_KEYS.spend)).toBe(14);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(
      new RegExp(`^${AMOUNT_ROUNDED_NOTE}: `),
    );
  });

  it.each([
    [
      "a malformed amount",
      { localSpend: { amount: "12,34", currency: "EUR" } },
    ],
    ["a float amount", { localSpend: { amount: 12.34, currency: "EUR" } }],
    ["another currency", { localSpend: { amount: "1.00", currency: "USD" } }],
    ["a total that is not tap plus view", { totalInstalls: 99 }],
    ["a negative count", { taps: -1 }],
    ["a fractional count", { impressions: 1.5 }],
    ["a missing field", { viewRedownloads: undefined }],
    ["an hourly date", { date: "2026-10-27 05" }],
  ])("refuses %s", (_case, overrides) => {
    expect(() => dayObservations(CAMPAIGN, day(overrides), options())).toThrow(
      AppleAdsReportError,
    );
  });
});
