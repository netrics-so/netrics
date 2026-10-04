"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";

import { apiErrorMessage, setWorkspaceTimeZone } from "@/lib/api";
import { useLocale } from "@/lib/i18n/client";

/** "Today" and daily numbers on dashboards follow this zone. */
export function TimeZoneForm({
  workspaceId,
  currentTimeZone,
}: {
  workspaceId: string;
  currentTimeZone: string;
}) {
  const locale = useLocale();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const zones = useMemo(() => {
    const all = Intl.supportedValuesOf("timeZone");
    return all.includes(currentTimeZone) ? all : [currentTimeZone, ...all];
  }, [currentTimeZone]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      await setWorkspaceTimeZone(
        workspaceId,
        String(form.get("timeZone") ?? ""),
      );
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="inline" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="workspace-time-zone">Time zone</label>
        <select
          id="workspace-time-zone"
          name="timeZone"
          defaultValue={currentTimeZone}
          disabled={pending}
        >
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </button>
      {error ? <div className="error">{error}</div> : null}
    </form>
  );
}
