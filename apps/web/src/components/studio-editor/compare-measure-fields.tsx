"use client";

import { useEffect, useState } from "react";

import type {
  CompareMeasurePreview,
  CompareMeasureRequest,
  PublishedModelCatalog,
  WorkspaceMetric,
} from "@netrics/contracts";
import type { CompareMeasureRefusal } from "@netrics/domain";

import { useCompareMeasureData } from "@/components/studio/use-widget-data";
import { ApiError, apiErrorMessage } from "@/lib/api";
import {
  boundErrorKey,
  boundMeasureOf,
  compareMeasureRequestOf,
  compareMeasureSource,
  compareRefusalOf,
  createCompareMeasure,
  defaultMeasureName,
  modelHref,
  previewCompareMeasure,
  readSavedMeasure,
  savedMeasureOf,
  unpinnedSides,
  forgetSavedMeasure,
  writeSavedMeasure,
  type BoundMeasure,
  type CompareWidget,
  type SavedCompareMeasure,
} from "@/lib/compare-measure";
import { dataErrorCodeKey } from "@/lib/data-errors";
import { useLocale, useT } from "@/lib/i18n/client";

import { useCurrencies } from "./use-metric-choices";

// "Save as measure" and the measure binding of a compare widget (#508):
// the author sees what would be created (or why not), creates the
// generated preparation and a draft model, publishes the model in Data &
// measures (the existing flow, `data:publish`), and binds the widget to
// it as a normal widget edit, which can be undone. The views take their
// state as props; the containers below hold it.

/** Where saving a compare widget as a measure stands. */
export type SaveFlow =
  | { step: "idle" }
  | { step: "checking"; currency: string | null }
  | {
      step: "preview";
      currency: string | null;
      /** The request previewed: creating sends exactly this. */
      request: CompareMeasureRequest;
      preview: CompareMeasurePreview;
      creating?: boolean;
    }
  | { step: "refused"; code: CompareMeasureRefusal; currency: string | null }
  | { step: "failed"; message: string }
  | {
      step: "draft";
      saved: SavedCompareMeasure;
      /** The author asked whether it is published, and it was not. */
      stillDraft?: boolean;
    };

export interface CompareMeasureSaveViewProps {
  flow: SaveFlow;
  name: string;
  /** Whether the author may create and publish models (data:publish). */
  canPublish: boolean;
  workspaceId: string;
  /** The published model a draft became, when it is published. */
  published: { modelName: string } | null;
  /** Currencies to pin for compare_currency_unpinned; null: loading. */
  currencies: string[] | null;
  /** Why the currencies could not load; null when they did or are loading. */
  currencyError?: string | null;
  onReloadCurrencies?: () => void;
  pin: string;
  onName: (name: string) => void;
  onPreview: (currency: string | null) => void;
  onPin: (currency: string) => void;
  onCreate: () => void;
  onBack: () => void;
  /** Forgets a compiled draft, to start again (another name or currency). */
  onStartOver?: () => void;
  onCheckAgain: () => void;
  onBind: () => void;
}

