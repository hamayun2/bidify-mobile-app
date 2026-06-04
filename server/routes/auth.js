const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { store, persist } = require('../store');
const { signToken, authRequired, publicUser } = require('../authMiddleware');
const { sendMail, otpEmailHtml } = require('../mailer');
const { uploadUrl } = require('../listingHelpers');

const router = express.Router();

const OTP_TTL_MS = 10 * 60 * 1000; // 10 min
const OTP_MAX_ATTEMPTS = 5;
const RESET_TOKEN_TTL_MS = 10 * 60 * 1000;

function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function normEmail(s) {
  return String(s || '').trim().toLowerCase();
}

// --- CNIC image upload (multipart) -----------------------------------------

const cnicUploadsDir = path.join(__dirname, '..', 'uploads', 'cnic');
if (!fs.existsSync(cnicUploadsDir)) fs.mkdirSync(cnicUploadsDir, { recursive: true });

const cnicStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, cnicUploadsDir),
  filename: (_req, file, cb) => {
    const safe = (file.originalname || 'cnic').replace(/[^a-z0-9.\-_]+/gi, '-');
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
  },
});
const cnicUpload = multer({
  storage: cnicStorage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB per image
}).fields([
  { name: 'cnicFront', maxCount: 1 },
  { name: 'cnicBack', maxCount: 1 },
]);

function cleanupCnicFiles(files) {
  if (!files) return;
  for (const arr of Object.values(files)) {
    for (const f of arr || []) {
      try { fs.unlinkSync(f.path); } catch (_) { /* ignore */ }
    }
  }
}

/**
 * Mock "verified CNIC" check used by /auth/register-cnic. Mirrors
 * src/data/verifiedCnics.js: last two digits must be 01..99.
 */
function isCnicVerifiedServerSide(cnic) {
  const d = String(cnic || '').replace(/\D/g, '');
  if (!/^\d{13}$/.test(d)) return false;
  const last2 = d.slice(-2);
  if (last2 === '00') return false;
  const n = parseInt(last2, 10);
  return n >= 1 && n <= 99;
}

router.post('/register', async (req, res) => {
  try {
    const { email, password, fullName, firstName, lastName } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password required' });
    }
    const em = String(email).toLowerCase().trim();
    if (store.users.some((u) => u.email.toLowerCase() === em)) {
      return res.status(400).json({ message: 'This email is already registered' });
    }
    const hash = await bcrypt.hash(String(password), 10);
    const isAdmin = em === 'admin@bidify.com';
    const fn =
      (fullName && String(fullName).trim()) ||
      [firstName, lastName].filter(Boolean).join(' ').trim() ||
      undefined;
    const user = {
      id: String(store.nextUserId++),
      email: em,
      passwordHash: hash,
      fullName: fn,
      role: isAdmin ? 'admin' : 'user',
    };
    store.users.push(user);
    persist();
    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Registration failed' });
  }
});

/**
 * Multipart registration: CNIC verification required.
 *
 * Fields:
 *   - cnicFront (file, required)
 *   - cnicBack  (file, required)
 *   - fullName, email, password, phone, cnic (text)
 *
 * On success, the new user row also carries cnic + cnicFrontUrl + cnicBackUrl
 * + cnicVerifiedAt. Existing users in the store are NEVER touched.
 */
