-- =============================================================================
-- Chat: messages.is_read, storage policies for chat images, notifications table
-- Run in Supabase SQL Editor. Does NOT modify bidding / wallet / escrow RPCs.
-- =============================================================================

-- ── 1) Chat tables (skip if you already have them) ───────────────────────────
CREATE TABLE IF NOT EXISTS public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.listings (id) ON DELETE CASCADE,
  buyer_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  seller_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_listing_buyer_seller_unique UNIQUE (listing_id, buyer_id, seller_id)
);

CREATE TABLE IF NOT EXISTS public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations (id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  body text NOT NULL DEFAULT '',
  image_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON public.messages (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS conversations_buyer_idx ON public.conversations (buyer_id);
CREATE INDEX IF NOT EXISTS conversations_seller_idx ON public.conversations (seller_id);

-- ── 2) Unread flag on messages ───────────────────────────────────────────────
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS is_read boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS messages_unread_inbox_idx
  ON public.messages (conversation_id, sender_id, is_read)
  WHERE is_read = false;

-- ── 3) RLS: conversations + messages ───────────────────────────────────────────
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversations_select_party ON public.conversations;
CREATE POLICY conversations_select_party
  ON public.conversations FOR SELECT TO authenticated
  USING (buyer_id = auth.uid() OR seller_id = auth.uid());

DROP POLICY IF EXISTS conversations_insert_buyer ON public.conversations;
CREATE POLICY conversations_insert_buyer
  ON public.conversations FOR INSERT TO authenticated
  WITH CHECK (buyer_id = auth.uid());

DROP POLICY IF EXISTS messages_select_party ON public.messages;
CREATE POLICY messages_select_party
  ON public.messages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND (c.buyer_id = auth.uid() OR c.seller_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS messages_insert_sender ON public.messages;
CREATE POLICY messages_insert_sender
  ON public.messages FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND (c.buyer_id = auth.uid() OR c.seller_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS messages_update_mark_read ON public.messages;
CREATE POLICY messages_update_mark_read
  ON public.messages FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND (c.buyer_id = auth.uid() OR c.seller_id = auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND (c.buyer_id = auth.uid() OR c.seller_id = auth.uid())
    )
  );

-- ── 4) Storage: listing_images bucket + chat paths under {user_id}/chat/ ───
INSERT INTO storage.buckets (id, name, public)
VALUES ('listing_images', 'listing_images', true)
ON CONFLICT (id) DO UPDATE SET public = excluded.public;

DROP POLICY IF EXISTS listing_images_public_read ON storage.objects;
CREATE POLICY listing_images_public_read
  ON storage.objects FOR SELECT
  USING (bucket_id = 'listing_images');

DROP POLICY IF EXISTS listing_images_auth_insert ON storage.objects;
CREATE POLICY listing_images_auth_insert
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'listing_images'
    AND (
      name LIKE auth.uid()::text || '/%'
      OR name LIKE 'chat/' || auth.uid()::text || '/%'
    )
  );

DROP POLICY IF EXISTS listing_images_auth_update ON storage.objects;
CREATE POLICY listing_images_auth_update
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'listing_images'
    AND name LIKE auth.uid()::text || '/%'
  );

-- ── 5) notifications table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  is_read boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON public.notifications (user_id, is_read, created_at DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notifications_select_own ON public.notifications;
CREATE POLICY notifications_select_own
  ON public.notifications FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS notifications_update_own ON public.notifications;
CREATE POLICY notifications_update_own
  ON public.notifications FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Inserts via trigger (security definer) + service_role
DROP POLICY IF EXISTS notifications_insert_service ON public.notifications;
CREATE POLICY notifications_insert_service
  ON public.notifications FOR INSERT TO service_role
  WITH CHECK (true);

-- ── 6) Trigger: new chat message → notification for recipient ───────────────
CREATE OR REPLACE FUNCTION public.notify_new_chat_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_convo public.conversations;
  v_recipient uuid;
  v_title text;
BEGIN
  SELECT * INTO v_convo FROM public.conversations WHERE id = NEW.conversation_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW.sender_id = v_convo.buyer_id THEN
    v_recipient := v_convo.seller_id;
  ELSE
    v_recipient := v_convo.buyer_id;
  END IF;

  IF v_recipient IS NULL OR v_recipient = NEW.sender_id THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(nullif(trim(l.title::text), ''), 'Listing')
  INTO v_title
  FROM public.listings l
  WHERE l.id = v_convo.listing_id;

  INSERT INTO public.notifications (user_id, title, body, metadata)
  VALUES (
    v_recipient,
    'New message',
    CASE
      WHEN nullif(trim(NEW.body), '') IS NOT NULL THEN left(trim(NEW.body), 120)
      WHEN NEW.image_url IS NOT NULL THEN 'Sent you a photo'
      ELSE 'New chat message'
    END,
    jsonb_build_object(
      'type', 'chat_message',
      'conversation_id', NEW.conversation_id,
      'listing_id', v_convo.listing_id,
      'listing_title', v_title,
      'message_id', NEW.id
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_new_chat_message ON public.messages;
CREATE TRIGGER trg_notify_new_chat_message
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_new_chat_message();

-- ── 7) Realtime (Supabase Dashboard) ─────────────────────────────────────────
-- Database → Publications → supabase_realtime: add table `notifications`
-- so the header bell red dot updates without restarting the app.

NOTIFY pgrst, 'reload schema';
