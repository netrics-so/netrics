"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

import type { Device } from "@netrics/contracts";
import type {
  DashboardDataFilter,
  DashboardFilterValue,
} from "@netrics/domain";

import { DashboardFilterInput } from "@/components/studio/shared-filters";
import { apiErrorMessage, updateDevice } from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n/client";

type ScopeValue = Exclude<DashboardFilterValue, null>;
type DeviceScopeValues = NonNullable<Device["scope"]>["values"];

/** Whether a choice restricts anything: an empty list or open range does not. */
export function restricts(value: DashboardFilterValue): value is ScopeValue {
  return (
    value !== null &&
    (value.kind === "values"
      ? value.values.length > 0
      : value.from !== null || value.to !== null)
  );
}

interface DeviceScopeProps {
  workspaceId: string;
  device: Pick<Device, "id" | "dashboardId" | "scope">;
  /** The shared filters of the screen's dashboard, as saved. */
  filters: DashboardDataFilter[];
}

/**
 * Sets and reviews a screen's fixed scope (#500): per shared filter of its
 * dashboard, the values or range the screen may show. The server
 * intersects it with every choice; this form only edits it.
 */
export function DeviceScope({
  workspaceId,
  device,
  filters,
}: DeviceScopeProps) {
  const locale = useLocale();
  const t = useT("devices");
  const errors = useT("apiErrors");
  const router = useRouter();
  const id = useId();
  const saved = device.scope?.values ?? {};
  const [limited, setLimited] = useState<Set<string>>(
    () => new Set(Object.keys(saved)),
  );
  const [draft, setDraft] = useState<Record<string, DashboardFilterValue>>(
    () => ({ ...saved }),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!device.dashboardId) {
    return <p className="muted">{t("scopeNoDashboard")}</p>;
  }
  if (filters.length === 0 && !device.scope) {
    return <p className="muted">{t("scopeNoFilters")}</p>;
  }

  async function save(values: Record<string, ScopeValue> | null) {
    setError(null);
    setPending(true);
    try {
      await updateDevice(workspaceId, device.id, {
        scope: values ? { values: values as DeviceScopeValues } : null,
      });
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values: Record<string, ScopeValue> = {};
    for (const filterId of limited) {
      const value = draft[filterId] ?? null;
      // An empty choice would read as "everything": never send it as one.
      if (!restricts(value)) {
        setError(errors("device_scope_value_invalid"));
        return;
      }
      values[filterId] = value;
    }
    void save(Object.keys(values).length > 0 ? values : null);
  }

  return (
    <form className="device-scope" onSubmit={onSubmit} aria-labelledby={id}>
      <h4 id={id}>{t("scopeTitle")}</h4>
      <p className="muted">{t("scopeHelp")}</p>
      {filters.map((filter) => {
        const checked = limited.has(filter.id);
        return (
          <fieldset key={filter.id} className="device-scope-filter">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={checked}
                disabled={pending}
                onChange={(event) => {
                  const next = new Set(limited);
                  if (event.target.checked) next.add(filter.id);
                  else next.delete(filter.id);
                  setLimited(next);
                }}
              />
              {t("scopeLimit", { name: filter.name })}
            </label>
            {checked ? (
              <DashboardFilterInput
                filter={filter}
                workspaceId={workspaceId}
                initialBrowse={filter.mode === "values"}
                value={draft[filter.id] ?? null}
                onChange={(value) =>
                  setDraft((current) => ({ ...current, [filter.id]: value }))
                }
              />
            ) : null}
          </fieldset>
        );
      })}
      {
        // Scoped filters the dashboard no longer has: shown so they can be
        // unticked; saving them as they are fails on the server.
        Object.keys(saved)
          .filter((filterId) => !filters.some((f) => f.id === filterId))
          .map((filterId) => (
            <fieldset key={filterId} className="device-scope-filter">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={limited.has(filterId)}
                  disabled={pending}
                  onChange={(event) => {
                    const next = new Set(limited);
                    if (event.target.checked) next.add(filterId);
                    else next.delete(filterId);
                    setLimited(next);
                  }}
                />
                {t("scopeLimit", { name: filterId })}
              </label>
              <p className="muted">{t("scopeFilterGone")}</p>
            </fieldset>
          ))
      }
      <p className="muted">{t("scopeOlderWidgets")}</p>
      <div className="actions">
        <button type="submit" disabled={pending}>
          {t("scopeSave")}
        </button>
        {device.scope ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void save(null)}
          >
            {t("scopeRemove")}
          </button>
        ) : null}
      </div>
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
    </form>
  );
}