/** The "Save as measure" block of an unbound compare widget. */
export function CompareMeasureSaveView(props: CompareMeasureSaveViewProps) {
  const t = useT("studio.compareMeasure");
  const { flow } = props;
  if (flow.step === "draft") {
    if (props.published)
      return (
        <fieldset className="compare-measure">
          <legend>{t("legend")}</legend>
          <p className="compare-measure-title" role="status">
            {t("publishedTitle", { name: props.published.modelName })}
          </p>
          <p className="help">{t("publishedHelp")}</p>
          <div className="compare-measure-actions">
            <button type="button" className="primary" onClick={props.onBind}>
              {t("bind")}
            </button>
            <button type="button" onClick={props.onStartOver}>
              {t("startOver")}
            </button>
          </div>
          <p className="help">{t("startOverHelp")}</p>
        </fieldset>
      );
    return (
      <fieldset className="compare-measure">
        <legend>{t("legend")}</legend>
        <p className="compare-measure-title" role="status">
          {t("draftTitle", { name: flow.saved.name })}
        </p>
        {props.canPublish ? (
          <>
            <p className="help">{t("draftHelp")}</p>
            <div className="compare-measure-actions">
              <a
                className="button primary"
                href={modelHref(props.workspaceId, flow.saved.modelId)}
                target="_blank"
                rel="noopener"
              >
                {t("openModel")}
              </a>
              <button type="button" onClick={props.onCheckAgain}>
                {t("checkAgain")}
              </button>
              <button type="button" onClick={props.onStartOver}>
                {t("startOver")}
              </button>
            </div>
            <p className="help">{t("startOverHelp")}</p>
            {flow.stillDraft ? (
              <p className="help" role="status">
                {t("stillDraft")}
              </p>
            ) : null}
          </>
        ) : (
          <p className="help compare-measure-blocked" role="note">
            {t("publishBlocked", { name: flow.saved.name })}
          </p>
        )}
      </fieldset>
    );
  }
  const busy =
    flow.step === "checking" || (flow.step === "preview" && flow.creating);
  return (
    <fieldset className="compare-measure">
      <legend>{t("legend")}</legend>
      <p className="help">{t("intro")}</p>
      {!props.canPublish ? (
        <p className="help compare-measure-blocked" role="note">
          {t("blockedSave")}
        </p>
      ) : flow.step === "preview" ? (
        <PreviewList {...props} flow={flow} />
      ) : (
        <>
          <div className="field">
            <label htmlFor="widget-measure-name">{t("nameLabel")}</label>
            <input
              id="widget-measure-name"
              type="text"
              maxLength={100}
              value={props.name}
              aria-describedby="widget-measure-name-help"
              disabled={busy}
              onChange={(event) => props.onName(event.target.value)}
            />
            <p id="widget-measure-name-help" className="help">
              {t("nameHelp")}
            </p>
          </div>
          {flow.step === "refused" ? (
            <Refusal {...props} flow={flow} />
          ) : flow.step === "failed" ? (
            <p className="error" role="alert">
              {t("refusals.other", { message: flow.message })}
            </p>
          ) : null}
          {flow.step === "refused" && offersPin(flow) ? null : (
            <button
              type="button"
              disabled={busy || props.name.trim() === ""}
              onClick={() =>
                props.onPreview(flow.step === "refused" ? flow.currency : null)
              }
            >
              {busy ? t("previewing") : t("preview")}
            </button>
          )}
        </>
      )}
    </fieldset>
  );
}

function PreviewList(
  props: CompareMeasureSaveViewProps & {
    flow: Extract<SaveFlow, { step: "preview" }>;
  },
) {
  const t = useT("studio.compareMeasure");
  const locale = useLocale();
  const { preview } = props.flow;
  const names = new Intl.ListFormat(locale, { type: "conjunction" }).format(
    [
      preview.measures.numerator,
      preview.measures.denominator,
      preview.measures.ratio,
      preview.measures.previous,
      preview.measures.change,
    ].map((measure) => measure.name),
  );
  return (
    <div className="compare-measure-preview">
      <p className="compare-measure-title">{t("willCreate")}</p>
      <ul>
        <li>
          {t("preparationLine", {
            name: preview.preparation.name,
            steps: preview.preparation.steps.length,
          })}
        </li>
        <li>{t("modelLine", { name: preview.model.name })}</li>
        <li>{t("measuresLine", { names })}</li>
      </ul>
      <p className="help">{t("allPeriods")}</p>
      {preview.currency ? (
        <p className="help">
          {t("pinnedNote", { currency: preview.currency })}
        </p>
      ) : null}
      <div className="compare-measure-actions">
        <button
          type="button"
          className="primary"
          disabled={props.flow.creating}
          onClick={props.onCreate}
        >
          {props.flow.creating ? t("creating") : t("create")}
        </button>
        <button
          type="button"
          disabled={props.flow.creating}
          onClick={props.onBack}
        >
          {t("back")}
        </button>
      </div>
    </div>
  );
}

/**
 * Whether a refusal offers the currency picker: an unpinned amount, or a
 * pinned retry that was refused (another currency may fit).
 */
export function offersPin(flow: Extract<SaveFlow, { step: "refused" }>) {
  return flow.code === "compare_currency_unpinned" || flow.currency !== null;
}

