"use client";

import { useState } from "react";

import { apiErrorMessage, startOAuthAuthorization } from "@/lib/api";
import { providerName } from "@/lib/oauth-connection";
import { useLocale } from "@/lib/i18n/client";

interface ConnectOAuthButtonProps {
  workspaceId: string;
  connectorId: string;
  provider: string;
  /** Reauthorize this connection instead of connecting a new one. */
  connectionId?: string;
  /** App path the provider returns to (validated by the API). */
  returnPath: string;
  /** Offer "Use a different account" (reauthorization only). */
  offerAccountChange?: boolean;
  primary?: boolean;
}

/**
 * Starts an OAuth authorization and sends the browser to the provider. A
 * JSON call plus window.location, never a form post: the CSP's form-action
 * 'self' would block a form redirect to the provider (ADR 0012).
 */
export function ConnectOAuthButton({
  workspaceId,
  connectorId,
  provider,
  connectionId,
  returnPath,
  offerAccountChange = false,
  primary = true,
}: ConnectOAuthButtonProps) {
  const locale = useLocale();
  const name = providerName(provider);
  const [otherAccount, setOtherAccount] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setError(null);
    setPending(true);
    try {
      const { authorizationUrl } = await startOAuthAuthorization(workspaceId, {
        connectorId,
        returnPath,
        ...(connectionId ? { connectionId } : {}),
        ...(connectionId && otherAccount ? { allowAccountChange: true } : {}),
      });
      window.location.assign(authorizationUrl);
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
      setPending(false);
    }
  }

  return (
    <>
      {offerAccountChange ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={otherAccount}
            disabled={pending}
            onChange={(event) => setOtherAccount(event.target.checked)}
          />
          <span>
            Use a different {name} account
            <span className="muted">
              {" "}
              — the connection then reads with that account; choose it at {name}
              .
            </span>
          </span>
        </label>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className={primary ? "primary" : undefined}
          disabled={pending}
          onClick={onClick}
        >
          {pending
            ? `Opening ${name}…`
            : connectionId
              ? `Reconnect ${name}`
              : `Connect with ${name}`}
        </button>
      </div>
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
