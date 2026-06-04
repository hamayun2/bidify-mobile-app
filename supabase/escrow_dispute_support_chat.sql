-- =============================================================================
-- Dispute support chat: shared ticket per order + party access + seller disputes
-- Run once in Supabase SQL Editor after escrow_phase_a + phase_4.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Party may access ticket if opener, admin, or buyer/seller on disputed order
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.user_can_access_support_ticket(p_ticket_id uuid, p_user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.support_tickets t
    JOIN public.auction_orders o ON o.id = t.order_id
    WHERE t.id = p_ticket_id
      AND p_user_id IS NOT NULL
      AND (
        t.opened_by_user_id = p_user_id
        OR coalesce(public.current_user_is_admin(), false)
        OR (
          o.status = 'disputed'::public.auction_order_status
          AND (o.buyer_id = p_user_id OR o.seller_id = p_user_id)
        )
      )
  );
$$;

REVOKE ALL ON FUNCTION public.user_can_access_support_ticket(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_can_access_support_ticket(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Get or create open support ticket for a disputed order (one ticket per order)
-- ---------------------------------------------------------------------------
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

    INSERT INTO public.support_ticket_messages (
      ticket_id,
      sender_id,
      body,
      is_admin_message
    )
    VALUES (
      v_ticket.id,
      v_caller,
      'I need help resolving this disputed order.',
      false
    );

    v_created := true;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'created', v_created,
    'ticket_id', v_ticket.id,
    'order_id', v_ticket.order_id,
    'status', v_ticket.status,
    'subject', v_ticket.subject,
    'opened_by', v_ticket.opened_by
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_order_support_ticket(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_order_support_ticket(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Fetch ticket thread (messages + attachments)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fetch_support_ticket_thread(p_ticket_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid;
  v_ticket public.support_tickets;
  v_messages jsonb;
  v_attachments jsonb;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.user_can_access_support_ticket(p_ticket_id, v_caller) THEN
    RAISE EXCEPTION 'Not allowed to view this support ticket';
  END IF;

  SELECT * INTO v_ticket FROM public.support_tickets WHERE id = p_ticket_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Support ticket not found';
  END IF;

  SELECT coalesce(jsonb_agg(row_to_json(m.*) ORDER BY m.created_at ASC), '[]'::jsonb)
  INTO v_messages
  FROM public.support_ticket_messages m
  WHERE m.ticket_id = p_ticket_id;

  SELECT coalesce(jsonb_agg(row_to_json(a.*) ORDER BY a.created_at ASC), '[]'::jsonb)
  INTO v_attachments
  FROM public.support_ticket_attachments a
  WHERE a.ticket_id = p_ticket_id;

  RETURN jsonb_build_object(
    'ok', true,
    'ticket', row_to_json(v_ticket),
    'messages', v_messages,
    'attachments', v_attachments
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fetch_support_ticket_thread(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fetch_support_ticket_thread(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Send message on support ticket
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.send_support_ticket_message(
  p_ticket_id uuid,
  p_body text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid;
  v_body text;
  v_msg public.support_ticket_messages;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_body := nullif(trim(coalesce(p_body, '')), '');
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'Message cannot be empty';
  END IF;

  IF NOT public.user_can_access_support_ticket(p_ticket_id, v_caller) THEN
    RAISE EXCEPTION 'Not allowed to message on this support ticket';
  END IF;

  INSERT INTO public.support_ticket_messages (
    ticket_id,
    sender_id,
    body,
    is_admin_message
  )
  VALUES (
    p_ticket_id,
    v_caller,
    v_body,
    coalesce(public.current_user_is_admin(), false)
  )
  RETURNING * INTO v_msg;

  UPDATE public.support_tickets
  SET updated_at = now()
  WHERE id = p_ticket_id;

  RETURN jsonb_build_object('ok', true, 'message', row_to_json(v_msg));
END;
$$;

REVOKE ALL ON FUNCTION public.send_support_ticket_message(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_support_ticket_message(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Register attachment after client uploads to storage
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_support_ticket_attachment(
  p_ticket_id uuid,
  p_message_id uuid,
  p_storage_path text,
  p_file_name text DEFAULT NULL,
  p_mime_type text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid;
  v_row public.support_ticket_attachments;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.user_can_access_support_ticket(p_ticket_id, v_caller) THEN
    RAISE EXCEPTION 'Not allowed to attach files on this support ticket';
  END IF;

  INSERT INTO public.support_ticket_attachments (
    ticket_id,
    message_id,
    uploaded_by,
    storage_path,
    file_name,
    mime_type
  )
  VALUES (
    p_ticket_id,
    p_message_id,
    v_caller,
    trim(p_storage_path),
    nullif(trim(p_file_name), ''),
    nullif(trim(p_mime_type), '')
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('ok', true, 'attachment', row_to_json(v_row));
END;
$$;

REVOKE ALL ON FUNCTION public.register_support_ticket_attachment(uuid, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_support_ticket_attachment(uuid, uuid, text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- RLS: allow buyer & seller on disputed orders to read/write shared ticket
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS support_tickets_select_party ON public.support_tickets;
CREATE POLICY support_tickets_select_party
  ON public.support_tickets FOR SELECT
  TO authenticated
  USING (
    opened_by_user_id = auth.uid()
    OR public.current_user_is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.auction_orders o
      WHERE o.id = support_tickets.order_id
        AND o.status = 'disputed'::public.auction_order_status
        AND (o.buyer_id = auth.uid() OR o.seller_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS support_ticket_messages_select_ticket ON public.support_ticket_messages;
CREATE POLICY support_ticket_messages_select_ticket
  ON public.support_ticket_messages FOR SELECT
  TO authenticated
  USING (public.user_can_access_support_ticket(ticket_id, auth.uid()));

DROP POLICY IF EXISTS support_ticket_messages_insert_ticket ON public.support_ticket_messages;
CREATE POLICY support_ticket_messages_insert_ticket
  ON public.support_ticket_messages FOR INSERT
  TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND public.user_can_access_support_ticket(ticket_id, auth.uid())
  );

DROP POLICY IF EXISTS support_ticket_attachments_select_ticket ON public.support_ticket_attachments;
CREATE POLICY support_ticket_attachments_select_ticket
  ON public.support_ticket_attachments FOR SELECT
  TO authenticated
  USING (public.user_can_access_support_ticket(ticket_id, auth.uid()));

DROP POLICY IF EXISTS support_ticket_attachments_insert_ticket ON public.support_ticket_attachments;
CREATE POLICY support_ticket_attachments_insert_ticket
  ON public.support_ticket_attachments FOR INSERT
  TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid()
    AND public.user_can_access_support_ticket(ticket_id, auth.uid())
  );

-- ---------------------------------------------------------------------------
-- Allow seller to raise dispute (matches frontend)
-- ---------------------------------------------------------------------------
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

  INSERT INTO public.support_ticket_messages (ticket_id, sender_id, body, is_admin_message)
  VALUES (v_ticket_id, v_caller, v_reason, false);

  RETURN jsonb_build_object(
    'ok', true,
    'order_id', p_order_id,
    'ticket_id', v_ticket_id,
    'status', 'disputed',
    'message', 'Dispute opened. Funds remain frozen until admin review.'
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
