"use client";
import Link from "next/link";
import { useEffect, useId, useState, type RefObject } from "react";
import type {
  StoreProductPricing,
  StoreTemplateProducts,
} from "@netrics/contracts";
import {
  ApiError,
  apiErrorMessage,
  fetchResourceIcon,
  getStoreTemplateProducts,
  retryStoreTemplateIcons,
  saveStoreTemplateProducts,
} from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n/client";
import { useLeaveGuard } from "@/components/studio-editor/use-leave-guard";

type Product = StoreTemplateProducts["products"][number];
type Choice = { pricing: StoreProductPricing; website: string };
const websiteValue = (website: Product["website"]) =>
  website ? `${website.connectionId}|${website.projectId}` : "";

/**
 * Unsaved app identity, for the scope form beside it: applying a scope
 * change navigates with the router, which no leave guard sees, so the form
 * asks in the page and saves or discards these first.
 */
export interface IdentityGuard {
  dirty: boolean;
  /** Saves the unsaved choices; false when saving failed (error shown). */
  save: () => Promise<boolean>;
  discard: () => void;
}

/**
 * The identity of an install's apps (#708): icon, paid or free and the
 * linked website, saved on their own (not through the scope review).
 */
export function StoreProductIdentity({
  workspaceId,
  requestId,
  initial,
  guard,
  locked = false,
}: {
  workspaceId: string;
  requestId: string;
  initial: StoreTemplateProducts;
  /** Kept current with the unsaved state (see IdentityGuard). */
  guard?: RefObject<IdentityGuard | null>;
  /** Read-only while the scope change beside it applies and navigates. */
  locked?: boolean;
}) {
  const t = useT("storeTemplate"),
    locale = useLocale(),
    id = useId();
  const [data, setData] = useState(initial),
    // A Map: product ids are free text (the editable Products table), and
    // ids like "constructor" or "__proto__" would hit a plain object's
    // inherited properties.
    [choices, setChoices] = useState<ReadonlyMap<string, Choice>>(
      () => new Map(),
    ),
    [pending, setPending] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const changed = [...choices.keys()],
    busy = !!pending || locked;
  useLeaveGuard(changed.length > 0, t("unsaved"));
  const choiceOf = (product: Product): Choice =>
    choices.get(product.productId) ?? {
      pricing: product.pricing,
      website: websiteValue(product.website),
    };
  function choose(product: Product, choice: Partial<Choice>) {
    setError(null);
    setNotice(null);
    setChoices((current) => {
      const next = { ...choiceOf(product), ...choice },
        rest = new Map(current);
      if (
        next.pricing === product.pricing &&
        next.website === websiteValue(product.website)
      )
        rest.delete(product.productId);
      else rest.set(product.productId, next);
      return rest;
    });
  }
  async function save(): Promise<boolean> {
    setPending("save");
    setError(null);
    setNotice(null);
    try {
      setData(
        await saveStoreTemplateProducts(workspaceId, requestId, {
          products: changed.map((productId) => {
            const choice = choices.get(productId)!,
              cut = choice.website.indexOf("|");
            return {
              productId,
              pricing: choice.pricing,
              website: choice.website
                ? {
                    connectionId: choice.website.slice(0, cut),
                    projectId: choice.website.slice(cut + 1),
                  }
                : null,
            };
          }),
        }),
      );
      setChoices(new Map());
      setNotice(t("identitySaved"));
      return true;
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
      return false;
    } finally {
      setPending(null);
    }
  }
  useEffect(() => {
    if (!guard) return;
    guard.current = {
      dirty: changed.length > 0,
      save,
      discard: () => setChoices(new Map()),
    };
  });
  async function loadIcon(product: Product) {
    if (!product.iconSource) return;
    setPending("icon:" + product.productId);
    setError(null);
    setNotice(null);
    try {
      await fetchResourceIcon(
        workspaceId,
        product.iconSource.connectionId,
        product.iconSource.resourceId,
      );
      setData(await getStoreTemplateProducts(workspaceId, requestId));
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(null);
    }
  }
  async function retryIcons() {
    setPending("icons");
    setError(null);
    setNotice(null);
    try {
      setData(await retryStoreTemplateIcons(workspaceId, requestId));
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(null);
    }
  }
  // Apps without an icon although one can be fetched: the fetch at
  // install or update failed (#740).
  const iconsMissing = data.products.filter(
    (product) => !product.icon && product.iconSource,
  ).length;
  return (
    <section className="card stack store-product-identity">
      <h2>{t("identity")}</h2>
      <p className="muted">{t("identityHelp")}</p>
      {iconsMissing ? (
        <div className="actions">
          <p className="help">{t("iconsMissing", { count: iconsMissing })}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void retryIcons()}
          >
            {pending === "icons" ? t("iconsRetrying") : t("iconsRetry")}
          </button>
        </div>
      ) : null}
      {!data.products.length ? (
        <p className="muted">{t("identityEmpty")}</p>
      ) : null}
      {data.products.map((product, index) => {
        const choice = choiceOf(product);
        const projectKnown =
          !choice.website ||
          data.websites.some((website) =>
            website.projects.some(
              (project) =>
                `${website.connectionId}|${project.id}` === choice.website,
            ),
          );
        return (
          <div
            className="store-template-group stack"
            key={product.productId}
            data-product={product.productId}
          >
            <div className="store-product-head">
              {product.icon ? (
                <img
                  src={product.icon.url}
                  alt=""
                  width={48}
                  height={48}
                  className="store-product-icon"
                />
              ) : (
                <span
                  className="store-product-icon store-product-icon-empty"
                  aria-hidden
                />
              )}
              <span>
                <strong>{product.name}</strong>
                <small className="help">
                  {product.apps
                    .map(
                      (app) =>
                        `${app.name} · ${
                          app.connectorId === "google-play"
                            ? t("googlePlay")
                            : t("appStoreConnect")
                        }`,
                    )
                    .join(" · ")}
                </small>
              </span>
            </div>
            {!product.icon && product.iconSource ? (
              <div className="actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void loadIcon(product)}
                >
                  {pending === "icon:" + product.productId
                    ? t("iconLoading")
                    : t("useIcon")}
                </button>
              </div>
            ) : null}
            {product.notEditable ? (
              <p className="help">
                {apiErrorMessage(
                  new ApiError(400, product.notEditable),
                  locale,
                )}
              </p>
            ) : null}
            <div className="field">
              <label htmlFor={`${id}-pricing-${index}`}>{t("pricing")}</label>
              <select
                id={`${id}-pricing-${index}`}
                value={choice.pricing}
                disabled={busy || !!product.notEditable}
                onChange={(event) =>
                  choose(product, {
                    pricing: event.target.value as StoreProductPricing,
                  })
                }
              >
                <option value="auto">
                  {product.hadProceeds
                    ? t("pricingAutoPaid")
                    : t("pricingAutoFree")}
                </option>
                <option value="paid">{t("pricingPaid")}</option>
                <option value="free">{t("pricingFree")}</option>
              </select>
              <p className="help">{t("pricingHelp")}</p>
            </div>
            <div className="field">
              <label htmlFor={`${id}-website-${index}`}>{t("website")}</label>
              <select
                id={`${id}-website-${index}`}
                value={choice.website}
                disabled={
                  busy ||
                  !!product.notEditable ||
                  (!data.websites.length && !choice.website)
                }
                onChange={(event) =>
                  choose(product, { website: event.target.value })
                }
              >
                <option value="">{t("websiteNone")}</option>
                {!projectKnown ? (
                  <option value={choice.website}>{t("websiteMissing")}</option>
                ) : null}
                {data.websites.map((website) => (
                  <optgroup key={website.connectionId} label={website.name}>
                    {website.projects.map((project) => (
                      <option
                        key={project.id}
                        value={`${website.connectionId}|${project.id}`}
                      >
                        {project.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>
        );
      })}
      {!data.websites.length ? (
        <p className="help">
          {t("websiteConnect")}{" "}
          <Link href={`/workspaces/${workspaceId}/sources`}>
            {t("connect")}
          </Link>
        </p>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy || !changed.length}
          onClick={() => void save()}
        >
          {pending === "save" ? t("identitySaving") : t("identitySave")}
        </button>
      </div>
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The identity section when the products cannot be read (e.g. more apps or
 * website projects than the workspace's row limit): an inline explanation,
 * so the scope editor beside it stays usable (removing the connection that
 * causes it, for one).
 */
export function StoreProductIdentityUnavailable({
  error,
}: {
  error: { status: number; code: string };
}) {
  const t = useT("storeTemplate"),
    locale = useLocale();
  return (
    <section className="card stack store-product-identity">
      <h2>{t("identity")}</h2>
      <p className="error" role="alert">
        {error.code === "data_source_row_limit"
          ? t("identityTooLarge")
          : apiErrorMessage(new ApiError(error.status, error.code), locale)}
      </p>
    </section>
  );
}
