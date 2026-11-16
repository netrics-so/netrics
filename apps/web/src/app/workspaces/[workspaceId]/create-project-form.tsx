"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { apiErrorMessage, createProject } from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n/client";

/**
 * A project name as the user typed it, trimmed (#640); null when nothing
 * but whitespace is left, so the form says so instead of a generic error.
 */
export function projectName(raw: string): string | null {
  const name = raw.trim();
  return name === "" ? null : name;
}

export function CreateProjectForm({ workspaceId }: { workspaceId: string }) {
  const locale = useLocale();
  const t = useT("workspace.newProject");
  const common = useT("common");
  const page = useT("projectsPage");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    setError(null);
    setDone(null);
    const name = projectName(String(new FormData(formEl).get("name") ?? ""));
    if (name === null) {
      setError(page("nameRequired"));
      return;
    }
    setPending(true);
    try {
      await createProject(workspaceId, name);
      router.refresh();
      formEl.reset();
      setDone(page("createdDone", { name }));
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="inline" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="project-name">{t("label")}</label>
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
        {pending ? common("creating") : t("create")}
      </button>
      {done ? (
        <p className="notice" role="status">
          {done}
        </p>
      ) : null}
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
    </form>
  );
}
