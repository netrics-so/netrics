"use client";

import { useState } from "react";

import { useConfirmation } from "@/components/confirm-dialog";
import { apiErrorMessage, deleteWorkspace } from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n/client";

/**
 * "Delete workspace" (#839), for owners: asks in the app's dialog for the
 * workspace's name, deletes, then leaves for the start page, which opens
 * another workspace of the user or offers to create one.
 */
export function DeleteWorkspace({
  workspaceId,
  name,
}: {
  workspaceId: string;
  name: string;
}) {
  const locale = useLocale();
  const t = useT("workspaceSettings.deletion");
  const common = useT("common");
  const confirmation = useConfirmation();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onDelete() {
    setError(null);
    const confirmed = await confirmation.ask({
      title: t("confirmTitle", { workspace: name }),
      text: t("confirmText"),
      confirm: t("confirm"),
      cancel: common("cancel"),
      destructive: true,
      typeToConfirm: {
        expected: name,
        label: t("typeLabel", { workspace: name }),
      },
    });
    if (!confirmed) return;
    setPending(true);
    try {
      await deleteWorkspace(workspaceId, name);
      // A full navigation: nothing of the deleted workspace stays in the
      // client's caches.
      window.location.assign("/");
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
      setPending(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        className="danger"
        disabled={pending}
        onClick={() => void onDelete()}
      >
        {pending ? t("deleting") : t("button")}
      </button>
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
      {confirmation.dialog}
    </div>
  );
}
