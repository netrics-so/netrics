"use client";
import { useRef, useState } from "react";
import type {
  StoreTemplateOptions,
  StoreTemplateProducts,
  StoreTemplateScope,
} from "@netrics/contracts";
import {
  StoreProductIdentity,
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
  products: StoreTemplateProducts;
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
        <StoreProductIdentity
          workspaceId={workspaceId}
          requestId={install.requestId}
          initial={products}
          guard={guard}
          locked={applying}
        />
      </div>
    </>
  );
}
