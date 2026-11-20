// What a custom-api connection's credential envelope holds, per auth type.
// Credentials are bound to the environment host they were entered for.

import type { CustomApiDefinition } from "@netrics/connector-sdk/custom-api";
import { z } from "zod";

export type CustomApiCredentials =
  | { host: string; apiKey: string; variables?: Record<string, string> }
  | { host: string; token: string; variables?: Record<string, string> }
  | {
      host: string;
      username: string;
      password: string;
      variables?: Record<string, string>;
    }
  /** Auth none: only stored when the definition has secret variables. */
  | { host: string; variables?: Record<string, string> }
  /** OAuth: minted by the host for one call. */
  | { accessToken: string };

const secretValue = z.string().min(1).max(4_096);

/** The shape the server stores for this definition's auth type (OAuth types: C-G4). */
export function customApiCredentialsSchema(
  definition: Pick<CustomApiDefinition, "auth" | "variables">,
): z.ZodType<CustomApiCredentials> {
  const secrets = definition.variables.filter((v) => v.secret);
  const variables = z.strictObject(
    Object.fromEntries(
      secrets.map((variable) => [variable.id, z.string().min(1).max(2_000)]),
    ),
  );
  const base = {
    host: z.string().min(1).max(300),
    ...(secrets.length > 0
      ? { variables }
      : { variables: z.strictObject({}).optional() }),
  };
  switch (definition.auth.type) {
    case "none":
      return z.strictObject(base) as z.ZodType<CustomApiCredentials>;
    case "api_key":
      return z.strictObject({
        ...base,
        apiKey: secretValue,
      }) as z.ZodType<CustomApiCredentials>;
    case "bearer":
      return z.strictObject({
        ...base,
        token: secretValue,
      }) as z.ZodType<CustomApiCredentials>;
    case "basic":
      return z.strictObject({
        ...base,
        username: secretValue,
        password: secretValue,
      }) as z.ZodType<CustomApiCredentials>;
    default:
      return z.strictObject({
        accessToken: secretValue,
      }) as z.ZodType<CustomApiCredentials>;
  }
}
