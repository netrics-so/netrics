"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { apiErrorMessage, createWorkspace } from "@/lib/api";

export function CreateWorkspaceForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      const { workspace } = await createWorkspace(
        String(form.get("name") ?? ""),
      );
      router.push(`/workspaces/${workspace.id}`);
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause));
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
      {error ? <div className="error">{error}</div> : null}
      <button type="submit" className="primary" disabled={pending}>
        {pending ? "Creating…" : "Create workspace"}
      </button>
    </form>
  );
}
