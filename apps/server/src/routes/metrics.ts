import type { FastifyInstance } from "fastify";

import {
  currencyConversionOptionsResponseSchema,
  metricBreakdownRequestSchema,
  metricBreakdownResponseSchema,
  metricCurrenciesRequestSchema,
  metricCurrenciesResponseSchema,
  metricQueryRequestSchema,
  metricQueryResponseSchema,
  metricResourcesRequestSchema,
  metricResourcesResponseSchema,
  workspaceMetricListResponseSchema,
} from "@netrics/contracts";
import { withWorkspace, type Database } from "@netrics/database";
import { can, type Locale } from "@netrics/domain";

import type { AuthService } from "../auth/index.js";
import {
  conversionOptions,
  listMetricCurrencies,
  listMetrics,
  listResourcesOfMetric,
  queryMetric,
  queryMetricBreakdown,
} from "../metrics/query.js";
import {
  createFreshnessReader,
  metricLiveFreshness,
  type FreshnessManifests,
} from "../dashboards/freshness.js";
import { parseBody, resolveAccess, sendError } from "./access.js";
import { routeSchema } from "./openapi.js";
import { createRequireSession } from "./session.js";

export interface MetricRouteDeps {
  authService: AuthService;
  db: Database;
  now?: () => Date;
  /** NETRICS_EXCHANGE_RATES: display-currency conversion (#191). */
  exchangeRates?: boolean;
  /** The connector registry: live queries' freshness (ADR 0025, #727). */
  registry?: FreshnessManifests;
}

export function registerMetricRoutes(
  app: FastifyInstance,
  deps: MetricRouteDeps,
): void {
  const requireSession = createRequireSession(deps.authService);
  const now = deps.now ?? (() => new Date());
  const reader = (workspaceId: string, locale: Locale) =>
    deps.registry
      ? createFreshnessReader(workspaceId, deps.registry, locale)
      : undefined;

  void app.register(
    (scope, _opts, done) => {
      scope.addHook("onRequest", requireSession);

      scope.get(
        "/workspaces/:workspaceId/metrics",
        {
          schema: routeSchema({
            summary: "Metrics the workspace's connections provide",
            tags: ["metrics"],
            response: workspaceMetricListResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "connections:view")) {
            return sendError(reply, 403, "forbidden");
          }
          const metrics = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            (tx) =>
              listMetrics(
                tx,
                access.workspaceId,
                request.sessionIdentity!.locale,
              ),
          );
          return workspaceMetricListResponseSchema.parse({ metrics });
        },
      );

      // POST because the request carries a structured dimension filter; it
      // reads only.
      scope.post(
        "/workspaces/:workspaceId/metrics/query",
        {
          schema: routeSchema({
            summary: "Value, change and sparkline of a metric for a period",
            tags: ["metrics"],
            body: metricQueryRequestSchema,
            response: metricQueryResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "connections:view")) {
            return sendError(reply, 403, "forbidden");
          }
          const body = parseBody(metricQueryRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const result = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            async (tx) => {
              const locale = request.sessionIdentity!.locale;
              const found = await queryMetric(
                tx,
                access.workspaceId,
                body,
                now(),
                {
                  exchangeRates: deps.exchangeRates ?? false,
                  locale,
                },
              );
              return found.ok
                ? {
                    ...found,
                    value: {
                      ...found.value,
                      ...(await metricLiveFreshness(
                        tx,
                        reader(access.workspaceId, locale),
                        body,
                      )),
                    },
                  }
                : found;
            },
          );
          if (!result.ok) {
            return sendError(reply, result.status, result.error);
          }
          return metricQueryResponseSchema.parse(result.value);
        },
      );

      // POST like the metric query; it reads only.
      scope.post(
        "/workspaces/:workspaceId/metrics/breakdown",
        {
          schema: routeSchema({
            summary:
              "A metric by one of its dimensions over a period, largest first, plus Others",
            tags: ["metrics"],
            body: metricBreakdownRequestSchema,
            response: metricBreakdownResponseSchema,
            errors: [403, 404, 503],
          }),
        },
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "connections:view")) {
            return sendError(reply, 403, "forbidden");
          }
          const body = parseBody(metricBreakdownRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const result = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            async (tx) => {
              const locale = request.sessionIdentity!.locale;
              const found = await queryMetricBreakdown(
                tx,
                access.workspaceId,
                body,
                now(),
                {
                  exchangeRates: deps.exchangeRates ?? false,
                  locale,
                },
              );
              return found.ok
                ? {
                    ...found,
                    value: {
                      ...found.value,
                      ...(await metricLiveFreshness(
                        tx,
                        reader(access.workspaceId, locale),
                        body,
                      )),
                    },
                  }
                : found;
            },
          );
          if (!result.ok) {
            return sendError(reply, result.status, result.error);
          }
          return metricBreakdownResponseSchema.parse(result.value);
        },
      );

      scope.get(
        "/workspaces/:workspaceId/currency-conversion",
        {
          schema: routeSchema({
            summary:
              "Whether amounts can be converted into a display currency, and into which",
            tags: ["metrics"],
            response: currencyConversionOptionsResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "connections:view")) {
            return sendError(reply, 403, "forbidden");
          }
          const options = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            (tx) => conversionOptions(tx, deps.exchangeRates ?? false),
          );
          return currencyConversionOptionsResponseSchema.parse(options);
        },
      );

      scope.post(
        "/workspaces/:workspaceId/metrics/currencies",
        {
          schema: routeSchema({
            summary:
              "Currencies of a per-currency amount metric, each with its own total",
            tags: ["metrics"],
            body: metricCurrenciesRequestSchema,
            response: metricCurrenciesResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "connections:view")) {
            return sendError(reply, 403, "forbidden");
          }
          const body = parseBody(metricCurrenciesRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const result = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            (tx) =>
              listMetricCurrencies(tx, access.workspaceId, body, now(), {
                exchangeRates: deps.exchangeRates ?? false,
              }),
          );
          if (!result.ok) {
            return sendError(reply, result.status, result.error);
          }
          return metricCurrenciesResponseSchema.parse(result.value);
        },
      );

      // POST like the other metric reads; it reads only.
      scope.post(
        "/workspaces/:workspaceId/metrics/resources",
        {
          schema: routeSchema({
            summary:
              "Resources (apps, projects, properties) a tile of a metric can show",
            tags: ["metrics"],
            body: metricResourcesRequestSchema,
            response: metricResourcesResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "connections:view")) {
            return sendError(reply, 403, "forbidden");
          }
          const body = parseBody(metricResourcesRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const result = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            (tx) =>
              listResourcesOfMetric(
                tx,
                access.workspaceId,
                body,
                request.sessionIdentity!.locale,
              ),
          );
          if (!result.ok) {
            return sendError(reply, result.status, result.error);
          }
          return metricResourcesResponseSchema.parse(result.value);
        },
      );

      done();
    },
    { prefix: "/v1" },
  );
}