router.post('/register-cnic', (req, res) => {
  cnicUpload(req, res, async (err) => {
    if (err) {
      cleanupCnicFiles(req.files);
      return res
        .status(400)
        .json({ message: err.message || 'CNIC image upload failed.' });
    }
    try {
      const { email, password, fullName, firstName, lastName, phone, cnic } = req.body || {};
      const front = req.files?.cnicFront?.[0];
      const back = req.files?.cnicBack?.[0];

      if (!email || !password) {
        cleanupCnicFiles(req.files);
        return res.status(400).json({ message: 'Email and password required' });
      }
      if (!front || !back) {
        cleanupCnicFiles(req.files);
        return res
          .status(400)
          .json({ message: 'Both CNIC front and back images are required.' });
      }
      const cleanCnic = String(cnic || '').replace(/\D/g, '');
      if (!/^\d{13}$/.test(cleanCnic)) {
        cleanupCnicFiles(req.files);
        return res.status(400).json({ message: 'CNIC must be exactly 13 digits.' });
      }
      if (!isCnicVerifiedServerSide(cleanCnic)) {
        cleanupCnicFiles(req.files);
        return res
          .status(400)
          .json({ message: 'CNIC not verified. Please enter the correct CNIC.' });
      }
      const cleanPhone = String(phone || '').replace(/\D/g, '');
      if (cleanPhone && !/^03\d{9}$/.test(cleanPhone)) {
        cleanupCnicFiles(req.files);
        return res
          .status(400)
          .json({ message: 'Phone must be 11 digits starting with 03.' });
      }

      const em = String(email).toLowerCase().trim();
      if (store.users.some((u) => u.email && u.email.toLowerCase() === em)) {
        cleanupCnicFiles(req.files);
        return res.status(400).json({ message: 'This email is already registered' });
      }
      // Block duplicate CNICs too (one CNIC per user is the realistic rule).
      if (store.users.some((u) => u.cnic && u.cnic === cleanCnic)) {
        cleanupCnicFiles(req.files);
        return res
          .status(409)
          .json({
            message: 'CNIC already registered',
            code: 'CNIC_ALREADY_REGISTERED',
            field: 'cnic',
          });
      }
      if (
        cleanPhone &&
        store.users.some((u) => u.phone && String(u.phone).replace(/\D/g, '') === cleanPhone)
      ) {
        cleanupCnicFiles(req.files);
        return res.status(409).json({
          message: 'Phone number already registered',
          code: 'PHONE_ALREADY_REGISTERED',
          field: 'phoneNumber',
        });
      }

      const hash = await bcrypt.hash(String(password), 10);
      const isAdmin = em === 'admin@bidify.com';
      const fn =
        (fullName && String(fullName).trim()) ||
        [firstName, lastName].filter(Boolean).join(' ').trim() ||
        undefined;

      const user = {
        id: String(store.nextUserId++),
        email: em,
        passwordHash: hash,
        fullName: fn,
        phone: cleanPhone || null,
        cnic: cleanCnic,
        cnicFrontUrl: uploadUrl(req, `cnic/${front.filename}`),
        cnicBackUrl: uploadUrl(req, `cnic/${back.filename}`),
        cnicVerifiedAt: new Date().toISOString(),
        role: isAdmin ? 'admin' : 'user',
      };
      store.users.push(user);
      persist();
      const token = signToken(user);
      res.json({ token, user: publicUser(user) });
    } catch (e) {
      console.error('register-cnic failed:', e);
      cleanupCnicFiles(req.files);
      res.status(500).json({ message: 'Registration failed.' });
    }
  });
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password required' });
    }
    const em = String(email).toLowerCase().trim();
    const user = store.users.find((u) => u.email.toLowerCase() === em);
    if (!user) return res.status(401).json({ message: 'This email is not registered' });
    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) return res.status(401).json({ message: 'Incorrect password' });
    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Login failed' });
  }
});

/**
 * After Supabase Auth login, mint an Express JWT for wallet / Stripe / chat APIs.
 * Creates a shadow user in store.json when missing (same email).
 */
router.post('/bridge-login', async (req, res) => {
  try {
    const email = normEmail(req.body?.email);
    const fullName = (req.body?.fullName && String(req.body.fullName).trim()) || null;
    const supabaseUserId =
      req.body?.supabaseUserId && String(req.body.supabaseUserId).trim()
        ? String(req.body.supabaseUserId).trim()
        : null;
    if (!email) return res.status(400).json({ message: 'email is required' });

    let user = store.users.find((u) => u.email && u.email.toLowerCase() === email);
    if (!user) {
      const hash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
      const isAdmin = email === 'admin@bidify.com';
      user = {
        id: String(store.nextUserId++),
        email,
        passwordHash: hash,
        fullName,
        role: isAdmin ? 'admin' : 'user',
        supabaseUserId,
        createdAt: new Date().toISOString(),
      };
      store.users.push(user);
      persist();
      console.log('[auth] bridge-login created Express shadow user for', email);
    } else {
      if (fullName && !user.fullName) user.fullName = fullName;
      if (supabaseUserId) user.supabaseUserId = supabaseUserId;
      persist();
    }

    const token = signToken(user);
    console.log('[auth] bridge-login OK for', email, user.supabaseUserId ? '(linked Supabase profile)' : '');
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error('[auth] bridge-login', e);
    res.status(500).json({ message: 'Bridge login failed' });
  }
});

