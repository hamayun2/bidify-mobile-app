/**
 * Start Stripe CLI webhook forwarding to local Bidify API.
 * Requires Stripe CLI: https://stripe.com/docs/stripe-cli
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const forward =
  process.env.STRIPE_WEBHOOK_FORWARD_URL ||
  'http://127.0.0.1:4000/api/payments/stripe/webhook';

const events =
  process.env.STRIPE_WEBHOOK_EVENTS ||
  'checkout.session.completed,payment_intent.succeeded';

console.log('');
console.log('[stripe-listen] Forwarding Stripe events →', forward);
console.log('[stripe-listen] Events:', events);
console.log('[stripe-listen] Tip: copy the whsec_… secret from this output into .env as STRIPE_WEBHOOK_SECRET');
console.log('');

const args = ['listen', '--forward-to', forward, '--events', events];

const child = spawn('stripe', args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: process.env,
  cwd: path.join(__dirname, '..'),
});

child.on('error', (err) => {
  console.error('');
  console.error('[stripe-listen] Could not start Stripe CLI.');
  console.error('  Install: https://stripe.com/docs/stripe-cli');
  console.error('  Then run: stripe login');
  console.error('  Error:', err.message);
  console.error('');
  console.error('You can still top up via in-app Payment Sheet (does not need stripe listen).');
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code == null ? 0 : code);
});
