import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { CreateProjectForm } from "./create-project-form";
import { getWorkspace, listProjects, listWorkspaces } from "@/lib/api";
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
