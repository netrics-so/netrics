"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { apiErrorMessage, createDashboard } from "@/lib/api";

export function CreateDashboardForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      const { dashboard } = await createDashboard(workspaceId, {
        name: String(form.get("name") ?? ""),
      });
      router.push(
        `/workspaces/${workspaceId}/dashboards/${dashboard.id}/studio`,
      );
    } catch (cause) {
      setError(apiErrorMessage(cause));
      setPending(false);
    }
  }

  return (
    <form className="inline" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="dashboard-name">New dashboard</label>
        <input
          id="dashboard-name"
          name="name"
          type="text"
          required
          maxLength={100}
          placeholder="Overview"
          disabled={pending}
        />
      </div>
      <button type="submit" className="primary" disabled={pending}>
        {pending ? "Creating…" : "Create"}
      </button>
      {error ? <div className="error">{error}</div> : null}
    </form>
  );
}
