"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { ConnectorCatalogEntry } from "@netrics/contracts";

import { addDemoContent, apiErrorMessage } from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n/client";
import {
  DEMO_CONNECTOR_ID,
  connectSourcePath,
  welcomePath,
} from "@/lib/onboarding";

/** What the explainer says netrics may do with a source. */
export type SourceAccess = "oauth" | "key" | "none" | "demo";

export function sourceAccess(connector: ConnectorCatalogEntry): SourceAccess {
  if (connector.id === DEMO_CONNECTOR_ID) {
    return "demo";
  }
  const strategies = connector.authStrategies.map((s) => s.strategy);
  if (strategies.includes("oauth2")) {
    return "oauth";
  }
  if (strategies.includes("token") || strategies.includes("signed-key")) {
    return "key";
  }
  return "none";
}

/**
 * The real sources of step 2, those this instance can connect first (the
 * demo is a card of its own, after them).
 */
export function sourceChoices(
  connectors: readonly ConnectorCatalogEntry[],
): ConnectorCatalogEntry[] {
  return connectors
    .filter((c) => c.id !== DEMO_CONNECTOR_ID)
    .toSorted((a, b) => Number(b.available) - Number(a.available));
}

const EXPLAIN = {
  oauth: "explainOAuth",
  key: "explainKey",
  none: "explainNone",
  demo: "explainDemo",
} as const;

/**
 * Step 2, "Connect your first source" (#308): source cards from the
 * connector catalogue and the demo as one more choice. Continue opens the
 * new-connection wizard with the connector chosen; the demo (or "Skip, use
 * demo data") adds the demo connection and dashboard when the workspace has
 * none yet, then goes on to step 3.
 */
export function SourceStep({
  workspaceId,
  connectors,
  hasDemo,
}: {
  workspaceId: string;
  connectors: readonly ConnectorCatalogEntry[];
  /** The workspace already has the demo connection. */
  hasDemo: boolean;
}) {
  const t = useT("onboarding.source");
  const locale = useLocale();
  const router = useRouter();
  const choices = sourceChoices(connectors);
  const [selected, setSelected] = useState<string>(
    choices.find((c) => c.available)?.id ?? DEMO_CONNECTOR_ID,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = choices.find((c) => c.id === selected) ?? null;
  const access: SourceAccess = chosen ? sourceAccess(chosen) : "demo";

  async function startWithDemo() {
    setError(null);
    if (!hasDemo) {
      setPending(true);
      try {
        const { demoDashboardId } = await addDemoContent(workspaceId);
        if (!demoDashboardId) {
          setError(t("demoFailed"));
          setPending(false);
          return;
        }
      } catch (cause) {
        setError(apiErrorMessage(cause, locale));
        setPending(false);
        return;
      }
    }
    router.push(welcomePath(workspaceId, "screen"));
    router.refresh();
  }

  function onContinue() {
    if (chosen) {
      router.push(connectSourcePath(workspaceId, chosen.id));
    } else {
      void startWithDemo();
    }
  }

  return (
    <div className="onboarding-panel">
      <header>
        <h1>{t("title")}</h1>
        <p className="subtitle">{t("subtitle")}</p>
      </header>
      <div
        className="source-choices"
        role="group"
        aria-label={t("choicesLabel")}
      >
        {choices.map((connector) => (
          <button
            key={connector.id}
            type="button"
            className="source-choice"
            aria-pressed={selected === connector.id}
            disabled={!connector.available || pending}
            onClick={() => setSelected(connector.id)}
          >
            <span className="source-choice-icon" aria-hidden="true">
              {connector.name.slice(0, 1)}
            </span>
            <span>
              <span className="source-choice-name">{connector.name}</span>
              <span className="source-choice-text">
                {connector.available ? connector.description : t("unavailable")}
              </span>
            </span>
          </button>
        ))}
        <button
          type="button"
          className="source-choice"
          aria-pressed={selected === DEMO_CONNECTOR_ID}
          disabled={pending}
          onClick={() => setSelected(DEMO_CONNECTOR_ID)}
        >
          <span className="source-choice-icon" aria-hidden="true">
            {"✦"}
          </span>
          <span>
            <span className="source-choice-name">{t("demoName")}</span>
            <span className="source-choice-text">
              {hasDemo ? t("demoReady") : t("demoText")}
            </span>
          </span>
        </button>
      </div>
      <p className="onboarding-explainer">
        <span className="onboarding-explainer-mark" aria-hidden="true">
          {"i"}
        </span>
        <span>{t(EXPLAIN[access], { name: chosen?.name ?? "" })}</span>
      </p>
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="onboarding-footer">
        <button
          type="button"
          disabled={pending}
          onClick={() => void startWithDemo()}
        >
          {pending ? t("adding") : t("skip")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={pending}
          onClick={onContinue}
        >
          {chosen ? t("continueWith", { name: chosen.name }) : t("continue")}
        </button>
      </div>
    </div>
  );
}
