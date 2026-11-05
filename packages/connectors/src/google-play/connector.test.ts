import { describe, expect, it } from "vitest";
import {
  assertManifestCompatible,
  resourceIconsResultSchema,
  syncResultSchema,
  validateDatasetPage,
  type ConnectionContext,
  type SyncRequest,
  type SyncResult,
} from "@netrics/connector-sdk";

import {
  bucketName,
  manualPackages,
  STORAGE_SCOPE,
  REPORTING_SCOPE,
} from "./api.js";
import { createGooglePlayConnector, googlePlayManifest } from "./index.js";
import { listingFacts, listingSnapshot } from "./ratings.js";
import {
  ALPHA,
  BETA,
  fakePlay,
  TEST_BUCKET,
  TEST_NOW,
} from "./test-helpers.js";

const context: ConnectionContext = {
  connectionId: "play-test",
  credentials: { accessToken: "synthetic-access-token" },
  config: {
    reportBucket: `gs://${TEST_BUCKET}/stats/installs/`,
    ratingStorefront: "DE",
    ratingLanguage: "de",
  },
};
const request: SyncRequest = {
  mode: "backfill",
  from: "2026-10-01T00:00:00.000Z",
  to: new Date(TEST_NOW).toISOString(),
  resources: [ALPHA, BETA],
};
async function runAll(
  fake: ReturnType<typeof fakePlay>,
  config = context.config,
  selected: string[] | null = request.resources!,
) {
  const connector = createGooglePlayConnector({ now: () => TEST_NOW });
  const pages: SyncResult[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = syncResultSchema.parse(
      await connector.sync(
        { ...context, config },
        { ...request, resources: selected ?? undefined, cursor },
        fake.runtime,
      ),
    );
    for (const dataset of result.datasetPages ?? [])
      validateDatasetPage(
        googlePlayManifest.datasets!.find(
          (definition) => definition.key === dataset.datasetKey,
        )!,
        dataset,
      );
    pages.push(result);
    if (result.done) return pages;
    expect(result.nextCursor).toBeTruthy();
    expect(result.nextCursor).not.toBe(cursor);
    cursor = result.nextCursor;
  }
  throw new Error("Fixture sync did not finish");
}

