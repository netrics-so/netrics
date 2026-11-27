"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type {
  CustomApiDefinitionResponse,
  CustomApiTestResponse,
} from "@netrics/contracts";

import { CustomApiRequestError } from "@/lib/custom-api";
import {
  BUILDER_STEPS,
  draftDefinitionOf,
  draftTestFingerprint,
  emptyBuilderState,
  pickRecords,
  requiredSecrets,
  stateFromDefinition,
  stepHints,
  stepIssues,
  withReadOnlyChecked,
  type BuilderState,
  type BuilderStep,
  type StepOptions,
} from "@/lib/custom-api-builder";
import {
  readStoredBuilder,
  writeStoredBuilder,
  type StoredBuilder,
} from "@/lib/custom-api-storage";
import { useLocale, useT } from "@/lib/i18n/client";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

import {
  afterSecretsSent,
  builderErrorMessage,
  defaultClient,
  testReady,
  ensureDraft,
  moveToStep,
  readOnlyChallenge,
  runTest,
  saveAndConnect,
  startSignIn,
  syncDraft,
  typedSecretsFor,
  type BuilderClient,
} from "./builder-actions";
import { StepBasics } from "./step-basics";
import { StepLogin } from "./step-login";
import { StepPaging } from "./step-paging";
import { StepRequest } from "./step-request";
import { StepResponse } from "./step-response";
import { StepSchedule } from "./step-schedule";
import { ReadOnlyConfirm } from "./read-only-confirm";
import { TestPanel } from "./test-panel";
import { CustomApiSummary } from "./summary";

const CREDENTIALS = new Set([
  "apiKey",
  "token",
  "username",
  "password",
  "clientId",
  "clientSecret",
]);

type SavedDefinition = CustomApiDefinitionResponse["definition"];
type Pending = "draft" | "secrets" | "test" | "save" | "discard" | null;

/** A test waiting for "this request only reads data" (ADR 0030 §2). */
export interface PendingChallenge {
  hash: string;
  pages: number;
  /** draftTestFingerprint of the request the server hashed. */
  fingerprint: string;
}

/** The challenge is still about the request the state would send. */
export function challengeCurrent(
  challenge: PendingChallenge,
  state: BuilderState,
): boolean {
  return challenge.fingerprint === draftTestFingerprint(state);
}

/**
 * The confirmation a test sends without asking again: the last confirmed
 * one, while the request is exactly the one it was given for.
 */
export function rememberedConfirmation(
  confirmed: Pick<PendingChallenge, "hash" | "fingerprint"> | null,
  state: BuilderState,
): string | undefined {
  return confirmed && confirmed.fingerprint === draftTestFingerprint(state)
    ? confirmed.hash
    : undefined;
}

/**
 * The remembered test confirmation after an edit (ADR 0030 §2): kept while
 * the request is the same, dropped by the first request-shaping change.
 * Once dropped it stays dropped, so undoing the change asks again.
 */
export function keptTestConfirmation<
  T extends Pick<PendingChallenge, "hash" | "fingerprint">,
>(confirmed: T | null, state: BuilderState): T | null {
  return confirmed && confirmed.fingerprint === draftTestFingerprint(state)
    ? confirmed
    : null;
}

/**
 * A finished test applied to the state as it is now (#887). Without an
 * edit since the test started, the test's state; otherwise the newer
 * edits stay and only what the test learned is taken (the stored secret
 * names and the result), so neither an edit nor an invalidated
 * confirmation is overwritten by the snapshot the test was sent from.
 */
export function stateAfterTest(
  current: BuilderState,
  sent: BuilderState,
  result: BuilderState,
  original?: CustomApiDefinitionResponse["definition"]["document"],
): BuilderState {
  if (current === sent) return result;
  return withReadOnlyChecked(
    { ...current, secretsSet: result.secretsSet, lastTest: result.lastTest },
    original,
  );
}

/**
 * The test confirmation to remember after a confirmed test was sent: only
 * while nothing was edited during the test, so a confirmation dropped by
 * an edit (even one undone since) never comes back (#887).
 */
