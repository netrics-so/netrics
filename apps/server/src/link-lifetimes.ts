/**
 * How long emailed links stay valid. better-auth and the invitation route
 * enforce these, and the emails state them; one source keeps them in step.
 */
export const PASSWORD_RESET_TTL_SECONDS = 60 * 60;
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
