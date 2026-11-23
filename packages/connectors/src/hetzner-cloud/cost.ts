// Hetzner Cloud's API has no invoices or usage amounts. The connector
// estimates a month's cost from what the project holds now and Hetzner's
// own price list (`GET /pricing`, in the project owner's currency, net and
// gross of VAT): every server (by type and location), its backups (a
// percentage of the server price), volumes (per GB), primary IPs and
// floating IPs (by type and location) and load balancers (by type and
// location), each at its monthly price.
//
// Not included: traffic beyond the included volume, snapshots and images,
// object storage, storage boxes, dedicated servers, anything created or
// deleted during the month (Hetzner bills hourly up to the monthly price),
// discounts and credits. docs/connectors/hetzner-cloud.md says the same.
//
// Amounts are exact: decimal strings become integers at 12 places, never
// floating-point numbers.

import { currencyExponent } from "../currency.js";

import type {
  HetznerFloatingIp,
  HetznerLoadBalancer,
  HetznerPricing,
  HetznerPrimaryIp,
  HetznerServer,
  HetznerVolume,
} from "./schemas.js";

const SCALE_DIGITS = 12;
const SCALE = 10n ** BigInt(SCALE_DIGITS);

/** A decimal string ("4.5100") as an integer of 10^-12 units. */
export function units(decimal: string): bigint {
  const [whole = "0", fraction = ""] = decimal.split(".");
  return (
    BigInt(whole) * SCALE +
    BigInt((fraction + "0".repeat(SCALE_DIGITS)).slice(0, SCALE_DIGITS))
  );
}

/** Divides, rounding half up (amounts are never negative). */
function divide(value: bigint, by: bigint): bigint {
  return (value * 2n + by) / (2n * by);
}

/** Units as a decimal string with `places` places, rounded half up. */
export function decimalOf(value: bigint, places = 6): string {
  const rounded = divide(value, 10n ** BigInt(SCALE_DIGITS - places));
  const text = rounded.toString().padStart(places + 1, "0");
  return places === 0
    ? text
    : `${text.slice(0, -places)}.${text.slice(-places)}`;
}

/** Units as whole minor units of a currency (cents of EUR), half up. */
export function minorOf(value: bigint, currency: string): number {
  const exponent = currencyExponent(currency);
  return Number(divide(value, 10n ** BigInt(SCALE_DIGITS - exponent)));
}

// ─── The price book ─────────────────────────────────────────────────────────

/**
 * The monthly prices a sync needs, compact enough for the cursor:
 * "kind:name@location" → [net, gross] decimal strings.
 */
export interface PriceBook {
  currency: string;
  /** Backups: percent of the server price, as a decimal string ("20.00"). */
  backupPercent: string;
  /** Volumes: [net, gross] per GB and month. */
  volumePerGb: [string, string];
  prices: Record<string, [string, string]>;
}

export function priceBook(pricing: HetznerPricing): PriceBook {
  const prices: Record<string, [string, string]> = {};
  const add = (
    kind: string,
    name: string,
    entries: ReadonlyArray<{
      location: string;
      price_monthly: { net: string; gross: string };
    }>,
  ) => {
    for (const entry of entries) {
      prices[`${kind}:${name}@${entry.location}`] = [
        entry.price_monthly.net,
        entry.price_monthly.gross,
      ];
    }
  };
  for (const type of pricing.server_types)
    add("server", type.name, type.prices);
  for (const type of pricing.load_balancer_types) {
    add("load_balancer", type.name, type.prices);
  }
  for (const ip of pricing.primary_ips) add("primary_ip", ip.type, ip.prices);
  for (const ip of pricing.floating_ips) add("floating_ip", ip.type, ip.prices);
  return {
    currency: pricing.currency,
    backupPercent: pricing.server_backup.percentage,
    volumePerGb: [
      pricing.volume.price_per_gb_month.net,
      pricing.volume.price_per_gb_month.gross,
    ],
    prices,
  };
}

// ─── Cost items ─────────────────────────────────────────────────────────────

/** What a cost item is. Each kind is one row per item in `cost_items`. */
export type CostKind =
  | "server"
  | "server_backup"
  | "volume"
  | "primary_ip"
  | "floating_ip"
  | "load_balancer";

