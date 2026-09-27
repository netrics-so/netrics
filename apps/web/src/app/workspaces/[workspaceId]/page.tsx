import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { CreateProjectForm } from "./create-project-form";
import { HealthBadge } from "./health-badge";
import {
  getWorkspace,
  listConnections,
  listProjects,
  listWorkspaces,
} from "@/lib/api";
import { relativeTime } from "@/lib/relative-time";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

interface WorkspacePageProps {
  params: Promise<{ workspaceId: string }>;
}

export default async function WorkspacePage({ params }: WorkspacePageProps) {
  const { workspaceId } = await params;
  const { cookieHeader } = await requireSession();

  const [{ workspaces }, workspaceResult] = await Promise.all([
    listWorkspaces(cookieHeader),
    getWorkspace(cookieHeader, workspaceId),
  ]);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!workspaceResult || !membership) {
    notFound();
  }

  const { projects } = await listProjects(cookieHeader, workspaceId);
  const { connections } = await listConnections(cookieHeader, workspaceId);
  const role = membership.role;

  return (
    <>
      <h1>{workspaceResult.workspace.name}</h1>
      <p className="subtitle">
        Your role: <span className="role-badge">{role}</span>
      </p>

      <div className="card">
        <h2>Workspaces</h2>
        <ul className="workspace-list">
          {workspaces.map((workspace) => (
            <li key={workspace.id}>
              {workspace.id === workspaceId ? (
                <span className="current">
                  {workspace.name} (current, {workspace.role})
                </span>
              ) : (
                <Link href={`/workspaces/${workspace.id}`}>
                  {workspace.name}
                </Link>
              )}
            </li>
          ))}
        </ul>
        <p className="muted">
          <Link href={`/workspaces/${workspaceId}/settings`}>
            Workspace settings
          </Link>
        </p>
      </div>

      <div className="card">
        <h2>Connections</h2>
        {connections.length === 0 ? (
          <p className="muted">No connections yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Connector</th>
                <th>Health</th>
                <th>Last success</th>
                <th>Next sync</th>
              </tr>
            </thead>
            <tbody>
              {connections.map((connection) => (
                <tr key={connection.id}>
                  <td>
                    <Link
                      href={`/workspaces/${workspaceId}/connections/${connection.id}`}
                    >
                      {connection.name}
                    </Link>
                  </td>
                  <td className="muted">
                    {connection.connectorName} {connection.connectorVersion}
                  </td>
                  <td>
                    <HealthBadge health={connection.state.health} />
                  </td>
                  <td className="muted">
                    {relativeTime(connection.state.lastSuccessAt)}
                  </td>
                  <td className="muted">
                    {relativeTime(connection.state.nextDueAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {can(role, "connections:create") ? (
          <p>
            <Link href={`/workspaces/${workspaceId}/connections/new`}>
              <button type="button" className="primary">
                Add connection
              </button>
            </Link>
          </p>
        ) : (
          <p className="muted">
            Your role cannot create connections in this workspace.
          </p>
        )}
      </div>

      <div className="card">
        <h2>Projects</h2>
        {projects.length === 0 ? (
          <p className="muted">No projects yet.</p>
        ) : (
          <ul className="workspace-list">
            {projects.map((project) => (
              <li key={project.id}>{project.name}</li>
            ))}
          </ul>
        )}
        {can(role, "projects:create") ? (
          <CreateProjectForm workspaceId={workspaceId} />
        ) : (
          <p className="muted">
            Your role cannot create projects in this workspace.
          </p>
        )}
      </div>
    </>
  );
}
