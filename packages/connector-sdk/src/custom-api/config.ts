// A custom API connection's configuration: its definition's plain
// (non-secret) values. One schema for the manifest the API validates
// against (packages/connectors) and the connection page's form (web).

import type { JsonSchema } from "../manifest.js";
import type { CustomApiDefinition } from "./definition.js";

/** A plain connection value's length, in characters. */
export const CUSTOM_API_VALUE_LENGTH = { min: 1, max: 500 } as const;

/** The configuration schema: every non-secret variable, a required string. */
export function customApiConfigSchema(
  definition: Pick<CustomApiDefinition, "variables">,
): JsonSchema {
  const variables = definition.variables.filter((v) => !v.secret);
  return {
    type: "object",
    properties: Object.fromEntries(
      variables.map((variable) => [
        variable.id,
        {
          type: "string",
          title: variable.label,
          minLength: CUSTOM_API_VALUE_LENGTH.min,
          maxLength: CUSTOM_API_VALUE_LENGTH.max,
        },
      ]),
    ),
    required: variables.map((variable) => variable.id),
    additionalProperties: false,
  };
}
