// The custom API builder's session copy (#807): its state across a reload
// or the OAuth round trip, keyed by workspace and draft. It never holds a
// secret (the builder state has none); the last test answer is dropped.

import type { CustomApiBody } from "@netrics/contracts";

import {
  BUILDER_STEPS,
  bodyEditorOf,
  type BuilderState,
  type BuilderStep,
} from "./custom-api-builder";

const PREFIX = "netrics.customApi.builder.";
/**
 * Bumped when the stored shape changes; older copies are ignored, except
 * version 1 (before #869), whose kept POST body is read into the editor.
 */
const VERSION = 2;

export interface StoredBuilder {
  state: BuilderState;
  step: BuilderStep;
  /** Editing: the definition and the version the editor loaded. */
  definitionId: string | null;
  baseVersion: number | null;
}

export const builderStorageKey = (workspaceId: string, draftId: string) =>
  `${PREFIX}${workspaceId}.${draftId}`;

/** The stored copy when it is this shape and for this definition; else null. */
export function parseStoredBuilder(
  raw: string | null,
  definitionId: string | null,
): StoredBuilder | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const stored = value as Partial<StoredBuilder> & { version?: unknown };
  if (
    (stored.version !== VERSION && stored.version !== 1) ||
    !stored.state ||
    typeof stored.state !== "object" ||
    !Array.isArray(stored.state.environments) ||
    !stored.state.stream ||
    !BUILDER_STEPS.includes(stored.step as BuilderStep) ||
    (stored.definitionId ?? null) !== definitionId ||
    (stored.baseVersion !== null &&
      (typeof stored.baseVersion !== "number" ||
        !Number.isInteger(stored.baseVersion)))
  )
    return null;
  const stream = stored.state.stream as BuilderState["stream"] & {
    post?: { method: "POST"; body: CustomApiBody };
  };
  const { post, ...rest } = stream;
  return {
    state: {
      ...stored.state,
      stream:
        stored.version === 1
          ? {
              ...rest,
              method: post ? "POST" : "GET",
              body: bodyEditorOf(post?.body),
            }
          : stream,
      // Before #869 no confirmation was kept: the save asks again.
      readOnly: stored.state.readOnly ?? {},
      images: stored.state.images ?? null,
      // Stored before #834's review: every field counts as set.
      nullableChosen:
        stored.state.nullableChosen ??
        stored.state.stream.fields.map((field) => field.id),
      lastTest: null,
    },
    step: stored.step as BuilderStep,
    definitionId,
    baseVersion: stored.baseVersion ?? null,
  };
}

export function serializeStoredBuilder(stored: StoredBuilder): string {
  return JSON.stringify({
    version: VERSION,
    ...stored,
    state: { ...stored.state, lastTest: null },
  });
}

export function readStoredBuilder(
  workspaceId: string,
  draftId: string,
  definitionId: string | null,
): StoredBuilder | null {
  try {
    return parseStoredBuilder(
      window.sessionStorage.getItem(builderStorageKey(workspaceId, draftId)),
      definitionId,
    );
  } catch {
    return null;
  }
}

export function writeStoredBuilder(
  workspaceId: string,
  draftId: string,
  stored: StoredBuilder | null,
): void {
  try {
    const key = builderStorageKey(workspaceId, draftId);
    if (stored === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, serializeStoredBuilder(stored));
  } catch {
    // Storage unavailable: a reload starts the builder again.
  }
}

/** Forgets every builder copy of this tab (sign-out). */
export function clearStoredBuilders(
  storage:
    | Pick<Storage, "length" | "key" | "removeItem">
    | undefined = typeof window === "undefined"
    ? undefined
    : window.sessionStorage,
): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Storage unavailable: nothing stored.
  }
}
