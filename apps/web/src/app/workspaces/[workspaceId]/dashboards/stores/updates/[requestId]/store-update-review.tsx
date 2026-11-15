"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";

import type {
  StoreTemplatePlan,
  StoreTemplateUpdate,
} from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { StoreUpdateSummary } from "@/components/store-update-summary";
import {
  ApiError,
  apiErrorMessage,
  applyStoreTemplateUpdate,
  closeStoreTemplateUpdate,
  createStoreTemplateCopy,
  getStoreTemplatePlan,
  readStoreTemplateInstalls,
  swapBackStoreTemplateDashboard,
  swapStoreTemplateDashboard,
} from "@/lib/api";
import type { WebTranslator } from "@/lib/i18n/catalogs";
import { useLocale, useT } from "@/lib/i18n/client";
import {
  applyReviewed,
  groupItems,
  itemSubject,
  itemValue,
  missingDecisions,
  needsDecision,
  progressStep,
  screensOn,
  stageOf,
  swapState,
  whyAsked,
  widgetNames,
  type Choice,
  type Decisions,
  type ItemSubject,
  type PlanItem,
  type PlanRecord,
  type StoreInstall,
  type UpdateDashboard,
} from "@/lib/store-updates";

type Screen = {
  id: string;
  name: string;
  dashboardId: string | null;
  revokedAt: string | null;
};

/**
 * A store-template update (11E), from review to the screens: 1 review the
 * plan and apply it as data drafts, 2 publish the drafts in data settings,
 * 3 create the updated dashboard copy, 4 compare it in Studio, 5 swap it
 * onto the original's screens, with switching back afterwards.
 */
