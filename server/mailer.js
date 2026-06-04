/**
 * Thin nodemailer wrapper for OTP/password emails. Falls back to console output
 * when SMTP credentials aren't configured so dev can grab the code from logs.
 *
 * Env vars (all optional except *_USER / *_PASS for actual delivery):
 *   SMTP_HOST   (default: smtp.gmail.com)
 *   SMTP_PORT   (default: 587)
 *   SMTP_SECURE (default: false; set to "true" for port 465)
 *   SMTP_USER   Gmail address (e.g. yourapp@gmail.com)
 *   SMTP_PASS   Gmail *app password* (NOT the regular password)
 *   MAIL_FROM   (default: "Bidify <${SMTP_USER}>")
 */

let nodemailer = null;
try {
  // eslint-disable-next-line global-require
  nodemailer = require('nodemailer');
} catch (_) {
  nodemailer = null;
}

let cachedTransport = null;

function getTransport() {
  if (!nodemailer) return null;
  if (cachedTransport) return cachedTransport;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return null;

  cachedTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
    auth: { user, pass },
  });
  return cachedTransport;
}

async function sendMail({ to, subject, text, html }) {
  const transport = getTransport();
  if (!transport) {
    console.log('[mailer] SMTP not configured — logging email instead:');
    console.log({ to, subject, text: text || html });
    return { delivered: false, logged: true };
  }
  const from = process.env.MAIL_FROM || `Bidify <${process.env.SMTP_USER}>`;
  await transport.sendMail({ from, to, subject, text, html });
  return { delivered: true };
}

function otpEmailHtml(code) {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#fafafa; padding:24px;">
      <div style="max-width:480px; margin:0 auto; background:#fff; border-radius:16px; padding:28px; border:1px solid #eee;">
        <h2 style="margin:0 0 4px 0; color:#111;">Bidify password reset</h2>
        <p style="color:#666; margin:0 0 18px 0;">Use this code to reset your password. It expires in 10 minutes.</p>
        <div style="font-size:32px; font-weight:800; letter-spacing:8px; background:#f4f4f4; padding:14px; text-align:center; border-radius:12px; color:#111;">
          ${code}
        </div>
        <p style="color:#999; font-size:12px; margin-top:18px;">If you didn't request this, you can safely ignore this email.</p>
      </div>
    </div>
  `;
}

module.exports = { sendMail, otpEmailHtml };
