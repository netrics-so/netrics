-- ADR 0011, #56: device refresh-token rotation with reuse detection.
ALTER TABLE "principal_tokens" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "principal_tokens" ADD COLUMN "rotated_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "principal_tokens_parent_idx" ON "principal_tokens" USING btree ("parent_id");
--> statement-breakpoint
-- Exchanges a device refresh token for a new access and refresh token.
--
--   'rotated'  the token was live, or is being retried: it was rotated less
--              than p_retry_window ago and no successor was used yet (the
--              device lost the response). Earlier successors are revoked and
--              a new pair is issued.
--   'reused'   a rotated token came back otherwise: someone else holds a
--              copy. Every token of the device is revoked; the caller marks
--              the device revoked.
--   'invalid'  unknown, expired, not a refresh token, or revoked (device
--              revoked, or token revoked by an administrator).
--
-- The token row is locked, so concurrent exchanges of one token serialize.
CREATE FUNCTION rotate_device_refresh_token(
  p_refresh_hash text,
  p_new_access_hash text,
  p_access_expires_at timestamptz,
  p_new_refresh_hash text,
  p_refresh_expires_at timestamptz,
  p_retry_window interval
)
RETURNS TABLE (status text, device_id uuid, workspace_id uuid, device_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t principal_tokens%ROWTYPE;
BEGIN
  SELECT * INTO t FROM principal_tokens p
  WHERE p.token_hash = p_refresh_hash
  FOR UPDATE;

  IF NOT FOUND
    OR t.kind <> 'device'
    OR NOT ('device:refresh' = ANY (t.scopes))
    OR (t.expires_at IS NOT NULL AND t.expires_at <= now()) THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  IF t.revoked_at IS NOT NULL THEN
    IF t.rotated_at IS NULL THEN
      RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid, NULL::text;
      RETURN;
    END IF;
    -- A rotated token again. A retry only while it was rotated recently, a
    -- successor pair is still live and no successor refresh token was used.
    IF t.rotated_at <= now() - p_retry_window
      OR EXISTS (
        SELECT 1 FROM principal_tokens s
        WHERE s.parent_id = t.id AND s.rotated_at IS NOT NULL
      )
      OR NOT EXISTS (
        SELECT 1 FROM principal_tokens s
        WHERE s.parent_id = t.id AND s.revoked_at IS NULL
      ) THEN
      UPDATE principal_tokens p SET revoked_at = now()
      WHERE p.device_id = t.device_id AND p.revoked_at IS NULL;
      RETURN QUERY SELECT 'reused'::text, t.device_id, t.workspace_id, t.name;
      RETURN;
    END IF;
    UPDATE principal_tokens p SET revoked_at = now()
    WHERE p.parent_id = t.id AND p.revoked_at IS NULL;
  ELSE
    UPDATE principal_tokens p SET revoked_at = now(), rotated_at = now()
    WHERE p.id = t.id;
  END IF;

  INSERT INTO principal_tokens
    (kind, name, token_hash, scopes, workspace_id, device_id, expires_at, parent_id)
  VALUES
    ('device', t.name, p_new_access_hash, ARRAY['device:read'], t.workspace_id, t.device_id, p_access_expires_at, t.id),
    ('device', t.name, p_new_refresh_hash, ARRAY['device:refresh'], t.workspace_id, t.device_id, p_refresh_expires_at, t.id);
  RETURN QUERY SELECT 'rotated'::text, t.device_id, t.workspace_id, t.name;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rotate_device_refresh_token(text, text, timestamptz, text, timestamptz, interval) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rotate_device_refresh_token(text, text, timestamptz, text, timestamptz, interval) TO netrics_app;
