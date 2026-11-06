import type {
  CreateGoalRequest,
  Goal,
  GoalCurrent,
  UpdateGoalRequest,
} from "@netrics/contracts";
import {
  deleteGoal,
  findConnectionMetric,
  findDashboardsUsingGoal,
  findGoal,
  findResourceNames,
  insertAuditEvent,
  insertGoal,
  listGoals,
  resourceNameKey,
  updateGoal,
  withWorkspace,
  type Database,
  type GoalInput,
  type GoalRow,
  type GoalUser,
  type Transaction,
} from "@netrics/database";
import {
  DEFAULT_LOCALE,
  RESOURCE_DIMENSION,
  goalBindingProblem,
  type GoalAggregation,
  type GoalPeriod,
  type Locale,
} from "@netrics/domain";

import { validateBinding } from "../dashboards/service.js";
import {
  findAllResourcesNames,
  tileAllResourcesName,
} from "../metrics/query.js";
import { readGoal } from "./progress.js";

/**
 * Goals (ADR 0019 section 4, #335): a named target for one metric in a
 * period to date. The binding is checked like a widget's, then for what a
 * goal needs (sum or last, a period to date, higher is better, one fixed
 * currency). Listing and reading answer each goal's current progress from
 * the same domain function the gauge payload uses (#339).
 */

export interface Actor {
  workspaceId: string;
  callerId: string;
  /** The caller's language: "All apps" in responses uses it (ADR 0016). */
  locale?: Locale;
}

export type GoalFailure =
  | { status: 400; error: string }
  | { status: 404; error: "goal_not_found" }
  | { status: 409; error: "goal_name_taken" | "version_conflict" };

export type GoalResult<T> =
  { ok: true; value: T } | ({ ok: false } & GoalFailure);

const NOT_FOUND = { ok: false, status: 404, error: "goal_not_found" } as const;

export interface GoalServiceDeps {
  db: Database;
  /** NETRICS_EXCHANGE_RATES: amounts may be converted (#191). */
  exchangeRates?: boolean;
  /** The clock; tests pin it. */
  now?: () => Date;
}

function dimensionsOf(row: GoalRow): Record<string, string> {
  return row.dimensions as Record<string, string>;
}

/** The request as a valid goal, or why it cannot be one. */
async function validateGoal(
  tx: Transaction,
  workspaceId: string,
  body: CreateGoalRequest,
): Promise<GoalResult<GoalInput>> {
  const binding = await validateBinding(tx, workspaceId, {
    connectionId: body.connectionId,
    metricKey: body.metricKey,
    aggregation: body.aggregation,
    period: body.period,
    dimensions: body.dimensions,
    displayCurrency: body.displayCurrency,
  });
  if (!binding.ok) {
    return { ok: false, status: 400, error: binding.error };
  }
  const metric = await findConnectionMetric(
    tx,
    workspaceId,
    body.connectionId,
    body.metricKey,
  );
  if (!metric) {
    return { ok: false, status: 400, error: "tile_metric_not_found" };
  }
  const valid = binding.value;
  const problem = goalBindingProblem({
    aggregation: valid.aggregation,
    period: valid.period,
    better: metric.better === "lower" ? "lower" : "higher",
    unit: metric.unit,
    dimensions: valid.dimensions,
    displayCurrency: valid.displayCurrency,
  });
  if (problem) {
    return { ok: false, status: 400, error: problem };
  }
  return {
    ok: true,
    value: {
      name: body.name.trim(),
      connectionId: valid.connectionId,
      metricKey: valid.metricKey,
      aggregation: valid.aggregation,
      dimensions: valid.dimensions,
      displayCurrency: valid.displayCurrency,
      period: valid.period,
      target: body.target,
    },
  };
}

