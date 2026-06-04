/**
 * HTTP entry for Stripe webhooks + verbose step logging.
 */
const { handleStripeWebhook } = require('./stripePayments');

function logStep(step, message, extra) {
  const suffix = extra != null ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[stripe/webhook] ${step} ${message}${suffix}`);
}

/**
 * Express handler — raw body required (express.raw).
 */
function stripeWebhookHttpHandler(req, res) {
  const path = req.originalUrl || req.url || '';
  void (async () => {
    logStep('1/6', 'POST received', { path, contentLength: req.headers['content-length'] });

    const sig = req.headers['stripe-signature'];
    if (!sig) {
      logStep('FAIL', 'Missing stripe-signature header — use Stripe CLI or Dashboard webhook, not a browser');
      return res.status(400).json({ ok: false, error: 'Missing stripe-signature' });
    }
    logStep('2/6', 'stripe-signature present', { prefix: String(sig).slice(0, 20) + '…' });

    const raw = req.body;
    if (!raw || (Buffer.isBuffer(raw) && raw.length === 0)) {
      logStep('FAIL', 'Empty body — webhook must use express.raw() before express.json()');
      return res.status(400).json({ ok: false, error: 'Empty body' });
    }
    const byteLen = Buffer.isBuffer(raw) ? raw.length : String(raw).length;
    logStep('3/6', 'Raw body OK', { bytes: byteLen });

    try {
      const out = await handleStripeWebhook(raw, sig, { log: logStep });
      logStep('6/6', 'Done', out);
      return res.status(200).json(out);
    } catch (e) {
      const msg = e?.message || String(e);
      if (/signature|webhook/i.test(msg)) {
        logStep('FAIL', 'Signature verification failed — STRIPE_WEBHOOK_SECRET must match `stripe listen` output', {
          hint: 'Run npm run dev (updates secret from CLI) or copy whsec_ from stripe listen into .env',
        });
      } else if (/profile|Supabase|credit_profile/i.test(msg)) {
        logStep('FAIL', 'Supabase wallet credit failed', { error: msg });
      } else {
        logStep('FAIL', msg);
      }
      return res.status(400).json({ ok: false, error: msg });
    }
  })();
}

module.exports = { stripeWebhookHttpHandler, logStep };
