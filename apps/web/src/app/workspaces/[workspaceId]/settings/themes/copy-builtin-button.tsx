"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { BuiltinThemeKey } from "@netrics/domain";

import { apiErrorMessage, createTheme } from "@/lib/api";
import { copyName } from "@/lib/theme-name";
import { useLocale, useT } from "@/lib/i18n/client";

export function CopyBuiltinButton({
  workspaceId,
  base,
  baseName,
  takenNames,
}: {
  workspaceId: string;
  base: BuiltinThemeKey;
  baseName: string;
  takenNames: string[];
}) {
  const locale = useLocale();
  const t = useT("themes");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function copy() {
    setPending(true);
    setError(null);
    try {
      const { theme } = await createTheme(workspaceId, {
        name: copyName(baseName, takenNames, locale),
        base,
      });
      router.push(`/workspaces/${workspaceId}/settings/themes/${theme.id}`);
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" onClick={copy} disabled={pending}>
        {pending ? t("copying") : t("copy")}
      </button>
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
