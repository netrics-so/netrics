"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type {
  CustomApiDefinitionResponse,
  CustomApiTestResponse,
} from "@netrics/contracts";

import { apiErrorMessage } from "@/lib/api";
import { CustomApiRequestError, startCustomOAuth } from "@/lib/custom-api";
import {
  BUILDER_STEPS,
  emptyBuilderState,
  pickRecords,
  stateFromDefinition,
  stepIssues,
  type BuilderState,
  type BuilderStep,
} from "@/lib/custom-api-builder";
import { useLocale, useT } from "@/lib/i18n/client";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

import {
  defaultClient,
  draftReady,
  ensureDraft,
  enterStep,
  runTest,
  saveAndConnect,
  syncDraft,
  type BuilderClient,
} from "./builder-actions";
import { StepBasics } from "./step-basics";
import { StepLogin } from "./step-login";
import { StepPaging } from "./step-paging";
import { StepRequest } from "./step-request";
import { StepResponse } from "./step-response";
import { StepSchedule } from "./step-schedule";
import { TestPanel } from "./test-panel";
import { CustomApiSummary } from "./summary";

type SavedDefinition = CustomApiDefinitionResponse["definition"];
type Pending = "draft" | "secrets" | "test" | "save" | "discard" | null;

/** Where the builder keeps its (secret-free) state across a reload or the OAuth round trip. */
export const storageKey = (draftId: string) =>
  `netrics.customApi.builder.${draftId}`;

interface Stored {
  state: BuilderState;
  step: BuilderStep;
}

function readStored(draftId: string): Stored | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(draftId));
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

function writeStored(draftId: string, stored: Stored | null) {
  try {
    if (stored === null) window.sessionStorage.removeItem(storageKey(draftId));
    else
      window.sessionStorage.setItem(
        storageKey(draftId),
        JSON.stringify({
          ...stored,
          state: { ...stored.state, lastTest: null },
        }),
      );
  } catch {
    // Storage unavailable: a reload starts the builder again.
  }
}

/** The first step that is not complete, or the last one. */
export function firstOpenStep(state: BuilderState): BuilderStep {
  return (
    BUILDER_STEPS.find((step) => stepIssues(state, step).length > 0) ?? "review"
  );
}

/** A step can be opened when every step before it is complete. */
export function reachable(state: BuilderState, step: BuilderStep): boolean {
  const index = BUILDER_STEPS.indexOf(step);
  return BUILDER_STEPS.slice(0, index).every(
    (before) => stepIssues(state, before).length === 0,
  );
}

export interface CustomApiBuilderProps {
  workspaceId: string;
  /** Editing a saved definition (its current version). */
  definition?: SavedDefinition;
  /** May edit (new: connections:create; saved: connections:update). */
  canEdit: boolean;
  projects: ReadonlyArray<{
    id: string;
    name: string;
    archivedAt: string | null;
  }>;
  /** The draft of this builder (`?draft=`), kept across a reload. */
  draftId?: string | null;
  /** Tests: where to start. */
  initial?: { state?: BuilderState; step?: BuilderStep };
  /** Tests: the API client. */
  api?: BuilderClient;
}

/**
 * The six-step custom API builder (#807): Basics, Login, Request, Response,
 * Paging and time window, Schedule and review, with the test panel beside
 * steps 3 to 6. The draft connection is created on the first entry to
 * Login, never on page load.
 */
