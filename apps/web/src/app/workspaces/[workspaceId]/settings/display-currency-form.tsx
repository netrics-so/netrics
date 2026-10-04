"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import type { CurrencyConversionOptionsResponse } from "@netrics/contracts";

import { apiErrorMessage, setWorkspaceDisplayCurrency } from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n/client";

const PER_CURRENCY = "";

/**
 * Amounts in several currencies: per currency (exact, the default) or
 * converted into one display currency with ECB reference rates (#191).
 */
export function DisplayCurrencyForm({
  workspaceId,
  currentDisplayCurrency,
  options,
}: {
  workspaceId: string;
  currentDisplayCurrency: string | null;
  options: CurrencyConversionOptionsResponse;
}) {
  const locale = useLocale();
  const t = useT("workspaceSettings.currency");
  const common = useT("common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!options.enabled) {
    return <p className="muted">{t("off")}</p>;
  }
  const currencies =
    currentDisplayCurrency &&
    !options.currencies.includes(currentDisplayCurrency)
      ? [currentDisplayCurrency, ...options.currencies]
      : options.currencies;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const value = String(
      new FormData(event.currentTarget).get("displayCurrency") ?? "",
    );
    try {
      await setWorkspaceDisplayCurrency(
        workspaceId,
        value === PER_CURRENCY ? null : value,
      );
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <form className="inline" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="workspace-display-currency">{t("label")}</label>
          <select
            id="workspace-display-currency"
            name="displayCurrency"
            defaultValue={currentDisplayCurrency ?? PER_CURRENCY}
            disabled={pending}
          >
            <option value={PER_CURRENCY}>{t("perCurrency")}</option>
            {currencies.map((currency) => (
              <option key={currency} value={currency}>
                {t("convertedTo", { currency })}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={pending}>
          {pending ? common("saving") : common("save")}
        </button>
        {error ? <div className="error">{error}</div> : null}
      </form>
      <p className="muted">
        {t.rich("hint", {
          source: (
            <a
              key="source"
              href={options.source.url}
              target="_blank"
              rel="noreferrer"
            >
              {options.source.name}
            </a>
          ),
        })}
      </p>
    </>
  );
}
