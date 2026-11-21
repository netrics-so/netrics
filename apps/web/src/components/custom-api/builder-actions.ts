// What the builder does against the API (#807), apart from rendering: the
// draft (created on first entry to Login), secrets sent once, test
// requests, saving the definition and promoting the draft to its first
// connection. Pure over an injected client, so the flows are testable
// without a browser.

import {
  customApiDraftDefinitionSchema,
  type CustomApiDefinition,
  type CustomApiDefinitionResponse,
  type CustomApiDraft,
} from "@netrics/contracts";

import * as client from "@/lib/custom-api";
import {
  BUILDER_STEPS,
  definitionOf,
  draftDefinitionOf,
  type BuilderState,
  type BuilderStep,
} from "@/lib/custom-api-builder";

export type BuilderClient = Pick<
  typeof client,
  | "createDraft"
  | "updateDraft"
  | "deleteDraft"
  | "testDraft"
  | "promoteDraft"
  | "createDefinition"
  | "saveDefinitionVersion"
>;

export const defaultClient: BuilderClient = client;

/** The draft can store this state (its definition passes the draft schema). */
export function draftReady(state: BuilderState): boolean {
  return customApiDraftDefinitionSchema.safeParse(draftDefinitionOf(state))
    .success;
}

/** Non-secret connection values, for the draft and the test request. */
export function plainValues(state: BuilderState): Record<string, string> {
  const values: Record<string, string> = {};
  for (const variable of state.variables)
    if (!variable.secret && variable.id) values[variable.id] = variable.value;
  return values;
}

/** The draft's answer applied: stored secret names, and whether some were lost. */
export function withDraft(
  state: BuilderState,
  draft: CustomApiDraft,
  sent: readonly string[] = [],
): { state: BuilderState; secretsLost: boolean } {
  const kept = new Set(draft.secretsSet);
  const secretsLost = state.secretsSet.some(
    (name) => !kept.has(name) && !sent.includes(name),
  );
  return { state: { ...state, secretsSet: draft.secretsSet }, secretsLost };
}

export async function ensureDraft(
  api: BuilderClient,
  workspaceId: string,
  draftId: string | null,
  definitionId?: string,
): Promise<string> {
  if (draftId) return draftId;
  return (await api.createDraft(workspaceId, definitionId)).id;
}

/**
 * Stores the state on the draft; `secrets` (names → values, null removes)
 * are sent once and never kept. Without them, stored ones carry over while
 * the hosts and the login method stay the same.
 */
export async function syncDraft(
  api: BuilderClient,
  workspaceId: string,
  draftId: string,
  state: BuilderState,
  secrets?: Record<string, string | null>,
): Promise<{ state: BuilderState; secretsLost: boolean }> {
  const draft = await api.updateDraft(workspaceId, draftId, {
    definition: draftDefinitionOf(state),
    environmentId: state.environmentId,
    variables: plainValues(state),
    ...(secrets ? { secrets } : {}),
  });
  return withDraft(state, draft, Object.keys(secrets ?? {}));
}

/**
 * Moving to a step: the draft is created on the first entry to Login (or
 * any later step), never before; an existing draft is brought up to date
 * when the state is complete enough to store.
 */
export async function enterStep(
  api: BuilderClient,
  input: {
    workspaceId: string;
    draftId: string | null;
    definitionId?: string;
    state: BuilderState;
    target: BuilderStep;
  },
): Promise<{
  draftId: string | null;
  state: BuilderState;
  secretsLost: boolean;
}> {
  let draftId = input.draftId;
  if (!draftId && BUILDER_STEPS.indexOf(input.target) >= 1)
    draftId = await ensureDraft(
      api,
      input.workspaceId,
      null,
      input.definitionId,
    );
  if (!draftId || !draftReady(input.state))
    return { draftId, state: input.state, secretsLost: false };
  const synced = await syncDraft(api, input.workspaceId, draftId, input.state);
  return { draftId, ...synced };
}

/** Sends a test request (1 page from the Request step, 5 to test paging). */
export async function runTest(
  api: BuilderClient,
  workspaceId: string,
  draftId: string,
  state: BuilderState,
  pages: number,
): Promise<{ state: BuilderState; secretsLost: boolean }> {
  const result = await api.testDraft(workspaceId, draftId, {
    definition: draftDefinitionOf(state),
    environmentId: state.environmentId,
    variables: plainValues(state),
    pages,
  });
  const applied = withDraft(state, result.draft);
  return {
    state: { ...applied.state, lastTest: result },
    secretsLost: applied.secretsLost,
  };
}

export type SaveResult =
  | { kind: "connected"; connectionId: string }
  | { kind: "saved"; definitionId: string }
  /** The definition was saved but the promote failed: retry the promote only. */
  | {
      kind: "promoteFailed";
      saved: CustomApiDefinitionResponse;
      error: unknown;
    };

/**
 * "Save and connect". A new definition is created, then the draft becomes
 * its first connection; `saved` (from an earlier attempt whose promote
 * failed) skips the create, so the definition is never created twice. An
 * edited definition is saved as a new version on the version the editor
 * loaded (409 custom_api_definition_stale when someone saved since).
 */
export async function saveAndConnect(
  api: BuilderClient,
  input: {
    workspaceId: string;
    draftId: string | null;
    state: BuilderState;
    editing?: {
      id: string;
      currentVersion: number;
      document: CustomApiDefinition;
    };
    saved?: CustomApiDefinitionResponse;
  },
): Promise<SaveResult> {
  const { workspaceId, draftId, state, editing } = input;
  if (editing) {
    const result = await api.saveDefinitionVersion(workspaceId, editing.id, {
      document: definitionOf(state, editing.document),
      baseVersion: editing.currentVersion,
    });
    if (draftId) await api.deleteDraft(workspaceId, draftId).catch(() => {});
    return { kind: "saved", definitionId: result.definition.id };
  }
  const saved =
    input.saved ??
    (await api.createDefinition(workspaceId, {
      document: definitionOf(state),
      ...(state.projectId ? { projectId: state.projectId } : {}),
    }));
  if (!draftId)
    return {
      kind: "promoteFailed",
      saved,
      error: new client.CustomApiRequestError(
        404,
        "custom_api_draft_not_found",
      ),
    };
  try {
    const { connectionId } = await api.promoteDraft(workspaceId, draftId, {
      definitionId: saved.definition.id,
      version: saved.definition.currentVersion,
      name: state.name.trim(),
      projectId: state.projectId,
    });
    return { kind: "connected", connectionId };
  } catch (error) {
    return { kind: "promoteFailed", saved, error };
  }
}
