const jwt = require('jsonwebtoken');
const { store } = require('./store');

const JWT_SECRET = process.env.JWT_SECRET || 'bidify-dev-change-me';

function adminEmailFromEnv(email) {
  const admin =
    (process.env.EXPO_PUBLIC_ADMIN_EMAIL && String(process.env.EXPO_PUBLIC_ADMIN_EMAIL).trim()) ||
    'admin@bidify.com';
  return String(email || '').toLowerCase().trim() === String(admin).toLowerCase();
}

function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role || 'user' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function findUserById(id) {
  return store.users.find((u) => String(u.id) === String(id));
}

function attachExpressUser(req, payload) {
  const user = findUserById(payload.sub);
  if (!user) return null;
  req.user = {
    id: user.id,
    email: user.email,
    role: user.role,
    fullName: user.fullName,
    supabaseUserId: user.supabaseUserId || null,
  };
  return req.user;
}

function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return res.status(401).json({ message: 'Unauthorized' });
  const token = m[1];

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!attachExpressUser(req, payload)) {
      return res.status(401).json({ message: 'Invalid session' });
    }
    return next();
  } catch {
    return res.status(401).json({ message: 'Invalid token' });
  }
}

function authOptional(req, res, next) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) {
    req.user = null;
    return next();
  }
  const token = m[1];

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = findUserById(payload.sub);
    req.user = user
      ? {
          id: user.id,
          email: user.email,
          role: user.role,
          fullName: user.fullName,
          supabaseUserId: user.supabaseUserId || null,
        }
      : null;
    return next();
  } catch {
    req.user = null;
    return next();
  }
}

function adminRequired(req, res, next) {
  return authRequired(req, res, () => {
    const role = req.user.role;
    const adminEmail = adminEmailFromEnv(req.user.email);
    if (role !== 'admin' && !adminEmail) {
      return res.status(403).json({ message: 'Admin access required' });
    }
    next();
  });
}

function publicUser(user) {
  if (!user) return null;
  const { password: _p, passwordHash: _h, ...rest } = user;
  return rest;
}

module.exports = {
  JWT_SECRET,
  signToken,
  authRequired,
  authOptional,
  adminRequired,
  publicUser,
  findUserById,
};
