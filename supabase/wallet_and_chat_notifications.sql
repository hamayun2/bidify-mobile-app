-- =============================================================================
-- Wallet/bid → notifications (bell + toast). Chat → messages only (tab badge).
-- Does NOT change wallet_ledger append RPCs, escrow, or balance math.
-- Run once in Supabase SQL Editor.
-- =============================================================================
-- Schema reference (verified against repo):
--   wallet_ledger: user_id, entry_type (bid_lock | bid_refund | …), amount, listing_id, metadata
--   transactions:  user_id, kind (bid_hold | bid_refund | …), amount, note
--   messages:      conversation_id, sender_id, is_read
--   notifications: user_id, title, body, is_read, metadata (jsonb)
-- =============================================================================

-- ── 1) Stop inserting chat rows into notifications (badge uses messages.is_read) ──
CREATE OR REPLACE FUNCTION public.notify_new_chat_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Chat unread is surfaced on the Chats tab only, not the global bell.
  RETURN NEW;
END;
$$;

-- ── 2) wallet_ledger → bid / wallet notifications (primary bid path in app) ───
CREATE OR REPLACE FUNCTION public.notify_wallet_ledger_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_title text;
  v_body text;
  v_type text;
  v_listing_title text;
  v_amount_label text;
  v_listing_label text;
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_amount_label := 'Rs. ' || trim(
    to_char(round(abs(coalesce(NEW.amount, 0)))::numeric, 'FM999,999,999,990')
  );

  IF NEW.listing_id IS NOT NULL THEN
    SELECT coalesce(nullif(trim(l.title::text), ''), 'Listing')
    INTO v_listing_title
    FROM public.listings l
    WHERE l.id = NEW.listing_id;
  ELSE
    v_listing_title := NULL;
  END IF;

  v_listing_label := coalesce(nullif(v_listing_title, ''), 'Listing');

  IF NEW.entry_type = 'bid_lock'::public.wallet_ledger_entry_type THEN
    v_type := 'wallet_bid_deduct';
    v_title := 'Bid Lock';
    v_body := format(
      '%s deducted for bid on ''%s''.',
      v_amount_label,
      v_listing_label
    );
  ELSIF NEW.entry_type = 'bid_refund'::public.wallet_ledger_entry_type
     OR NEW.entry_type = 'legacy_tier_release'::public.wallet_ledger_entry_type THEN
    v_type := 'wallet_bid_refund';
    v_title := 'Bid Refund';
    v_body := format(
      '%s successfully refunded to your Bidify Protection Account from ''%s''.',
      v_amount_label,
      v_listing_label
    );
  ELSIF NEW.entry_type = 'topup'::public.wallet_ledger_entry_type THEN
    v_type := 'wallet_topup';
    v_title := 'Wallet Top-up';
    v_body := format('%s added to your Bidify Protection Account.', v_amount_label);
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (user_id, title, body, metadata)
  VALUES (
    NEW.user_id,
    v_title,
    v_body,
    jsonb_build_object(
      'type', v_type,
      'ledger_id', NEW.id,
      'entry_type', NEW.entry_type::text,
      'listing_id', NEW.listing_id,
      'listing_title', v_listing_title,
      'amount', abs(NEW.amount)
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_wallet_ledger_entry ON public.wallet_ledger;
CREATE TRIGGER trg_notify_wallet_ledger_entry
  AFTER INSERT ON public.wallet_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_wallet_ledger_entry();

-- ── 3) transactions table (legacy / parallel) — same messages when table exists ──
CREATE OR REPLACE FUNCTION public.notify_transactions_bid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_title text;
  v_body text;
  v_type text;
  v_listing_title text;
  v_listing_id uuid;
  v_amount_label text;
  v_listing_label text;
  v_note text;
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_amount_label := 'Rs. ' || trim(
    to_char(round(abs(coalesce(NEW.amount, 0)))::numeric, 'FM999,999,999,990')
  );

  v_note := coalesce(NEW.note, '');

  IF to_regclass('public.listings') IS NOT NULL AND v_note <> '' THEN
    BEGIN
      SELECT (regexp_match(v_note, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'i'))[1]::uuid
      INTO v_listing_id;
    EXCEPTION
      WHEN OTHERS THEN
        v_listing_id := NULL;
    END;
  END IF;

  IF v_listing_id IS NOT NULL THEN
    SELECT coalesce(nullif(trim(l.title::text), ''), 'Listing')
    INTO v_listing_title
    FROM public.listings l
    WHERE l.id = v_listing_id;
  ELSE
    v_listing_title := NULL;
  END IF;

  v_listing_label := coalesce(nullif(v_listing_title, ''), 'Listing');

  IF NEW.kind::text = 'bid_hold' THEN
    v_type := 'wallet_bid_deduct';
    v_title := 'Bid Lock';
    v_body := format(
      '%s deducted for bid on ''%s''.',
      v_amount_label,
      v_listing_label
    );
  ELSIF NEW.kind::text = 'bid_refund' THEN
    v_type := 'wallet_bid_refund';
    v_title := 'Bid Refund';
    v_body := format(
      '%s successfully refunded to your Bidify Protection Account from ''%s''.',
      v_amount_label,
      v_listing_label
    );
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (user_id, title, body, metadata)
  VALUES (
    NEW.user_id,
    v_title,
    v_body,
    jsonb_build_object(
      'type', v_type,
      'transaction_id', NEW.id,
      'kind', NEW.kind::text,
      'listing_id', v_listing_id,
      'listing_title', v_listing_title,
      'amount', abs(NEW.amount)
    )
  );

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'transactions'
  ) THEN
    DROP TRIGGER IF EXISTS trg_notify_transactions_bid ON public.transactions;
    CREATE TRIGGER trg_notify_transactions_bid
      AFTER INSERT ON public.transactions
      FOR EACH ROW
      EXECUTE FUNCTION public.notify_transactions_bid();
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
