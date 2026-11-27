// Version history and rollback of custom API definitions (milestone 13,
// #808). Versions are immutable: a restore saves the old document as a new
// version through the service's createVersion, so validation, dataset
// versions, limits, the stale check and the audit are the same as a save.

import {
  CUSTOM_API_SCHEMA_VERSION,
  CustomApiDefinitionError,
  readStoredCustomApiDefinition,
  upgradeCustomApiDefinition,
  type CustomApiDefinition,
  type CustomApiDefinitionResponse,
  type CustomApiVersionHistory,
  type RestoreCustomApiVersionRequest,
} from "@netrics/contracts";
import {
  findCustomApiDefinition,
  findCustomApiDefinitionVersion,
  listCustomApiDefinitionVersionHashes,
  listCustomApiDefinitionVersions,
  withWorkspace,
  type CustomApiDefinitionVersionHash,
  type Database,
  rethrowWorkspaceGone,
} from "@netrics/database";

import type { CustomApiInstanceConfig } from "../env.js";
import { canonicalSha256 } from "./canonical-json.js";
import {
  createCustomApiService,
  type Actor,
  type CustomApiResult,
} from "./service.js";

/** Versions per history page. */
export const CUSTOM_API_HISTORY_PAGE = 20;
/** Versions before a page compared for "same as version N" (#885). */
export const CUSTOM_API_HISTORY_SAME_AS_LOOKBACK = 100;

const NOT_FOUND = {
  ok: false,
  status: 404,
  error: "custom_api_definition_not_found",
} as const;

/**
 * For each version, the nearest earlier version with the same content
 * (#885). Contents compare at today's schema version, as a restore does:
 * the stored hash of a version saved at an older schema version is that
 * of the older document, so its document is upgraded and hashed again
 * (the stored hash stays when the stored shape no longer reads). `rows`
 * is the page and the CUSTOM_API_HISTORY_SAME_AS_LOOKBACK versions before
 * it: a match further back is not named, so a page reads and re-hashes at
 * most 120 versions however long the history is.
 */
function sameAsOf(
  rows: readonly CustomApiDefinitionVersionHash[],
): Map<number, number | null> {
  const latest = new Map<string, number>();
  const sameAs = new Map<number, number | null>();
  for (const row of rows) {
    let hash = row.documentSha256;
    if (row.schemaVersion < CUSTOM_API_SCHEMA_VERSION && row.document !== null)
      try {
        hash = canonicalSha256(readStoredCustomApiDefinition(row.document));
      } catch (caught) {
        rethrowWorkspaceGone(caught);
      }
    sameAs.set(row.version, latest.get(hash) ?? null);
    latest.set(hash, row.version);
  }
  return sameAs;
}

/** Counts for the history list; zeros when the stored shape is unreadable. */
function summaryOf(
  raw: unknown,
): CustomApiVersionHistory["versions"][number]["summary"] {
  try {
    const document = readStoredCustomApiDefinition(raw);
    return {
      streams: document.streams.length,
      fields: document.streams.reduce(
        (total, stream) => total + stream.fields.length,
        0,
      ),
      environments: document.environments.length,
    };
  } catch (caught) {
    rethrowWorkspaceGone(caught);
    return { streams: 0, fields: 0, environments: 0 };
  }
}

