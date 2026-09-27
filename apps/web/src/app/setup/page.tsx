import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { SetupForm } from "./setup-form";
import { getSetupStatus } from "@/lib/api";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const cookieHeader = (await headers()).get("cookie") ?? "";
  if (await getSessionUser(cookieHeader)) {
    redirect("/");
  }
  if (!(await getSetupStatus()).setupRequired) {
    redirect("/login");
  }
  const { token } = await searchParams;

  return (
    <>
      <h1>Set up netrics</h1>
      <p className="subtitle">
        Create the first account. It becomes the owner of your first workspace.
      </p>
      <div className="card">
        <SetupForm initialToken={typeof token === "string" ? token : ""} />
      </div>
      <p className="muted">
        The setup token is printed in the API log when the installation starts,
        or set by your operator as NETRICS_SETUP_TOKEN.
      </p>
    </>
  );
}
