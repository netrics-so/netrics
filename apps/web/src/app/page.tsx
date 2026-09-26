import { redirect } from "next/navigation";

import { CreateWorkspaceForm } from "./create-workspace-form";
import { listWorkspaces } from "@/lib/api";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { cookieHeader, user } = await requireSession();
  const { workspaces } = await listWorkspaces(cookieHeader);

  const first = workspaces[0];
  if (first) {
    redirect(`/workspaces/${first.id}`);
  }

  return (
    <>
      <h1>Welcome, {user.name}</h1>
      <p className="subtitle">
        You are not a member of any workspace yet — create the first one.
      </p>
      <div className="card">
        <CreateWorkspaceForm />
      </div>
    </>
  );
}
