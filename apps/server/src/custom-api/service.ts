import { randomUUID } from "node:crypto";

import {
  CustomApiDefinitionError,
  upgradeCustomApiDefinition,
  type CreateCustomApiDefinitionRequest,
  type CreateCustomApiDefinitionVersionRequest,
  type CustomApiDefinition,
  type CustomApiDefinitionListQuery,
  type CustomApiDefinitionListResponse,
  type CustomApiDefinitionResponse,
  type CustomApiDefinitionSummary,
  type CustomApiIssue,
  type UpdateCustomApiDefinitionRequest,
} from "@netrics/contracts";
import {
  countCustomApiDefinitions,
  findCustomApiDefinition,
  findProject,
  insertAuditEvent,
  insertCustomApiDefinition,
  insertCustomApiDefinitionVersion,
  listCustomApiDefinitions,
  updateCustomApiDefinition,
  withWorkspace,
  type CustomApiDefinitionRow,
  type CustomApiDefinitionWithVersion,
  type Database,
  type Transaction,
} from "@netrics/database";

import type { CustomApiInstanceConfig } from "../env.js";
import { canonicalSha256 } from "./canonical-json.js";
import { customApiDatasetVersions } from "./dataset-versions.js";

/**
 * Custom API definitions (milestone 13, #803): a workspace's own API
 * descriptions, stored as immutable versions. Documents hold no secrets;
 * audit events carry names and versions, never document content.
 */

export interface Actor {
  workspaceId: string;
  callerId: string;
}

export type CustomApiResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409;
      error: string;
      issues?: CustomApiIssue[];
    };

type Failure = Extract<CustomApiResult<never>, { ok: false }>;

function fail(
  status: Failure["status"],
  error: string,
  issues?: CustomApiIssue[],
): Failure {
  return issues
    ? { ok: false, status, error, issues }
    : { ok: false, status, error };
}

const NOT_FOUND = fail(404, "custom_api_definition_not_found");

function summary(
  definition: CustomApiDefinitionRow,
  connectionCount: number,
): CustomApiDefinitionSummary {
  return {
    id: definition.id,
    name: definition.name,
    projectId: definition.projectId,
    currentVersion: definition.currentVersion,
    archivedAt: definition.archivedAt?.toISOString() ?? null,
    connectionCount,
    createdAt: definition.createdAt.toISOString(),
    updatedAt: definition.updatedAt.toISOString(),
  };
}

function present(
  found: CustomApiDefinitionWithVersion,
): CustomApiDefinitionResponse {
  return {
    definition: {
      ...summary(found.definition, found.connectionCount),
      // Stored documents passed validation when they were saved; reading
      // them through the upgrade keeps older schema versions readable.
      document: upgradeCustomApiDefinition(found.version.document),
      datasetVersions: found.version.datasetVersions as Record<string, number>,
    },
  };
}

/** The validated document, or the 400 answer with its issues. */
function validate(
  raw: unknown,
  limits: CustomApiInstanceConfig,
): { ok: true; document: CustomApiDefinition } | Failure {
  let document: CustomApiDefinition;
  try {
    document = upgradeCustomApiDefinition(raw);
  } catch (error) {
    if (error instanceof CustomApiDefinitionError) {
      return fail(400, "custom_api_definition_invalid", error.issues);
    }
    throw error;
  }
  if (document.streams.length > limits.maxStreams) {
    return fail(400, "custom_api_stream_limit");
  }
  return { ok: true, document };
}

function versionContent(
  document: CustomApiDefinition,
  datasetVersions: Record<string, number>,
  createdBy: string,
) {
  return {
    createdBy,
    document: document as unknown as Record<string, unknown>,
    documentSha256: canonicalSha256(document),
    schemaVersion: document.schemaVersion,
    datasetVersions,
  };
}

/** Null when the project is live in the workspace; otherwise the 404. */
async function checkProject(
  tx: Transaction,
  workspaceId: string,
  projectId: string,
): Promise<Failure | null> {
  const project = await findProject(tx, workspaceId, projectId);
  // Archived projects take no new items (#572).
  return !project || project.archivedAt !== null
    ? fail(404, "project_not_found")
    : null;
}

