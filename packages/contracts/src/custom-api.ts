// Custom API definitions (milestone 13). The document schema lives in the
// connector SDK's internal subpath, the one package both contracts and
// connectors may import; the API contract re-exports it.
export {
  CUSTOM_API_ISSUE_CODES,
  CUSTOM_API_LIMITS,
  CUSTOM_API_SCHEMA_VERSION,
  CustomApiDefinitionError,
  customApiAuthSchema,
  customApiDefinitionSchema,
  customApiEnvironmentSchema,
  customApiFieldSchema,
  customApiIssues,
  customApiPaginationSchema,
  customApiStreamSchema,
  customApiVariableSchema,
  customApiWindowSchema,
  upgradeCustomApiDefinition,
} from "@netrics/connector-sdk/custom-api";
export type {
  CustomApiAuth,
  CustomApiDefinition,
  CustomApiDefinitionErrorCode,
  CustomApiEnvironment,
  CustomApiField,
  CustomApiImages,
  CustomApiIssue,
  CustomApiIssueCode,
  CustomApiPagination,
  CustomApiStream,
  CustomApiVariable,
  CustomApiWindow,
} from "@netrics/connector-sdk/custom-api";
