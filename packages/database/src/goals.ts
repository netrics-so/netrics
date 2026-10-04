import { and, asc, eq, sql } from "drizzle-orm";

import { isDuplicateGoalNameError, type Transaction } from "./context.js";
import * as schema from "./schema.js";

// Goals (ADR 0019 section 4, #335), as netrics_app inside withWorkspace.
// Every query names the workspace explicitly on top of RLS. The binding is
// validated by the caller (the server's goal service).

export type GoalRow = typeof schema.goals.$inferSelect;

export interface GoalInput {
  name: string;
  connectionId: string;
  metricKey: string;
  aggregation: string;
  dimensions: Record<string, string>;
  displayCurrency: string | null;
  period: string;
  target: number;
}

/** A dashboard that shows a goal (on a gauge widget, #339). */
export interface GoalUser {
  id: string;
  name: string;
}

function goalScope(workspaceId: string, goalId: string) {
  return and(
    eq(schema.goals.workspaceId, workspaceId),
    eq(schema.goals.id, goalId),
  );
}

export async function listGoals(
  tx: Transaction,
  workspaceId: string,
): Promise<GoalRow[]> {
  return tx
    .select()
    .from(schema.goals)
    .where(eq(schema.goals.workspaceId, workspaceId))
    .orderBy(asc(sql`lower(${schema.goals.name})`), asc(schema.goals.id));
}

export async function findGoal(
  tx: Transaction,
  workspaceId: string,
  goalId: string,
): Promise<GoalRow | null> {
  const [row] = await tx
    .select()
    .from(schema.goals)
    .where(goalScope(workspaceId, goalId))
    .limit(1);
  return row ?? null;
}

export type InsertGoalResult =
  { status: "ok"; goal: GoalRow } | { status: "name_taken" };

export async function insertGoal(
  tx: Transaction,
  workspaceId: string,
  createdByUserId: string,
  input: GoalInput,
): Promise<InsertGoalResult> {
  try {
    // A savepoint, so a duplicate name leaves the transaction usable.
    const [row] = await tx.transaction((inner) =>
      inner
        .insert(schema.goals)
        .values({ workspaceId, createdByUserId, ...input })
        .returning(),
    );
    if (!row) {
      throw new Error("goal insert returned no row");
    }
    return { status: "ok", goal: row };
  } catch (error) {
    if (isDuplicateGoalNameError(error)) {
      return { status: "name_taken" };
    }
    throw error;
  }
}

export type UpdateGoalResult =
  | { status: "ok"; goal: GoalRow }
  | { status: "not_found" }
  | { status: "name_taken" }
  | { status: "version_conflict"; currentVersion: number };

/** Replaces the goal if `expectedVersion` is still current. */
export async function updateGoal(
  tx: Transaction,
  workspaceId: string,
  goalId: string,
  expectedVersion: number,
  input: GoalInput,
): Promise<UpdateGoalResult> {
  let row: GoalRow | undefined;
  try {
    [row] = await tx.transaction((inner) =>
      inner
        .update(schema.goals)
        .set({
          ...input,
          version: expectedVersion + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            goalScope(workspaceId, goalId),
            eq(schema.goals.version, expectedVersion),
          ),
        )
        .returning(),
    );
  } catch (error) {
    if (isDuplicateGoalNameError(error)) {
      return { status: "name_taken" };
    }
    throw error;
  }
  if (row) {
    return { status: "ok", goal: row };
  }
  const current = await findGoal(tx, workspaceId, goalId);
  return current
    ? { status: "version_conflict", currentVersion: current.version }
    : { status: "not_found" };
}

/**
 * The dashboards whose gauge widgets show a goal. Gauges arrive with #339
 * (`dashboard_widgets.goal_id`); until then no dashboard can use a goal.
 */
export async function findDashboardsUsingGoal(
  _tx: Transaction,
  _workspaceId: string,
  _goalId: string,
): Promise<GoalUser[]> {
  return [];
}

export type DeleteGoalResult =
  | { status: "ok"; goal: GoalRow; dashboards: GoalUser[] }
  | { status: "not_found" };

/**
 * Deletes a goal, also when gauges use it (they then show "Goal deleted",
 * ADR 0019 §5), and names the dashboards that did.
 */
export async function deleteGoal(
  tx: Transaction,
  workspaceId: string,
  goalId: string,
): Promise<DeleteGoalResult> {
  const [locked] = await tx
    .select()
    .from(schema.goals)
    .where(goalScope(workspaceId, goalId))
    .for("update")
    .limit(1);
  if (!locked) {
    return { status: "not_found" };
  }
  const dashboards = await findDashboardsUsingGoal(tx, workspaceId, goalId);
  await tx.delete(schema.goals).where(goalScope(workspaceId, goalId));
  return { status: "ok", goal: locked, dashboards };
}