export function createGoalService(deps: GoalServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const inWorkspace = <T>(actor: Actor, run: (tx: Transaction) => Promise<T>) =>
    withWorkspace(
      deps.db,
      { workspaceId: actor.workspaceId, userId: actor.callerId },
      run,
    );

  /**
   * The goal's progress now, or null when its metric cannot be read: each
   * query runs in a savepoint, so one failing goal leaves the others.
   */
  async function currentOf(
    tx: Transaction,
    actor: Actor,
    row: GoalRow,
    at: Date,
  ): Promise<GoalCurrent | null> {
    const reading = await readGoal(tx, actor.workspaceId, row, at, {
      exchangeRates: deps.exchangeRates ?? false,
      locale: actor.locale ?? DEFAULT_LOCALE,
    });
    return reading
      ? {
          ...reading.progress,
          currency: reading.read.currency,
          approximate: reading.read.conversion !== null,
        }
      : null;
  }

  /** Goals as the API returns them, named in the caller's language. */
  async function present(
    tx: Transaction,
    actor: Actor,
    rows: readonly GoalRow[],
  ): Promise<Goal[]> {
    const names = await findResourceNames(
      tx,
      actor.workspaceId,
      rows.flatMap((row) => {
        const resourceId = dimensionsOf(row)[RESOURCE_DIMENSION];
        return resourceId === undefined
          ? []
          : [{ connectionId: row.connectionId, resourceId }];
      }),
    );
    const scopes = await findAllResourcesNames(
      tx,
      actor.workspaceId,
      rows.map((row) => ({
        connectionId: row.connectionId,
        metricKey: row.metricKey,
        dimensions: dimensionsOf(row),
      })),
      actor.locale ?? DEFAULT_LOCALE,
    );
    const at = now();
    const goals: Goal[] = [];
    for (const row of rows) {
      const dimensions = dimensionsOf(row);
      const resourceId = dimensions[RESOURCE_DIMENSION];
      goals.push({
        id: row.id,
        name: row.name,
        connectionId: row.connectionId,
        metricKey: row.metricKey,
        aggregation: row.aggregation as GoalAggregation,
        period: row.period as GoalPeriod,
        dimensions,
        displayCurrency: row.displayCurrency,
        target: row.target,
        version: row.version,
        resourceName:
          resourceId === undefined
            ? null
            : (names.get(resourceNameKey(row.connectionId, resourceId)) ??
              null),
        allResourcesName: tileAllResourcesName(scopes, {
          connectionId: row.connectionId,
          metricKey: row.metricKey,
          dimensions,
        }),
        current: await currentOf(tx, actor, row, at),
        dashboards: await findDashboardsUsingGoal(
          tx,
          actor.workspaceId,
          row.id,
        ),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
    }
    return goals;
  }

  const presentOne = async (tx: Transaction, actor: Actor, row: GoalRow) =>
    (await present(tx, actor, [row]))[0]!;

  return {
    list(actor: Actor) {
      return inWorkspace(actor, async (tx) =>
        present(tx, actor, await listGoals(tx, actor.workspaceId)),
      );
    },

    get(actor: Actor, goalId: string) {
      return inWorkspace(actor, async (tx): Promise<GoalResult<Goal>> => {
        const row = await findGoal(tx, actor.workspaceId, goalId);
        return row
          ? { ok: true, value: await presentOne(tx, actor, row) }
          : NOT_FOUND;
      });
    },

    create(actor: Actor, body: CreateGoalRequest) {
      return inWorkspace(actor, async (tx): Promise<GoalResult<Goal>> => {
        const valid = await validateGoal(tx, actor.workspaceId, body);
        if (!valid.ok) {
          return valid;
        }
        const result = await insertGoal(
          tx,
          actor.workspaceId,
          actor.callerId,
          valid.value,
        );
        if (result.status === "name_taken") {
          return { ok: false, status: 409, error: "goal_name_taken" };
        }
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "goal.created",
          target: result.goal.id,
          metadata: {
            name: result.goal.name,
            metricKey: result.goal.metricKey,
            period: result.goal.period,
          },
        });
        return { ok: true, value: await presentOne(tx, actor, result.goal) };
      });
    },

    update(actor: Actor, goalId: string, body: UpdateGoalRequest) {
      return inWorkspace(actor, async (tx): Promise<GoalResult<Goal>> => {
        if (!(await findGoal(tx, actor.workspaceId, goalId))) {
          return NOT_FOUND;
        }
        const valid = await validateGoal(tx, actor.workspaceId, body);
        if (!valid.ok) {
          return valid;
        }
        const result = await updateGoal(
          tx,
          actor.workspaceId,
          goalId,
          body.version,
          valid.value,
        );
        switch (result.status) {
          case "not_found":
            return NOT_FOUND;
          case "name_taken":
            return { ok: false, status: 409, error: "goal_name_taken" };
          case "version_conflict":
            return { ok: false, status: 409, error: "version_conflict" };
        }
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "goal.updated",
          target: goalId,
          metadata: { name: result.goal.name, version: result.goal.version },
        });
        return { ok: true, value: await presentOne(tx, actor, result.goal) };
      });
    },

    remove(actor: Actor, goalId: string) {
      return inWorkspace(
        actor,
        async (tx): Promise<GoalResult<{ dashboards: GoalUser[] }>> => {
          const result = await deleteGoal(tx, actor.workspaceId, goalId);
          if (result.status === "not_found") {
            return NOT_FOUND;
          }
          await insertAuditEvent(tx, {
            workspaceId: actor.workspaceId,
            actorUserId: actor.callerId,
            action: "goal.deleted",
            target: goalId,
            metadata: {
              name: result.goal.name,
              dashboards: result.dashboards.length,
            },
          });
          return { ok: true, value: { dashboards: result.dashboards } };
        },
      );
    },
  };
}
