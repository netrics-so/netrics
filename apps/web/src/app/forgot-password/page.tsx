import Link from "next/link";

import { ForgotPasswordForm } from "./forgot-password-form";

export const dynamic = "force-dynamic";

// Reachable signed out: the only way back in for someone who lost the
// password.
export default function ForgotPasswordPage() {
  return (
    <>
      <h1>Reset password</h1>
      <p className="subtitle">We email you a link to choose a new password</p>
      <div className="card">
        <ForgotPasswordForm />
      </div>
      <p className="muted">
        Remembered it? <Link href="/login">Sign in</Link>
      </p>
    </>
  );
}
