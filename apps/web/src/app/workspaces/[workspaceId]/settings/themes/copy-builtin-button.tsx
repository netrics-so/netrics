"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { BuiltinThemeKey } from "@netrics/domain";

import { apiErrorMessage, createTheme } from "@/lib/api";
import { copyName } from "@/lib/theme-name";

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
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function copy() {
    setPending(true);
    setError(null);
    try {
      const { theme } = await createTheme(workspaceId, {
        name: copyName(baseName, takenNames),
        base,
      });
      router.push(`/workspaces/${workspaceId}/settings/themes/${theme.id}`);
    } catch (cause) {
      setError(apiErrorMessage(cause));
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" onClick={copy} disabled={pending}>
        {pending ? "Copying…" : "Copy and edit"}
      </button>
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
