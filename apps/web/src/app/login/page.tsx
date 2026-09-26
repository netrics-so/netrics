import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { LoginForm } from "./login-form";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const cookieHeader = (await headers()).get("cookie") ?? "";
  if (await getSessionUser(cookieHeader)) {
    redirect("/");
  }

  return (
    <>
      <h1>Sign in</h1>
      <p className="subtitle">Sign in to your netrics account</p>
      <div className="card">
        <LoginForm />
      </div>
      <p className="muted">
        No account yet? <Link href="/signup">Create one</Link>
      </p>
    </>
  );
}
