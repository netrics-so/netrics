import { eq, sql } from "drizzle-orm";
import { DEFAULT_DATA_POLICY, type DataPolicy } from "@netrics/domain";
import { dataPolicyOverrideSchema } from "@netrics/contracts";
import type { Db, Transaction } from "./context.js";
import { dataWorkspacePolicies } from "./schema.js";

export async function resolveDataPolicy(
  tx: Transaction,
  workspaceId: string,
  defaults: DataPolicy = { ...DEFAULT_DATA_POLICY },
) {
  const [row] = await tx
    .select()
    .from(dataWorkspacePolicies)
    .where(eq(dataWorkspacePolicies.workspaceId, workspaceId));
  const overrides = dataPolicyOverrideSchema.parse(row?.overrides ?? {});
  return { policy: { ...defaults, ...overrides }, overrides };
}

/** Installation API only: callers must authorize an installation administrator. */
export async function adminSetDataPolicy(
  db: Db | Transaction,
  workspaceId: string,
  input: unknown,
) {
  const overrides = dataPolicyOverrideSchema.parse(input);
  const [row] = await db.execute<{ workspace_id: string }>(
    sql`select admin_set_data_policy(${workspaceId}::uuid, ${JSON.stringify(overrides)}::jsonb) as workspace_id`,
  );
  return row?.workspace_id ?? null;
}
