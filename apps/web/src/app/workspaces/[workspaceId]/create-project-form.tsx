"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { apiErrorMessage, createProject } from "@/lib/api";

export function CreateProjectForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    setError(null);
    setPending(true);
    const form = new FormData(formEl);
    try {
      await createProject(workspaceId, String(form.get("name") ?? ""));
      router.refresh();
      formEl.reset();
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="inline" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="project-name">New project</label>
        <input
          id="project-name"
          name="name"
          type="text"
          required
          maxLength={100}
          disabled={pending}
        />
      </div>
      <button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create project"}
      </button>
      {error ? <div className="error">{error}</div> : null}
    </form>
  );
}