export function createCustomApiService(deps: {
  db: Database;
  limits: CustomApiInstanceConfig;
}) {
  const inWorkspace = <T>(actor: Actor, run: (tx: Transaction) => Promise<T>) =>
    withWorkspace(
      deps.db,
      { workspaceId: actor.workspaceId, userId: actor.callerId },
      run,
    );

  return {
    list(
      actor: Actor,
      query: CustomApiDefinitionListQuery,
    ): Promise<CustomApiResult<CustomApiDefinitionListResponse>> {
      return inWorkspace(actor, async (tx) => {
        const rows = await listCustomApiDefinitions(tx, actor.workspaceId, {
          includeArchived: query.includeArchived === "true",
          ...(query.project !== undefined ? { project: query.project } : {}),
          ...(query.unassigned !== undefined
            ? { unassigned: query.unassigned }
            : {}),
        });
        return {
          ok: true,
          value: {
            definitions: rows.map((row) =>
              summary(row.definition, row.connectionCount),
            ),
          },
        };
      });
    },

    get(
      actor: Actor,
      definitionId: string,
    ): Promise<CustomApiResult<CustomApiDefinitionResponse>> {
      return inWorkspace(actor, async (tx) => {
        const found = await findCustomApiDefinition(
          tx,
          actor.workspaceId,
          definitionId,
        );
        return found ? { ok: true, value: present(found) } : NOT_FOUND;
      });
    },

    create(
      actor: Actor,
      body: CreateCustomApiDefinitionRequest,
    ): Promise<CustomApiResult<CustomApiDefinitionResponse>> {
      const valid = validate(body.document, deps.limits);
      if (!valid.ok) {
        return Promise.resolve(valid);
      }
      const { document } = valid;
      return inWorkspace(actor, async (tx) => {
        if (body.projectId !== undefined) {
          const refused = await checkProject(
            tx,
            actor.workspaceId,
            body.projectId,
          );
          if (refused) {
            return refused;
          }
        }
        // Two concurrent creates may both pass this count and end one above
        // the limit; the limit bounds abuse, it is not an exact quota.
        const count = await countCustomApiDefinitions(tx, actor.workspaceId);
        if (count >= deps.limits.maxDefinitions) {
          return fail(409, "custom_api_definition_limit");
        }
        const created = await insertCustomApiDefinition(tx, actor.workspaceId, {
          id: randomUUID(),
          projectId: body.projectId ?? null,
          name: document.name,
          ...versionContent(
            document,
            customApiDatasetVersions(null, document),
            actor.callerId,
          ),
        });
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "custom_api_definition.created",
          target: created.definition.id,
          metadata: { name: created.definition.name, version: 1 },
        });
        return { ok: true, value: present(created) };
      });
    },

    createVersion(
      actor: Actor,
      definitionId: string,
      body: CreateCustomApiDefinitionVersionRequest,
    ): Promise<CustomApiResult<CustomApiDefinitionResponse>> {
      const valid = validate(body.document, deps.limits);
      if (!valid.ok) {
        return Promise.resolve(valid);
      }
      const { document } = valid;
      return inWorkspace(
        actor,
        async (tx): Promise<CustomApiResult<CustomApiDefinitionResponse>> => {
          const current = await findCustomApiDefinition(
            tx,
            actor.workspaceId,
            definitionId,
          );
          if (!current) {
            return NOT_FOUND;
          }
          if (current.definition.archivedAt !== null) {
            return fail(409, "custom_api_definition_archived");
          }
          if (current.definition.currentVersion !== body.baseVersion) {
            return fail(409, "custom_api_definition_stale");
          }
          const datasetVersions = customApiDatasetVersions(
            {
              document: upgradeCustomApiDefinition(current.version.document),
              datasetVersions: current.version.datasetVersions as Record<
                string,
                number
              >,
            },
            document,
          );
          // The insert locks the definition and checks the base again: of two
          // concurrent saves from the same base, the second answers stale.
          const created = await insertCustomApiDefinitionVersion(
            tx,
            actor.workspaceId,
            definitionId,
            {
              baseVersion: body.baseVersion,
              name: document.name,
              ...versionContent(document, datasetVersions, actor.callerId),
            },
          );
          if (created === null) {
            return NOT_FOUND;
          }
          if (created === "stale") {
            return fail(409, "custom_api_definition_stale");
          }
          if (created.definition.archivedAt !== null) {
            // Archived between the read and the lock: roll the version back.
            throw new ArchivedMeanwhile();
          }
          await insertAuditEvent(tx, {
            workspaceId: actor.workspaceId,
            actorUserId: actor.callerId,
            action: "custom_api_definition.version_created",
            target: definitionId,
            metadata: { version: created.version.version },
          });
          return { ok: true, value: present(created) };
        },
      ).catch((error: unknown) => {
        if (error instanceof ArchivedMeanwhile) {
          return fail(409, "custom_api_definition_archived");
        }
        throw error;
      });
    },

    update(
      actor: Actor,
      definitionId: string,
      body: UpdateCustomApiDefinitionRequest,
    ): Promise<CustomApiResult<CustomApiDefinitionResponse>> {
      return inWorkspace(actor, async (tx) => {
        const current = await findCustomApiDefinition(
          tx,
          actor.workspaceId,
          definitionId,
        );
        if (!current) {
          return NOT_FOUND;
        }
        if (current.definition.archivedAt !== null) {
          return fail(409, "custom_api_definition_archived");
        }
        if (body.projectId !== null) {
          const refused = await checkProject(
            tx,
            actor.workspaceId,
            body.projectId,
          );
          if (refused) {
            return refused;
          }
        }
        const row = await updateCustomApiDefinition(
          tx,
          actor.workspaceId,
          definitionId,
          { projectId: body.projectId },
        );
        if (!row) {
          return NOT_FOUND;
        }
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "custom_api_definition.updated",
          target: definitionId,
          metadata: { projectId: body.projectId },
        });
        return {
          ok: true,
          value: present({ ...current, definition: row }),
        };
      });
    },

    archive(
      actor: Actor,
      definitionId: string,
    ): Promise<CustomApiResult<CustomApiDefinitionResponse>> {
      return inWorkspace(actor, async (tx) => {
        const current = await findCustomApiDefinition(
          tx,
          actor.workspaceId,
          definitionId,
        );
        if (!current) {
          return NOT_FOUND;
        }
        if (current.definition.archivedAt !== null) {
          // Archiving twice changes nothing.
          return { ok: true, value: present(current) };
        }
        const row = await updateCustomApiDefinition(
          tx,
          actor.workspaceId,
          definitionId,
          { archivedAt: new Date() },
        );
        if (!row) {
          return NOT_FOUND;
        }
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "custom_api_definition.archived",
          target: definitionId,
          metadata: { name: row.name },
        });
        return {
          ok: true,
          value: present({ ...current, definition: row }),
        };
      });
    },
  };
}

class ArchivedMeanwhile extends Error {
  constructor() {
    super("custom API definition archived during the save");
  }
}
