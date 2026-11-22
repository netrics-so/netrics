// The one reader of a custom-api connection's definition, drafts included
// (milestone 13, #806): the pinned version for a connection, the stored
// unsaved definition for a builder draft. C-G4's OAuth flow reads the token
// and authorize endpoints through it.

import {
  customApiDraftDefinitionSchema,
  type CustomApiDraftDefinition,
} from "@netrics/contracts";
import {
  upgradeCustomApiDefinition,
  type CustomApiDefinition,
} from "@netrics/connector-sdk/custom-api";
import {
  CUSTOM_API_CONNECTOR_ID,
  type CustomApiPin,
} from "@netrics/connectors/custom-api";
import {
  findConnection,
  type Transaction,
  rethrowWorkspaceGone,
} from "@netrics/database";

export type LoadedCustomApiDefinition =
  | {
      draft: false;
      definition: CustomApiDefinition;
      environmentId: string;
      pin: CustomApiPin;
    }
  | {
      draft: true;
      definition: CustomApiDraftDefinition;
      environmentId: string | null;
    };

/**
 * Pinned connections: upgradeCustomApiDefinition(pinned version document).
 * Drafts: config.draft.definition. null for another workspace, a bundled
 * connector, a draft without a definition yet, or an undecodable document.
 * Explicit workspace_id predicate (findConnection).
 */
export async function loadConnectionCustomApiDefinition(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
): Promise<LoadedCustomApiDefinition | null> {
  const found = await findConnection(tx, workspaceId, connectionId, {
    includeDrafts: true,
  });
  if (!found || found.row.connectorId !== CUSTOM_API_CONNECTOR_ID) return null;
  if (found.row.status === "draft") {
    const draft = (found.row.config as { draft?: Record<string, unknown> })
      ?.draft;
    const parsed = customApiDraftDefinitionSchema.safeParse(draft?.definition);
    if (!parsed.success) return null;
    const environmentId =
      typeof draft?.environmentId === "string" ? draft.environmentId : null;
    return { draft: true, definition: parsed.data, environmentId };
  }
  const pinned = found.customApi;
  if (!pinned) return null;
  try {
    return {
      draft: false,
      definition: upgradeCustomApiDefinition(pinned.document),
      environmentId: pinned.environmentId,
      pin: {
        definitionId: pinned.definitionId,
        versionId: pinned.versionId,
        version: pinned.version,
        environmentId: pinned.environmentId,
        datasetVersions: { ...pinned.datasetVersions },
      },
    };
  } catch (caught) {
    rethrowWorkspaceGone(caught);
    return null;
  }
}
