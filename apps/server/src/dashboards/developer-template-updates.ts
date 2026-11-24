import type { ConnectorRegistry } from "@netrics/connector-runtime";
import { developerTemplateResultSchema } from "@netrics/contracts";
import type { Database } from "@netrics/database";
import { DEFAULT_DATA_POLICY, type DataPolicy } from "@netrics/domain";

import {
  asDeveloperInputs,
  asStoreInputs,
  developerTemplate,
  developerTemplateInputsSchema,
  DEVELOPER_TEMPLATE_ID,
  type DeveloperTemplateInputs,
} from "./developer-template.js";
import {
  readDeveloperProjects,
  writePendingDeveloperRows,
  withDeveloperSourceDatasets,
} from "./developer-template-service.js";
import type { StoreTemplateDefinition } from "./store-template.js";
import {
  createStoreTemplateUpdateService,
  type TemplateFamily,
} from "./store-template-updates.js";

/**
 * Template updates of the Developer Portfolio (#876): the App Portfolio's
 * update engine (store-template-updates.ts) with this template's inputs,
 * source datasets and slide items (its projects, read from the install's
 * projects and links tables). A newer version, or a project linked,
 * unlinked or renamed since the dashboard was built, is offered as an
 * update; it is reviewed, applied as drafts, copied and swapped like the
 * App Portfolio's.
 */
export function developerTemplateFamily(deps: {
  registry: ConnectorRegistry;
  now?: () => Date;
  policy?: DataPolicy;
}): TemplateFamily {
  const policy = deps.policy ?? DEFAULT_DATA_POLICY,
    now = deps.now ?? (() => new Date());
  return {
    id: DEVELOPER_TEMPLATE_ID,
    parseInputs: (value) =>
      asStoreInputs(
        developerTemplateInputsSchema.parse(value) as DeveloperTemplateInputs,
      ),
    withSourceDatasets: async (tx, workspaceId, inputs, register) =>
      asStoreInputs(
        await withDeveloperSourceDatasets(
          tx,
          { registry: deps.registry, policy },
          workspaceId,
          asDeveloperInputs(inputs),
          register,
        ),
      ),
    readItems: (tx, workspaceId, install, inputs) =>
      readDeveloperProjects(
        tx,
        workspaceId,
        {
          result: developerTemplateResultSchema.parse(install.result),
          connections: asDeveloperInputs(inputs).connections,
        },
        now(),
        policy,
      ) as unknown as ReturnType<TemplateFamily["readItems"]>,
    writeItems: (tx, data, actor, install, inputs) =>
      writePendingDeveloperRows(
        tx,
        data,
        actor,
        {
          result: developerTemplateResultSchema.parse(install.result),
          connectionIds: inputs.connections.map((connection) => connection.id),
        },
        policy,
      ),
  };
}

export function createDeveloperTemplateUpdateService(deps: {
  db: Database;
  registry: ConnectorRegistry;
  now?: () => Date;
  policy?: DataPolicy;
  /** The newest template; tests pass other versions. */
  template?: StoreTemplateDefinition;
}): ReturnType<typeof createStoreTemplateUpdateService> {
  return createStoreTemplateUpdateService({
    ...deps,
    template: deps.template ?? developerTemplate,
    family: developerTemplateFamily(deps),
  });
}
