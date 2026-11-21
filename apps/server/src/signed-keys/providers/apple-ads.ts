import {
  APPLE_ADS_HOST,
  APPLE_ADS_RATE_LIMITED_MESSAGE,
  checkAppleAdsAccess,
  createAppleAdsClient,
  isAppleAdsRateLimited,
} from "@netrics/connectors";
import { sharedEn } from "@netrics/domain";
import { z } from "zod";

import type {
  SignedKeyField,
  SignedKeyProbe,
  SignedKeyProviderDefinition,
} from "./types.js";

// Apple Ads (ADR 0020, #373): the API user's key pair signs an ES256
// client secret (header `kid` key ID; claims `iss` team ID, `sub` client
// ID, `aud https://appleid.apple.com`), which the host exchanges for a
// one-hour access token with an OAuth 2 client-credentials grant, scope
// `searchadsorg`. Connectors receive only the access token.
//
// Apple's documentation, checked 2026-10-29:
// https://developer.apple.com/documentation/apple-ads-platform-api/implementing-oauth-for-the-apple-ads-platform-api
// https://developer.apple.com/documentation/apple-ads-platform-api/access-overview

/** Apple's authorization server (the host's token exchange only). */
export const APPLE_ID_HOST = "appleid.apple.com";
export const APPLE_ADS_TOKEN_ENDPOINT = `https://${APPLE_ID_HOST}/auth/oauth2/token`;
export const APPLE_ADS_AUDIENCE = `https://${APPLE_ID_HOST}`;
export const APPLE_ADS_SCOPE = "searchadsorg";

/**
 * Where the user signs in (Account Settings → API and User Management are
 * in its menu). TO BE CONFIRMED at the exit gate (#378): deep links into
 * the Apple Ads UI, which Apple does not document.
 */
export const APPLE_ADS_SIGN_IN_URL = "https://ads.apple.com/";
/** Apple's help on inviting users, with the API roles. */
export const APPLE_ADS_INVITE_HELP_URL =
  "https://ads.apple.com/help/advanced/0011-invite-users-to-your-account/";
/** Apple's guide to the key pair and the credentials block. */
export const APPLE_ADS_OAUTH_GUIDE_URL =
  "https://developer.apple.com/documentation/apple-ads-platform-api/implementing-oauth-for-the-apple-ads-platform-api";

/**
 * `SEARCHADS.` and an ID. Apple's own examples are not all strict UUIDs
 * (`SEARCHADS.aeb3ef5f-0c5a-4f2a-99c8-fca83f25a9`), so the format check is
 * lenient. TO BE CONFIRMED by #370: the exact client ID and team ID shape.
 */
const SEARCHADS_ID = /^SEARCHADS\.[0-9a-z]+(?:-[0-9a-z]+){2,}$/i;
/** A UUID-like key ID (`a273d0d3-4d9e-458c-a173-0db8619ca7d7`). */
const KEY_ID = /^[0-9a-z]+(?:-[0-9a-z]+){2,}$/i;

/**
 * The refusals' English texts come from the shared catalog (#378). Each is
 * recorded with its reason code (#795), by which the web shows a refusal
 * in the viewer's language.
 */
const REFUSALS = sharedEn.providerMessages.appleAds;

export const INVALID_CLIENT_MESSAGE: string = REFUSALS.invalidClient;

function searchAdsIdField(
  key: "clientId" | "teamId",
  label: string,
): SignedKeyField {
  return {
    key,
    label,
    description: `The ${key} shown under Account Settings → API in Apple Ads after you saved the public key.`,
    input: "text",
    secret: false,
    placeholder: "SEARCHADS.27478e71-3bb0-4588-998c-182e2b405577",
    maxBytes: 80,
    validate: (value) =>
      value.length <= 80 && SEARCHADS_ID.test(value)
        ? null
        : `${label} starts with SEARCHADS. followed by an ID, such as SEARCHADS.27478e71-3bb0-4588-998c-182e2b405577. Copy it from Account Settings → API in Apple Ads.`,
  };
}

