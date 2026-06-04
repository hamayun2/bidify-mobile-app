-- =============================================================================
-- AI Assistant for dispute support tickets
-- Run after escrow_dispute_support_chat.sql
-- =============================================================================

ALTER TABLE public.support_ticket_messages
  ADD COLUMN IF NOT EXISTS is_ai_assistant boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS support_ticket_messages_ai_idx
  ON public.support_ticket_messages (ticket_id)
  WHERE is_ai_assistant = true;

-- Shared greeting text (keep in sync with product copy)
CREATE OR REPLACE FUNCTION public.support_ticket_ai_greeting_text()
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    'Hi, I am Bidify''s AI Support Assistant. I notice this order is currently under dispute. '
    || 'Please tell me exactly what the issue is so I can help settle it or prepare the details for a human administrator.';
$$;

-- Idempotent: insert AI greeting as the first assistant message on a ticket
CREATE OR REPLACE FUNCTION public.seed_support_ticket_ai_greeting(p_ticket_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket public.support_tickets;
  v_order public.auction_orders;
  v_sender uuid;
  v_msg public.support_ticket_messages;
  v_greeting text;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  SELECT * INTO v_ticket FROM public.support_tickets WHERE id = p_ticket_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Support ticket not found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.support_ticket_messages m
    WHERE m.ticket_id = p_ticket_id
      AND m.is_ai_assistant = true
  ) THEN
    RETURN jsonb_build_object('ok', true, 'seeded', false, 'ticket_id', p_ticket_id);
  END IF;

  SELECT * INTO v_order FROM public.auction_orders WHERE id = v_ticket.order_id;
  v_sender := coalesce(v_ticket.opened_by_user_id, v_order.buyer_id, v_order.seller_id);
  IF v_sender IS NULL THEN
    RAISE EXCEPTION 'Cannot seed AI greeting without a ticket participant';
  END IF;

  v_greeting := public.support_ticket_ai_greeting_text();

  INSERT INTO public.support_ticket_messages (
    ticket_id,
    sender_id,
    body,
    is_admin_message,
    is_ai_assistant,
    created_at
  )
  VALUES (
    p_ticket_id,
    v_sender,
    v_greeting,
    false,
    true,
    v_ticket.created_at
  )
  RETURNING * INTO v_msg;

  RETURN jsonb_build_object(
    'ok', true,
    'seeded', true,
    'ticket_id', p_ticket_id,
    'message', row_to_json(v_msg)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.seed_support_ticket_ai_greeting(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_support_ticket_ai_greeting(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.seed_support_ticket_ai_greeting(uuid) TO service_role;

-- Service role / API: persist AI reply after Gemini generates text
CREATE OR REPLACE FUNCTION public.send_support_ticket_ai_message(
  p_ticket_id uuid,
  p_body text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket public.support_tickets;
  v_order public.auction_orders;
  v_sender uuid;
  v_body text;
  v_msg public.support_ticket_messages;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  v_body := nullif(trim(coalesce(p_body, '')), '');
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'AI message cannot be empty';
  END IF;

  SELECT * INTO v_ticket FROM public.support_tickets WHERE id = p_ticket_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Support ticket not found';
  END IF;

  IF v_ticket.is_human_required = true
     OR v_ticket.status = 'awaiting_admin'::public.support_ticket_status THEN
    RETURN jsonb_build_object(
      'ok', true,
      'skipped', true,
      'reason', 'human_admin_required'
    );
  END IF;

  SELECT * INTO v_order FROM public.auction_orders WHERE id = v_ticket.order_id;
  v_sender := coalesce(v_ticket.opened_by_user_id, v_order.buyer_id, v_order.seller_id);

  INSERT INTO public.support_ticket_messages (
    ticket_id,
    sender_id,
    body,
    is_admin_message,
    is_ai_assistant
  )
  VALUES (
    p_ticket_id,
    v_sender,
    v_body,
    false,
    true
  )
  RETURNING * INTO v_msg;

  UPDATE public.support_tickets SET updated_at = now() WHERE id = p_ticket_id;

  RETURN jsonb_build_object('ok', true, 'message', row_to_json(v_msg));
END;
$$;

REVOKE ALL ON FUNCTION public.send_support_ticket_ai_message(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_support_ticket_ai_message(uuid, text) TO service_role;

-- Patch ensure_order_support_ticket: always seed AI greeting when ticket is opened
CREATE OR REPLACE FUNCTION public.ensure_order_support_ticket(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.auction_orders;
  v_caller uuid;
  v_ticket public.support_tickets;
  v_created boolean := false;
  v_role public.support_ticket_opened_by;
  v_seed jsonb;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  SELECT * INTO v_order FROM public.auction_orders o WHERE o.id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_order.status IS DISTINCT FROM 'disputed'::public.auction_order_status THEN
    RAISE EXCEPTION 'Admin support is only available for disputed orders';
  END IF;

  IF v_caller IS DISTINCT FROM v_order.buyer_id
     AND v_caller IS DISTINCT FROM v_order.seller_id
     AND NOT coalesce(public.current_user_is_admin(), false) THEN
    RAISE EXCEPTION 'Not allowed to access support for this order';
  END IF;

  SELECT * INTO v_ticket
  FROM public.support_tickets t
  WHERE t.order_id = p_order_id
    AND t.status IN (
      'open'::public.support_ticket_status,
      'under_review'::public.support_ticket_status
    )
  ORDER BY t.created_at ASC
  LIMIT 1;

  IF NOT FOUND THEN
    IF v_caller = v_order.seller_id THEN
      v_role := 'seller'::public.support_ticket_opened_by;
    ELSE
      v_role := 'buyer'::public.support_ticket_opened_by;
    END IF;

    INSERT INTO public.support_tickets (
      order_id,
      opened_by,
      opened_by_user_id,
      status,
      subject,
      reason
    )
    VALUES (
      p_order_id,
      v_role,
      v_caller,
      'open'::public.support_ticket_status,
      'Dispute — admin review',
      'Opened from My Orders to contact Bidify support.'
    )
    RETURNING * INTO v_ticket;

    v_created := true;
  END IF;

  v_seed := public.seed_support_ticket_ai_greeting(v_ticket.id);

  RETURN jsonb_build_object(
    'ok', true,
    'created', v_created,
    'ticket_id', v_ticket.id,
    'order_id', v_ticket.order_id,
    'status', v_ticket.status,
    'subject', v_ticket.subject,
    'opened_by', v_ticket.opened_by,
    'ai_greeting', v_seed
  );
END;
$$;

-- Patch raise_order_dispute: seed AI greeting on new dispute ticket
CREATE OR REPLACE FUNCTION public.raise_order_dispute(
  p_order_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.auction_orders;
  v_caller uuid;
  v_reason text;
  v_ticket_id uuid;
  v_existing uuid;
  v_role public.support_ticket_opened_by;
  v_seed jsonb;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  v_reason := nullif(trim(coalesce(p_reason, '')), '');
  IF v_reason IS NULL OR length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Please describe the issue (at least 10 characters).';
  END IF;

  SELECT o.* INTO v_order FROM public.auction_orders o WHERE o.id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_order.status IS DISTINCT FROM 'pending_delivery'::public.auction_order_status THEN
    RAISE EXCEPTION 'Disputes can only be raised while the order is awaiting delivery';
  END IF;

  IF v_caller IS DISTINCT FROM v_order.buyer_id
     AND v_caller IS DISTINCT FROM v_order.seller_id
     AND NOT coalesce(public.current_user_is_admin(), false) THEN
    RAISE EXCEPTION 'Only the buyer or seller can raise a dispute on this order';
  END IF;

  IF v_caller = v_order.seller_id THEN
    v_role := 'seller'::public.support_ticket_opened_by;
  ELSE
    v_role := 'buyer'::public.support_ticket_opened_by;
  END IF;

  SELECT t.id INTO v_existing
  FROM public.support_tickets t
  WHERE t.order_id = p_order_id
    AND t.status IN ('open'::public.support_ticket_status, 'under_review'::public.support_ticket_status)
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'A dispute is already open for this order';
  END IF;

  UPDATE public.auction_orders o
  SET
    status = 'disputed'::public.auction_order_status,
    disputed_at = now(),
    disputed_by = v_role,
    delivery_otp_hash = NULL,
    updated_at = now()
  WHERE o.id = p_order_id;

  INSERT INTO public.support_tickets (
    order_id,
    opened_by,
    opened_by_user_id,
    status,
    subject,
    reason
  )
  VALUES (
    p_order_id,
    v_role,
    v_caller,
    'open'::public.support_ticket_status,
    'Delivery dispute',
    v_reason
  )
  RETURNING id INTO v_ticket_id;

  v_seed := public.seed_support_ticket_ai_greeting(v_ticket_id);

  INSERT INTO public.support_ticket_messages (ticket_id, sender_id, body, is_admin_message, is_ai_assistant)
  VALUES (v_ticket_id, v_caller, v_reason, false, false);

  RETURN jsonb_build_object(
    'ok', true,
    'order_id', p_order_id,
    'ticket_id', v_ticket_id,
    'status', 'disputed',
    'ai_greeting', v_seed,
    'message', 'Dispute opened. Funds remain frozen until admin review.'
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
