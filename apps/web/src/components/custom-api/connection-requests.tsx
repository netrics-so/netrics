"use client";

import type { ConnectionCustomApiRequest } from "@netrics/contracts";

import { useT } from "@/lib/i18n/client";

type Request = ConnectionCustomApiRequest;

/**
 * What a custom-api connection sends (ADR 0030 §2), shown to everyone who
 * can see the connection: each stream's method and path and, for POST, the
 * body template with its `{{ placeholders }}` (never a value or a secret).
 * A JSON body says that its read-only promise is the author's.
 */
export function CustomApiConnectionRequests({
  requests,
}: {
  requests: readonly Request[];
}) {
  const t = useT("customApi.connectionRequests");
  if (requests.length === 0) return null;
  return (
    <div className="card stack" id="custom-api-requests">
      <h2>{t("title")}</h2>
      <p className="help">{t("help")}</p>
      {requests.map((request) => (
        <section
          key={request.stream}
          className="stack"
          aria-label={request.name}
          data-testid={`custom-api-request-${request.stream}`}
        >
          <h3>{request.name}</h3>
          <p>
            <code>
              {request.method} {request.path}
            </code>
          </p>
          {request.body?.kind === "graphql" ? (
            <>
              <p className="help">{t("graphql")}</p>
              <pre>
                <code>{request.body.query}</code>
              </pre>
              <p className="help">{t("variables")}</p>
              <pre>
                <code>{JSON.stringify(request.body.variables, null, 2)}</code>
              </pre>
            </>
          ) : null}
          {request.body?.kind === "json" ? (
            <>
              <p className="notice warning" role="note">
                {t("jsonReadOnly")}
              </p>
              <pre>
                <code>{JSON.stringify(request.body.value, null, 2)}</code>
              </pre>
            </>
          ) : null}
        </section>
      ))}
    </div>
  );
}
