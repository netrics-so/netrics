"use client";

import type { CustomApiDefinitionResponse } from "@netrics/contracts";

import { useT } from "@/lib/i18n/client";

import { typeOf } from "./field-mapping";

/** What viewers see of a custom API: no draft, no secrets, read only. */
export function CustomApiSummary({
  definition,
}: {
  definition: Pick<CustomApiDefinitionResponse["definition"], "document">;
}) {
  const t = useT("customApi");
  const document = definition.document;
  return (
    <section className="card custom-api-summary">
      <p className="muted">{t("viewer.readOnly")}</p>
      <p>
        {t("viewer.auth", {
          method: t(`login.methods.${document.auth.type}`),
        })}
      </p>
      <h3>{t("viewer.environments")}</h3>
      <ul>
        {document.environments.map((environment) => (
          <li key={environment.id}>
            {environment.name}: <code>{environment.baseUrl}</code>
          </li>
        ))}
      </ul>
      <h3>{t("viewer.stream")}</h3>
      {document.streams.map((stream) => (
        <div key={stream.key}>
          <p>
            <strong>{stream.name}</strong> <code>{stream.request.path}</code>
          </p>
          <ul>
            {stream.fields.map((field) => (
              <li key={field.id}>
                {field.name} · {t(`response.types.${typeOf(field)}`)}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
