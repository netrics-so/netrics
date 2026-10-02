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
  lockOAuthGrant,
  oauthAccountHasGrant,
  resetConnectionAuth,
  updateConnection,
  upsertConnectionOAuth,
  withUserContext,
  withWorkspace,
  type ConsumedOAuthAuthorization,
  type Database,
  type Transaction,
} from "@netrics/database";
import { can, type WorkspaceAction } from "@netrics/domain";

import {
  decryptOAuthCodeVerifier,
  encryptCredentials,
  encryptOAuthAccessToken,
  encryptOAuthCodeVerifier,
  type CredentialKeyring,
} from "../credentials.js";
import type { Secret } from "../secret.js";
import {
  buildAuthorizationUrl,
  exchangeCode,
  hashState,
  OAuthError,
  randomToken,
  revokeToken,
  verifyIdToken,
  type IdTokenAccount,
  type OAuthHttpFactory,
  type TokenSet,
} from "./client.js";
import type { ConfiguredOAuthProvider, OAuthProviders } from "./config.js";
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
   * and client, so that would stop those connections too.
   */
  async function discardGrant(
    provider: ConfiguredOAuthProvider,
    tokens: TokenSet,
    account: IdTokenAccount,
  ): Promise<void> {
    if (await oauthAccountHasGrant(db, provider.definition.id, account.sub)) {
      return;
    }
    const token: Secret = tokens.refreshToken ?? tokens.accessToken;
    const revoked = await revokeToken(
      provider,
      deps.oauthHttp(provider.definition),
      token,
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

        // 5. Every scope the connector needs must be granted.
        const granted = tokens.scopes ?? [
          ...provider.definition.identityScopes,
          ...strategy.scopes,
        ];
        if (strategy.scopes.some((scope) => !granted.includes(scope))) {
          await discardGrant(provider, tokens, account);
          throw new FlowStop("scope_missing", "scope_missing");
        }
        if (!tokens.refreshToken) {
          await discardGrant(provider, tokens, account);
          throw new FlowStop("failed", "no_refresh_token");
        }
        const refreshToken = tokens.refreshToken;

        // 6. Store, bound to the workspace (and connection) of the state.
        const result = await withWorkspace(
          db,
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
            // Serialize with disconnects of the same account (#133).
            await lockOAuthGrant(tx, providerId, account.sub);
            return authorization.purpose === "connect"
              ? connect(tx, authorization, registered.manifest, {
                  tokens,
                  refreshToken,
                  account,
                  granted,
                })
              : reauthorize(tx, authorization, {
                  tokens,
                  refreshToken,
                  account,
                  granted,
                });
          },
        ).catch(async (error: unknown) => {
          if (
            error instanceof FlowStop &&
            error.outcome === "account_mismatch"
          ) {
            await discardGrant(provider, tokens, account);
          }
          throw error;
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

  function sealGrant(workspaceId: string, connectionId: string, grant: Grant) {
    const binding = { workspaceId, connectionId };
    return {
      // The credentials envelope of an OAuth connection holds the refresh
      // token as {"refreshToken": "..."}; the token service (#133) reads it.
      credentialsEncrypted: Buffer.from(
        encryptCredentials(
          JSON.stringify({ refreshToken: grant.refreshToken.reveal() }),
          credentialKeyring,
          binding,
        ),
        "utf8",
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
  ): Promise<OAuthCallbackResponse> {
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
      outcome: "connected",
      redirectTo: withOutcome(authorization.returnPath, {
        oauth: "connected",
        connection: connectionId,
      }),
    };
  }

  /**
   * New tokens for the connection bound into the state: same workspace (the
   * transaction's), same connector, same account unless a change was chosen.
   */
  async function reauthorize(
    tx: Transaction,
    authorization: ConsumedOAuthAuthorization,
    grant: Grant,
  ): Promise<OAuthCallbackResponse> {
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
    const accountChanged = linked?.accountSub !== grant.account.sub;
    if (accountChanged && !authorization.allowAccountChange) {
      throw new FlowStop("account_mismatch", "account_mismatch");
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
        metadata: { connectorId: authorization.connectorId, provider },
      });
    }
    return {
      outcome: "reauthorized",
      redirectTo: withOutcome(authorization.returnPath, {
        oauth: "reauthorized",
      }),
    };
  }
}

export type OAuthFlow = ReturnType<typeof createOAuthFlow>;
