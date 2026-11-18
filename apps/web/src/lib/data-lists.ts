import {
  getDataSources,
  getDataWorkspace,
  type DataSource,
  type DataWorkspace,
} from "./data-api";
import {
  navigationQuery,
  pickerQuery,
  type ProjectScope,
} from "./project-scope";

/**
 * The lists of the data page (#573): datasets, preparations and models of
 * the active project, and the sources its editors may read: the active
 * project's plus unassigned ones (the same list under "All projects").
 * Used by the page on the server (with the forwarded headers) and on
 * refresh.
 */
export async function loadDataLists(
  workspaceId: string,
  scope: ProjectScope,
  forwarded?: Headers,
): Promise<{ data: DataWorkspace; pickerSources: DataSource[] }> {
  const [data, pickerSources] = await Promise.all([
    getDataWorkspace(workspaceId, forwarded, navigationQuery(scope)),
    scope.active
      ? getDataSources(workspaceId, forwarded, pickerQuery(scope))
      : null,
  ]);
  return { data, pickerSources: pickerSources ?? data.sources };
}
