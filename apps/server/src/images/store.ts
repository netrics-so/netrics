import {
  deleteImage,
  findImage,
  imageUsage,
  insertImageWithinQuota,
  listImages,
  readImageContent,
  type ImageInput,
  type ImageQuota,
  type ImageRow,
  type ImageUsage,
  type InsertImageResult,
  type Transaction,
} from "@netrics/database";

/**
 * Where image bytes live (ADR 0015, section 5). The metadata is always a
 * workspace_images row; the PostgreSQL store keeps the bytes in the same
 * row. A later object-storage store implements the same interface, so the
 * API does not change. Every call runs inside the caller's workspace
 * transaction (RLS) and names the workspace explicitly.
 */
export interface ImageStore {
  list(tx: Transaction, workspaceId: string): Promise<ImageRow[]>;
  find(
    tx: Transaction,
    workspaceId: string,
    imageId: string,
  ): Promise<ImageRow | null>;
  read(
    tx: Transaction,
    workspaceId: string,
    imageId: string,
  ): Promise<Buffer | null>;
  usage(tx: Transaction, workspaceId: string): Promise<ImageUsage>;
  /** Stores the image unless the workspace would exceed its quota. */
  insert(
    tx: Transaction,
    workspaceId: string,
    input: ImageInput,
    quota: ImageQuota,
  ): Promise<InsertImageResult>;
  remove(
    tx: Transaction,
    workspaceId: string,
    imageId: string,
  ): Promise<boolean>;
}

export const postgresImageStore: ImageStore = {
  list: listImages,
  find: findImage,
  read: readImageContent,
  usage: imageUsage,
  insert: insertImageWithinQuota,
  remove: deleteImage,
};