export function StoreUpdateReview({
  workspaceId,
  install: initialInstall,
  screens,
  dashboardNames,
  canCopy,
  canSwap,
}: {
  workspaceId: string;
  install: StoreInstall;
  /** The workspace's screens, or null when the role cannot see them. */
  screens: Screen[] | null;
  /** Dashboard names by id, archived ones included. */
  dashboardNames: Record<string, string>;
  /** dashboards:create */
  canCopy: boolean;
  /** dashboards:update and devices:manage */
  canSwap: boolean;
}) {
  const t = useT("storeUpdate"),
    locale = useLocale(),
    router = useRouter();
  const [install, setInstall] = useState(initialInstall);
  const [plan, setPlan] = useState<StoreTemplatePlan | null>(null),
    [planError, setPlanError] = useState<string | null>(null),
    [decisions, setDecisions] = useState<Decisions>({}),
    [notice, setNotice] = useState<"reloaded" | null>(null),
    [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState<string | null>(null),
    [problem, setProblem] = useState<Problem | null>(null),
    [announcement, setAnnouncement] = useState<Announcement | null>(null);
  // After a step succeeds, focus moves to the progress, which announces it.
  const focusTarget = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (announcement) focusTarget.current?.focus();
  }, [announcement]);
  const stage = stageOf(install);
  const requestId = install.requestId;

  async function reloadInstall() {
    const { installs } = await readStoreTemplateInstalls(workspaceId);
    const next = installs.find(
      (candidate) => candidate.requestId === requestId,
    );
    if (next) setInstall(next);
    router.refresh();
  }

  async function loadPlan() {
    setPlanError(null);
    try {
      setPlan(await getStoreTemplatePlan(workspaceId, requestId));
    } catch (failure) {
      setPlanError(apiErrorMessage(failure, locale));
    }
  }
  useEffect(() => {
    // Only when the stage asks for a plan.
    if (stage === "review" && !plan) void loadPlan();
  }, [stage]);

  async function apply() {
    if (!plan) return;
    setPending("apply");
    setError(null);
    setNotice(null);
    setAnnouncement(null);
    try {
      const result = await applyReviewed(plan, decisions, {
        apply: (body) => applyStoreTemplateUpdate(workspaceId, requestId, body),
        reload: () => getStoreTemplatePlan(workspaceId, requestId),
      });
      if (result.kind === "reloaded") {
        setPlan(result.plan);
        setDecisions(result.decisions);
        setNotice("reloaded");
      } else {
        setInstall((current) => ({
          ...current,
          openUpdate: result.update,
          lastUpdate: result.update,
        }));
        setPlan(null);
        await reloadInstall().catch(() => {});
        setAnnouncement("applied");
      }
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "store_update_open")
        await reloadInstall().catch(() => {});
      setError(applyErrorMessage(failure, plan));
    } finally {
      setPending(null);
    }
  }
  function applyErrorMessage(failure: unknown, current: StoreTemplatePlan) {
    if (
      failure instanceof ApiError &&
      failure.code === "store_update_unmergeable" &&
      failure.details.key
    ) {
      const record = current.records.find(
        (candidate) => candidate.key === failure.details.key,
      );
      const list = new Intl.ListFormat(locale, { type: "conjunction" });
      return t("progress.unmergeableData", {
        name: record?.name ?? failure.details.key,
        names: list.format(widgetNames(failure.details.refs ?? [], current)),
      });
    }
    return apiErrorMessage(failure, locale);
  }

  /** A copy, swap, swap back or close; the install is read again after. */
  async function act(
    key: string,
    action: Problem["action"],
    run: () => Promise<unknown>,
  ) {
    setPending(`${action}:${key}`);
    setProblem(null);
    setError(null);
    setAnnouncement(null);
    try {
      await run();
      await reloadInstall();
      if (action !== "refresh") setAnnouncement(action);
    } catch (failure) {
      if (failure instanceof ApiError) {
        let names: string[] = [];
        if (failure.code === "store_update_unmergeable") {
          const known = await getStoreTemplatePlan(
            workspaceId,
            requestId,
          ).catch(() => null);
          names = widgetNames(failure.details.refs ?? [], known);
        }
        setProblem({ key, action, error: failure, names });
      } else setError(apiErrorMessage(failure, locale));
    } finally {
      setPending(null);
    }
  }
  const update = install.openUpdate ?? install.lastUpdate;
  const actions: DashboardActions = {
    copy: (key, options) =>
      void act(key, "copy", () =>
        createStoreTemplateCopy(workspaceId, update!.id, key, options),
      ),
    swap: (key) =>
      void act(key, "swap", () =>
        swapStoreTemplateDashboard(workspaceId, update!.id, key),
      ),
    swapBack: (key) =>
      void act(key, "swapBack", () =>
        swapBackStoreTemplateDashboard(workspaceId, update!.id, key),
      ),
    close: () => {
      if (!update || !window.confirm(t("progress.closeConfirm"))) return;
      void act("", "close", () =>
        closeStoreTemplateUpdate(workspaceId, requestId, update.id),
      );
    },
    refresh: () => void act("", "refresh", async () => {}),
  };

  if (stage === "unavailable")
    return <p className="notice">{t("unavailable")}</p>;
  if (stage === "upToDate") return <p className="notice">{t("upToDate")}</p>;
  return (
    <div className="store-update">
      <p className="store-update-versions muted">
        {t("versions", {
          from: install.templateVersion,
          to: install.latestVersion,
        })}
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {stage === "review" ? (
        <div ref={focusTarget} tabIndex={-1} className="store-update-focus">
          <StatusLine announcement={announcement} />
          <Steps current={1} />
          {install.lastUpdate &&
          install.lastUpdate.dashboards.some(
            (entry) => entry.swappedAt !== null,
          ) ? (
            <ProgressView
              workspaceId={workspaceId}
              update={install.lastUpdate}
              screens={screens}
              dashboardNames={dashboardNames}
              canCopy={canCopy}
              canSwap={canSwap}
              pending={pending}
              problem={problem}
              actions={actions}
              previous
            />
          ) : null}
          {plan ? (
            <ReviewView
              plan={plan}
              decisions={decisions}
              onDecide={(ref, choice) =>
                setDecisions((current) => ({ ...current, [ref]: choice }))
              }
              onApply={() => void apply()}
              pending={pending === "apply"}
              notice={notice}
              error={null}
            />
          ) : planError ? (
            <div className="error" role="alert">
              <p>{planError}</p>
              <button type="button" onClick={() => void loadPlan()}>
                {t("retry")}
              </button>
            </div>
          ) : (
            <p className="muted">{t("loading")}</p>
          )}
        </div>
      ) : update ? (
        <ProgressView
          focusRef={focusTarget}
          announcement={announcement}
          workspaceId={workspaceId}
          update={update}
          screens={screens}
          dashboardNames={dashboardNames}
          canCopy={canCopy}
          canSwap={canSwap}
          pending={pending}
          problem={problem}
          actions={actions}
          closable={stage === "progress"}
        />
      ) : null}
    </div>
  );
}

