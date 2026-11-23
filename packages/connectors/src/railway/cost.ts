// Railway's API has no money amount per project: `usage` and
// `estimatedUsage` answer resource quantities. The connector prices them
// with Railway's public list prices for containers, so the result is an
// estimate of the resource usage part of the bill. Not included: the plan's
// subscription fee, the usage it includes, credits, discounts, VM rates
// (sandboxes, agents), backups and anything else Railway bills apart.
//
// Prices: https://docs.railway.com/reference/pricing/plans (checked
// 2026-11-23). Units of the usage values are not documented next to the
// API; per-minute values are assumed, as the per-minute list prices are.

/** The measurements the cost is computed from. */
export const COST_MEASUREMENTS = [
  "CPU_USAGE",
  "MEMORY_USAGE_GB",
  "NETWORK_TX_GB",
  "DISK_USAGE_GB",
] as const;
export type CostMeasurement = (typeof COST_MEASUREMENTS)[number];

/** US dollars per unit of each measurement. */
export const USD_PER_UNIT: Readonly<Record<CostMeasurement, number>> = {
  /** $20 per vCPU per month: $0.000463 per vCPU-minute. */
  CPU_USAGE: 0.000463,
  /** $10 per GB of memory per month: $0.000231 per GB-minute. */
  MEMORY_USAGE_GB: 0.000231,
  /** Egress: $0.05 per GB. */
  NETWORK_TX_GB: 0.05,
  /** Volume storage: $0.15 per GB per month: $0.000003472222222 per GB-minute. */
  DISK_USAGE_GB: 0.000003472222222,
};

export type Usage = Partial<Record<CostMeasurement, number>>;

function isCostMeasurement(value: string): value is CostMeasurement {
  return (COST_MEASUREMENTS as readonly string[]).includes(value);
}

/** Adds one answer row to the usage of its project. */
export function addUsage(
  byProject: Map<string, Usage>,
  projectId: string | null | undefined,
  measurement: string,
  value: number,
): void {
  if (!projectId || !isCostMeasurement(measurement)) return;
  if (!Number.isFinite(value) || value < 0) return;
  const usage = byProject.get(projectId) ?? {};
  usage[measurement] = (usage[measurement] ?? 0) + value;
  byProject.set(projectId, usage);
}

/** The usage's list price in US dollars, unrounded. */
export function usageCostUsd(usage: Usage): number {
  let total = 0;
  for (const measurement of COST_MEASUREMENTS) {
    total += (usage[measurement] ?? 0) * USD_PER_UNIT[measurement];
  }
  return total;
}

/** Whole cents, as the `USD_minor` metrics store them. */
export function cents(usd: number): number {
  return Math.round(usd * 100);
}

/** A dataset decimal with four places ("12.3457"). */
export function usdDecimal(usd: number): string {
  return usd.toFixed(4);
}

/** A non-negative quantity with up to six places, as a plain number. */
export function quantity(value: number | undefined): number {
  return Math.round((value ?? 0) * 1e6) / 1e6;
}
