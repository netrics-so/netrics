"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { apiErrorMessage, renameWorkspace } from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n/client";

export function RenameWorkspaceForm({
  workspaceId,
  currentName,
}: {
  workspaceId: string;
  currentName: string;
}) {
  const locale = useLocale();
  const t = useT("workspaceSettings.workspace");
  const common = useT("common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      await renameWorkspace(workspaceId, String(form.get("name") ?? ""));
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
        <label htmlFor="workspace-name">{t("nameLabel")}</label>
        <input
          id="workspace-name"
          name="name"
          type="text"
          required
          maxLength={100}
          defaultValue={currentName}
          disabled={pending}
        />
      </div>
      <button type="submit" disabled={pending}>
        {pending ? common("saving") : t("rename")}
      </button>
      {error ? <div className="error">{error}</div> : null}
    </form>
  );
}
