import { readFileSync } from "node:fs";

import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConnectorResponse } from "@netrics/connector-sdk";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { loadConfig } from "./env.js";
import {
  ECB_90_DAYS_URL,
  ECB_DAILY_URL,
  EcbFormatError,
  parseEcbRates,
  type RatesHttp,
} from "./exchange-rates/ecb.js";
import {
  RATES_REFRESH_MS,
  RATES_RETRY_MS,
  createExchangeRateJob,
  refreshExchangeRates,
} from "./exchange-rates/job.js";
import { createScheduler, exchangeRateJobFor } from "./scheduler.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// The ECB rate job (#191), offline: stored ECB files stand in for the
// network, and the database is a migrated test database.

const fixture = (name: string) =>
  readFileSync(
    new URL(`./exchange-rates/fixtures/${name}`, import.meta.url),
    "utf8",
  );
// eurofxref-hist-90d.xml cut to 2026-09-25..2026-10-02 (6 days, 29 rates
// each), and eurofxref-daily.xml of 2026-10-02 as the ECB serves them.
const SAMPLE = fixture("eurofxref-hist-sample.xml");
const DAILY = fixture("eurofxref-daily.xml");

function response(status: number, body: string): ConnectorResponse {
  return {
    status,
    headers: {},
    text: () => body,
    json: () => JSON.parse(body) as unknown,
    bytes: () => new TextEncoder().encode(body),
  };
}

/** Answers each URL with a body, and records the requests. */
function fakeEcb(bodies: Record<string, ConnectorResponse>) {
  const requests: string[] = [];
  const http: RatesHttp = async (url) => {
    requests.push(url);
    const answer = bodies[url];
    if (!answer) {
      throw new Error(`unexpected request to ${url}`);
    }
    return answer;
  };
  return { http, requests };
}

describe("parseEcbRates", () => {
  it("reads every day and rate of the 90-day file as decimal strings", () => {
    const rates = parseEcbRates(SAMPLE);
    expect(rates).toHaveLength(6 * 29);
    expect(new Set(rates.map((rate) => rate.date))).toEqual(
      new Set([
        "2026-10-02",
        "2026-10-01",
        "2026-09-30",
        "2026-09-29",
        "2026-09-28",
        "2026-09-25",
      ]),
    );
    expect(rates).toContainEqual({
      date: "2026-10-02",
      currency: "USD",
      unitsPerEur: "1.1225",
    });
    expect(rates).toContainEqual({
      date: "2026-10-02",
      currency: "ISK",
      unitsPerEur: "137",
    });
  });

  it("reads the daily file, written with single quotes and indented", () => {
    const rates = parseEcbRates(DAILY);
    expect(rates.length).toBeGreaterThanOrEqual(20);
    expect(new Set(rates.map((rate) => rate.date)).size).toBe(1);
    expect(rates.find((rate) => rate.currency === "USD")?.unitsPerEur).toMatch(
      /^\d+\.\d+$/,
    );
  });

  it("rejects truncated, partial and malformed files as a whole", () => {
    const broken = [
      // Cut off mid-download.
      SAMPLE.slice(0, SAMPLE.length / 2),
      // A day with a few rates only.
      SAMPLE.replace(
        /(<Cube time="2026-10-01">)[\s\S]*?(<\/Cube>)/,
        '$1<Cube currency="USD" rate="1.1298"/>$2',
      ),
      // A rate that is not a decimal.
      SAMPLE.replace('rate="1.1225"', 'rate="1,1225"'),
      SAMPLE.replace('rate="1.1225"', 'rate="-1.1225"'),
      // A currency code that is not ISO 4217.
      SAMPLE.replace(
        'currency="USD" rate="1.1225"',
        'currency="usd" rate="1.1225"',
      ),
      // An impossible date.
      SAMPLE.replace('time="2026-09-30"', 'time="2026-09-31"'),
      // Something else inside a day.
      SAMPLE.replace(
        '<Cube currency="USD" rate="1.1225"/>',
        '<Cube currency="USD" rate="1.1225"/><Note>revised</Note>',
      ),
      // An error page.
      "<html><body>Service unavailable</body></html>",
      "",
    ];
    for (const xml of broken) {
      expect(() => parseEcbRates(xml)).toThrow(EcbFormatError);
    }
  });
});

