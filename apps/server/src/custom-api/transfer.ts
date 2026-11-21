// Export and import of custom API definitions (milestone 13, #808). An
// export is the definition document with its schema version and nothing
// else: documents hold no secrets, and no connection value, connection id
// or workspace id is added. An import runs the same upgrade and validation
// as a save (the document schema is strict, so keys such as `credentials`
// or `token` are refused, never stored) and creates a new definition.

import {
  CUSTOM_API_EXPORT_FORMAT,
  CUSTOM_API_SCHEMA_VERSION,
  CustomApiDefinitionError,
  customApiExportSchema,
  upgradeCustomApiDefinition,
  type CustomApiDefinition,
  type CustomApiDefinitionResponse,
  type CustomApiExport,
  type CustomApiIssue,
  type ImportCustomApiDefinitionRequest,
} from "@netrics/contracts";
import {
  insertAuditEvent,
  withWorkspace,
  type Database,
} from "@netrics/database";

import type { CustomApiInstanceConfig } from "../env.js";
import {
  createCustomApiService,
  type Actor,
  type CustomApiResult,
} from "./service.js";
import { createCustomApiVersionService } from "./versions.js";

/** The export envelope of a document. */
export function exportDefinition(
  document: CustomApiDefinition,
  now: Date,
): CustomApiExport {
  return {
    format: CUSTOM_API_EXPORT_FORMAT,
    schemaVersion: document.schemaVersion,
    exportedAt: now.toISOString(),
    definition: document,
  };
}

/** `[a-z0-9-]`, at most 60 characters; "custom-api" when nothing is left. */
export function exportFileSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "custom-api";
}

type ImportFailure = {
  ok: false;
  error: "custom_api_import_invalid" | "custom_api_import_newer";
  issues: CustomApiIssue[];
};

const prefixed = (issues: CustomApiIssue[]) =>
  issues.map((issue) => ({
    ...issue,
    path: issue.path ? `definition.${issue.path}` : "definition",
  }));

/**
 * The exported file's document, upgraded to today's schema and validated;
 * or the refusal with up to 20 issues (paths and fixed messages, never the
 * file's values).
 */
export function parseImport(
  file: unknown,
): { ok: true; document: CustomApiDefinition } | ImportFailure {
  const envelope = customApiExportSchema.safeParse(file);
  const newer = (version: unknown) =>
    typeof version === "number" && version > CUSTOM_API_SCHEMA_VERSION;
  if (
    file !== null &&
    typeof file === "object" &&
    (newer((file as Record<string, unknown>).schemaVersion) ||
      newer(
        (
          (file as Record<string, unknown>).definition as
            Record<string, unknown> | undefined
        )?.schemaVersion,
      ))
  )
    return { ok: false, error: "custom_api_import_newer", issues: [] };
  if (!envelope.success)
    return {
      ok: false,
      error: "custom_api_import_invalid",
      issues: envelope.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.map(String).join("."),
        code: "invalid",
        // zod's built-in messages name the expectation, not the input.
        message: issue.message,
      })),
    };
  try {
    return {
      ok: true,
      document: upgradeCustomApiDefinition(envelope.data.definition),
    };
  } catch (error) {
    if (error instanceof CustomApiDefinitionError)
      return {
        ok: false,
        error:
          error.code === "unsupported_schema_version" &&
          newer(
            (envelope.data.definition as Record<string, unknown> | null)
              ?.schemaVersion,
          )
            ? "custom_api_import_newer"
            : "custom_api_import_invalid",
        issues: error.issues.length
          ? prefixed(error.issues)
          : [{ path: "definition", code: "invalid", message: error.message }],
      };
    throw error;
  }
}

export function createCustomApiTransferService(deps: {
  db: Database;
  limits: CustomApiInstanceConfig;
}) {
  const definitions = createCustomApiService(deps);
  const versions = createCustomApiVersionService(deps);

  return {
    /** GET …/definitions/:id/export?version= */
    async export(
      actor: Actor,
      definitionId: string,
      version: number | undefined,
      now: Date = new Date(),
    ): Promise<CustomApiResult<{ file: CustomApiExport; filename: string }>> {
      let number = version;
      if (number === undefined) {
        const found = await definitions.get(actor, definitionId);
        if (!found.ok) return found;
        number = found.value.definition.currentVersion;
      }
      const read = await versions.getVersion(actor, definitionId, number);
      if (!read.ok) return read;
      await withWorkspace(
        deps.db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        (tx) =>
          insertAuditEvent(tx, {
            workspaceId: actor.workspaceId,
            actorUserId: actor.callerId,
            action: "custom_api_definition.exported",
            target: definitionId,
            metadata: { version: read.value.version },
          }),
      );
      return {
        ok: true,
        value: {
          file: exportDefinition(read.value.document, now),
          filename: `${exportFileSlug(read.value.name)}.netrics-api.json`,
        },
      };
    },

    /** POST …/definitions/import */
    async import(
      actor: Actor,
      body: ImportCustomApiDefinitionRequest,
    ): Promise<CustomApiResult<CustomApiDefinitionResponse>> {
      const parsed = parseImport(body.file);
      if (!parsed.ok)
        return {
          ok: false,
          status: 400,
          error: parsed.error,
          ...(parsed.issues.length ? { issues: parsed.issues } : {}),
        };
      const name = body.name ?? parsed.document.name;
      return definitions.create(
        actor,
        {
          document: { ...parsed.document, name },
          ...(body.projectId ? { projectId: body.projectId } : {}),
        },
        { importName: name },
      );
    },
  };
}
