// The shapes of the Hetzner Cloud answers the connector reads
// (https://docs.hetzner.cloud/reference/cloud, checked 2026-11-23). Only
// the fields netrics uses are parsed; unknown fields are ignored, so an
// additive change never breaks a sync, and a changed shape fails parsing
// instead of storing something else.

import { z } from "zod";

import { HetznerApiError } from "./api.js";

/** Every server status the API documents (`GET /servers`, `status`). */
export const SERVER_STATUSES = [
  "running",
  "initializing",
  "starting",
  "stopping",
  "off",
  "deleting",
  "migrating",
  "rebuilding",
  "unknown",
] as const;

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const decimal = z.string().regex(/^\d{1,12}(\.\d{1,12})?$/);
const price = z.object({ net: decimal, gross: decimal });
const labels = z.record(z.string(), z.string()).default({});
const location = z.object({
  name: z.string().min(1),
  city: z.string().optional(),
  country: z.string().optional(),
  network_zone: z.string().optional(),
});

export const paginationSchema = z.object({
  page: z.number().int().positive(),
  per_page: z.number().int().positive(),
  previous_page: z.number().int().positive().nullable().optional(),
  next_page: z.number().int().positive().nullable(),
  last_page: z.number().int().positive().nullable().optional(),
  total_entries: z.number().int().nonnegative().nullable().optional(),
});
export type Pagination = z.infer<typeof paginationSchema>;

const meta = z.object({ pagination: paginationSchema });

export const serverSchema = z.object({
  id,
  name: z.string().min(1),
  status: z.string().min(1),
  created: z.string().min(1),
  labels,
  server_type: z.object({
    name: z.string().min(1),
    cores: z.number().int().positive(),
    memory: z.number().nonnegative(),
    disk: z.number().nonnegative(),
    cpu_type: z.string().optional(),
    architecture: z.string().optional(),
  }),
  location,
  backup_window: z.string().nullable().optional(),
  primary_disk_size: z.number().nonnegative().optional(),
  included_traffic: z.number().nonnegative().nullable().optional(),
  outgoing_traffic: z.number().nonnegative().nullable().optional(),
  ingoing_traffic: z.number().nonnegative().nullable().optional(),
});
export type HetznerServer = z.infer<typeof serverSchema>;

export const volumeSchema = z.object({
  id,
  name: z.string().min(1),
  size: z.number().nonnegative(),
  server: id.nullable().optional(),
  location,
});
export type HetznerVolume = z.infer<typeof volumeSchema>;

export const primaryIpSchema = z.object({
  id,
  name: z.string().min(1),
  type: z.string().min(1),
  assignee_id: id.nullable().optional(),
  assignee_type: z.string().optional(),
  location,
});
export type HetznerPrimaryIp = z.infer<typeof primaryIpSchema>;

export const floatingIpSchema = z.object({
  id,
  name: z.string().min(1),
  type: z.string().min(1),
  server: id.nullable().optional(),
  home_location: location,
});
export type HetznerFloatingIp = z.infer<typeof floatingIpSchema>;

export const loadBalancerSchema = z.object({
  id,
  name: z.string().min(1),
  load_balancer_type: z.object({ name: z.string().min(1) }),
  location,
});
export type HetznerLoadBalancer = z.infer<typeof loadBalancerSchema>;

export const serversPageSchema = z.object({
  servers: z.array(serverSchema),
  meta,
});
export const volumesPageSchema = z.object({
  volumes: z.array(volumeSchema),
  meta,
});
export const primaryIpsPageSchema = z.object({
  primary_ips: z.array(primaryIpSchema),
  meta,
});
export const floatingIpsPageSchema = z.object({
  floating_ips: z.array(floatingIpSchema),
  meta,
});
export const loadBalancersPageSchema = z.object({
  load_balancers: z.array(loadBalancerSchema),
  meta,
});

const locationPrice = z.object({
  location: z.string().min(1),
  price_monthly: price,
});

export const pricingSchema = z.object({
  pricing: z.object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    vat_rate: decimal.optional(),
    server_backup: z.object({ percentage: decimal }),
    volume: z.object({ price_per_gb_month: price }),
    server_types: z.array(
      z.object({ name: z.string().min(1), prices: z.array(locationPrice) }),
    ),
    load_balancer_types: z.array(
      z.object({ name: z.string().min(1), prices: z.array(locationPrice) }),
    ),
    primary_ips: z.array(
      z.object({ type: z.string().min(1), prices: z.array(locationPrice) }),
    ),
    floating_ips: z.array(
      z.object({ type: z.string().min(1), prices: z.array(locationPrice) }),
    ),
  }),
});
export type HetznerPricing = z.infer<typeof pricingSchema>["pricing"];

export const metricsSchema = z.object({
  metrics: z.object({
    start: z.string(),
    end: z.string(),
    step: z.number().positive(),
    time_series: z.record(
      z.string(),
      z.object({
        values: z.array(
          z.tuple([z.number(), z.union([z.string(), z.number()])]),
        ),
      }),
    ),
  }),
});
export type HetznerMetrics = z.infer<typeof metricsSchema>["metrics"];

/** Parses an answer, or fails with netrics' own description. */
export function parse<T>(schema: z.ZodType<T>, json: unknown, what: string): T {
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new HetznerApiError(200, "invalid", `${what} did not parse`);
  }
  return parsed.data;
}

/**
 * Checks a listing page's pagination against the page asked for. An answer
 * that announces more pages but names no next page, skips a page, or names
 * a next page without items is refused: following it could loop or leave
 * items out silently.
 */
export function checkPagination(
  pagination: Pagination,
  requestedPage: number,
  items: number,
  what: string,
): number | null {
  const { page, next_page: next, last_page: last } = pagination;
  const invalid = (reason: string) =>
    new HetznerApiError(200, "invalid", `${what}: ${reason}`);
  if (page !== requestedPage) throw invalid("answered another page");
  if (items > pagination.per_page) throw invalid("more items than per_page");
  if (next !== null && next !== page + 1) throw invalid("skips a page");
  if (next !== null && items === 0) throw invalid("an empty page has a next");
  if (next === null && last !== null && last !== undefined && page < last) {
    throw invalid("announces more pages but names no next page");
  }
  return next;
}
