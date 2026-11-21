"use client";

import { ProjectSelect } from "@/components/project-select";
import {
  environmentIdFromName,
  hostOf,
  type BuilderState,
} from "@/lib/custom-api-builder";
import { useT } from "@/lib/i18n/client";

import type { StepProps } from "./step-props";

/** Step 1: name, environments (named base URLs) and project. */
export function StepBasics({
  state,
  update,
  projects,
  savedEnvironmentIds = new Set(),
}: StepProps & {
  projects: ReadonlyArray<{
    id: string;
    name: string;
    archivedAt: string | null;
  }>;
  /** Environments of the saved definition: their ids stay (connections pin them). */
  savedEnvironmentIds?: ReadonlySet<string>;
}) {
  const t = useT("customApi.basics");
  const secretsStored = state.secretsSet.length > 0;
  const setEnvironment = (
    index: number,
    patch: Partial<BuilderState["environments"][number]>,
  ) =>
    update((current) => ({
      ...current,
      environments: current.environments.map((environment, i) =>
        i === index ? { ...environment, ...patch } : environment,
      ),
    }));

  return (
    <div className="custom-api-form">
      <div className="field">
        <label htmlFor="custom-api-name">{t("name")}</label>
        <input
          id="custom-api-name"
          value={state.name}
          maxLength={100}
          onChange={(event) =>
            update((current) => ({ ...current, name: event.target.value }))
          }
        />
      </div>
      {state.environments.map((environment, index) => {
        const several = state.environments.length > 1;
        const testing = state.environmentId === environment.id;
        return (
          <fieldset key={index} className="custom-api-environment">
            {several ? (
              <div className="field">
                <label htmlFor={`custom-api-env-name-${index}`}>
                  {t("environmentName")}
                </label>
                <input
                  id={`custom-api-env-name-${index}`}
                  value={environment.name}
                  maxLength={100}
                  onChange={(event) => {
                    const name = event.target.value;
                    const taken = new Set(
                      state.environments
                        .filter((_, i) => i !== index)
                        .map((e) => e.id),
                    );
                    // A new environment takes its id from its name; ids
                    // of saved environments stay (connections pin them).
                    const keepId = savedEnvironmentIds.has(environment.id);
                    update((current) => {
                      const id = keepId
                        ? environment.id
                        : environmentIdFromName(name, taken);
                      return {
                        ...current,
                        environmentId:
                          current.environmentId === environment.id
                            ? id
                            : current.environmentId,
                        environments: current.environments.map((e, i) =>
                          i === index ? { ...e, name, id } : e,
                        ),
                      };
                    });
                  }}
                />
              </div>
            ) : null}
            <div className="field">
              <label htmlFor={`custom-api-base-url-${index}`}>
                {t("baseUrl")}
              </label>
              <input
                id={`custom-api-base-url-${index}`}
                type="url"
                inputMode="url"
                value={environment.baseUrl}
                onChange={(event) =>
                  setEnvironment(index, { baseUrl: event.target.value })
                }
              />
              <p className="help">{t("baseUrlHelp")}</p>
              {secretsStored && testing && hostOf(environment.baseUrl) ? (
                <p className="help custom-api-warning">{t("hostWarning")}</p>
              ) : null}
            </div>
            {several ? (
              <div className="custom-api-row-actions">
                <label className="checkbox">
                  <input
                    type="radio"
                    name="custom-api-test-environment"
                    checked={testing}
                    onChange={() =>
                      update((current) => ({
                        ...current,
                        environmentId: environment.id,
                      }))
                    }
                  />
                  {t("testEnvironment")}
                </label>
                <button
                  type="button"
                  className="link-button"
                  onClick={() =>
                    update((current) => {
                      const environments = current.environments.filter(
                        (_, i) => i !== index,
                      );
                      return {
                        ...current,
                        environments,
                        environmentId:
                          current.environmentId === environment.id
                            ? environments[0]!.id
                            : current.environmentId,
                      };
                    })
                  }
                >
                  {t("removeEnvironment")}
                </button>
              </div>
            ) : null}
          </fieldset>
        );
      })}
      {state.environments.length < 10 ? (
        <button
          type="button"
          onClick={() =>
            update((current) => {
              const taken = new Set(current.environments.map((e) => e.id));
              const id = environmentIdFromName("staging", taken);
              return {
                ...current,
                environments: [
                  ...current.environments,
                  { id, name: "Staging", baseUrl: "" },
                ],
              };
            })
          }
        >
          {t("addEnvironment")}
        </button>
      ) : null}
      <div className="field">
        <label htmlFor="custom-api-project">{t("project")}</label>
        <ProjectSelect
          id="custom-api-project"
          projects={projects}
          value={state.projectId}
          onChange={(projectId) =>
            update((current) => ({ ...current, projectId }))
          }
        />
      </div>
    </div>
  );
}
