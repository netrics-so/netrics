import type { ConnectorRegistry } from "@netrics/connector-runtime";
import { developerTemplateResultSchema } from "@netrics/contracts";
import { resolveDataPolicy, type Database } from "@netrics/database";
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
  developerDefaults,
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
    // The workspace's defaults and the projects as they are now, under the
    // workspace's effective data policy (as the install reads them).
    readItems: async (tx, workspaceId, install, raw) => {
      const inputs = asDeveloperInputs(raw);
      const { policy: effective } = await resolveDataPolicy(
        tx,
        workspaceId,
        policy,
      );
      const defaults = await developerDefaults(
        tx,
        workspaceId,
        inputs.connections,
        effective,
      );
      const apps = await readDeveloperProjects(
        tx,
        workspaceId,
        {
          result: developerTemplateResultSchema.parse(install.result),
          connections: inputs.connections,
          defaults,
        },
        now(),
        effective,
      );
      return asStoreInputs({ ...inputs, defaults, apps });
    },
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
