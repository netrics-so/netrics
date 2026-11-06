import type { Logger } from "pino";

import {
  latestExchangeRateDate,
  upsertExchangeRates,
  type Database,
} from "@netrics/database";
import { addDays, civilDate } from "@netrics/domain";

import {
  ECB_90_DAYS_URL,
  ECB_DAILY_URL,
  parseEcbRates,
  type RatesHttp,
} from "./ecb.js";

// The rate job (#191) runs inside the scheduler as netrics_scheduler, the
// only role that may write exchange_rates. It is off with
// NETRICS_EXCHANGE_RATES=off: then the scheduler never contacts the ECB.

/** After a successful fetch, look again this much later. */
export const RATES_REFRESH_MS = 6 * 60 * 60 * 1000;
/** After a failed fetch, retry this much later. */
export const RATES_RETRY_MS = 60 * 60 * 1000;
/**
 * With nothing stored, or the last stored day older than this, the 90-day
 * file backfills the gap instead of the daily one.
 */
const BACKFILL_AFTER_DAYS = 4;

export interface RatesRefreshResult {
  url: string;
  /** Rows added or corrected. */
  stored: number;
  /** The last publication day stored afterwards. */
  latestDate: string | null;
}

/**
 * One fetch: the 90-day file when the table is empty or behind, else the
 * daily file. Throws on HTTP errors and malformed files (nothing stored).
 */
export async function refreshExchangeRates(
  db: Database,
  http: RatesHttp,
  now: Date = new Date(),
): Promise<RatesRefreshResult> {
  const latest = await latestExchangeRateDate(db);
  const behind =
    latest === null ||
    latest < addDays(civilDate(now, "UTC"), -BACKFILL_AFTER_DAYS);
  const url = behind ? ECB_90_DAYS_URL : ECB_DAILY_URL;
  const response = await http(url);
  if (response.status !== 200) {
    throw new Error(`ECB answered HTTP ${response.status}`);
  }
  const rates = parseEcbRates(response.text());
  const stored = await upsertExchangeRates(db, rates);
  return { url, stored, latestDate: await latestExchangeRateDate(db) };
}

export interface ExchangeRateJob {
  /**
   * Starts a fetch when one is due and none is running; never throws and
   * never waits for the network, so sync planning is not held up.
   */
  tick(): void;
  /** Waits for a running fetch. */
  idle(): Promise<void>;
}

export function createExchangeRateJob(deps: {
  db: Database;
  http: RatesHttp;
  logger: Logger;
  now?: () => Date;
}): ExchangeRateJob {
  const now = deps.now ?? (() => new Date());
  let nextAttemptAt = 0;
  let running: Promise<void> | null = null;

  async function run(): Promise<void> {
    try {
      const result = await refreshExchangeRates(deps.db, deps.http, now());
      nextAttemptAt = now().getTime() + RATES_REFRESH_MS;
      deps.logger.info(result, "exchange rates refreshed");
    } catch (error) {
      nextAttemptAt = now().getTime() + RATES_RETRY_MS;
      // The message only: never a response body.
      deps.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "exchange rate refresh failed",
      );
    }
  }

  return {
    tick() {
      if (running || now().getTime() < nextAttemptAt) {
        return;
      }
      running = run().finally(() => {
        running = null;
      });
    },
    async idle() {
      await running;
    },
  };
}
