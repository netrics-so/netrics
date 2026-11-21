"use client";

import { createAuthClient } from "better-auth/react";

import { clearStoredBuilders } from "./custom-api-storage";

// The only place in the web app that touches better-auth. The client talks
// to same-origin /api/auth/*, which next.config.ts rewrites to the API, so
// the session cookie is a plain first-party cookie and no baseURL or
// NEXT_PUBLIC_ variable is needed in the browser.
export const authClient = createAuthClient();

/** Signing out also forgets this tab's unsaved custom API builders (#807). */
export const signOut: typeof authClient.signOut = (...args) => {
  clearStoredBuilders();
  return authClient.signOut(...args);
};

export const {
  signIn,
  signUp,
  changePassword,
  requestPasswordReset,
  resetPassword,
} = authClient;
