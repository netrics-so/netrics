import type { FastifyBaseLogger } from "fastify";

import { countUsers, issueSetupToken, type Database } from "@netrics/database";

import type { Config } from "./env.js";
import { generateToken, hashToken } from "./tokens.js";

/**
 * First-run setup for installations with closed sign-up.
 *
 * While no account exists, the api issues a one-time setup token and logs a
 * setup URL. Only a sign-up request carrying that token can create the first
 * account (enforced in src/auth). This prevents whoever reaches a fresh
 * instance first from claiming it.
 */

export const SETUP_TOKEN_HEADER = "x-netrics-setup-token";

export const hashSetupToken = hashToken;

export async function prepareInstallationSetup(
  config: Config,
  db: Database,
  logger: FastifyBaseLogger,
): Promise<void> {
  if (config.signup === "open" || (await countUsers(db)) > 0) {
    return;
  }
  const token = config.setupToken ?? generateToken();
  await issueSetupToken(db, hashSetupToken(token));
  const url = new URL("/setup", config.webOrigin);
  if (config.setupToken) {
    logger.warn(
      { setupUrl: url.toString() },
      "netrics is not set up yet: open the setup URL and enter NETRICS_SETUP_TOKEN",
    );
    return;
  }
  // Printing the generated token is the point: the operator reads it from
  // the log. It only authorizes creating the very first account.
  url.searchParams.set("token", token);
  logger.warn(
    { setupUrl: url.toString() },
    "netrics is not set up yet: open the setup URL to create the first account",
  );
}
