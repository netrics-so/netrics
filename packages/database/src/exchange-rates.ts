import { sql } from "drizzle-orm";

import type { Db, Transaction } from "./context.js";

// ECB euro reference rates (#191): installation-level reference data. The
// scheduler's rate job writes them as netrics_scheduler; netrics_app only
// reads them (migration 0031). Rates stay decimal strings end to end.

export interface StoredExchangeRate {
  /** YYYY-MM-DD, the ECB publication day. */
  date: string;
  currency: string;
  /** Units of the currency per euro, as published. */
  unitsPerEur: string;
}

const SOURCE = "ecb";
const MAX_RATES_PER_WRITE = 10_000;

/**
 * Stores parsed rates in one statement: new days are added, a corrected
 * rate replaces the stored one. Callers validate the whole file first, so a
 * malformed file never reaches this point.
 */
export async function upsertExchangeRates(
  db: Db,
  rates: readonly StoredExchangeRate[],
): Promise<number> {
  if (rates.length === 0) {
    return 0;
  }
  if (rates.length > MAX_RATES_PER_WRITE) {
    throw new RangeError("too many exchange rates in one write");
  }
  const rows = await db.execute(sql`
    insert into exchange_rates (source, rate_date, currency, units_per_eur)
    select ${SOURCE}, r.rate_date, r.currency, r.units_per_eur
    from jsonb_to_recordset(${JSON.stringify(
      rates.map((rate) => ({
        rate_date: rate.date,
        currency: rate.currency,
        units_per_eur: rate.unitsPerEur,
      })),
    )}::jsonb) as r(rate_date date, currency text, units_per_eur numeric)
    on conflict (source, rate_date, currency) do update
      set units_per_eur = excluded.units_per_eur, fetched_at = now()
      where exchange_rates.units_per_eur <> excluded.units_per_eur
    returning 1`);
  return rows.length;
}

/** The latest publication day stored, or null before the first fetch. */
export async function latestExchangeRateDate(
  db: Db | Transaction,
): Promise<string | null> {
  const [row] = await db.execute(sql`
    select max(rate_date)::text as latest
    from exchange_rates where source = ${SOURCE}`);
  return (row?.latest as string | null | undefined) ?? null;
}

/**
 * The currencies with a rate in the `recentDays` before the latest
 * publication day (the ones a display currency can be), and that day.
 */
export async function listRateCurrencies(
  tx: Db | Transaction,
  recentDays: number,
): Promise<{ currencies: string[]; latestDate: string | null }> {
  const rows = await tx.execute(sql`
    with latest as (
      select max(rate_date) as day from exchange_rates where source = ${SOURCE}
    )
    select distinct r.currency, latest.day::text as latest
    from exchange_rates r, latest
    where r.source = ${SOURCE}
      and r.rate_date > latest.day - ${recentDays}::int
    order by r.currency`);
  return {
    currencies: rows.map((row) => row.currency as string),
    latestDate: (rows[0]?.latest as string | undefined) ?? null,
  };
}

/** The rates of `currencies` published from `from` to `to` (inclusive). */
export async function findExchangeRates(
  tx: Db | Transaction,
  query: { currencies: readonly string[]; from: string; to: string },
): Promise<StoredExchangeRate[]> {
  if (query.currencies.length === 0) {
    return [];
  }
  const rows = await tx.execute(sql`
    select rate_date::text as date, currency, units_per_eur::text as rate
    from exchange_rates
    where source = ${SOURCE}
      and rate_date between ${query.from}::date and ${query.to}::date
      and currency in (${sql.join(
        query.currencies.map((currency) => sql`${currency}`),
        sql`, `,
      )})
    order by rate_date, currency`);
  return rows.map((row) => ({
    date: row.date as string,
    currency: row.currency as string,
    unitsPerEur: row.rate as string,
  }));
}