/** The resource of cost that is attached to no server or load balancer. */
export const UNATTACHED = "unattached";

/**
 * Resource IDs: a server's is its ID; a load balancer's is prefixed, as
 * Hetzner numbers servers and load balancers separately.
 */
export function serverResource(id: number): string {
  return String(id);
}
export function loadBalancerResource(id: number): string {
  return `lb-${id}`;
}

export interface CostItem {
  kind: CostKind;
  id: string;
  name: string;
  /** The server or load balancer it belongs to, or UNATTACHED. */
  resource: string;
  location: string;
  /** What it is priced as: a type ("cx22"), a size ("50 GB"). */
  basis: string;
  /** Monthly [net, gross] units; null when the price list has no price. */
  monthly: [bigint, bigint] | null;
}

function listed(
  book: PriceBook,
  kind: string,
  name: string,
  location: string,
): [bigint, bigint] | null {
  const price = book.prices[`${kind}:${name}@${location}`];
  return price ? [units(price[0]), units(price[1])] : null;
}

/** A server's price, and its backups' when they are on. */
export function serverItems(
  book: PriceBook,
  server: HetznerServer,
): CostItem[] {
  const id = String(server.id);
  const resource = serverResource(server.id);
  const location = server.location.name;
  const monthly = listed(book, "server", server.server_type.name, location);
  const items: CostItem[] = [
    {
      kind: "server",
      id,
      name: server.name,
      resource,
      location,
      basis: server.server_type.name,
      monthly,
    },
  ];
  // Backups are on when the server has a backup window (API: null when
  // they are off) and cost a percentage of the server price.
  if (server.backup_window) {
    const percent = units(book.backupPercent);
    items.push({
      kind: "server_backup",
      id,
      name: server.name,
      resource,
      location,
      basis: `${book.backupPercent} %`,
      monthly: monthly
        ? [
            divide(monthly[0] * percent, 100n * SCALE),
            divide(monthly[1] * percent, 100n * SCALE),
          ]
        : null,
    });
  }
  return items;
}

export function volumeItem(book: PriceBook, volume: HetznerVolume): CostItem {
  const size = BigInt(Math.ceil(volume.size));
  return {
    kind: "volume",
    id: String(volume.id),
    name: volume.name,
    resource: volume.server ? serverResource(volume.server) : UNATTACHED,
    location: volume.location.name,
    basis: `${size} GB`,
    monthly: [
      units(book.volumePerGb[0]) * size,
      units(book.volumePerGb[1]) * size,
    ],
  };
}

export function primaryIpItem(book: PriceBook, ip: HetznerPrimaryIp): CostItem {
  const assignee = ip.assignee_id ?? null;
  const resource =
    assignee === null
      ? UNATTACHED
      : ip.assignee_type === "server"
        ? serverResource(assignee)
        : ip.assignee_type === "load_balancer"
          ? loadBalancerResource(assignee)
          : UNATTACHED;
  return {
    kind: "primary_ip",
    id: String(ip.id),
    name: ip.name,
    resource,
    location: ip.location.name,
    basis: ip.type,
    monthly: listed(book, "primary_ip", ip.type, ip.location.name),
  };
}

export function floatingIpItem(
  book: PriceBook,
  ip: HetznerFloatingIp,
): CostItem {
  return {
    kind: "floating_ip",
    id: String(ip.id),
    name: ip.name,
    resource: ip.server ? serverResource(ip.server) : UNATTACHED,
    location: ip.home_location.name,
    basis: ip.type,
    monthly: listed(book, "floating_ip", ip.type, ip.home_location.name),
  };
}

export function loadBalancerItem(
  book: PriceBook,
  balancer: HetznerLoadBalancer,
): CostItem {
  return {
    kind: "load_balancer",
    id: String(balancer.id),
    name: balancer.name,
    resource: loadBalancerResource(balancer.id),
    location: balancer.location.name,
    basis: balancer.load_balancer_type.name,
    monthly: listed(
      book,
      "load_balancer",
      balancer.load_balancer_type.name,
      balancer.location.name,
    ),
  };
}
