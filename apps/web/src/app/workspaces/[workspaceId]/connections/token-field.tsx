"use client";

import type { ConnectorAuthStrategy } from "@netrics/contracts";

import { useT } from "@/lib/i18n/client";

interface TokenFieldProps {
  id: string;
  strategy: ConnectorAuthStrategy | undefined;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Editing an existing connection: empty keeps the stored token. */
  replacing?: boolean;
  /** Show the setup steps open (new connection, or a rejected token). */
  guideOpen?: boolean;
}

/** The access-token input with the connector's setup guide. */
export function TokenField({
  id,
  strategy,
  value,
  onChange,
  disabled,
  replacing,
  guideOpen,
}: TokenFieldProps) {
  const t = useT("connections.token");
  const label = strategy?.tokenLabel ?? t("accessToken");
  const setup = strategy?.setup;
  return (
    <div className="field">
      {setup ? (
        <details className="setup-guide" open={guideOpen}>
          <summary>{t("howTo")}</summary>
          <ol>
            {setup.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {setup.url ? (
            <p>
              <a href={setup.url} target="_blank" rel="noreferrer">
                {t("openPage")}
              </a>
            </p>
          ) : null}
        </details>
      ) : null}
      <label htmlFor={id}>
        {replacing ? t("newLabel", { label: label.toLowerCase() }) : label}
      </label>
      <input
        id={id}
        type="password"
        value={value}
        autoComplete={replacing ? "new-password" : "off"}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="help">
        {replacing ? `${t("keepCurrent")} ` : ""}
        {strategy?.tokenDescription ?? ""}
      </p>
    </div>
  );
}
