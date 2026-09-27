import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { SignupForm } from "./signup-form";
import { getSetupStatus } from "@/lib/api";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function SignupPage() {
  const cookieHeader = (await headers()).get("cookie") ?? "";
  if (await getSessionUser(cookieHeader)) {
    redirect("/");
  }
  const setup = await getSetupStatus();
  if (setup.setupRequired) {
    redirect("/setup");
  }
  if (setup.signup === "closed") {
    return (
      <>
        <h1>Sign-up is closed</h1>
        <p className="subtitle">
          Accounts on this installation are created by invitation. Ask an
          administrator to invite you.
        </p>
        <p className="muted">
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Create account</h1>
      <p className="subtitle">Register for netrics</p>
      <div className="card">
        <SignupForm />
      </div>
      <p className="muted">
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </>
  );
}
