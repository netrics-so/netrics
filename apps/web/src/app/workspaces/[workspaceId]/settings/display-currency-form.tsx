"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import type { CurrencyConversionOptionsResponse } from "@netrics/contracts";

import { apiErrorMessage, setWorkspaceDisplayCurrency } from "@/lib/api";

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
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!options.enabled) {
    return (
      <p className="muted">
        Amounts in several currencies are shown per currency. This instance does
        not fetch exchange rates, so they cannot be converted.
      </p>
    );
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
      setError(apiErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <form className="inline" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="workspace-display-currency">Amounts</label>
          <select
            id="workspace-display-currency"
            name="displayCurrency"
            defaultValue={currentDisplayCurrency ?? PER_CURRENCY}
            disabled={pending}
          >
            <option value={PER_CURRENCY}>Per currency (exact)</option>
            {currencies.map((currency) => (
              <option key={currency} value={currency}>
                Converted to {currency} (≈)
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
        {error ? <div className="error">{error}</div> : null}
      </form>
      <p className="muted">
        Converted amounts are approximate: each day at the{" "}
        <a href={options.source.url} target="_blank" rel="noreferrer">
          {options.source.name}
        </a>{" "}
        of that day (the last published rate on weekends and holidays).
        Apple&rsquo;s own reports use different rates. Currencies the ECB does
        not publish stay unconverted and are shown apart. A tile can override
        this.
      </p>
    </>
  );
}
