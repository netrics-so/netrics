import { and, asc, eq, sql } from "drizzle-orm";

import { isDuplicateThemeNameError, type Transaction } from "./context.js";
import * as schema from "./schema.js";

// Custom dashboard themes (#216), as netrics_app inside withWorkspace. Every
// query names the workspace explicitly on top of RLS. Tokens are validated
// by the caller (contracts and domain); here they are opaque JSON.

export type WorkspaceThemeRow = typeof schema.workspaceThemes.$inferSelect;

export interface ThemeInput {
  name: string;
  base: string;
  tokens: Record<string, unknown>;
}

export interface ThemeUser {
  id: string;
  name: string;
}

function themeScope(workspaceId: string, themeId: string) {
  return and(
    eq(schema.workspaceThemes.workspaceId, workspaceId),
    eq(schema.workspaceThemes.id, themeId),
  );
}

export async function listThemes(
  tx: Transaction,
  workspaceId: string,
): Promise<WorkspaceThemeRow[]> {
  return tx
    .select()
    .from(schema.workspaceThemes)
    .where(eq(schema.workspaceThemes.workspaceId, workspaceId))
    .orderBy(asc(sql`lower(${schema.workspaceThemes.name})`));
}

export async function findTheme(
  tx: Transaction,
  workspaceId: string,
  themeId: string,
): Promise<WorkspaceThemeRow | null> {
  const [row] = await tx
    .select()
    .from(schema.workspaceThemes)
    .where(themeScope(workspaceId, themeId))
    .limit(1);
  return row ?? null;
}

export type InsertThemeResult =
  { status: "ok"; theme: WorkspaceThemeRow } | { status: "name_taken" };

export async function insertTheme(
  tx: Transaction,
  workspaceId: string,
  input: ThemeInput,
): Promise<InsertThemeResult> {
  try {
    // A savepoint, so a duplicate name leaves the transaction usable.
    const [row] = await tx.transaction((inner) =>
      inner
        .insert(schema.workspaceThemes)
        .values({ workspaceId, ...input })
        .returning(),
    );
    if (!row) {
      throw new Error("theme insert returned no row");
    }
    return { status: "ok", theme: row };
  } catch (error) {
    if (isDuplicateThemeNameError(error)) {
      return { status: "name_taken" };
    }
    throw error;
  }
}

export type UpdateThemeResult =
  | { status: "ok"; theme: WorkspaceThemeRow }
  | { status: "not_found" }
  | { status: "name_taken" }
  | { status: "version_conflict"; currentVersion: number };

/** Replaces name and tokens if `expectedVersion` is still current. */
export async function updateTheme(
  tx: Transaction,
  workspaceId: string,
  themeId: string,
  expectedVersion: number,
  input: Pick<ThemeInput, "name" | "tokens">,
): Promise<UpdateThemeResult> {
  let row: WorkspaceThemeRow | undefined;
  try {
    [row] = await tx.transaction((inner) =>
      inner
        .update(schema.workspaceThemes)
        .set({
          name: input.name,
          tokens: input.tokens,
          version: expectedVersion + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            themeScope(workspaceId, themeId),
            eq(schema.workspaceThemes.version, expectedVersion),
          ),
        )
        .returning(),
    );
  } catch (error) {
    if (isDuplicateThemeNameError(error)) {
      return { status: "name_taken" };
    }
    throw error;
  }
  if (row) {
    return { status: "ok", theme: row };
  }
  const current = await findTheme(tx, workspaceId, themeId);
  return current
    ? { status: "version_conflict", currentVersion: current.version }
    : { status: "not_found" };
}

/** The dashboards that show a custom theme, by name. */
export async function findDashboardsUsingTheme(
  tx: Transaction,
  workspaceId: string,
  themeId: string,
): Promise<ThemeUser[]> {
  return tx
    .select({ id: schema.dashboards.id, name: schema.dashboards.name })
    .from(schema.dashboards)
    .where(
      and(
        eq(schema.dashboards.workspaceId, workspaceId),
        eq(schema.dashboards.themeId, themeId),
      ),
    )
    .orderBy(asc(schema.dashboards.name));
}

export type DeleteThemeResult =
  | { status: "ok"; theme: WorkspaceThemeRow }
  | { status: "not_found" }
  | { status: "in_use"; dashboards: ThemeUser[] };

/**
 * Deletes a theme no dashboard uses. The row is locked first, so a dashboard
 * saved concurrently either sees the theme gone or keeps it from being
 * deleted (the foreign key refuses the delete in that case).
 */
export async function deleteTheme(
  tx: Transaction,
  workspaceId: string,
  themeId: string,
): Promise<DeleteThemeResult> {
  const [locked] = await tx
    .select()
    .from(schema.workspaceThemes)
    .where(themeScope(workspaceId, themeId))
    .for("update")
    .limit(1);
  if (!locked) {
    return { status: "not_found" };
  }
  const users = await findDashboardsUsingTheme(tx, workspaceId, themeId);
  if (users.length > 0) {
    return { status: "in_use", dashboards: users };
  }
  await tx
    .delete(schema.workspaceThemes)
    .where(themeScope(workspaceId, themeId));
  return { status: "ok", theme: locked };
}
