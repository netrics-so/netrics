import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";

import type {
  OAuthCallbackOutcome,
  OAuthCallbackRequest,
  OAuthCallbackResponse,
  StartOAuthAuthorizationRequest,
  StartOAuthAuthorizationResponse,
  WorkspaceRole,
} from "@netrics/contracts";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import type {
  ConnectorManifest,
  OAuth2AuthStrategy,
} from "@netrics/connector-sdk";
import {
  consumeOAuthAuthorization,
  findConnection,
  findConnectionOAuth,
  findMembership,
  insertAuditEvent,
  insertConnection,
  insertOAuthAuthorization,
  oauthAccountHasGrant,
  releaseOAuthGrant,
  resetConnectionAuth,
  updateConnection,
  upsertConnectionOAuth,
  withOAuthGrantLocks,
  withUserContext,
  withWorkspace,
  type ConsumedOAuthAuthorization,
  type Database,
  type Transaction,
} from "@netrics/database";
import { can, type WorkspaceAction } from "@netrics/domain";

import {
  decryptOAuthCodeVerifier,
  encryptOAuthAccessToken,
  encryptOAuthCodeVerifier,
  type CredentialKeyring,
} from "../credentials.js";
import { Secret } from "../secret.js";
import {
  buildAuthorizationUrl,
  exchangeCode,
  hashState,
  isRefreshTokenLive,
  OAuthError,
  randomToken,
  verifyIdToken,
  type IdTokenAccount,
  type OAuthHttpFactory,
  type TokenSet,
} from "./client.js";
import type { ConfiguredOAuthProvider, OAuthProviders } from "./config.js";
import {
  openOAuthCredentials,
  sealOAuthCredentials,
  type OAuthTokenService,
} from "./tokens.js";
import {
  defaultReturnPath,
  isAllowedReturnPath,
  withOutcome,
} from "./return-path.js";

/**
 * The OAuth authorization flow (ADR 0012, #132): start writes the state
 * record and returns the provider URL; the callback validates in the ADR's
 * order, fails closed, and stores a grant only on the connection and
 * workspace bound into the state.
 *
 * Codes, states, verifiers and tokens never reach logs, errors, audit events
 * or responses: failures are logged as the outcome plus a short reason code.
 */

export const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

export interface OAuthFlowDeps {
  db: Database;
  registry: ConnectorRegistry;
  credentialKeyring: CredentialKeyring;
  oauthProviders: OAuthProviders;
  oauthHttp: OAuthHttpFactory;
  /** Revocations (best effort, short timeout) go through the token service. */
  oauthTokens: OAuthTokenService;
  logger: FastifyBaseLogger;
  now?: () => Date;
}

export interface FlowActor {
  workspaceId: string;
  callerId: string;
  role: WorkspaceRole;
}

export type StartResult =
  | { ok: true; value: StartOAuthAuthorizationResponse }
  | { ok: false; status: 400 | 403 | 404; error: string };

/** The connector's OAuth strategy, if it has one. */
function oauthStrategy(
  manifest: ConnectorManifest,
): OAuth2AuthStrategy | undefined {
  return manifest.authStrategies.find(
    (strategy): strategy is OAuth2AuthStrategy =>
      strategy.strategy === "oauth2",
  );
}

function requiredAction(purpose: "connect" | "reauthorize"): WorkspaceAction {
  return purpose === "connect" ? "connections:create" : "connections:update";
}

/** Thrown inside the flow to end it with an outcome; never carries secrets. */
class FlowStop extends Error {
  constructor(
    readonly outcome: OAuthCallbackOutcome,
    readonly reason: string,
  ) {
    super(`oauth callback ${outcome}: ${reason}`);
  }
}