/**
 * The access check after the exchange (#373): `GET /v1/acls` (no
 * context), then the ad account's details in its own context. With a
 * configured ad account it must be readable and an App Store account;
 * without one (the wizard's preview) at least one must be.
 */
export const appleAdsProbes: readonly SignedKeyProbe[] = [
  {
    name: "acls",
    async run(context) {
      // No signal: probes never wait for a Retry-After.
      const client = createAppleAdsClient(context.fetch, context.accessToken());
      try {
        return await checkAppleAdsAccess(client, context.config);
      } catch (error) {
        if (isAppleAdsRateLimited(error)) {
          return { ok: false, message: APPLE_ADS_RATE_LIMITED_MESSAGE };
        }
        throw error;
      }
    },
  },
];

export const appleAdsProvider: SignedKeyProviderDefinition = {
  id: "apple-ads",
  name: "Apple Ads",
  fields: [
    searchAdsIdField("clientId", "Client ID"),
    searchAdsIdField("teamId", "Team ID"),
    {
      key: "keyId",
      label: "Key ID",
      description:
        "The keyId shown under Account Settings → API in Apple Ads after you saved the public key.",
      input: "text",
      secret: false,
      placeholder: "a273d0d3-4d9e-458c-a173-0db8619ca7d7",
      maxBytes: 64,
      validate: (value) =>
        value.length <= 64 && KEY_ID.test(value)
          ? null
          : "Key ID is an ID such as a273d0d3-4d9e-458c-a173-0db8619ca7d7. Copy it from Account Settings → API in Apple Ads.",
    },
    {
      key: "privateKey",
      label: "Private key",
      description:
        "The EC P-256 private key whose public key you saved under Account Settings → API (PEM).",
      input: "file",
      secret: true,
      maxBytes: 4096,
      privateKey: true,
    },
  ],
  token: (values) => ({
    kid: values.keyId!,
    claims: {
      iss: values.teamId!,
      sub: values.clientId!,
      aud: APPLE_ADS_AUDIENCE,
    },
  }),
  // The client secret is signed per exchange and never stored (ADR 0020
  // section 2); Apple allows up to 180 days.
  lifetime: { issuedBeforeSeconds: 60, expiresInSeconds: 10 * 60 },
  exchange: {
    tokenEndpoint: APPLE_ADS_TOKEN_ENDPOINT,
    form: (values) => ({
      grant_type: "client_credentials",
      client_id: values.clientId!,
      scope: APPLE_ADS_SCOPE,
    }),
    response: z.object({
      access_token: z.string().min(1),
      expires_in: z.number().int().positive(),
    }),
    invalidClient: INVALID_CLIENT_MESSAGE,
    invalidClientCode: "apple_ads.invalid_client",
  },
  serverDomains: [APPLE_ID_HOST, APPLE_ADS_HOST],
  // Apple asks the API user for a public key: netrics generates the pair
  // (ADR 0020 §3, #371); pasting an existing private key stays possible.
  generatedKeyPair: true,
  setup: {
    steps: [
      "An Account Admin invites an API user under Account Settings → User Management in Apple Ads, with the role API Account Read Only (or the limited-access role API Read Only for some campaign groups). An Admin login cannot be the API user: Apple Ads offers the public key only to users with an API role. The API user accepts the invitation and signs in to Apple Ads.",
      "As the API user, open Account Settings → API, choose Generate API Client, paste the public key and save.",
      "Copy the clientId, teamId and keyId Apple Ads shows for the key. The teamId can be the same as the clientId.",
      "Enter the values below. netrics checks the key with Apple before it stores anything.",
    ],
    url: APPLE_ADS_SIGN_IN_URL,
    links: [
      {
        step: 0,
        label: "How to invite an API user",
        url: APPLE_ADS_INVITE_HELP_URL,
      },
      {
        step: 1,
        label: "Open Apple Ads",
        url: APPLE_ADS_SIGN_IN_URL,
      },
    ],
  },
  probes: appleAdsProbes,
  authFailure: {
    unauthorized: REFUSALS.unauthorized,
    forbidden: REFUSALS.forbidden,
    codes: {
      unauthorized: "apple_ads.unauthorized",
      forbidden: "apple_ads.forbidden",
    },
  },
};
