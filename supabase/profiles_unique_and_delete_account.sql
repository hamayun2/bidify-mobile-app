-- =============================================================================
-- Unique phone + CNIC (anti-fraud) and complete account deletion
-- Run in Supabase SQL Editor after core schema / profiles table exists.
-- =============================================================================

-- Normalize empty strings to NULL so partial unique indexes work
UPDATE public.profiles
SET phone_number = NULLIF(trim(coalesce(phone_number, '')), '')
WHERE phone_number IS NOT NULL AND trim(phone_number) = '';

UPDATE public.profiles
SET cnic = NULLIF(trim(coalesce(cnic, '')), '')
WHERE cnic IS NOT NULL AND trim(cnic) = '';

-- id_card mirrors cnic (national ID) for API / validation copy
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS id_card text;

UPDATE public.profiles
SET id_card = NULLIF(trim(coalesce(cnic, '')), '')
WHERE (id_card IS NULL OR trim(id_card) = '')
  AND cnic IS NOT NULL
  AND trim(cnic) <> '';

UPDATE public.profiles
SET cnic = id_card
WHERE (cnic IS NULL OR trim(cnic) = '')
  AND id_card IS NOT NULL
  AND trim(id_card) <> '';

-- Partial unique: allow many NULLs, forbid duplicate non-empty values
DROP INDEX IF EXISTS public.profiles_phone_number_unique_idx;
CREATE UNIQUE INDEX profiles_phone_number_unique_idx
  ON public.profiles (phone_number)
  WHERE phone_number IS NOT NULL AND trim(phone_number) <> '';

DROP INDEX IF EXISTS public.profiles_cnic_unique_idx;
CREATE UNIQUE INDEX profiles_cnic_unique_idx
  ON public.profiles (cnic)
  WHERE cnic IS NOT NULL AND trim(cnic) <> '';

DROP INDEX IF EXISTS public.profiles_id_card_unique_idx;
CREATE UNIQUE INDEX profiles_id_card_unique_idx
  ON public.profiles (id_card)
  WHERE id_card IS NOT NULL AND trim(id_card) <> '';

COMMENT ON INDEX public.profiles_phone_number_unique_idx IS
  'One account per phone number (non-empty).';
COMMENT ON INDEX public.profiles_cnic_unique_idx IS
  'One account per CNIC / national ID (non-empty).';
COMMENT ON INDEX public.profiles_id_card_unique_idx IS
  'One account per ID card (non-empty); kept in sync with cnic.';

-- ---------------------------------------------------------------------------
-- Allow user removal to cascade disputed/completed orders (was RESTRICT)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auction_orders_buyer_id_fkey'
      AND confdeltype = 'r'
  ) THEN
    ALTER TABLE public.auction_orders DROP CONSTRAINT auction_orders_buyer_id_fkey;
    ALTER TABLE public.auction_orders
      ADD CONSTRAINT auction_orders_buyer_id_fkey
      FOREIGN KEY (buyer_id) REFERENCES auth.users (id) ON DELETE CASCADE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auction_orders_seller_id_fkey'
      AND confdeltype = 'r'
  ) THEN
    ALTER TABLE public.auction_orders DROP CONSTRAINT auction_orders_seller_id_fkey;
    ALTER TABLE public.auction_orders
      ADD CONSTRAINT auction_orders_seller_id_fkey
      FOREIGN KEY (seller_id) REFERENCES auth.users (id) ON DELETE CASCADE;
  END IF;
EXCEPTION
  WHEN undefined_table THEN
    NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Ensure child tables cascade when auth.users row is removed
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass AS tbl, a.attname AS col
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    JOIN pg_class ref ON ref.oid = c.confrelid
    WHERE c.contype = 'f'
      AND ref.relnamespace = 'auth'::regnamespace
      AND ref.relname = 'users'
      AND c.confdeltype <> 'c'
      AND c.conrelid::regclass::text LIKE 'public.%'
  LOOP
    EXECUTE format(
      'ALTER TABLE %s DROP CONSTRAINT %I',
      r.tbl,
      r.conname
    );
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES auth.users (id) ON DELETE CASCADE',
      r.tbl,
      r.conname,
      r.col
    );
  END LOOP;
EXCEPTION
  WHEN undefined_table THEN
    NULL;
END $$;

-- ---------------------------------------------------------------------------
-- delete_my_account — wipe user data + auth row (caller = self or service_role)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_my_account(p_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid uuid;
  v_orders bigint := 0;
  v_bids bigint := 0;
  v_listings bigint := 0;
  v_support_msgs bigint := 0;
  v_support_tickets bigint := 0;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  v_uid := coalesce(p_user_id, auth.uid());
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF auth.uid() IS NOT NULL AND v_uid IS DISTINCT FROM auth.uid() THEN
    IF NOT coalesce(public.current_user_is_admin(), false) THEN
      RAISE EXCEPTION 'Not allowed to delete another account';
    END IF;
  END IF;

  IF auth.uid() IS NULL AND p_user_id IS NULL THEN
    RAISE EXCEPTION 'User id required for service deletion';
  END IF;

  IF to_regclass('public.support_ticket_attachments') IS NOT NULL THEN
    EXECUTE $sql$
      DELETE FROM public.support_ticket_attachments a
      WHERE a.uploaded_by = $1
         OR EXISTS (
           SELECT 1 FROM public.support_ticket_messages m
           WHERE m.id = a.message_id AND m.sender_id = $1
         )
    $sql$ USING v_uid;
  END IF;

  IF to_regclass('public.support_ticket_messages') IS NOT NULL THEN
    DELETE FROM public.support_ticket_messages m WHERE m.sender_id = v_uid;
    GET DIAGNOSTICS v_support_msgs = ROW_COUNT;
  END IF;

  IF to_regclass('public.support_tickets') IS NOT NULL THEN
    DELETE FROM public.support_tickets t
    WHERE t.opened_by_user_id = v_uid OR t.assigned_admin_id = v_uid;
    GET DIAGNOSTICS v_support_tickets = ROW_COUNT;
  END IF;

  DELETE FROM public.auction_orders o
  WHERE o.buyer_id = v_uid OR o.seller_id = v_uid;
  GET DIAGNOSTICS v_orders = ROW_COUNT;

  DELETE FROM public.bids b WHERE b.bidder_id = v_uid;
  GET DIAGNOSTICS v_bids = ROW_COUNT;

  DELETE FROM public.listings l WHERE l.seller_id = v_uid;
  GET DIAGNOSTICS v_listings = ROW_COUNT;

  IF to_regclass('public.wallet_ledger') IS NOT NULL THEN
    DELETE FROM public.wallet_ledger w WHERE w.user_id = v_uid;
  END IF;

  IF to_regclass('public.wallet_transactions') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.wallet_transactions WHERE user_id = $1' USING v_uid;
  END IF;

  IF to_regclass('public.wallet_topups') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.wallet_topups WHERE user_id = $1' USING v_uid;
  END IF;

  DELETE FROM public.profiles WHERE id = v_uid;

  DELETE FROM auth.users WHERE id = v_uid;

  RETURN jsonb_build_object(
    'ok', true,
    'user_id', v_uid,
    'deleted_orders', v_orders,
    'deleted_bids', v_bids,
    'deleted_listings', v_listings,
    'deleted_support_messages', v_support_msgs,
    'deleted_support_tickets', v_support_tickets
  );
END;
$$;

REVOKE ALL ON FUNCTION public.delete_my_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_my_account(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_my_account(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
