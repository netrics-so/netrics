"use client";

import { createAuthClient } from "better-auth/react";

// The only place in the web app that touches better-auth. The client talks
// to same-origin /api/auth/*, which next.config.ts rewrites to the API, so
// the session cookie is a plain first-party cookie and no baseURL or
// NEXT_PUBLIC_ variable is needed in the browser.
export const authClient = createAuthClient();

export const { signIn, signUp, signOut, changePassword } = authClient;