router.get('/profile', authRequired, (req, res) => {
  const user = store.users.find((u) => String(u.id) === String(req.user.id));
  if (!user) return res.status(404).json({ message: 'User not found' });
  res.json(publicUser(user));
});

/**
 * Forgot-password OTP flow.
 *
 * To avoid leaking which emails are registered we always respond 200 from
 * /request-otp regardless of whether the email exists — but we only generate
 * an OTP and send mail when it does.
 */
router.post('/password/request-otp', async (req, res) => {
  try {
    const email = normEmail(req.body?.email);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: 'Enter a valid email.' });
    }
    const user = store.users.find((u) => u.email.toLowerCase() === email);
    if (user) {
      const code = generateOtp();
      store.passwordOtps[email] = {
        code,
        expiresAt: Date.now() + OTP_TTL_MS,
        attempts: 0,
      };
      persist();
      try {
        await sendMail({
          to: email,
          subject: 'Your Bidify password reset code',
          text: `Your Bidify password reset code is: ${code}. It expires in 10 minutes.`,
          html: otpEmailHtml(code),
        });
      } catch (mailErr) {
        console.warn('[auth] OTP mail failed:', mailErr?.message);
      }
    }
    res.json({
      ok: true,
      message: 'If that email exists, an OTP has been sent.',
      // Surfaced ONLY when SMTP is not configured (dev mode) so the developer
      // can copy the code from the API response.
      devOtp:
        process.env.SMTP_USER || process.env.NODE_ENV === 'production'
          ? undefined
          : user
            ? store.passwordOtps[email]?.code
            : undefined,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Could not send OTP.' });
  }
});

router.post('/password/verify-otp', (req, res) => {
  const email = normEmail(req.body?.email);
  const code = String(req.body?.code || '').trim();
  if (!email || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ message: 'Email and 6-digit code required.' });
  }
  const entry = store.passwordOtps[email];
  if (!entry) return res.status(400).json({ message: 'No active OTP. Request a new one.' });
  if (Date.now() > entry.expiresAt) {
    delete store.passwordOtps[email];
    persist();
    return res.status(400).json({ message: 'OTP expired. Request a new one.' });
  }
  if (entry.attempts >= OTP_MAX_ATTEMPTS) {
    delete store.passwordOtps[email];
    persist();
    return res.status(429).json({ message: 'Too many attempts. Request a new OTP.' });
  }
  if (entry.code !== code) {
    entry.attempts += 1;
    persist();
    return res.status(400).json({ message: 'Incorrect code.' });
  }
  const resetToken = crypto.randomBytes(24).toString('hex');
  entry.resetToken = resetToken;
  entry.resetTokenExpiresAt = Date.now() + RESET_TOKEN_TTL_MS;
  entry.code = null; // single-use
  persist();
  res.json({ ok: true, resetToken });
});

router.post('/password/reset', async (req, res) => {
  try {
    const email = normEmail(req.body?.email);
    const resetToken = String(req.body?.resetToken || '').trim();
    const newPassword = String(req.body?.newPassword || '');
    if (!email || !resetToken || newPassword.length < 6) {
      return res.status(400).json({
        message: 'Email, reset token, and a new password (min 6 chars) are required.',
      });
    }
    const entry = store.passwordOtps[email];
    if (!entry || !entry.resetToken || entry.resetToken !== resetToken) {
      return res.status(400).json({ message: 'Invalid or expired reset token.' });
    }
    if (Date.now() > (entry.resetTokenExpiresAt || 0)) {
      delete store.passwordOtps[email];
      persist();
      return res.status(400).json({ message: 'Reset token expired. Start again.' });
    }
    const user = store.users.find((u) => u.email.toLowerCase() === email);
    if (!user) return res.status(400).json({ message: 'Account not found.' });

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    delete store.passwordOtps[email];
    persist();
    res.json({ ok: true, message: 'Password reset. You can now sign in.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Password reset failed.' });
  }
});

module.exports = router;
