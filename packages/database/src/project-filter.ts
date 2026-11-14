import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import * as schema from "./schema.js";

/**
 * The project a list is narrowed to (#572). `project` absent: no narrowing,
 * the full list. "all": unassigned items and items of unarchived projects.
 * A project id: that project's items, plus unassigned ones with
 * `unassigned: "include"`. An unknown or another workspace's id matches
 * nothing, the same as an empty project.
 */
export type ProjectFilter = {
  project?: "all" | string;
  unassigned?: "include";
};

export function projectFilterSql(
  column: AnyPgColumn,
  workspaceId: string,
  filter: ProjectFilter,
): SQL | undefined {
  if (filter.project === undefined) return undefined;
  if (filter.project === "all") {
    return or(
      isNull(column),
      sql`${column} in (select ${schema.projects.id} from ${schema.projects}
        where ${and(
          eq(schema.projects.workspaceId, workspaceId),
          isNull(schema.projects.archivedAt),
        )})`,
    );
  }
  const inProject = eq(column, filter.project);
  return filter.unassigned === "include"
    ? or(inProject, isNull(column))
    : inProject;
}
