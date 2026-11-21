"use client";

import { useState } from "react";

import { apiErrorMessage } from "@/lib/api";
import { exportDefinition } from "@/lib/custom-api";
import { useLocale, useT } from "@/lib/i18n/client";

/** "Export": downloads the definition file (no logins, no connection values). */
export function ExportDefinitionButton({
  workspaceId,
  definitionId,
  download = exportDefinition,
}: {
  workspaceId: string;
  definitionId: string;
  download?: typeof exportDefinition;
}) {
  const t = useT("customApi.export");
  const locale = useLocale();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="custom-api-export">
      <button
        type="button"
        title={t("help")}
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            await download(workspaceId, definitionId);
          } catch (cause) {
            setError(apiErrorMessage(cause, locale));
          } finally {
            setPending(false);
          }
        }}
      >
        {t("button")}
      </button>
      {error ? (
        <span className="error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
