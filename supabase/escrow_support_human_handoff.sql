-- =============================================================================
-- AI → Human admin handoff for dispute support tickets
-- Run after escrow_support_ai_assistant.sql
-- =============================================================================

ALTER TABLE public.support_tickets
  ADD COLUMN IF NOT EXISTS is_human_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS human_requested_at timestamptz;

-- Add enum value for awaiting_admin (safe if already exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'support_ticket_status'
      AND e.enumlabel = 'awaiting_admin'
  ) THEN
    ALTER TYPE public.support_ticket_status ADD VALUE 'awaiting_admin';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS support_tickets_human_required_idx
  ON public.support_tickets (is_human_required, status)
  WHERE is_human_required = true;

-- User requests escalation from AI to human admin
CREATE OR REPLACE FUNCTION public.request_support_ticket_human(p_ticket_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid;
  v_ticket public.support_tickets;
  v_order public.auction_orders;
  v_msg public.support_ticket_messages;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  IF NOT public.user_can_access_support_ticket(p_ticket_id, v_caller) THEN
    RAISE EXCEPTION 'Not allowed to request admin on this ticket';
  END IF;

  SELECT * INTO v_ticket FROM public.support_tickets WHERE id = p_ticket_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Support ticket not found';
  END IF;

  SELECT * INTO v_order FROM public.auction_orders WHERE id = v_ticket.order_id;

  IF v_ticket.is_human_required = true
     OR v_ticket.status = 'awaiting_admin'::public.support_ticket_status THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_requested', true,
      'ticket_id', v_ticket.id,
      'status', v_ticket.status,
      'is_human_required', v_ticket.is_human_required
    );
  END IF;

  UPDATE public.support_tickets
  SET
    is_human_required = true,
    human_requested_at = now(),
    status = 'awaiting_admin'::public.support_ticket_status,
    updated_at = now()
  WHERE id = p_ticket_id
  RETURNING * INTO v_ticket;

  INSERT INTO public.support_ticket_messages (
    ticket_id,
    sender_id,
    body,
    is_admin_message,
    is_ai_assistant
  )
  VALUES (
    p_ticket_id,
    v_caller,
    'User requested to speak with a human Bidify administrator.',
    false,
    false
  )
  RETURNING * INTO v_msg;

  RETURN jsonb_build_object(
    'ok', true,
    'ticket_id', v_ticket.id,
    'status', v_ticket.status,
    'is_human_required', v_ticket.is_human_required,
    'human_requested_at', v_ticket.human_requested_at,
    'order_id', v_order.id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.request_support_ticket_human(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_support_ticket_human(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_support_ticket_human(uuid) TO service_role;

-- Service role variant for Express API (validates p_user_id is a ticket party)
CREATE OR REPLACE FUNCTION public.request_support_ticket_human_for_user(
  p_ticket_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket public.support_tickets;
  v_order public.auction_orders;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  IF p_ticket_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'Ticket and user are required';
  END IF;

  IF NOT public.user_can_access_support_ticket(p_ticket_id, p_user_id) THEN
    RAISE EXCEPTION 'Not allowed to request admin on this ticket';
  END IF;

  SELECT * INTO v_ticket FROM public.support_tickets WHERE id = p_ticket_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Support ticket not found';
  END IF;

  IF v_ticket.is_human_required = true
     OR v_ticket.status = 'awaiting_admin'::public.support_ticket_status THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_requested', true,
      'ticket_id', v_ticket.id,
      'status', v_ticket.status,
      'is_human_required', v_ticket.is_human_required
    );
  END IF;

  UPDATE public.support_tickets
  SET
    is_human_required = true,
    human_requested_at = now(),
    status = 'awaiting_admin'::public.support_ticket_status,
    updated_at = now()
  WHERE id = p_ticket_id
  RETURNING * INTO v_ticket;

  SELECT * INTO v_order FROM public.auction_orders WHERE id = v_ticket.order_id;

  INSERT INTO public.support_ticket_messages (
    ticket_id,
    sender_id,
    body,
    is_admin_message,
    is_ai_assistant
  )
  VALUES (
    p_ticket_id,
    p_user_id,
    'User requested to speak with a human Bidify administrator.',
    false,
    false
  );

  RETURN jsonb_build_object(
    'ok', true,
    'ticket_id', v_ticket.id,
    'status', v_ticket.status,
    'is_human_required', v_ticket.is_human_required,
    'human_requested_at', v_ticket.human_requested_at,
    'order_id', v_order.id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.request_support_ticket_human_for_user(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_support_ticket_human_for_user(uuid, uuid) TO service_role;

-- Keep ensure_order_support_ticket finding tickets in awaiting_admin state
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
      'under_review'::public.support_ticket_status,
      'awaiting_admin'::public.support_ticket_status
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
    'is_human_required', v_ticket.is_human_required,
    'human_requested_at', v_ticket.human_requested_at,
    'ai_greeting', v_seed
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
