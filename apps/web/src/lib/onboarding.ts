/**
 * First-run onboarding (#308, design 1e): three steps from an empty account
 * to a number on a screen. The step is derived from what exists, so nothing
 * is stored: no workspace yet is step 1; a workspace without a real source
 * is step 2 (demo data does not count); after that, or when the user skips
 * the source, step 3.
 */

export const ONBOARDING_STEPS = ["workspace", "source", "screen"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type OnboardingStepState = "done" | "current" | "next";

/** The connector that generates demo data (apps/server onboarding). */
export const DEMO_CONNECTOR_ID = "demo";

export interface OnboardingState {
  /** False on the home page before the first workspace exists. */
  hasWorkspace: boolean;
  /** The workspace's connections (any status). */
  connections?: readonly { connectorId: string }[];
  /** Whether the caller may add sources; viewers go straight to step 3. */
  canConnect?: boolean;
  /** `?step=screen`: the user skipped the source step. */
  requested?: string | null;
}

export function hasRealSource(
  connections: readonly { connectorId: string }[],
): boolean {
  return connections.some((c) => c.connectorId !== DEMO_CONNECTOR_ID);
}

export function hasDemoSource(
  connections: readonly { connectorId: string }[],
): boolean {
  return connections.some((c) => c.connectorId === DEMO_CONNECTOR_ID);
}

export function onboardingStep(state: OnboardingState): OnboardingStep {
  if (!state.hasWorkspace) {
    return "workspace";
  }
  if (
    state.requested === "screen" ||
    state.canConnect === false ||
    hasRealSource(state.connections ?? [])
  ) {
    return "screen";
  }
  return "source";
}

/** Each step's state in the rail: before the current one is done. */
export function onboardingRail(
  current: OnboardingStep,
): { step: OnboardingStep; number: number; state: OnboardingStepState }[] {
  const index = ONBOARDING_STEPS.indexOf(current);
  return ONBOARDING_STEPS.map((step, i) => ({
    step,
    number: i + 1,
    state: i < index ? "done" : i === index ? "current" : "next",
  }));
}

/** Where step 2 sends a chosen connector: the wizard, preselected. */
export function connectSourcePath(
  workspaceId: string,
  connectorId: string,
): string {
  return `/workspaces/${workspaceId}/connections/new?connector=${encodeURIComponent(connectorId)}`;
}

export function welcomePath(
  workspaceId: string,
  step?: OnboardingStep,
): string {
  return `/workspaces/${workspaceId}/welcome${step === "screen" ? "?step=screen" : ""}`;
}