describe("the rate job", () => {
  let testDb: TestDatabase;
  let schedulerDb: Database;
  let appDb: Database;
  let admin: Sql;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    const url = new URL(testDb.adminUrl);
    url.username = "netrics_scheduler";
    url.password = "netrics_scheduler";
    schedulerDb = createDatabase(url.toString());
    appDb = createDatabase(testDb.appUrl);
    admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  }, 60_000);

  afterAll(async () => {
    await schedulerDb.$client.end({ timeout: 5 }).catch(() => undefined);
    await appDb.$client.end({ timeout: 5 }).catch(() => undefined);
    await admin.end({ timeout: 5 }).catch(() => undefined);
  });

  const stored = async () =>
    (
      await admin`
        select count(*)::int as n, max(rate_date)::text as latest
        from exchange_rates`
    )[0] as { n: number; latest: string | null };

  it("backfills from the 90-day file, then reads the daily one", async () => {
    const { http, requests } = fakeEcb({
      [ECB_90_DAYS_URL]: response(200, SAMPLE),
      [ECB_DAILY_URL]: response(200, DAILY),
    });
    const now = new Date("2026-10-03T15:00:00Z");
    const first = await refreshExchangeRates(schedulerDb, http, now);
    expect(first).toEqual({
      url: ECB_90_DAYS_URL,
      stored: 174,
      latestDate: "2026-10-02",
    });
    const second = await refreshExchangeRates(schedulerDb, http, now);
    // The daily file repeats 2026-10-02 unchanged: nothing to store.
    expect(second).toMatchObject({ url: ECB_DAILY_URL, stored: 0 });
    expect(requests).toEqual([ECB_90_DAYS_URL, ECB_DAILY_URL]);
    const [usd] = await admin`
      select units_per_eur::text as rate from exchange_rates
      where rate_date = '2026-10-02' and currency = 'USD'`;
    expect(usd?.rate).toBe("1.1225");
  });

  it("keeps stored rates when a download is malformed or fails", async () => {
    const before = await stored();
    const now = new Date("2026-10-03T15:00:00Z");
    const partial = fakeEcb({
      [ECB_DAILY_URL]: response(
        200,
        DAILY.replace(/rate='[^']*'/, "rate='9.99"),
      ),
    });
    await expect(
      refreshExchangeRates(schedulerDb, partial.http, now),
    ).rejects.toThrow(EcbFormatError);
    const down = fakeEcb({ [ECB_DAILY_URL]: response(503, "") });
    await expect(
      refreshExchangeRates(schedulerDb, down.http, now),
    ).rejects.toThrow("HTTP 503");
    expect(await stored()).toEqual(before);
  });

  it("lets the app role read rates but never write them", async () => {
    const rows =
      await appDb.$client`select count(*)::int as n from exchange_rates`;
    expect(rows[0]?.n).toBe(174);
    await expect(
      appDb.$client`
        insert into exchange_rates (rate_date, currency, units_per_eur)
        values ('2026-10-05', 'USD', '1')`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      appDb.$client`update exchange_rates set units_per_eur = 1`,
    ).rejects.toThrow(/permission denied/);
    await expect(appDb.$client`delete from exchange_rates`).rejects.toThrow(
      /permission denied/,
    );
  });

  it("fetches again after six hours, or an hour after a failure", async () => {
    let clock = new Date("2026-10-03T15:00:00Z").getTime();
    let fail = true;
    const requests: string[] = [];
    const job = createExchangeRateJob({
      db: schedulerDb,
      http: async (url) => {
        requests.push(url);
        return fail ? response(500, "") : response(200, DAILY);
      },
      logger: pino({ level: "silent" }),
      now: () => new Date(clock),
    });
    job.tick();
    await job.idle();
    expect(requests).toHaveLength(1);
    clock += RATES_RETRY_MS - 1;
    job.tick();
    await job.idle();
    expect(requests).toHaveLength(1);
    fail = false;
    clock += 1;
    job.tick();
    await job.idle();
    expect(requests).toHaveLength(2);
    clock += RATES_REFRESH_MS - 1;
    job.tick();
    await job.idle();
    expect(requests).toHaveLength(2);
  });

  it("makes no request to the ECB with NETRICS_EXCHANGE_RATES=off", async () => {
    const config = loadConfig({ NETRICS_EXCHANGE_RATES: "off" });
    expect(config.exchangeRates).toBe(false);
    expect(loadConfig({}).exchangeRates).toBe(true);
    const requests: string[] = [];
    const http: RatesHttp = async (url) => {
      requests.push(url);
      return response(200, DAILY);
    };
    const logger = pino({ level: "silent" });
    expect(exchangeRateJobFor(config, schedulerDb, logger, http)).toEqual({});
    const scheduler = createScheduler({
      schedulerDb,
      pollMs: 10,
      logger,
      ...exchangeRateJobFor(config, schedulerDb, logger, http),
    });
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await scheduler.stop();
    expect(requests).toEqual([]);

    // Turned on, the same scheduler fetches.
    const on = createScheduler({
      schedulerDb,
      pollMs: 10,
      logger,
      ...exchangeRateJobFor({ exchangeRates: true }, schedulerDb, logger, http),
    });
    on.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await on.stop();
    expect(requests.length).toBeGreaterThan(0);
  });
});
