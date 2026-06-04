-- =============================================================================
-- pgcrypto + _hash_delivery_otp (Supabase: digest lives in extensions schema)
-- Run once in SQL Editor before resolve_auction / escrow phase 2.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._hash_delivery_otp(p_otp text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions
AS $$
  SELECT encode(
    extensions.digest(trim(coalesce(p_otp, ''))::text, 'sha256'::text),
    'hex'::text
  );
$$;

REVOKE ALL ON FUNCTION public._hash_delivery_otp(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._hash_delivery_otp(text) TO authenticated, service_role;

-- Verify (must return one row, hash_len_64 = true)
SELECT encode(
  extensions.digest('ping'::text, 'sha256'::text),
  'hex'::text
) AS extensions_digest_ok;

SELECT public._hash_delivery_otp('123456') AS fn_hash,
       length(public._hash_delivery_otp('123456')) = 64 AS hash_len_64;

NOTIFY pgrst, 'reload schema';
