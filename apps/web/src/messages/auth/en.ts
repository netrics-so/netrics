/**
 * Auth and onboarding (#251): home page, create workspace, login, sign-up,
 * setup, password reset, invitations, and better-auth's errors. Top-level
 * groups here must not collide with other areas' (the aggregate catalog
 * test checks).
 */
export const authEn = {
  home: {
    title: "Welcome, {name}",
    pageTitle: "Welcome",
    noWorkspace:
      "You are not a member of any workspace yet — create the first one.",
    workspaceName: "Workspace name",
    withDemo: "Add demo data and a sample dashboard",
    withDemoHint: "— generated numbers to explore with; delete them any time.",
    create: "Create workspace",
    newTitle: "New workspace",
    newSubtitle:
      "A workspace has its own dashboards, sources, screens and team.",
  },
  authFields: {
    name: "Name",
    email: "Email",
    password: "Password",
  },
  login: {
    title: "Sign in",
    subtitle: "Sign in to your netrics account",
    submit: "Sign in",
    pending: "Signing in…",
    forgot: "Forgot password?",
    noAccount: "No account yet? {link}",
    createOne: "Create one",
  },
  signup: {
    title: "Create account",
    subtitle: "Register for netrics",
    submit: "Create account",
    pending: "Creating account…",
    haveAccount: "Already have an account? {link}",
    signIn: "Sign in",
    closedTitle: "Sign-up is closed",
    closedText:
      "Accounts on this installation are created by invitation. Ask an administrator to invite you.",
  },
  setup: {
    title: "Set up netrics",
    subtitle:
      "Create the first account. It becomes the owner of your first workspace.",
    token: "Setup token",
    tokenHint:
      "The setup token is printed in the API log when the installation starts, or set by your operator as NETRICS_SETUP_TOKEN.",
    submit: "Create owner account",
    pending: "Setting up…",
    invalidToken: "The setup token is invalid or was already used.",
  },
  passwordReset: {
    forgotTitle: "Reset password",
    forgotSubtitle: "We email you a link to choose a new password",
    send: "Send reset link",
    sending: "Sending…",
    sent: "If an account exists for that address, we sent a link to reset the password. It is valid for {hours, plural, one {# hour} other {# hours}}.",
    tooManyRequests: "Too many requests. Wait a few minutes and try again.",
    sendFailed: "We could not send the email. Try again later.",
    remembered: "Remembered it? {link}",
    signIn: "Sign in",
    resetTitle: "Choose a new password",
    resetSubtitle: "Set the password for your netrics account",
    invalidLink: "This reset link is invalid or has expired.",
    missingLink: "This page needs the link from the reset email.",
    requestNew: "Request a new link",
    backToSignIn: "Back to sign in",
    newPassword: "New password",
    confirmPassword: "Confirm new password",
    minLengthHint: "At least {count} characters.",
    submit: "Set new password",
    saving: "Saving…",
    done: "Password changed. Other sessions were signed out. {link} with the new password.",
    mismatch: "The passwords do not match.",
  },
  invite: {
    notFoundTitle: "Invitation not found",
    notFoundText:
      "This link is not valid. Check that you copied it completely.",
    title: "Join {workspace}",
    accepted: "This invitation has already been used.",
    revoked: "This invitation was withdrawn. Ask for a new one.",
    expired: "This invitation has expired. Ask for a new one.",
    invitedAs: "You were invited as {role} with {email}.",
    haveAccount: "Already have an account for {email}? {link}",
    signIn: "Sign in",
    wrongAccount:
      "You are signed in as {signedIn}, but this invitation is for {invited}.",
    signOut: "Sign out",
    accept: "Accept invitation",
    joining: "Joining…",
    createAndJoin: "Create account and join",
    creating: "Creating account…",
  },
  /** better-auth's error codes, worded for people. */
  authErrors: {
    invalidCredentials: "That email and password do not match an account.",
    wrongPassword: "The current password is not correct.",
    invalidEmail: "Enter a valid email address.",
    userExists: "An account with this email already exists. Sign in instead.",
    passwordTooShort: "Use at least {count} characters.",
    passwordTooLong: "Use at most {count} characters.",
    signupDisabled: "Sign-up is disabled on this installation.",
    emailNotVerified: "Confirm your email address first.",
    sessionExpired: "Your session has expired — sign in again.",
    invalidToken: "This link is invalid or has expired.",
    tooManyAttempts: "Too many attempts. Wait a few minutes and try again.",
    signInFailed: "Sign-in failed. Try again.",
    signUpFailed: "Sign-up failed. Try again.",
    setupFailed: "Setup failed. Try again.",
    changePasswordFailed: "Could not change the password. Try again.",
    generic: "Something went wrong. Try again.",
  },
} as const;
