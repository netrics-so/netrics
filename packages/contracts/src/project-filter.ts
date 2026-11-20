import { z } from "zod";

// In its own module so the contract modules that index.ts re-exports can
// extend it without importing index.ts (a cycle).

/**
 * Narrows a list to a project (#572). Absent: the full list. "all": unassigned
 * items and items of unarchived projects. A project id: that project's items,
 * plus unassigned ones with `unassigned=include`.
 */
export const projectFilterQuerySchema = z.strictObject({
  project: z.union([z.literal("all"), z.uuid()]).optional(),
  unassigned: z.literal("include").optional(),
});
export type ProjectFilterQuery = z.infer<typeof projectFilterQuerySchema>;