export function confirmationAfterTest(
  hash: string | undefined,
  current: BuilderState,
  sent: BuilderState,
): Pick<PendingChallenge, "hash" | "fingerprint"> | null {
  return hash && current === sent
    ? { hash, fingerprint: draftTestFingerprint(sent) }
    : null;
}

/** The first step that is not complete, or the last one. */
export function firstOpenStep(
  state: BuilderState,
  options: StepOptions = {},
): BuilderStep {
  return (
    BUILDER_STEPS.find((step) => stepIssues(state, step, options).length > 0) ??
    "review"
  );
}

/** A step can be opened when every step before it is complete. */
export function reachable(
  state: BuilderState,
  step: BuilderStep,
  options: StepOptions = {},
): boolean {
  const index = BUILDER_STEPS.indexOf(step);
  return BUILDER_STEPS.slice(0, index).every(
    (before) => stepIssues(state, before, options).length === 0,
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
  initial?: { state?: BuilderState; step?: BuilderStep; baseVersion?: number };
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
  /**
   * A JSON-body POST test waiting for its read-only confirmation (ADR
   * 0030): the server's hash, and the fingerprint of the request it was
   * asked for. Only the state, never a copy of it, is sent on confirm.
   */
  const [challenge, setChallenge] = useState<PendingChallenge | null>(null);
  /** The last test request confirmed and sent: its hash and fingerprint. */
  const [confirmedTest, setConfirmedTest] = useState<Pick<
    PendingChallenge,
    "hash" | "fingerprint"
  > | null>(null);
  const [secretsLost, setSecretsLost] = useState(false);
  const [testedFields, setTestedFields] = useState<string | null>(null);
  const [pagingTest, setPagingTest] = useState<CustomApiTestResponse | null>(
    null,
  );
  const [saved, setSaved] = useState<CustomApiDefinitionResponse | null>(null);
  const [stale, setStale] = useState(false);
  // Editing: the version this editor's state was loaded from. A reload or
  // the OAuth round trip keeps it, so a newer save by someone else answers
  // custom_api_definition_stale instead of being overwritten.
  const [baseVersion, setBaseVersion] = useState<number | null>(
    initial?.baseVersion ?? definition?.currentVersion ?? null,
  );
  // Secrets typed but not saved yet: only here, never stored.
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const done = useRef(false);
  /** The state as last rendered: a finished test checks it for newer edits. */
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);
  /** The page is leaving on purpose (the OAuth redirect): no leave prompt. */
  const leaving = useRef(false);
  const editing = definition !== undefined;
  // The document saveAndConnect saves against: the step checks use it too.
  const stepOptions: StepOptions = {
    editing,
    ...(definition ? { original: definition.document } : {}),
  };
  const definitionId = definition?.id ?? null;
  const stored = (): StoredBuilder => ({
    state,
    step,
    definitionId,
    baseVersion,
  });

  // A new definition counts days in the viewer's time zone; a reload or
  // the OAuth round trip restores the builder from the session.
  useEffect(() => {
    if (initial?.state) return;
    const stored = initialDraftId
      ? readStoredBuilder(workspaceId, initialDraftId, definitionId)
      : null;
    if (stored) {
      setState(stored.state);
      setStep(stored.step);
      if (stored.baseVersion !== null) setBaseVersion(stored.baseVersion);
    } else if (!definition)
      setState((current) => ({
        ...current,
        defaults: { ...current.defaults, timeZone: viewerTimeZone() },
      }));
    // The sign-in outcome was shown by the page: a reload must not show it
    // again. `?draft=` stays, so a reload keeps the test login.
    const url = new URL(window.location.href);
    if (url.searchParams.has("oauth")) {
      url.searchParams.delete("oauth");
      window.history.replaceState(window.history.state, "", url);
    }
    // Once, on mount (the props are the page's first render).
  }, []);

  useEffect(() => {
    if (draftId && !done.current)
      writeStoredBuilder(workspaceId, draftId, {
        state,
        step,
        definitionId,
        baseVersion,
      });
  }, [workspaceId, draftId, definitionId, state, step, baseVersion]);

  useEffect(() => {
    if (!draftId) return;
    const leave = (event: BeforeUnloadEvent) => {
      if (done.current || leaving.current) return;
      event.preventDefault();
      event.returnValue = t("errors.leave");
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [draftId, t]);

  // A typed value whose name the definition no longer declares (a variable
  // unticked as secret, renamed or removed) is dropped, never sent.
  const declared = requiredSecrets(state).join("\n");
  useEffect(() => {
    const names = new Set(declared.split("\n"));
    setSecretInputs((current) => {
      const stale = Object.keys(current).filter((name) => !names.has(name));
      if (stale.length === 0) return current;
      const next = { ...current };
      for (const name of stale) delete next[name];
      return next;
    });
  }, [declared]);

  // A pending read-only challenge holds only for the request it showed:
  // an edit that shapes the request, or another test environment, drops
  // it, and the test has to be sent (and confirmed) again.
  const challengeHolds =
    challenge !== null && challengeCurrent(challenge, state);
  useEffect(() => {
    if (challenge && !challengeHolds) {
      setChallenge(null);
      setTestError(t("test.readOnly.changed"));
    }
  }, [challenge, challengeHolds, t]);
  // So does a remembered confirmation: the first request-shaping edit
  // drops it for good, and undoing that edit asks again.
  const testConfirmationHolds =
    keptTestConfirmation(confirmedTest, state) !== null;
  useEffect(() => {
    if (confirmedTest && !testConfirmationHolds) setConfirmedTest(null);
  }, [confirmedTest, testConfirmationHolds]);

  if (!canEdit && definition)
    return <CustomApiSummary definition={definition} />;

  // Every edit drops the read-only confirmations whose request it changed.
  const update = (change: (current: BuilderState) => BuilderState) =>
    setState((current) =>
      withReadOnlyChecked(change(current), definition?.document),
    );

  const message = (cause: unknown) => builderErrorMessage(cause, locale);

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
      const entered = await moveToStep(
        api,
        {
          workspaceId,
          draftId,
          ...(definition ? { definitionId: definition.id } : {}),
          state,
          target,
          createDraft: !editing,
          secrets: secretInputs,
        },
        secretsLost,
      );
      if (entered.draftId) rememberDraft(entered.draftId);
      // Typed replacements were stored with the move; a loss in the same
      // update still warns.
      if (entered.clearInputs) setSecretInputs({});
      setSecretsLost(entered.warning);
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
      setSecretInputs((current) => {
        const next = { ...current };
        for (const name of Object.keys(secrets)) delete next[name];
        return next;
      });
      return true;
    } catch (cause) {
      setState((current) => refused(cause, current));
      setError(message(cause));
      return false;
    } finally {
      setPending(null);
    }
  }

  async function test(
    pages: number,
    from: BuilderState = state,
    confirmedNow?: string,
  ) {
    // A request confirmed before is sent again with its confirmation
    // while it is exactly the same; any change asks again.
    const readOnlyConfirmation =
      confirmedNow ?? rememberedConfirmation(confirmedTest, from);
    setTestError(null);
    setError(null);
    setChallenge(null);
    setState(from);
    if (!testReady(from)) {
      setTestError(t("issues.definitionInvalid"));
      return;
    }
    setPending("test");
    try {
      const id = await ensureDraft(api, workspaceId, draftId, definition?.id);
      rememberDraft(id);
      const result = await runTest(
        api,
        workspaceId,
        id,
        from,
        pages,
        secretInputs,
        readOnlyConfirmation,
      );
      // Edits made while the test ran stay (#887).
      const remembered = confirmationAfterTest(
        readOnlyConfirmation,
        latest.current,
        from,
      );
      setState((current) =>
        stateAfterTest(current, from, result.state, definition?.document),
      );
      if (remembered) setConfirmedTest(remembered);
      const after = afterSecretsSent(result, secretsLost);
      if (after.clearInputs) setSecretInputs({});
      setSecretsLost(after.secretsLost);
      setTestedFields(JSON.stringify(result.state.stream.fields));
      setPagingTest(pages > 1 ? result.state.lastTest : null);
    } catch (cause) {
      const hash = readOnlyChallenge(cause);
      if (hash !== null && hash !== readOnlyConfirmation) {
        // Nothing was sent: show the request and ask.
        setChallenge({ hash, pages, fingerprint: draftTestFingerprint(from) });
        return;
      }
      setState((current) => refused(cause, current));
      setTestError(message(cause));
    } finally {
      setPending(null);
    }
  }

  async function signIn() {
    if (!draftId) return;
    setError(null);
    setPending("draft");
    try {
      const started = await startSignIn(api, { workspaceId, draftId, state });
      setState(started.state);
      if (started.kind === "secretsLost") {
        // The current settings moved the login elsewhere: nothing started.
        setSecretsLost(true);
        setError(t("login.hostChanged"));
        setPending(null);
        return;
      }
      writeStoredBuilder(workspaceId, draftId, {
        ...stored(),
        state: started.state,
      });
      leaving.current = true;
      window.location.assign(started.authorizationUrl);
    } catch (cause) {
      leaving.current = false;
      setState((current) => refused(cause, current));
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
                currentVersion: baseVersion ?? definition.currentVersion,
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
      if (draftId) writeStoredBuilder(workspaceId, draftId, null);
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
      writeStoredBuilder(workspaceId, draftId, null);
      await api.deleteDraft(workspaceId, draftId).catch(() => {});
    }
    router.push(`/workspaces/${workspaceId}/custom-apis`);
  }

  const index = BUILDER_STEPS.indexOf(step);
  // Secrets typed for every missing name are saved by Continue.
  const typed = new Set(
    Object.keys(typedSecretsFor(state, secretInputs) ?? {}),
  );
  const missing = requiredSecrets(state).filter(
    (name) => !state.secretsSet.includes(name),
  );
  const typedCoversMissing =
    missing.length > 0 && missing.every((name) => typed.has(name));
  const issues = stepIssues(state, step, stepOptions).filter(
    (key) =>
      !typedCoversMissing ||
      (key !== "issues.secretMissing" && key !== "issues.secretValueMissing"),
  );
  const hints = stepHints(state, step, stepOptions);
  const setSecretInput = (name: string, value: string | undefined) =>
    setSecretInputs((current) => {
      const next = { ...current };
      if (value === undefined) delete next[name];
      else next[name] = value;
      return next;
    });
  const busy = pending !== null;
  const withPanel = index >= 2;
  const testBaseUrl = state.environments
    .find((e) => e.id === state.environmentId)
    ?.baseUrl.trim();
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
          values={secretInputs}
          onValueChange={setSecretInput}
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
          values={secretInputs}
          onValueChange={setSecretInput}
          savedVariableIds={
            new Set(definition?.document.variables.map((v) => v.id) ?? [])
          }
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
          {...(definition ? { original: definition.document } : {})}
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
            const open = stepIssues(state, entry, stepOptions).length > 0;
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
                  disabled={
                    busy || current || !reachable(state, entry, stepOptions)
                  }
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
        {hints.length ? (
          <ul className="custom-api-hints help">
            {hints.map((key) => (
              <li key={key}>
                {t(key.replace("issues.", "hints.") as "hints.secretMissing")}
              </li>
            ))}
          </ul>
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
      {withPanel && challenge && challengeHolds ? (
        <ReadOnlyConfirm
          request={draftDefinitionOf(state).stream.request}
          pagination={state.stream.pagination}
          {...(testBaseUrl ? { baseUrl: testBaseUrl } : {})}
          pending={pending === "test"}
          onConfirm={() => {
            // The current request, which is the one confirmed (checked
            // again here): never an earlier copy of the state.
            if (challengeCurrent(challenge, state))
              void test(challenge.pages, state, challenge.hash);
          }}
          onCancel={() => setChallenge(null)}
        />
      ) : null}
      {withPanel ? (
        <TestPanel
          test={state.lastTest}
          error={testError}
          pending={pending === "test"}
          missingSecrets={missing.map(
            (name) =>
              state.variables.find((v) => v.id === name)?.label ||
              (CREDENTIALS.has(name) ? t(`login.${name as "token"}`) : name),
          )}
        />
      ) : null}
    </div>
  );
}
