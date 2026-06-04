import client, { isAuxiliaryApiConfigured } from './client';
import { getSupabase } from '../services/supabaseClient';

/**
 * Ask Express + Gemini to analyze a dispute message and persist AI reply.
 * @param {{ ticketId: string, orderId: string, userMessage: string }} params
 */
export async function requestDisputeAiReply({ ticketId, orderId, userMessage }) {
  if (!isAuxiliaryApiConfigured()) {
    throw new Error(
      'AI assistant needs EXPO_PUBLIC_API_URL and npm run api (Gemini runs on the Express server).'
    );
  }

  const supabase = getSupabase();
  const { data: sessionData } = await supabase.auth.getSession();
  const uid = sessionData?.session?.user?.id;
  if (!uid) {
    throw new Error('Sign in again to use the AI assistant.');
  }

  const { data } = await client.post(
    '/support/ai-dispute-handler',
    {
      ticketId,
      orderId,
      userId: uid,
      userMessage: String(userMessage || '').trim(),
    },
    { timeout: 45_000 }
  );

  return data;
}

/**
 * Escalate dispute chat from AI to human admin (Supabase RPC — no Express required).
 * @param {{ ticketId: string, orderId?: string }} params
 */
export async function requestHumanAdminSupport({ ticketId }) {
  const { requestSupportTicketHuman } = await import('../services/supportTicketService');
  const result = await requestSupportTicketHuman(ticketId);
  return {
    ok: true,
    status: result?.status || 'awaiting_admin',
    isHumanRequired: true,
    ...result,
  };
}