describe("Google Play account connector", () => {
  it("never shares private console titles between connections or account previews", async () => {
    const connector = createGooglePlayConnector(),
      first = fakePlay(),
      second = fakePlay();
    first.apps.set(ALPHA, "Private unreleased title");
    expect(
      (await connector.discover(context, first.runtime)).find(
        (resource) => resource.id === ALPHA,
      )?.name,
    ).toBe("Private unreleased title");
    second.privateStatus.set("apps", 403);
    const other = await connector.discover(
      { ...context, connectionId: "different-tenant" },
      second.runtime,
    );
    expect(other.find((resource) => resource.id === ALPHA)?.name).toBe(ALPHA);
  });
  it("declares model-ready datasets and host-managed read-only Google authorization", () => {
    expect(() => assertManifestCompatible(googlePlayManifest)).not.toThrow();
    expect(googlePlayManifest.metrics).toEqual([]);
    expect(googlePlayManifest.datasets).toHaveLength(4);
    expect(googlePlayManifest.authStrategies).toEqual([
      {
        strategy: "oauth2",
        provider: "google",
        scopes: [STORAGE_SCOPE, REPORTING_SCOPE],
      },
    ]);
    expect(
      googlePlayManifest.datasets!.every(
        (dataset) => dataset.retentionDays === null,
      ),
    ).toBe(true);
    expect(
      bucketName({ reportBucket: `gs://${TEST_BUCKET}/stats/installs/` }),
    ).toBe(TEST_BUCKET);
    expect(
      bucketName({ reportBucket: "gs://pubsite_prod_0123456789/stats/" }),
    ).toBe("pubsite_prod_0123456789");
    for (const invalid of [
      "https://example.com/",
      "some-other-bucket",
      "gs://pubsite_prod_rev_x?token=bad",
    ])
      expect(() => bucketName({ reportBucket: invalid })).toThrow("report URI");
    expect(
      manualPackages({ packageNames: `${ALPHA}, ${BETA}\n${ALPHA}` }),
    ).toEqual([ALPHA, BETA]);
    expect(() =>
      manualPackages({ packageNames: "https://evil.example" }),
    ).toThrow("package names");
  });
  it("checks report access independently and explains partial permission without leaking provider diagnostics", async () => {
    const fake = fakePlay(),
      connector = createGooglePlayConnector();
    expect(await connector.check(context, fake.runtime)).toEqual({ ok: true });
    fake.privateStatus.set("earnings/", 403);
    expect(await connector.check(context, fake.runtime)).toMatchObject({
      ok: true,
      message: expect.stringContaining("financial data access"),
    });
    fake.privateStatus.set("stats/installs/", 403);
    const refused = await connector.check(context, fake.runtime);
    expect(refused).toMatchObject({ ok: false });
    expect(JSON.stringify(refused)).not.toContain(
      "private provider diagnostic",
    );
    expect(
      await connector.check({ ...context, config: {} }, fake.runtime),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("report URI"),
    });
  });
  it("discovers named apps across pages, includes manually named new apps and falls back to report IDs", async () => {
    const fake = fakePlay({ pageSize: 1 }),
      connector = createGooglePlayConnector();
    const resources = await connector.discover(
      {
        ...context,
        config: { ...context.config, packageNames: "com.example.new" },
      },
      fake.runtime,
    );
    expect(resources.map((resource) => [resource.id, resource.name])).toEqual([
      [ALPHA, "Alpha Notes"],
      [BETA, "Beta Tracker"],
      ["com.example.new", "com.example.new"],
    ]);
    expect(
      fake.calls.filter(
        (call) => call.url.hostname === "playdeveloperreporting.googleapis.com",
      ),
    ).toHaveLength(2);
    fake.privateStatus.set("apps", 403);
    const fallback = await createGooglePlayConnector().discover(
      context,
      fake.runtime,
    );
    expect(fallback.map((resource) => resource.id)).toEqual([ALPHA, BETA]);
  });
  it("keeps signed credentials on private hosts and returns safe public artwork", async () => {
    const fake = fakePlay(),
      connector = createGooglePlayConnector({ now: () => TEST_NOW });
    await connector.sync(context, request, fake.runtime);
    const icons = resourceIconsResultSchema.parse(
      await connector.resourceIcons!(
        context,
        { resources: [{ id: ALPHA }] },
        fake.runtime,
      ),
    );
    expect(icons.icons[0]).toMatchObject({
      resourceId: ALPHA,
      contentType: "image/png",
      data: Buffer.from(fake.png).toString("base64"),
    });
    expect(
      fake.calls
        .filter((call) =>
          ["play.google.com", "play-lh.googleusercontent.com"].includes(
            call.url.hostname,
          ),
        )
        .every((call) => call.init?.headers?.authorization === undefined),
    ).toBe(true);
  });
});

describe("public listing scope and availability", () => {
  it("keeps country, language and form factor explicit; zero ratings remain distinct from a missing listing", async () => {
    const fake = fakePlay();
    const first = await listingSnapshot(
      fake.runtime,
      ALPHA,
      { country: "DE", locale: "de" },
      request.to,
    );
    expect(first.record.values).toMatchObject({
      app_id: ALPHA,
      storefront: "DE",
      locale: "de",
      form_factor: "store_default",
      rating: "4.25",
      rating_count: 123456,
      availability: "available",
    });
    const none = await listingSnapshot(
      fake.runtime,
      BETA,
      { country: "DE", locale: "de" },
      request.to,
    );
    expect(none.record.values).toMatchObject({
      rating: null,
      rating_count: 0,
      availability: "unrated",
    });
    const missing = await listingSnapshot(
      fake.runtime,
      "com.example.missing",
      { country: "DE", locale: "de" },
      request.to,
    );
    expect(missing.record.values).toMatchObject({
      rating: null,
      rating_count: null,
      availability: "not_listed",
    });
    expect(
      fake.calls.every(
        (call) =>
          call.url.searchParams.get("gl") === "DE" &&
          call.url.searchParams.get("hl") === "de",
      ),
    ).toBe(true);
  });
  it("rejects unrelated or ambiguous JSON-LD and records blocked/malformed pages as unavailable", async () => {
    const body = {
      "@type": "SoftwareApplication",
      url: `https://play.google.com/store/apps/details?id=${BETA}`,
      aggregateRating: { ratingValue: "5", ratingCount: "10" },
    };
    const html = `<script type="application/ld+json">${JSON.stringify(body)}</script>`;
    expect(listingFacts(html, ALPHA)).toBeUndefined();
    expect(listingFacts(html + html, BETA)).toBeUndefined();
    const fake = fakePlay();
    fake.publicStatus.set(ALPHA, 429);
    expect(
      (
        await listingSnapshot(
          fake.runtime,
          ALPHA,
          { country: "US", locale: "en" },
          request.to,
        )
      ).record.values,
    ).toMatchObject({
      availability: "temporarily_unavailable",
      rating: null,
      rating_count: null,
    });
    fake.publicStatus.delete(ALPHA);
    fake.publicFacts.set(ALPHA, { malformed: true });
    expect(
      (
        await listingSnapshot(
          fake.runtime,
          ALPHA,
          { country: "US", locale: "en" },
          request.to,
        )
      ).record.values.availability,
    ).toBe("temporarily_unavailable");
  });
});

