// The custom API builder's session copy (#807): its state across a reload
// or the OAuth round trip, keyed by workspace and draft. It never holds a
// secret (the builder state has none); the last test answer is dropped.

import {
  BUILDER_STEPS,
  type BuilderState,
  type BuilderStep,
} from "./custom-api-builder";

const PREFIX = "netrics.customApi.builder.";
/** Bumped when the stored shape changes; older copies are ignored. */
const VERSION = 1;

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
    stored.version !== VERSION ||
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
  return {
    state: { ...stored.state, lastTest: null },
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
