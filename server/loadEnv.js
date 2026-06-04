/**
 * Load environment variables before any other server module runs.
 * Order: server/.env → project root .env (root wins on duplicate keys).
 */
const path = require('path');
const fs = require('fs');

const SERVER_ENV_PATH = path.resolve(__dirname, '.env');
const ROOT_ENV_PATH = path.resolve(__dirname, '..', '.env');

const serverParsed = require('dotenv').config({ path: SERVER_ENV_PATH });
const serverVisionKey =
  serverParsed.parsed?.GOOGLE_VISION_API_KEY ||
  process.env.GOOGLE_VISION_API_KEY ||
  '';

require('dotenv').config({ path: ROOT_ENV_PATH, override: true });

const VISION_PLACEHOLDER = 'PASTE_YOUR_API_KEY_HERE';

// Root .env overrides most keys, but do not let a root placeholder wipe a real server/.env key.
const rootVision = String(process.env.GOOGLE_VISION_API_KEY || '').trim();
const serverVision = String(serverVisionKey || '').trim();
if (
  serverVision &&
  serverVision !== VISION_PLACEHOLDER &&
  (!rootVision || rootVision === VISION_PLACEHOLDER)
) {
  process.env.GOOGLE_VISION_API_KEY = serverVision;
}

function isVisionApiKeyConfigured() {
  const v = String(process.env.GOOGLE_VISION_API_KEY || '').trim();
  if (!v) return false;
  if (v === VISION_PLACEHOLDER) return false;
  return true;
}

if (process.env.NODE_ENV !== 'production') {
  console.log('[Bidify/env] server/.env:', fs.existsSync(SERVER_ENV_PATH) ? SERVER_ENV_PATH : '(missing)');
  console.log('[Bidify/env] root .env:', fs.existsSync(ROOT_ENV_PATH) ? ROOT_ENV_PATH : '(missing)');
  console.log(
    '[Bidify/env] GOOGLE_VISION_API_KEY:',
    isVisionApiKeyConfigured() ? 'configured' : 'MISSING or still placeholder'
  );
}

module.exports = {
  SERVER_ENV_PATH,
  ROOT_ENV_PATH,
  VISION_PLACEHOLDER,
  isVisionApiKeyConfigured,
};
