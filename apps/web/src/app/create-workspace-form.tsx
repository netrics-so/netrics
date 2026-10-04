"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { apiErrorMessage, createWorkspace } from "@/lib/api";
import { useLocale } from "@/lib/i18n/client";

export function CreateWorkspaceForm() {
  const locale = useLocale();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      const { workspace, demoDashboardId } = await createWorkspace(
        String(form.get("name") ?? ""),
        form.get("withDemo") === "on",
      );
      // Straight to something useful when the demo was added.
      router.push(
        demoDashboardId
          ? `/workspaces/${workspace.id}/dashboards/${demoDashboardId}`
          : `/workspaces/${workspace.id}`,
      );
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
      setPending(false);
    }
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="name">Workspace name</label>
        <input
          id="name"
          name="name"
          type="text"
          required
          maxLength={100}
          disabled={pending}
        />
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          name="withDemo"
          defaultChecked
          disabled={pending}
        />
        <span>
          Add demo data and a sample dashboard
          <span className="muted">
            {" "}
            — generated numbers to explore with; delete them any time.
          </span>
        </span>
      </label>
      {error ? <div className="error">{error}</div> : null}
      <button type="submit" className="primary" disabled={pending}>
        {pending ? "Creating…" : "Create workspace"}
      </button>
    </form>
  );
}