function Refusal(
  props: CompareMeasureSaveViewProps & {
    flow: Extract<SaveFlow, { step: "refused" }>;
  },
) {
  const t = useT("studio.compareMeasure");
  const { code } = props.flow;
  return (
    <div className="compare-measure-refusal" role="alert">
      <p className="compare-measure-title">{t("refusedTitle")}</p>
      <p>{t(`refusals.${code}`)}</p>
      {offersPin(props.flow) ? (
        props.currencyError ? (
          <>
            <p className="help">{props.currencyError}</p>
            <button type="button" onClick={props.onReloadCurrencies}>
              {t("pinReload")}
            </button>
          </>
        ) : props.currencies === null ? (
          <p className="help">{t("pinLoading")}</p>
        ) : props.currencies.length === 0 ? (
          <p className="help">{t("pinNone")}</p>
        ) : (
          <div className="field">
            <label htmlFor="widget-measure-currency">{t("pinLabel")}</label>
            <select
              id="widget-measure-currency"
              value={props.pin}
              onChange={(event) => props.onPin(event.target.value)}
            >
              {props.currencies.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={props.pin === ""}
              onClick={() => props.onPreview(props.pin)}
            >
              {t("retry", { currency: props.pin })}
            </button>
          </div>
        )
      ) : null}
    </div>
  );
}

/** Holds the flow of an unbound compare widget's "Save as measure". */
export function CompareMeasureSave({
  widget,
  numerator,
  denominator,
  workspaceId,
  canPublish,
  models,
  onRefreshModels,
  onBind,
}: {
  widget: CompareWidget;
  numerator: WorkspaceMetric | undefined;
  denominator: WorkspaceMetric | undefined;
  workspaceId: string;
  canPublish: boolean;
  models: PublishedModelCatalog["models"];
  onRefreshModels: () => void;
  onBind: (saved: SavedCompareMeasure) => void;
}) {
  const locale = useLocale();
  const [name, setName] = useState(() =>
    defaultMeasureName(widget, numerator, denominator),
  );
  const [flow, setFlow] = useState<SaveFlow>({ step: "idle" });
  // A draft compiled earlier in this tab, for this widget's sides.
  const source = compareMeasureSource(widget);
  useEffect(() => {
    const saved = readSavedMeasure(workspaceId, widget);
    setFlow(saved ? { step: "draft", saved } : { step: "idle" });
    // The widget's sides decide; the widget object changes on every edit.
  }, [workspaceId, source]);
  const [pin, setPin] = useState("");
  const unpinned = unpinnedSides(widget, numerator, denominator)[0];
  const [currencyRevision, setCurrencyRevision] = useState(0);
  const currencies = useCurrencies(
    workspaceId,
    flow.step === "refused" && offersPin(flow) ? unpinned?.metric : undefined,
    widget.period,
    unpinned?.resourceId ?? null,
    currencyRevision,
  );
  const options = currencies.totals?.map((total) => total.currency) ?? null;
  useEffect(() => {
    if (options && options.length > 0 && !options.includes(pin))
      setPin(options[0]!);
  }, [options?.join(","), pin]);

  const draftModelId = flow.step === "draft" ? flow.saved.modelId : null;
  const publishedModel = draftModelId
    ? models.find((model) => model.modelId === draftModelId)
    : undefined;
  // Back from publishing in the other tab: look again.
  useEffect(() => {
    if (!draftModelId || publishedModel) return;
    const refresh = () => onRefreshModels();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [draftModelId, publishedModel, onRefreshModels]);

  const fail = (cause: unknown, currency: string | null) => {
    const refusal =
      cause instanceof ApiError ? compareRefusalOf(cause.code) : null;
    setFlow(
      refusal
        ? { step: "refused", code: refusal, currency }
        : { step: "failed", message: apiErrorMessage(cause, locale) },
    );
  };
  const preview = (currency: string | null) => {
    const request = compareMeasureRequestOf(widget, name, currency);
    setFlow({ step: "checking", currency });
    previewCompareMeasure(workspaceId, request)
      .then((result) =>
        setFlow({ step: "preview", currency, request, preview: result }),
      )
      .catch((cause: unknown) => fail(cause, currency));
  };
  const create = () => {
    if (flow.step !== "preview") return;
    const { currency, request } = flow;
    setFlow({ ...flow, creating: true });
    createCompareMeasure(workspaceId, request)
      .then((result) => {
        const saved = savedMeasureOf(result, widget, request.name);
        writeSavedMeasure(workspaceId, saved);
        setFlow({ step: "draft", saved });
      })
      .catch((cause: unknown) => fail(cause, currency));
  };

  return (
    <CompareMeasureSaveView
      flow={flow}
      name={name}
      canPublish={canPublish}
      workspaceId={workspaceId}
      published={
        publishedModel ? { modelName: publishedModel.modelName } : null
      }
      currencies={options}
      currencyError={currencies.error}
      onReloadCurrencies={() => setCurrencyRevision((value) => value + 1)}
      pin={pin}
      onName={setName}
      onPreview={preview}
      onPin={setPin}
      onCreate={create}
      onBack={() => setFlow({ step: "idle" })}
      onStartOver={() => {
        forgetSavedMeasure(workspaceId, source);
        setFlow({ step: "idle" });
      }}
      onCheckAgain={() => {
        if (flow.step === "draft") setFlow({ ...flow, stillDraft: true });
        onRefreshModels();
      }}
      onBind={() => {
        if (flow.step === "draft") onBind(flow.saved);
      }}
    />
  );
}

export interface CompareMeasureBoundViewProps {
  workspaceId: string;
  modelId: string;
  bound: BoundMeasure;
  /** The reading's typed error, worded; null when it reads. */
  error: string | null;
  /** The inline definition kept next to the binding. */
  kept: { numerator: string; denominator: string };
  onUnbind: () => void;
}

/** A bound compare widget: which measure, its errors, and the way back. */
export function CompareMeasureBoundView(props: CompareMeasureBoundViewProps) {
  const t = useT("studio.compareMeasure");
  const { bound } = props;
  const problem =
    bound.kind === "unpublished"
      ? t("errors.unpublished")
      : bound.kind === "removed"
        ? t("errors.measureRemoved")
        : null;
  // The reading's own error is the specific one; the catalog's is a guess
  // while the reading loads.
  const message = props.error ?? problem;
  return (
    <fieldset className="compare-measure compare-measure--bound">
      <legend>{t("boundLegend")}</legend>
      {bound.kind === "unpublished" ? null : (
        <p className="compare-measure-title">
          {t.rich("boundAs", {
            measure: <strong key="measure">{bound.measureName}</strong>,
            model: (
              <a
                key="model"
                href={modelHref(props.workspaceId, props.modelId)}
                target="_blank"
                rel="noopener"
              >
                {bound.modelName}
              </a>
            ),
          })}
        </p>
      )}
      {message ? (
        <p className="error" role="alert">
          {message}
        </p>
      ) : null}
      {bound.kind === "unpublished" ? (
        <p>
          <a
            href={modelHref(props.workspaceId, props.modelId)}
            target="_blank"
            rel="noopener"
          >
            {t("openBoundModel")}
          </a>
        </p>
      ) : null}
      <p className="help">{t("boundHelp")}</p>
      <p className="help">
        {t("keptDefinition", {
          numerator: props.kept.numerator,
          denominator: props.kept.denominator,
        })}
      </p>
      <button type="button" onClick={props.onUnbind}>
        {t("unbind")}
      </button>
      <p className="help">{t("unbindHelp")}</p>
    </fieldset>
  );
}

/** Reads the bound widget's measures (shared with the canvas) for its errors. */
export function CompareMeasureBound({
  widget,
  workspaceId,
  models,
  numerator,
  denominator,
  onUnbind,
}: {
  widget: CompareWidget & {
    measure: NonNullable<CompareWidget["measure"]>;
  };
  workspaceId: string;
  models: PublishedModelCatalog["models"];
  numerator: WorkspaceMetric | undefined;
  denominator: WorkspaceMetric | undefined;
  onUnbind: () => void;
}) {
  const t = useT("studio.compareMeasure");
  const tData = useT("data");
  const reading = useCompareMeasureData(workspaceId, widget);
  const code = reading.data?.error ?? null;
  const key = code ? boundErrorKey(code) : null;
  const error = code
    ? key
      ? t(`errors.${key}`)
      : tData(`errors.${dataErrorCodeKey(code)}`)
    : reading.error;
  return (
    <CompareMeasureBoundView
      workspaceId={workspaceId}
      modelId={widget.measure.modelId}
      bound={boundMeasureOf(widget.measure, models)}
      error={error}
      kept={{
        numerator: numerator?.name ?? widget.metricKey,
        denominator: denominator?.name ?? widget.denominator.metricKey,
      }}
      onUnbind={onUnbind}
    />
  );
}
