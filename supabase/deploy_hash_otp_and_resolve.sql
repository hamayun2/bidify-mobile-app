-- =============================================================================
-- REDEPLOY: Fix digest(42883) + verify resolve_auction for one listing
-- Run entire file in Supabase SQL Editor (single paste).
-- =============================================================================

-- ── 1) Extension (Supabase: pgcrypto in extensions schema) ───────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;

-- ── 2) OTP hash (extensions.digest only — no public.digest) ────────────────
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

-- ── 3) Pre-flight: digest + helper must work ───────────────────────────────
SELECT encode(
  extensions.digest('ping'::text, 'sha256'::text),
  'hex'::text
) AS extensions_digest_ok;

SELECT public._hash_delivery_otp('123456') AS fn_hash,
       length(public._hash_delivery_otp('123456')) = 64 AS hash_len_64;

-- ── 4) Force-resolve test listing (change UUID if needed) ──────────────────
-- Prerequisite: full escrow_phase_2_resolve_auction.sql deployed at least once.

SELECT public.resolve_auction('ef77c12d-45b5-47ec-b172-be924620e8eb'::uuid, true);

SELECT
  o.id AS order_id,
  o.listing_id,
  o.buyer_id,
  o.seller_id,
  o.winning_bid_id,
  o.status,
  o.escrow_amount,
  o.delivery_otp_hash IS NOT NULL AS has_otp_hash,
  o.created_at
FROM public.auction_orders o
WHERE o.listing_id = 'ef77c12d-45b5-47ec-b172-be924620e8eb'::uuid;

SELECT id, auction_resolved_at, winner_bidder_id, winning_bid_id, status
FROM public.listings
WHERE id = 'ef77c12d-45b5-47ec-b172-be924620e8eb'::uuid;

NOTIFY pgrst, 'reload schema';
