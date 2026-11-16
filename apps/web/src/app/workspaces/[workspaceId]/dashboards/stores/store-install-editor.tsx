"use client";
import { useRef, useState } from "react";
import type {
  StoreTemplateOptions,
  StoreTemplateProducts,
  StoreTemplateScope,
} from "@netrics/contracts";
import {
  StoreProductIdentity,
  StoreProductIdentityUnavailable,
  type IdentityGuard,
} from "./store-product-identity";
import { StoreTemplateForm } from "./store-template-form";

/**
 * Edit mode of an install: its app scope and its app identity, which share
 * one unsaved-changes guard (applying the scope saves or discards unsaved
 * identity choices first, #708).
 */
export function StoreInstallEditor({
  workspaceId,
  install,
  options,
  products,
}: {
  workspaceId: string;
  install: { requestId: string; name: string; scope: StoreTemplateScope };
  options: StoreTemplateOptions;
  /**
   * The app identity, or why it could not be read: the scope editor works
   * either way.
   */
  products:
    | { value: StoreTemplateProducts }
    | { error: { status: number; code: string } };
}) {
  const guard = useRef<IdentityGuard | null>(null),
    [applying, setApplying] = useState(false);
  return (
    <>
      <StoreTemplateForm
        workspaceId={workspaceId}
        install={install}
        initialOptions={options}
        identityGuard={guard}
        onApplying={setApplying}
      />
      <div className="store-template-form">
        {"value" in products ? (
          <StoreProductIdentity
            workspaceId={workspaceId}
            requestId={install.requestId}
            initial={products.value}
            guard={guard}
            locked={applying}
          />
        ) : (
          <StoreProductIdentityUnavailable error={products.error} />
        )}
      </div>
    </>
  );
}