export function CustomApiBuilder({
  workspaceId,
  definition,
  canEdit,
  projects,
  draftId: initialDraftId = null,
  initial,
  api = defaultClient,
}: CustomApiBuilderProps) {
  const t = useT("customApi");
  const locale = useLocale();
  const router = useRouter();
  const [state, setState] = useState<BuilderState>(() => {
    if (initial?.state) return initial.state;
    if (definition) {
      const state = stateFromDefinition(definition.document);
      return { ...state, projectId: definition.projectId };
    }
    return emptyBuilderState(locale, "UTC");
  });
  const [step, setStep] = useState<BuilderStep>(initial?.step ?? "basics");
  const [draftId, setDraftId] = useState<string | null>(initialDraftId);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [secretsLost, setSecretsLost] = useState(false);
  const [testedFields, setTestedFields] = useState<string | null>(null);
  const [pagingTest, setPagingTest] = useState<CustomApiTestResponse | null>(
    null,
  );
  const [saved, setSaved] = useState<CustomApiDefinitionResponse | null>(null);
  const [stale, setStale] = useState(false);
  const done = useRef(false);

  // A new definition counts days in the viewer's time zone; a reload or
  // the OAuth round trip restores the builder from the session.
  useEffect(() => {
    if (initial?.state) return;
    const stored = initialDraftId ? readStored(initialDraftId) : null;
    if (stored) {
      setState(stored.state);
      setStep(stored.step);
    } else if (!definition)
      setState((current) => ({
        ...current,
        defaults: { ...current.defaults, timeZone: viewerTimeZone() },
      }));
    // Once, on mount (the props are the page's first render).
  }, []);

  useEffect(() => {
    if (draftId && !done.current) writeStored(draftId, { state, step });
  }, [draftId, state, step]);

  useEffect(() => {
    if (!draftId) return;
    const leave = (event: BeforeUnloadEvent) => {
      if (done.current) return;
      event.preventDefault();
      event.returnValue = t("errors.leave");
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [draftId, t]);

  if (!canEdit && definition)
    return <CustomApiSummary definition={definition} />;

  const update = (change: (current: BuilderState) => BuilderState) =>
    setState(change);

  const message = (cause: unknown) => {
    if (
      cause instanceof CustomApiRequestError &&
      cause.status === 429 &&
      cause.retryAfterSeconds !== null
    )
      return t("test.wait", { seconds: cause.retryAfterSeconds });
    return apiErrorMessage(cause, locale);
  };

  /** A refused draft request: an expired draft starts the login again. */
  const refused = (cause: unknown, current: BuilderState): BuilderState => {
    if (cause instanceof CustomApiRequestError) {
      if (cause.code === "custom_api_draft_not_found") {
        setDraftId(null);
        return { ...current, secretsSet: [] };
      }
      if (cause.code === "custom_api_credentials_host_changed") {
        setSecretsLost(true);
        return { ...current, secretsSet: [] };
      }
    }
    return current;
  };

  const rememberDraft = (id: string) => {
    if (id === draftId) return;
    setDraftId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("draft", id);
    window.history.replaceState(window.history.state, "", url);
  };

  async function goTo(target: BuilderStep) {
    if (pending) return;
    setError(null);
    setPending("draft");
    try {
      const entered = await enterStep(api, {
        workspaceId,
        draftId,
        ...(definition ? { definitionId: definition.id } : {}),
        state,
        target,
      });
      if (entered.draftId) rememberDraft(entered.draftId);
      if (entered.secretsLost) setSecretsLost(true);
      setState(entered.state);
      setStep(target);
    } catch (cause) {
      setState(refused(cause, state));
      setError(message(cause));
    } finally {
      setPending(null);
    }
  }

  async function saveSecrets(secrets: Record<string, string>) {
    setError(null);
    setPending("secrets");
    try {
      const id = await ensureDraft(api, workspaceId, draftId, definition?.id);
      rememberDraft(id);
      const synced = await syncDraft(api, workspaceId, id, state, secrets);
      setState(synced.state);
      setSecretsLost(false);
      return true;
    } catch (cause) {
      setState((current) => refused(cause, current));
      setError(message(cause));
      return false;
    } finally {
      setPending(null);
    }
  }

  async function test(pages: number, from: BuilderState = state) {
    setTestError(null);
    setError(null);
    setState(from);
    if (!draftReady(from)) {
      setTestError(t("issues.definitionInvalid"));
      return;
    }
    setPending("test");
    try {
      const id = await ensureDraft(api, workspaceId, draftId, definition?.id);
      rememberDraft(id);
      const result = await runTest(api, workspaceId, id, from, pages);
      setState(result.state);
      if (result.secretsLost) setSecretsLost(true);
      setTestedFields(JSON.stringify(result.state.stream.fields));
      setPagingTest(pages > 1 ? result.state.lastTest : null);
    } catch (cause) {
      setState(refused(cause, from));
      setTestError(message(cause));
    } finally {
      setPending(null);
    }
  }

  async function signIn() {
    if (!draftId) return;
    setPending("draft");
    try {
      writeStored(draftId, { state, step });
      const { authorizationUrl } = await startCustomOAuth(workspaceId, draftId);
      window.location.assign(authorizationUrl);
    } catch (cause) {
      setError(message(cause));
      setPending(null);
    }
  }

  async function save() {
    setError(null);
    setPending("save");
    try {
      const result = await saveAndConnect(api, {
        workspaceId,
        draftId,
        state,
        ...(definition
          ? {
              editing: {
                id: definition.id,
                currentVersion: definition.currentVersion,
                document: definition.document,
              },
            }
          : {}),
        ...(saved ? { saved } : {}),
      });
      if (result.kind === "promoteFailed") {
        setSaved(result.saved);
        setError(`${t("review.promoteFailed")} ${message(result.error)}`);
        return;
      }
      done.current = true;
      if (draftId) writeStored(draftId, null);
      if (result.kind === "connected")
        router.push(
          `/workspaces/${workspaceId}/connections/${result.connectionId}`,
        );
      else {
        router.push(`/workspaces/${workspaceId}/custom-apis`);
        router.refresh();
      }
    } catch (cause) {
      if (
        cause instanceof CustomApiRequestError &&
        cause.code === "custom_api_definition_stale"
      )
        setStale(true);
      setError(message(cause));
    } finally {
      setPending(null);
    }
  }

  async function discard() {
    setPending("discard");
    done.current = true;
    if (draftId) {
      writeStored(draftId, null);
      await api.deleteDraft(workspaceId, draftId).catch(() => {});
    }
    router.push(`/workspaces/${workspaceId}/custom-apis`);
  }

  const index = BUILDER_STEPS.indexOf(step);
  const issues = stepIssues(state, step);
  const busy = pending !== null;
  const withPanel = index >= 2;
  const fieldsChanged =
    testedFields !== null &&
    testedFields !== JSON.stringify(state.stream.fields);

  let body: ReactNode;
  switch (step) {
    case "basics":
      body = (
        <StepBasics
          state={state}
          update={update}
          projects={projects}
          savedEnvironmentIds={
            new Set(definition?.document.environments.map((e) => e.id) ?? [])
          }
        />
      );
      break;
    case "login":
      body = (
        <StepLogin
          state={state}
          update={update}
          workspaceId={workspaceId}
          draftId={draftId}
          secretsLost={secretsLost}
          pending={busy}
          onSaveSecrets={saveSecrets}
          onSignIn={() => void signIn()}
        />
      );
      break;
    case "request":
      body = (
        <StepRequest
          state={state}
          update={update}
          pending={busy}
          onSaveSecrets={saveSecrets}
          onTest={() => void test(1)}
        />
      );
      break;
    case "response":
      body = (
        <StepResponse
          state={state}
          update={update}
          pending={busy}
          previewStale={fieldsChanged}
          onPickRecords={(path) => void test(1, pickRecords(state, path))}
          onRefresh={() => void test(1)}
        />
      );
      break;
    case "paging":
      body = (
        <StepPaging
          state={state}
          update={update}
          pending={busy}
          pagingTest={pagingTest}
          onTest={() => void test(5)}
        />
      );
      break;
    case "review":
      body = (
        <StepSchedule
          state={state}
          update={update}
          onGoTo={(target) => void goTo(target)}
        />
      );
      break;
  }

  return (
    <div
      className={`custom-api-builder${withPanel ? " custom-api-builder--panel" : ""}`}
    >
      <nav className="custom-api-stepper" aria-label={t("stepper.label")}>
        <ol>
          {BUILDER_STEPS.map((entry, i) => {
            const open = stepIssues(state, entry).length > 0;
            const current = entry === step;
            const status = current
              ? t("stepper.current")
              : i < index && !open
                ? t("stepper.done")
                : i < index && open
                  ? t("stepper.issue")
                  : null;
            return (
              <li
                key={entry}
                className={`custom-api-stepper-item${current ? " is-current" : ""}${i < index && !open ? " is-done" : ""}${i < index && open ? " has-issue" : ""}`}
              >
                <button
                  type="button"
                  aria-current={current ? "step" : undefined}
                  disabled={busy || current || !reachable(state, entry)}
                  onClick={() => void goTo(entry)}
                >
                  <span
                    className="custom-api-stepper-number"
                    aria-hidden="true"
                  >
                    {i < index && !open ? "✓" : i + 1}
                  </span>
                  <span>{t(`steps.${entry}`)}</span>
                  {status ? (
                    <span className="visually-hidden"> ({status})</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      <section
        className="custom-api-step card"
        aria-labelledby="custom-api-step-title"
      >
        <h2 id="custom-api-step-title">{t(`steps.${step}`)}</h2>
        {stale ? (
          <p className="notice warning" role="alert">
            {t("review.stale")}
          </p>
        ) : null}
        {body}
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        {issues.length ? (
          <div className="custom-api-issues">
            <p>{t("nav.before")}</p>
            <ul>
              {issues.map((key) => (
                <li key={key}>{t(key as "issues.nameRequired")}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="custom-api-nav">
          {index > 0 ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void goTo(BUILDER_STEPS[index - 1]!)}
            >
              {t("nav.back")}
            </button>
          ) : null}
          <button
            type="button"
            className="link-button"
            disabled={busy}
            onClick={() => void discard()}
          >
            {pending === "discard" ? t("nav.discarding") : t("nav.discard")}
          </button>
          {step === "review" ? (
            <button
              type="button"
              className="primary"
              disabled={busy || issues.length > 0 || stale}
              onClick={() => void save()}
            >
              {pending === "save"
                ? t("review.saving")
                : saved
                  ? t("review.retry")
                  : definition
                    ? t("review.saveVersion")
                    : t("review.save")}
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={busy || issues.length > 0}
              onClick={() => void goTo(BUILDER_STEPS[index + 1]!)}
            >
              {t("nav.continue")}
            </button>
          )}
        </div>
      </section>
      {withPanel ? (
        <TestPanel
          test={state.lastTest}
          error={testError}
          pending={pending === "test"}
        />
      ) : null}
    </div>
  );
}