export function createOAuthFlow(deps: OAuthFlowDeps) {
  const { db, registry, credentialKeyring, oauthProviders, logger } = deps;
  const now = deps.now ?? (() => new Date());

  /** Whether the user still holds the role the flow needs, in its workspace. */
  async function stillAllowed(
    tx: Transaction,
    workspaceId: string,
    userId: string,
    purpose: "connect" | "reauthorize",
  ): Promise<boolean> {
    const membership = await findMembership(tx, workspaceId, userId);
    return (
      membership !== null &&
      can(membership.role as WorkspaceRole, requiredAction(purpose))
    );
  }

  /**
   * Revokes a refused grant at the provider, unless a connection on this
   * instance holds a grant of the same account: Google revokes per account
   * and project, so that would stop those connections too. Runs under the
   * account's grant lock (`lockedDb`), so no grant of the account is stored
   * between the check and the revocation.
   */
  async function discardGrant(
    lockedDb: Database,
    provider: ConfiguredOAuthProvider,
    tokens: TokenSet,
    account: IdTokenAccount,
  ): Promise<void> {
    if (
      await oauthAccountHasGrant(lockedDb, provider.definition.id, account.sub)
    ) {
      return;
    }
    const token: Secret = tokens.refreshToken ?? tokens.accessToken;
    const revoked = await deps.oauthTokens.revokeGrant(
      provider.definition.id,
      token.reveal(),
    );
    if (!revoked) {
      logger.warn(
        { provider: provider.definition.id },
        "oauth grant revocation failed",
      );
    }
  }

  return {
    async start(
      actor: FlowActor,
      body: StartOAuthAuthorizationRequest,
    ): Promise<StartResult> {
      const purpose = body.connectionId ? "reauthorize" : "connect";
      if (!can(actor.role, requiredAction(purpose))) {
        return { ok: false, status: 403, error: "forbidden" };
      }
      const registered = registry.get(body.connectorId);
      if (!registered) {
        return { ok: false, status: 400, error: "invalid_request" };
      }
      const strategy = oauthStrategy(registered.manifest);
      if (!strategy) {
        return { ok: false, status: 400, error: "oauth_not_supported" };
      }
      const provider = oauthProviders.get(strategy.provider);
      if (!provider) {
        return { ok: false, status: 400, error: "connector_unavailable" };
      }
      const allowAccountChange = body.allowAccountChange ?? false;
      if (allowAccountChange && purpose === "connect") {
        return { ok: false, status: 400, error: "invalid_request" };
      }
      const connectionId = body.connectionId ?? null;
      const returnPath =
        body.returnPath ?? defaultReturnPath(actor.workspaceId, connectionId);
      if (!isAllowedReturnPath(returnPath, actor.workspaceId)) {
        return { ok: false, status: 400, error: "invalid_return_path" };
      }

      const state = randomToken();
      const nonce = randomToken();
      const codeVerifier = randomToken();
      const id = randomUUID();
      const expiresAt = new Date(now().getTime() + AUTHORIZATION_TTL_MS);

      const stored = await withWorkspace(
        db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        async (tx) => {
          if (connectionId) {
            const existing = await findConnection(
              tx,
              actor.workspaceId,
              connectionId,
            );
            if (!existing) {
              return {
                ok: false as const,
                status: 404 as const,
                error: "connection_not_found",
              };
            }
            if (existing.row.connectorId !== body.connectorId) {
              return {
                ok: false as const,
                status: 400 as const,
                error: "invalid_request",
              };
            }
            if (existing.oauth?.provider !== strategy.provider) {
              return {
                ok: false as const,
                status: 400 as const,
                error: "oauth_not_linked",
              };
            }
          }
          await insertOAuthAuthorization(tx, {
            id,
            workspaceId: actor.workspaceId,
            userId: actor.callerId,
            provider: strategy.provider,
            connectorId: body.connectorId,
            connectionId,
            purpose,
            allowAccountChange,
            returnPath,
            stateHash: hashState(state),
            nonce,
            codeVerifierEncrypted: Buffer.from(
              encryptOAuthCodeVerifier(codeVerifier, credentialKeyring, {
                workspaceId: actor.workspaceId,
                authorizationId: id,
              }),
              "utf8",
            ),
            expiresAt,
          });
          return { ok: true as const };
        },
      );
      if (!stored.ok) {
        return stored;
      }

      return {
        ok: true,
        value: {
          authorizationUrl: buildAuthorizationUrl(provider, {
            state,
            nonce,
            codeVerifier,
            scopes: [
              ...new Set([
                ...provider.definition.identityScopes,
                ...strategy.scopes,
              ]),
            ],
          }),
          purpose,
          expiresAt: expiresAt.toISOString(),
        },
      };
    },

    /**
     * Completes an authorization for the signed-in user. Always answers with
     * a relative app path; only `connected` and `reauthorized` store anything.
     */
    async callback(
      userId: string,
      providerId: string,
      query: OAuthCallbackRequest,
    ): Promise<OAuthCallbackResponse> {
      let consumed: ConsumedOAuthAuthorization | null = null;
      try {
        // 1. Consume the state: single use, unknown and expired fail.
        if (!query.state) {
          throw new FlowStop("invalid_state", "missing_state");
        }
        consumed = await consumeOAuthAuthorization(db, hashState(query.state));
        if (!consumed || consumed.provider !== providerId) {
          consumed = null;
          throw new FlowStop("invalid_state", "unknown_state");
        }
        const authorization = consumed;

        // 2. Same user, still holding the role.
        if (authorization.userId !== userId) {
          throw new FlowStop("forbidden", "other_user");
        }
        const allowed = await withUserContext(db, { userId }, (tx) =>
          stillAllowed(
            tx,
            authorization.workspaceId,
            userId,
            authorization.purpose,
          ),
        );
        if (!allowed) {
          throw new FlowStop("forbidden", "role_missing");
        }

        // 3. Consent refused (or any provider error): nothing is stored.
        if (query.error) {
          throw new FlowStop(
            "denied",
            query.error === "access_denied"
              ? "access_denied"
              : "provider_error",
          );
        }
        if (!query.code) {
          throw new FlowStop("failed", "missing_code");
        }
        const registered = registry.get(authorization.connectorId);
        const strategy = registered && oauthStrategy(registered.manifest);
        const provider = oauthProviders.get(providerId);
        if (
          !registered ||
          !strategy ||
          !provider ||
          strategy.provider !== providerId
        ) {
          throw new FlowStop("failed", "provider_unavailable");
        }

        // 4. Exchange the code with the verifier; check the ID token.
        const codeVerifier = decryptOAuthCodeVerifier(
          authorization.codeVerifierEncrypted.toString("utf8"),
          credentialKeyring,
          {
            workspaceId: authorization.workspaceId,
            authorizationId: authorization.id,
          },
        );
        const http = deps.oauthHttp(provider.definition);
        const tokens = await exchangeCode(provider, http, {
          code: query.code,
          codeVerifier,
          now: now(),
        });
        const account = verifyIdToken(tokens.idToken, {
          issuers: provider.definition.openIdConnect.issuers,
          clientId: provider.clientId,
          nonce: authorization.nonce,
          now: now(),
        });

        // 5. Every scope the connector needs must be granted, and a grant
        //    without a refresh token is of no use. Both are refused below,
        //    under the account's grant lock, and revoked when unused.
        const granted = tokens.scopes ?? [
          ...provider.definition.identityScopes,
          ...strategy.scopes,
        ];
        const refusal = strategy.scopes.some(
          (scope) => !granted.includes(scope),
        )
          ? new FlowStop("scope_missing", "scope_missing")
          : !tokens.refreshToken
            ? new FlowStop("failed", "no_refresh_token")
            : null;

        // 6. Store, bound to the workspace (and connection) of the state,
        //    under the grant lock of the account (ADR 0012, "Grant lock").
        //    A reauthorization also locks the account linked now, since an
        //    account change releases that account's grant; the locks are
        //    taken in a fixed order, so two account swaps cannot deadlock.
        const previousSub =
          authorization.purpose === "reauthorize" && authorization.connectionId
            ? await linkedAccount(
                authorization.workspaceId,
                userId,
                authorization.connectionId,
              )
            : null;
        const keys = [account.sub, ...(previousSub ? [previousSub] : [])].map(
          (accountSub) => ({ provider: providerId, accountSub }),
        );
        const result = await withOAuthGrantLocks(db, keys, async (lockedDb) => {
          const refreshToken = tokens.refreshToken;
          if (refusal || !refreshToken) {
            await discardGrant(lockedDb, provider, tokens, account);
            throw refusal ?? new FlowStop("failed", "no_refresh_token");
          }
          // Revocation is account-wide: a disconnect of this account that
          // revoked between the code exchange and this lock also killed
          // this grant. No revocation can start while the lock is held, so
          // one refresh tells whether the grant is still live.
          if (!(await isRefreshTokenLive(provider, http, refreshToken))) {
            throw new FlowStop("failed", "grant_revoked");
          }
          const grant = { tokens, refreshToken, account, granted };
          let stored: Stored;
          try {
            stored = await withWorkspace(
              lockedDb,
              { workspaceId: authorization.workspaceId, userId },
              async (tx) => {
                if (
                  !(await stillAllowed(
                    tx,
                    authorization.workspaceId,
                    userId,
                    authorization.purpose,
                  ))
                ) {
                  throw new FlowStop("forbidden", "role_missing");
                }
                return authorization.purpose === "connect"
                  ? connect(tx, authorization, registered.manifest, grant)
                  : reauthorize(tx, authorization, grant, previousSub);
              },
            );
          } catch (error) {
            if (
              error instanceof FlowStop &&
              error.outcome === "account_mismatch"
            ) {
              await discardGrant(lockedDb, provider, tokens, account);
            }
            throw error;
          }
          // An account change released the previous account's grant on
          // this connection; when no other connection on the instance uses
          // it, it is revoked, still under that account's lock.
          if (stored.releasedRefreshToken) {
            const revoked = await deps.oauthTokens.revokeGrant(
              providerId,
              stored.releasedRefreshToken.reveal(),
            );
            if (!revoked) {
              logger.warn(
                { provider: providerId },
                "oauth revocation of the previous account failed",
              );
            }
          }
          return stored.response;
        });
        logger.info(
          {
            provider: providerId,
            purpose: authorization.purpose,
            outcome: result.outcome,
          },
          "oauth authorization completed",
        );
        return result;
      } catch (error) {
        let outcome: OAuthCallbackOutcome;
        let reason: string;
        if (error instanceof FlowStop) {
          ({ outcome, reason } = error);
        } else if (error instanceof OAuthError) {
          outcome = "failed";
          reason = `${error.step}:${error.code}`;
        } else {
          // Unexpected (database, decryption): log the class only.
          outcome = "failed";
          reason = error instanceof Error ? error.name : "unknown";
        }
        logger.warn(
          {
            provider: providerId,
            purpose: consumed?.purpose ?? null,
            outcome,
            reason,
          },
          "oauth authorization refused",
        );
        // Only the user who started the flow learns where it was headed.
        const returnPath =
          consumed && outcome !== "invalid_state" && outcome !== "forbidden"
            ? consumed.returnPath
            : "/";
        return {
          outcome,
          redirectTo: withOutcome(returnPath, { oauth: outcome }),
        };
      }
    },
  };

  interface Grant {
    tokens: TokenSet;
    refreshToken: Secret;
    account: IdTokenAccount;
    granted: string[];
  }

  interface Stored {
    response: OAuthCallbackResponse;
    /** The previous account's refresh token, to revoke after commit. */
    releasedRefreshToken: Secret | null;
  }

  /** The account a connection is linked to now (null: none, or gone). */
  async function linkedAccount(
    workspaceId: string,
    userId: string,
    connectionId: string,
  ): Promise<string | null> {
    const linked = await withWorkspace(db, { workspaceId, userId }, (tx) =>
      findConnectionOAuth(tx, workspaceId, connectionId),
    );
    return linked?.accountSub ?? null;
  }

  function sealGrant(workspaceId: string, connectionId: string, grant: Grant) {
    const binding = { workspaceId, connectionId };
    return {
      // The token service's envelope format (#133): {"refreshToken": "..."}.
      credentialsEncrypted: sealOAuthCredentials(
        grant.refreshToken.reveal(),
        credentialKeyring,
        binding,
      ),
      accessTokenEncrypted: Buffer.from(
        encryptOAuthAccessToken(
          grant.tokens.accessToken.reveal(),
          credentialKeyring,
          binding,
        ),
        "utf8",
      ),
    };
  }

  /** A new connection in the setup state, holding the grant. */
  async function connect(
    tx: Transaction,
    authorization: ConsumedOAuthAuthorization,
    manifest: ConnectorManifest,
    grant: Grant,
  ): Promise<Stored> {
    const { workspaceId, userId, provider } = authorization;
    const connectionId = randomUUID();
    const sealed = sealGrant(workspaceId, connectionId, grant);
    await insertConnection(tx, {
      id: connectionId,
      workspaceId,
      connectorId: authorization.connectorId,
      name: manifest.name,
      config: {},
      credentialsEncrypted: sealed.credentialsEncrypted,
      projectId: null,
      pollIntervalSeconds: manifest.minRefreshIntervalSeconds,
      setupPending: true,
    });
    await upsertConnectionOAuth(tx, {
      workspaceId,
      connectionId,
      provider,
      accountSub: grant.account.sub,
      accountEmail: grant.account.email,
      grantedScopes: grant.granted,
      accessTokenEncrypted: sealed.accessTokenEncrypted,
      accessTokenExpiresAt: grant.tokens.accessTokenExpiresAt,
    });
    await insertAuditEvent(tx, {
      workspaceId,
      actorUserId: userId,
      action: "connection.created",
      target: connectionId,
      metadata: { name: manifest.name, connectorId: authorization.connectorId },
    });
    await insertAuditEvent(tx, {
      workspaceId,
      actorUserId: userId,
      action: "connection.oauth_connected",
      target: connectionId,
      metadata: { connectorId: authorization.connectorId, provider },
    });
    return {
      response: {
        outcome: "connected",
        redirectTo: withOutcome(authorization.returnPath, {
          oauth: "connected",
          connection: connectionId,
        }),
      },
      releasedRefreshToken: null,
    };
  }

  /**
   * New tokens for the connection bound into the state: same workspace (the
   * transaction's), same connector, same account unless a change was chosen.
   * `lockedSub` is the account whose grant lock the caller holds as the
   * connection's current one.
   */
  async function reauthorize(
    tx: Transaction,
    authorization: ConsumedOAuthAuthorization,
    grant: Grant,
    lockedSub: string | null,
  ): Promise<Stored> {
    const { workspaceId, userId, provider } = authorization;
    const connectionId = authorization.connectionId!;
    const existing = await findConnection(tx, workspaceId, connectionId);
    if (
      !existing ||
      existing.row.connectorId !== authorization.connectorId ||
      existing.oauth?.provider !== provider
    ) {
      throw new FlowStop("failed", "connection_gone");
    }
    const linked = await findConnectionOAuth(tx, workspaceId, connectionId);
    if (!linked || linked.accountSub !== lockedSub) {
      // Changed by a concurrent reauthorization after the lock was chosen.
      throw new FlowStop("failed", "connection_changed");
    }
    const accountChanged = linked.accountSub !== grant.account.sub;
    if (accountChanged && !authorization.allowAccountChange) {
      throw new FlowStop("account_mismatch", "account_mismatch");
    }
    // An account change releases the previous account's grant here, like a
    // disconnect: revoke it (after commit) only if no other connection on
    // the instance uses it.
    let releasedRefreshToken: Secret | null = null;
    let previousGrant: "kept" | "released" | null = null;
    if (accountChanged) {
      const shared = await releaseOAuthGrant(tx, {
        provider,
        accountSub: linked.accountSub,
        connectionId,
      });
      previousGrant = shared ? "kept" : "released";
      if (!shared && existing.row.credentialsEncrypted) {
        try {
          releasedRefreshToken = new Secret(
            openOAuthCredentials(
              existing.row.credentialsEncrypted,
              credentialKeyring,
              { workspaceId, connectionId },
            ),
          );
        } catch {
          // Unreadable: nothing to revoke; the user can remove access at
          // the provider.
          releasedRefreshToken = null;
        }
      }
    }
    const sealed = sealGrant(workspaceId, connectionId, grant);
    await updateConnection(tx, workspaceId, connectionId, {
      credentialsEncrypted: sealed.credentialsEncrypted,
    });
    await upsertConnectionOAuth(tx, {
      workspaceId,
      connectionId,
      provider,
      accountSub: grant.account.sub,
      accountEmail: grant.account.email,
      grantedScopes: grant.granted,
      accessTokenEncrypted: sealed.accessTokenEncrypted,
      accessTokenExpiresAt: grant.tokens.accessTokenExpiresAt,
    });
    // Healthy again; due now, unless setup is still pending.
    await resetConnectionAuth(tx, workspaceId, connectionId, {
      schedule: !existing.row.setupPending,
    });
    await insertAuditEvent(tx, {
      workspaceId,
      actorUserId: userId,
      action: "connection.oauth_reauthorized",
      target: connectionId,
      metadata: { connectorId: authorization.connectorId, provider },
    });
    if (accountChanged) {
      await insertAuditEvent(tx, {
        workspaceId,
        actorUserId: userId,
        action: "connection.oauth_account_changed",
        target: connectionId,
        metadata: {
          connectorId: authorization.connectorId,
          provider,
          previousGrant,
        },
      });
    }
    return {
      response: {
        outcome: "reauthorized",
        redirectTo: withOutcome(authorization.returnPath, {
          oauth: "reauthorized",
        }),
      },
      releasedRefreshToken,
    };
  }
}

export type OAuthFlow = ReturnType<typeof createOAuthFlow>;
