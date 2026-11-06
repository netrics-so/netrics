import type { AppStoreReviewsStatusResponse } from "@netrics/contracts";
import {
  AppStoreConnectApiError,
  AppStoreConnectRateBudgetError,
  createAppStoreConnectClient,
  probeCustomerReviews,
  reviewsProbeApp,
} from "@netrics/connectors";

import {
  APP_STORE_CONNECT_KEYS_URL,
  RATE_LIMITED_MESSAGE,
} from "./providers/app-store-connect.js";
import type { SignedKey, SignedKeyHttp } from "./registry.js";

// The optional reviews key of an App Store Connect connection (ADR 0014
// decision 2, #190): whether it is stored, and whether Apple still accepts
// it. The status is asked live with a freshly signed token of the reviews
// key (nothing is stored about it); the connection's own state is never
// touched by it.

/** The envelope member of the reviews key. */
export const REVIEWS_KEY_ID = "reviews";

export const REVIEWS_PAUSED_PREFIX =
  "App Store reviews paused — upload a new reviews key.";

const UNREACHABLE_MESSAGE =
  "App Store Connect could not be reached to check the reviews key. Try again in a few minutes.";

export async function appStoreReviewsStatus(input: {
  /** The connection's stored key, with its additional keys. */
  key: SignedKey;
  http: SignedKeyHttp;
  config: Readonly<Record<string, unknown>>;
}): Promise<AppStoreReviewsStatusResponse> {
  const reviewsKey = input.key.additional(REVIEWS_KEY_ID);
  if (!reviewsKey) {
    return {
      status: "not_configured",
      keyId: null,
      message: null,
      keysUrl: APP_STORE_CONNECT_KEYS_URL,
    };
  }
  const keyId = reviewsKey.publicFields.keyId ?? null;
  const client = createAppStoreConnectClient(
    input.http,
    reviewsKey.mintToken(),
  );
  const answer = (
    status: AppStoreReviewsStatusResponse["status"],
    message: string | null,
  ): AppStoreReviewsStatusResponse => ({
    status,
    keyId,
    message,
    keysUrl: APP_STORE_CONNECT_KEYS_URL,
  });
  try {
    const appId = await reviewsProbeApp(client, input.config);
    if (appId === undefined) {
      return answer("active", null);
    }
    const result =
      typeof appId === "string"
        ? await probeCustomerReviews(client, appId)
        : appId;
    return result.ok
      ? answer("active", null)
      : answer("paused", `${REVIEWS_PAUSED_PREFIX} ${result.message}`);
  } catch (error) {
    const rateLimited =
      error instanceof AppStoreConnectRateBudgetError ||
      (error instanceof AppStoreConnectApiError && error.status === 429);
    return answer(
      "unknown",
      rateLimited ? RATE_LIMITED_MESSAGE : UNREACHABLE_MESSAGE,
    );
  }
}
