import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { LoginForm } from "./login-form";
import { getSetupStatus } from "@/lib/api";
import { safeNextPath } from "@/lib/next-path";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const next = safeNextPath((await searchParams).next) ?? "/";
  const cookieHeader = (await headers()).get("cookie") ?? "";
  if (await getSessionUser(cookieHeader)) {
    redirect(next);
  }
  const setup = await getSetupStatus();
  if (setup.setupRequired) {
    redirect("/setup");
  }

  return (
    <>
      <h1>Sign in</h1>
      <p className="subtitle">Sign in to your netrics account</p>
      <div className="card">
        <LoginForm next={next} />
      </div>
      <p className="muted">
        <Link href="/forgot-password">Forgot password?</Link>
      </p>
      {setup.signup === "open" ? (
        <p className="muted">
          No account yet? <Link href="/signup">Create one</Link>
        </p>
      ) : null}
    </>
  );
}
