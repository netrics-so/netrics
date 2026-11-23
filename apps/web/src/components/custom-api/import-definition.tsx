"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { CUSTOM_API_IMPORT_MAX_BYTES } from "@netrics/contracts";

import { apiErrorMessage } from "@/lib/api";
import { CustomApiRequestError, importDefinition } from "@/lib/custom-api";
import { useLocale, useT } from "@/lib/i18n/client";

type Issue = CustomApiRequestError["issues"][number];

/** A chosen file's JSON, or why it can't be sent (size, not JSON). */
export function readImportFile(
  text: string,
  bytes: number,
): { ok: true; file: unknown } | { ok: false; error: "tooLarge" | "notJson" } {
  if (bytes > CUSTOM_API_IMPORT_MAX_BYTES)
    return { ok: false, error: "tooLarge" };
  try {
    return { ok: true, file: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "notJson" };
  }
}

/**
 * Whether a file's definition sends JSON bodies with POST (ADR 0030): the
 * importer confirms they only read data; the file's own confirmation is
 * never taken over.
 */
export function importSendsJsonBodies(file: unknown): boolean {
  const streams = (
    (file as { definition?: { streams?: unknown } } | null)?.definition as
      { streams?: unknown } | undefined
  )?.streams;
  return (
    Array.isArray(streams) &&
    streams.some(
      (stream: unknown) =>
        (stream as { request?: { body?: { kind?: unknown } } } | null)?.request
          ?.body?.kind === "json",
    )
  );
}

/**
 * Sends the file; the new definition's id, or the refusal with the
 * definition's issues (custom_api_import_invalid lists them).
 */
export async function importFlow(
  client: { importDefinition: typeof importDefinition },
  workspaceId: string,
  input: {
    file: unknown;
    name: string;
    projectId: string | null;
    readOnlyConfirmed?: boolean;
  },
): Promise<
  | { ok: true; definitionId: string }
  | { ok: false; cause: unknown; issues: Issue[] }
> {
  try {
    const { definition } = await client.importDefinition(workspaceId, {
      file: input.file,
      ...(input.name.trim() ? { name: input.name.trim() } : {}),
      projectId: input.projectId,
      ...(input.readOnlyConfirmed ? { readOnlyConfirmed: true } : {}),
    });
    return { ok: true, definitionId: definition.id };
  } catch (cause) {
    return {
      ok: false,
      cause,
      issues: cause instanceof CustomApiRequestError ? cause.issues : [],
    };
  }
}

/** The issues of a refused file: where, and what is wrong (never values). */
export function ImportIssues({
  message,
  issues,
}: {
  message: string;
  issues: Issue[];
}) {
  const t = useT("customApi.import");
  return (
    <div className="error" role="alert">
      <p>{issues.length ? t("invalid") : message}</p>
      {issues.length ? (
        <ul className="custom-api-import-issues">
          {issues.map((issue, index) => (
            <li key={`${issue.path}-${index}`}>
              {issue.path ? <code>{issue.path}</code> : null} {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Import of an exported custom API (#808): a JSON file of at most 512 KB,
 * an optional name and project; the new definition opens on success.
 */
export function ImportDefinition({
  workspaceId,
  projects,
  client = { importDefinition },
}: {
  workspaceId: string;
  projects: { id: string; name: string }[];
  client?: { importDefinition: typeof importDefinition };
}) {
  const t = useT("customApi.import");
  const locale = useLocale();
  const router = useRouter();
  const [file, setFile] = useState<unknown>(undefined);
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const sendsJson = file !== undefined && importSendsJsonBodies(file);
  const [problem, setProblem] = useState<{
    message: string;
    issues: Issue[];
  } | null>(null);

  async function choose(chosen: File | undefined) {
    setProblem(null);
    setFile(undefined);
    setReadOnly(false);
    if (!chosen) return;
    const read = readImportFile(
      chosen.size > CUSTOM_API_IMPORT_MAX_BYTES ? "" : await chosen.text(),
      chosen.size,
    );
    if (!read.ok) setProblem({ message: t(read.error), issues: [] });
    else setFile(read.file);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (file === undefined) return;
    setPending(true);
    setProblem(null);
    const result = await importFlow(client, workspaceId, {
      file,
      name,
      projectId,
      readOnlyConfirmed: sendsJson && readOnly,
    });
    if (result.ok) {
      router.push(
        `/workspaces/${workspaceId}/custom-apis/${result.definitionId}`,
      );
      return;
    }
    setPending(false);
    setProblem({
      message: apiErrorMessage(result.cause, locale),
      issues: result.issues,
    });
  }

  return (
    <form className="card stack custom-api-import" onSubmit={submit}>
      <h2>{t("title")}</h2>
      <div className="field">
        <label htmlFor="custom-api-import-file">{t("choose")}</label>
        <input
          id="custom-api-import-file"
          type="file"
          accept="application/json,.json"
          disabled={pending}
          onChange={(event) => void choose(event.target.files?.[0])}
        />
      </div>
      <div className="field">
        <label htmlFor="custom-api-import-name">{t("name")}</label>
        <input
          id="custom-api-import-name"
          type="text"
          maxLength={100}
          value={name}
          disabled={pending}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      {projects.length ? (
        <div className="field">
          <label htmlFor="custom-api-import-project">{t("project")}</label>
          <select
            id="custom-api-import-project"
            value={projectId ?? ""}
            disabled={pending}
            onChange={(event) => setProjectId(event.target.value || null)}
          >
            <option value="">{t("noProject")}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {sendsJson ? (
        <div className="field">
          <p className="notice warning">{t("jsonBodies")}</p>
          <label className="checkbox">
            <input
              id="custom-api-import-read-only"
              type="checkbox"
              checked={readOnly}
              disabled={pending}
              onChange={(event) => setReadOnly(event.target.checked)}
            />{" "}
            {t("readOnlyConfirm")}
          </label>
        </div>
      ) : null}
      {problem ? (
        <ImportIssues message={problem.message} issues={problem.issues} />
      ) : null}
      <div className="actions">
        <button
          type="submit"
          className="primary"
          disabled={pending || file === undefined || (sendsJson && !readOnly)}
        >
          {pending ? t("importing") : t("button")}
        </button>
      </div>
    </form>
  );
}