describe("complete report ingestion", () => {
  it("publishes ratings first, preserves exact source lines and reports missing months without zero data", async () => {
    const fake = fakePlay();
    const pages = await runAll(fake);
    expect(pages[0]?.datasetPages?.[0]?.datasetKey).toBe("store_ratings");
    const all = pages.flatMap((page) => page.datasetPages ?? []);
    const installs = all
      .filter((page) => page.datasetKey === "install_rows")
      .flatMap((page) => page.records);
    expect(installs).toHaveLength(4);
    expect(
      installs
        .filter((row) => row.values.app_id === ALPHA)
        .map((row) => row.values.daily_user_installs),
    ).toEqual(["10", "0", null]);
    const earnings = all
      .filter((page) => page.datasetKey === "earning_rows")
      .flatMap((page) => page.records);
    expect(earnings).toHaveLength(8);
    expect(earnings.some((row) => row.values.merchant_amount === "0.25")).toBe(
      true,
    );
    expect(earnings.some((row) => row.values.app_id === "__unmapped")).toBe(
      false,
    );
    const status = all
      .filter((page) => page.datasetKey === "report_status")
      .flatMap((page) => page.records.map((row) => row.values));
    expect(
      status.filter((row) => row.availability === "not_published"),
    ).toHaveLength(4);
    expect(
      status.filter((row) => row.availability === "available"),
    ).toHaveLength(4);
    expect(
      all
        .filter((page) =>
          ["install_rows", "earning_rows"].includes(page.datasetKey),
        )
        .every((page) => page.window?.from === "2026-10-01"),
    ).toBe(true);
    expect(pages.at(-1)).toMatchObject({ done: true, nextCursor: request.to });
    expect(JSON.stringify(pages)).not.toContain("synthetic-access-token");
  });
  it("isolates financial permission failures while installs continue and retains account adjustments only at account scope", async () => {
    const fake = fakePlay();
    fake.privateStatus.set("earnings/", 403);
    const pages = await runAll(fake);
    expect(
      pages
        .flatMap((page) => page.datasetPages ?? [])
        .some((page) => page.datasetKey === "install_rows"),
    ).toBe(true);
    expect(
      pages
        .flatMap((page) => page.datasetPages ?? [])
        .some((page) => page.datasetKey === "earning_rows"),
    ).toBe(false);
    expect(
      pages
        .flatMap((page) => page.datasetPages ?? [])
        .filter((page) => page.datasetKey === "report_status")
        .some(
          (page) =>
            page.records[0]?.values.availability === "permission_missing",
        ),
    ).toBe(true);
    const account = await runAll(fakePlay(), context.config, null);
    expect(
      account
        .flatMap((page) => page.datasetPages ?? [])
        .filter((page) => page.datasetKey === "earning_rows")
        .flatMap((page) => page.records)
        .some((row) => row.values.app_id === "__unmapped"),
    ).toBe(true);
  });
  it("leaves corrupted report partitions unpublished while continuing independent data", async () => {
    const fake = fakePlay();
    fake.put(
      "earnings/earnings_202610.zip",
      new TextEncoder().encode("invalid zip"),
    );
    const pages = await runAll(fake);
    expect(
      pages
        .flatMap((page) => page.datasetPages ?? [])
        .filter((page) => page.datasetKey === "earning_rows"),
    ).toHaveLength(0);
    expect(
      pages
        .flatMap((page) => page.datasetPages ?? [])
        .filter((page) => page.datasetKey === "report_status")
        .some(
          (page) => page.records[0]?.values.availability === "invalid_report",
        ),
    ).toBe(true);
  });
  it("does not access any provider when no apps are selected", async () => {
    const fake = fakePlay();
    const result = await createGooglePlayConnector({
      now: () => TEST_NOW,
    }).sync(context, { ...request, resources: [] }, fake.runtime);
    expect(result).toMatchObject({ observations: [], done: true });
    expect(fake.calls).toHaveLength(0);
  });
});