/** The five steps, with the current one marked. */
export function Steps({ current }: { current: number }) {
  const t = useT("storeUpdate");
  const steps = ["review", "publish", "copy", "compare", "swap"] as const;
  return (
    <ol className="store-update-steps" aria-label={t("steps.label")}>
      {steps.map((step, index) => {
        const number = index + 1;
        const state =
          number < current ? "done" : number === current ? "current" : "todo";
        return (
          <li
            key={step}
            className={`store-update-step store-update-step--${state}`}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="store-update-step-number" aria-hidden="true">
              {state === "done" ? "✓" : number}
            </span>
            <span>
              {t(`steps.${step}`)}
              {state === "done" ? (
                <span className="visually-hidden"> ({t("steps.done")})</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Step 1: the plan, grouped per record, with a choice where one is asked. */
export function ReviewView({
  plan,
  decisions,
  onDecide,
  onApply,
  pending,
  notice,
  error,
}: {
  plan: StoreTemplatePlan;
  decisions: Decisions;
  onDecide: (ref: string, choice: Choice) => void;
  onApply: () => void;
  pending: boolean;
  notice: "reloaded" | null;
  error: string | null;
}) {
  const t = useT("storeUpdate");
  const missing = missingDecisions(plan, decisions);
  const asked = plan.records
    .flatMap((record) => record.items)
    .filter(needsDecision).length;
  const scope = plan.records.reduce(
    (count, record) => count + groupItems(record).scope,
    0,
  );
  return (
    <section className="store-update-review" aria-labelledby="review-title">
      <h2 id="review-title">{t("steps.review")}</h2>
      <p>
        <StoreUpdateSummary summary={plan.summary} />
      </p>
      <p className="muted">{t("intro")}</p>
      {scope > 0 ? (
        <p className="muted">{t("scopeNote", { count: scope })}</p>
      ) : null}
      {notice === "reloaded" ? (
        <p className="notice warning" role="status">
          {t("reloaded")}
        </p>
      ) : null}
      {plan.records.map((record) => (
        <RecordReview
          key={record.key}
          record={record}
          plan={plan}
          decisions={decisions}
          onDecide={onDecide}
        />
      ))}
      <div className="store-update-apply">
        {asked > 0 ? (
          <p className={missing.length ? "muted" : undefined}>
            {t("decided", { done: asked - missing.length, total: asked })}
            {missing.length ? ` · ${t("applyHint")}` : ""}
          </p>
        ) : (
          <p className="muted">{t("nothingToDecide")}</p>
        )}
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          className="primary"
          disabled={missing.length > 0 || pending}
          onClick={onApply}
        >
          {pending ? t("applying") : t("apply")}
        </button>
      </div>
    </section>
  );
}

function RecordReview({
  record,
  plan,
  decisions,
  onDecide,
}: {
  record: PlanRecord;
  plan: StoreTemplatePlan;
  decisions: Decisions;
  onDecide: (ref: string, choice: Choice) => void;
}) {
  const t = useT("storeUpdate");
  const groups = groupItems(record);
  const shown =
    groups.choose.length +
    groups.removal.length +
    groups.template.length +
    groups.customer.length;
  if (shown === 0) return null;
  return (
    <section className="card store-update-record">
      <h3>
        <span className="store-update-kind">{t(`kinds.${record.kind}`)}</span>{" "}
        {record.name}
      </h3>
      {record.recordId === null ? (
        <p className="muted">{t("newRecord")}</p>
      ) : null}
      {record.hasUnpublishedDraft ? (
        <p className="notice warning">{t("unpublishedDraft")}</p>
      ) : null}
      {groups.choose.length ? (
        <ItemGroup title={t("groups.choose")}>
          {groups.choose.map((item) => (
            <Decision
              key={item.ref}
              item={item}
              plan={plan}
              choices={[
                ["template", t("useTemplate")],
                ["customer", t("keepMine")],
              ]}
              value={decisions[item.ref]}
              onDecide={onDecide}
            />
          ))}
        </ItemGroup>
      ) : null}
      {groups.removal.length ? (
        <ItemGroup title={t("groups.removal")}>
          {groups.removal.map((item) => (
            <Decision
              key={item.ref}
              item={item}
              plan={plan}
              choices={[
                ["remove", t("remove")],
                ["keep", t("keep")],
              ]}
              value={decisions[item.ref]}
              onDecide={onDecide}
            />
          ))}
        </ItemGroup>
      ) : null}
      {groups.template.length ? (
        <ItemGroup title={t("groups.template")}>
          {groups.template.map((item) => (
            <li key={item.ref}>
              <ItemText item={item} />{" "}
              <span className="muted">· {t(`change.${item.change}`)}</span>
            </li>
          ))}
        </ItemGroup>
      ) : null}
      {groups.customer.length ? (
        <ItemGroup title={t("groups.customer")}>
          {groups.customer.map((item) => (
            <li key={item.ref}>
              <ItemText item={item} />
            </li>
          ))}
        </ItemGroup>
      ) : null}
    </section>
  );
}

function ItemGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="store-update-group">
      <h4>{title}</h4>
      <ul>{children}</ul>
    </div>
  );
}

function Decision({
  item,
  plan,
  choices,
  value,
  onDecide,
}: {
  item: PlanItem;
  plan: StoreTemplatePlan;
  choices: [Choice, string][];
  value: Choice | undefined;
  onDecide: (ref: string, choice: Choice) => void;
}) {
  const t = useT("storeUpdate");
  const describe = useDescribe();
  const why = whyAsked(item, plan);
  const ours =
    item.current === undefined
      ? t("absent")
      : describe(itemSubject(item.ref, item.current));
  const theirs =
    item.next === undefined
      ? t("absent")
      : describe(itemSubject(item.ref, item.next));
  return (
    <li>
      <fieldset className="store-update-decision">
        <legend>
          <ItemText item={item} />
        </legend>
        <p className="muted">
          {why.kind === "removedDataset"
            ? why.dataset
              ? t("why.removedDataset", { dataset: why.dataset })
              : t("why.removedDatasetUnknown")
            : t(`why.${why.kind}`)}
        </p>
        {item.outcome === "choose" && ours !== theirs ? (
          <ul className="store-update-values">
            <li>{t("templateValue", { text: theirs })}</li>
            <li>{t("yourValue", { text: ours })}</li>
          </ul>
        ) : null}
        <div className="store-update-choices">
          {choices.map(([choice, label]) => (
            <label key={choice}>
              <input
                type="radio"
                name={item.ref}
                value={choice}
                checked={value === choice}
                onChange={() => onDecide(item.ref, choice)}
              />{" "}
              {label}
            </label>
          ))}
        </div>
      </fieldset>
    </li>
  );
}

function ItemText({ item }: { item: PlanItem }) {
  const describe = useDescribe();
  return <span>{describe(itemSubject(item.ref, itemValue(item)))}</span>;
}

const STEP_TYPES = {
  select: "select",
  rename: "rename",
  cast: "cast",
  replace: "replace",
  filter: "filter",
  calculate: "calculate",
  deduplicate: "deduplicate",
  append: "append",
  join: "join",
  group: "group",
  source: "source",
} as const;
const AGGREGATIONS = {
  sum: "sum",
  count: "count",
  distinct_count: "distinct_count",
  avg: "avg",
  min: "min",
  max: "max",
  last: "lastAggregate",
  any: "any",
  all: "all",
} as const;
const WIDGET_TYPES = [
  "measure",
  "metric",
  "line",
  "bar",
  "table",
  "compare",
  "gauge",
  "image",
  "text",
  "clock",
  "status",
  "countdown",
  "review",
] as const;
const known = <T extends string>(
  options: Readonly<Record<string, T>>,
  key: string,
): T | undefined =>
  Object.prototype.hasOwnProperty.call(options, key) ? options[key] : undefined;

/** One line per item, from its value: what it is and its name. */
function useDescribe() {
  const t = useT("storeUpdate"),
    data = useT("data");
  return (subject: ItemSubject): string => {
    switch (subject.kind) {
      case "measure": {
        const how =
          subject.how.kind === "aggregate"
            ? (() => {
                const key = known(AGGREGATIONS, subject.how.op);
                return key ? data(key) : subject.how.op;
              })()
            : t(`item.${subject.how.kind}`);
        return t("item.measure", { name: subject.name, how });
      }
      case "dimension":
        return t("item.dimension", { name: subject.name });
      case "step": {
        const key = known(STEP_TYPES, subject.type);
        const type = key ? data(key) : subject.type;
        return subject.name
          ? t("item.step", { type, name: subject.name })
          : t("item.stepUnnamed", { type });
      }
      case "output":
        return t("item.output", { name: subject.name });
      case "relationship":
        return t("item.relationship");
      case "widget": {
        const type = (WIDGET_TYPES as readonly string[]).includes(subject.type)
          ? t(`widgetTypes.${subject.type as (typeof WIDGET_TYPES)[number]}`)
          : t("widgetTypes.widget");
        return subject.title
          ? t("item.widget", { title: subject.title, type })
          : t("item.widgetUntitled", { type });
      }
      case "filter":
        return t("item.filter", { name: subject.name });
      case "slide":
        return subject.name
          ? t("item.slide", { name: subject.name })
          : t("item.slideUntitled");
      case "setting":
        return t("item.setting", { name: subject.name });
    }
  };
}

/** A step that succeeded, announced to the customer. */
type Announcement = "applied" | "copy" | "swap" | "swapBack" | "close";

/** Always present, so screen readers announce the text once it is filled. */
function StatusLine({ announcement }: { announcement: Announcement | null }) {
  const t = useT("storeUpdate");
  return (
    <p className={announcement ? "notice" : "visually-hidden"} role="status">
      {announcement ? t(`done.${announcement}`) : ""}
    </p>
  );
}

/**
 * The question before screens move: how many, which, and that it can be
 * undone.
 */
export function swapConfirmation(
  t: WebTranslator<"storeUpdate">,
  direction: "swap" | "swapBack",
  /** Null when the screens cannot be listed (the role cannot see them). */
  names: readonly string[] | null,
  locale: Locale,
): string {
  if (names === null)
    return t(
      direction === "swap"
        ? "progress.confirmSwapUnknown"
        : "progress.confirmSwapBackUnknown",
    );
  return t(
    direction === "swap" ? "progress.confirmSwap" : "progress.confirmSwapBack",
    {
      count: names.length,
      screens: new Intl.ListFormat(locale, { type: "conjunction" }).format(
        names,
      ),
    },
  );
}

/**
 * Asks before screens move (swap, swap again, switch back) and moves them
 * only when the customer agrees. Answers whether it went ahead.
 */
export function confirmSwap(
  direction: "swap" | "swapBack",
  entry: UpdateDashboard,
  screens: Screen[] | null,
  t: WebTranslator<"storeUpdate">,
  locale: Locale,
  actions: Pick<DashboardActions, "swap" | "swapBack">,
  confirm: (question: string) => boolean = (question) =>
    window.confirm(question),
): boolean {
  const from = direction === "swap" ? entry.originalId : entry.copyId;
  const names = screens ? screensOn(screens, from) : null;
  if (!confirm(swapConfirmation(t, direction, names, locale))) return false;
  if (direction === "swap") actions.swap(entry.key);
  else actions.swapBack(entry.key);
  return true;
}

type Problem = {
  key: string;
  action: "copy" | "swap" | "swapBack" | "close" | "refresh";
  error: ApiError;
  /** Widget names of a store_update_unmergeable. */
  names: string[];
};
type DashboardActions = {
  copy: (
    key: string,
    options?: { replace?: boolean; discardCopyEdits?: boolean },
  ) => void;
  swap: (key: string) => void;
  swapBack: (key: string) => void;
  close: () => void;
  refresh: () => void;
};

/** Steps 2–5 of an applied update, or of a previous one to swap again. */
export function ProgressView({
  workspaceId,
  update,
  screens,
  dashboardNames,
  canCopy,
  canSwap,
  pending,
  problem,
  actions,
  closable = false,
  previous = false,
  announcement = null,
  focusRef,
}: {
  workspaceId: string;
  update: StoreTemplateUpdate;
  screens: Screen[] | null;
  dashboardNames: Record<string, string>;
  canCopy: boolean;
  canSwap: boolean;
  pending: string | null;
  problem: Problem | null;
  actions: DashboardActions;
  /** An open update can be stopped. */
  closable?: boolean;
  /** A closed update shown above a new review: its swap only. */
  previous?: boolean;
  /** The step that just succeeded, announced in a status line. */
  announcement?: Announcement | null;
  /** Takes focus after a step succeeds. */
  focusRef?: Ref<HTMLDivElement>;
}) {
  const t = useT("storeUpdate");
  const current = progressStep(update);
  const unpublished = update.drafts.some((draft) => !draft.published);
  return (
    <div
      className="store-update-progress store-update-focus"
      ref={focusRef}
      tabIndex={-1}
    >
      {previous ? null : <StatusLine announcement={announcement} />}
      {previous ? null : <Steps current={current} />}
      {previous ? null : (
        <section className="card store-update-stage">
          <h2>{t("steps.publish")}</h2>
          {update.drafts.length === 0 ? (
            <p className="muted">{t("progress.noDrafts")}</p>
          ) : (
            <>
              <p className="muted">{t("progress.publishIntro")}</p>
              <ul className="store-update-drafts">
                {update.drafts.map((draft) => (
                  <li key={draft.recordId}>
                    <span className="store-update-kind">
                      {t(`kinds.${draft.kind}`)}
                    </span>{" "}
                    <strong>{draft.name}</strong>{" "}
                    <span
                      className={
                        draft.published
                          ? "store-update-state store-update-state--done"
                          : "store-update-state"
                      }
                    >
                      {draft.published
                        ? t("progress.published")
                        : t("progress.draft")}
                    </span>{" "}
                    {draft.published ? null : (
                      <Link
                        href={`/workspaces/${workspaceId}/data?${draft.kind}=${encodeURIComponent(draft.recordId)}`}
                      >
                        {t("progress.openDraft")}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
              {unpublished ? (
                <button
                  type="button"
                  onClick={actions.refresh}
                  disabled={pending !== null}
                >
                  {t("progress.checkAgain")}
                </button>
              ) : null}
            </>
          )}
        </section>
      )}
      {update.dashboards.length === 0 ? (
        <p className="muted">{t("progress.noDashboards")}</p>
      ) : (
        update.dashboards.map((entry) => (
          <DashboardSteps
            key={entry.key}
            workspaceId={workspaceId}
            entry={entry}
            name={dashboardNames[entry.originalId] ?? ""}
            screens={screens}
            unpublished={unpublished}
            canCopy={canCopy}
            canSwap={canSwap}
            pending={pending}
            problem={problem?.key === entry.key ? problem : null}
            actions={actions}
          />
        ))
      )}
      {problem && problem.key === "" ? <ProblemText problem={problem} /> : null}
      {closable ? (
        <p>
          <button
            type="button"
            className="link-button"
            onClick={actions.close}
            disabled={pending !== null}
          >
            {pending === "close:" ? t("progress.closing") : t("progress.close")}
          </button>
        </p>
      ) : current === 6 && !previous ? (
        <p className="muted">{t("progress.finished")}</p>
      ) : null}
    </div>
  );
}

/** Steps 3–5 for one dashboard of the update. */
export function DashboardSteps({
  workspaceId,
  entry,
  name,
  screens,
  unpublished,
  canCopy,
  canSwap,
  pending,
  problem,
  actions,
}: {
  workspaceId: string;
  entry: UpdateDashboard;
  name: string;
  screens: Screen[] | null;
  unpublished: boolean;
  canCopy: boolean;
  canSwap: boolean;
  pending: string | null;
  problem: Problem | null;
  actions: DashboardActions;
}) {
  const t = useT("storeUpdate"),
    locale = useLocale();
  const state = swapState(entry);
  const busy = pending !== null;
  const moving =
    screens && state !== "swapped" ? screensOn(screens, entry.originalId) : [];
  const list = new Intl.ListFormat(locale, { type: "conjunction" });
  const base = `/workspaces/${workspaceId}/dashboards`;
  return (
    <>
      <section className="card store-update-stage">
        <h2>{t("steps.copy")}</h2>
        {entry.copyId === null ? (
          <>
            <p className="muted">{t("progress.copyHint", { name })}</p>
            {unpublished ? (
              <p className="muted">{t("progress.copyWaiting")}</p>
            ) : null}
            {canCopy ? (
              <button
                type="button"
                className="primary"
                disabled={!entry.ready || busy}
                onClick={() => actions.copy(entry.key)}
              >
                {pending === `copy:${entry.key}`
                  ? t("progress.creating")
                  : t("progress.createCopy")}
              </button>
            ) : (
              <p className="muted">{t("progress.copyCannot")}</p>
            )}
          </>
        ) : (
          <p className="store-update-state store-update-state--done">
            {t("progress.copyCreated")}
          </p>
        )}
        {problem?.action === "copy" ? (
          <ProblemText
            problem={problem}
            onDiscard={() =>
              actions.copy(entry.key, { replace: true, discardCopyEdits: true })
            }
            onClose={actions.close}
          />
        ) : null}
      </section>
      <section className="card store-update-stage">
        <h2>{t("steps.compare")}</h2>
        {entry.copyId ? (
          <>
            <p className="muted">{t("progress.compareHint")}</p>
            <p className="store-update-links">
              {state === "swappedBack" ? (
                // Archived since the switch back: read-only, not the Studio.
                <Link href={`${base}/${entry.copyId}`}>
                  {t("progress.viewArchivedCopy")}
                </Link>
              ) : (
                <Link href={`${base}/${entry.copyId}/studio`}>
                  {t("progress.openCopy")}
                </Link>
              )}
              <Link href={`${base}/${entry.originalId}`}>
                {t("progress.openOriginal")}
              </Link>
            </p>
          </>
        ) : (
          <p className="muted">{t("progress.afterCopy")}</p>
        )}
      </section>
      <section className="card store-update-stage">
        <h2>{t("steps.swap")}</h2>
        {state === "swapped" ? (
          <>
            <p className="store-update-state store-update-state--done">
              {t("progress.swapped")}
            </p>
            <p className="muted">{t("progress.switchBackHint")}</p>
            {canSwap ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  confirmSwap("swapBack", entry, screens, t, locale, actions)
                }
              >
                {pending === `swapBack:${entry.key}`
                  ? t("progress.switchingBack")
                  : t("progress.switchBack")}
              </button>
            ) : (
              <p className="muted">{t("progress.swapCannot")}</p>
            )}
          </>
        ) : entry.copyId ? (
          <>
            {state === "swappedBack" ? (
              <p className="muted">{t("progress.switchedBack")}</p>
            ) : null}
            {screens ? (
              <p>
                {t("progress.screens", {
                  count: moving.length,
                  screens: list.format(moving),
                })}
              </p>
            ) : null}
            <p className="muted">{t("progress.swapHint")}</p>
            {canSwap ? (
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() =>
                  confirmSwap("swap", entry, screens, t, locale, actions)
                }
              >
                {pending === `swap:${entry.key}`
                  ? t("progress.swapping")
                  : state === "swappedBack"
                    ? t("progress.swapAgain")
                    : t("progress.swap")}
              </button>
            ) : (
              <p className="muted">{t("progress.swapCannot")}</p>
            )}
          </>
        ) : (
          <p className="muted">{t("progress.afterCopy")}</p>
        )}
        {problem && problem.action !== "copy" ? (
          <ProblemText
            problem={problem}
            onRecreate={() => actions.copy(entry.key, { replace: true })}
            onClose={actions.close}
          />
        ) : null}
      </section>
    </>
  );
}

/** A failed copy or swap, worded with what to do next. */
function ProblemText({
  problem,
  onDiscard,
  onRecreate,
  onClose,
}: {
  problem: Problem;
  onDiscard?: () => void;
  onRecreate?: () => void;
  onClose?: () => void;
}) {
  const t = useT("storeUpdate"),
    locale = useLocale();
  const { error } = problem;
  const list = new Intl.ListFormat(locale, { type: "conjunction" });
  const describe = useDescribe();
  if (error.code === "device_scope_not_applicable" && error.details.devices)
    return (
      <p className="error" role="alert">
        {t("progress.scopeProblems", {
          count: error.details.devices.length,
          screens: list.format(error.details.devices.map((d) => d.name)),
        })}
      </p>
    );
  if (error.code === "store_update_unmergeable")
    return (
      <div className="error" role="alert">
        <p>
          {t("progress.unmergeable", { names: list.format(problem.names) })}
        </p>
        {onClose ? (
          <button type="button" onClick={onClose}>
            {t("progress.close")}
          </button>
        ) : null}
      </div>
    );
  if (error.code === "store_update_review_changed") {
    const items = (error.details.records ?? [])
      .flatMap((record) => record.items)
      .filter(
        (item) =>
          needsDecision(item) &&
          (!error.details.refs?.length ||
            error.details.refs.includes(item.ref)),
      );
    return (
      <div className="error" role="alert">
        <p>{t("progress.reviewChanged")}</p>
        <ul>
          {items.map((item) => (
            <li key={item.ref}>
              {describe(itemSubject(item.ref, itemValue(item)))}
            </li>
          ))}
        </ul>
        {onClose ? (
          <button type="button" onClick={onClose}>
            {t("progress.close")}
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="error" role="alert">
      <p>{apiErrorMessage(error, locale)}</p>
      {error.code === "store_update_copy_edited" && onDiscard ? (
        <button type="button" onClick={onDiscard}>
          {t("progress.discardEdits")}
        </button>
      ) : null}
      {(error.code === "store_update_original_changed" ||
        error.code === "store_update_copy_missing") &&
      onRecreate ? (
        <button type="button" onClick={onRecreate}>
          {t("progress.recreate")}
        </button>
      ) : null}
    </div>
  );
}