export function createCustomApiVersionService(deps: {
  db: Database;
  limits: CustomApiInstanceConfig;
}) {
  const definitions = createCustomApiService(deps);
  const inWorkspace = <T>(
    actor: Actor,
    run: Parameters<typeof withWorkspace<T>>[2],
  ) =>
    withWorkspace(
      deps.db,
      { workspaceId: actor.workspaceId, userId: actor.callerId },
      run,
    );

  return {
    /** Newest first, 20 per page; `before` pages to older versions. */
    listVersions(
      actor: Actor,
      definitionId: string,
      before?: number,
    ): Promise<CustomApiResult<CustomApiVersionHistory>> {
      return inWorkspace(actor, async (tx) => {
        const found = await findCustomApiDefinition(
          tx,
          actor.workspaceId,
          definitionId,
        );
        if (!found) return NOT_FOUND;
        // One more than a page tells whether an older page exists.
        const rows = await listCustomApiDefinitionVersions(
          tx,
          actor.workspaceId,
          definitionId,
          {
            ...(before !== undefined ? { before } : {}),
            limit: CUSTOM_API_HISTORY_PAGE + 1,
          },
        );
        const page = rows.slice(0, CUSTOM_API_HISTORY_PAGE);
        const sameAs = sameAsOf(
          page.length === 0
            ? []
            : await listCustomApiDefinitionVersionHashes(
                tx,
                actor.workspaceId,
                definitionId,
                {
                  from:
                    page[page.length - 1]!.version -
                    CUSTOM_API_HISTORY_SAME_AS_LOOKBACK,
                  through: page[0]!.version,
                  documentsBelowSchema: CUSTOM_API_SCHEMA_VERSION,
                },
              ),
        );
        return {
          ok: true,
          value: {
            versions: page.map((row) => ({
              id: row.id,
              version: row.version,
              createdAt: row.createdAt.toISOString(),
              author: row.author,
              current: row.version === found.definition.currentVersion,
              sameAs: sameAs.get(row.version) ?? null,
              summary: summaryOf(row.document),
            })),
            nextBefore:
              rows.length > CUSTOM_API_HISTORY_PAGE
                ? page[page.length - 1]!.version
                : null,
          },
        };
      });
    },

    /** One version's document (read-only view, export). */
    getVersion(
      actor: Actor,
      definitionId: string,
      version: number,
    ): Promise<
      CustomApiResult<{
        version: number;
        name: string;
        document: CustomApiDefinition;
      }>
    > {
      return inWorkspace(actor, async (tx) => {
        const found = await findCustomApiDefinition(
          tx,
          actor.workspaceId,
          definitionId,
        );
        if (!found) return NOT_FOUND;
        const row =
          version === found.version.version
            ? found.version
            : await findCustomApiDefinitionVersion(
                tx,
                actor.workspaceId,
                definitionId,
                version,
              );
        if (!row)
          return {
            ok: false,
            status: 404,
            error: "custom_api_version_not_found",
          };
        let document: CustomApiDefinition;
        try {
          document = readStoredCustomApiDefinition(row.document);
        } catch (error) {
          if (error instanceof CustomApiDefinitionError)
            return {
              ok: false,
              status: 409,
              error: "custom_api_definition_invalid",
              issues: error.issues,
            };
          throw error;
        }
        return {
          ok: true,
          value: {
            version: row.version,
            name: found.definition.name,
            document,
          },
        };
      });
    },

    /**
     * Saves version `version`'s document as the next version. Refused with
     * custom_api_version_unchanged when it equals the current document,
     * custom_api_definition_stale when baseVersion is not current, and
     * custom_api_definition_invalid when today's rules reject it.
     */
    async restore(
      actor: Actor,
      definitionId: string,
      version: number,
      body: RestoreCustomApiVersionRequest,
    ): Promise<CustomApiResult<CustomApiDefinitionResponse>> {
      const old = await inWorkspace(actor, (tx) =>
        findCustomApiDefinitionVersion(
          tx,
          actor.workspaceId,
          definitionId,
          version,
        ),
      );
      if (!old) {
        const definition = await inWorkspace(actor, (tx) =>
          findCustomApiDefinition(tx, actor.workspaceId, definitionId),
        );
        return definition
          ? { ok: false, status: 404, error: "custom_api_version_not_found" }
          : NOT_FOUND;
      }
      let document: CustomApiDefinition;
      try {
        // Older schema versions are upgraded to today's before saving.
        document = upgradeCustomApiDefinition(old.document);
      } catch (error) {
        if (error instanceof CustomApiDefinitionError)
          return {
            ok: false,
            status: 400,
            error: "custom_api_definition_invalid",
            issues: error.issues,
          };
        throw error;
      }
      return definitions.createVersion(
        actor,
        definitionId,
        { baseVersion: body.baseVersion, document },
        { restoredFrom: version },
      );
    },
  };
}
