const { createClient } = require('@supabase/supabase-js');
const {
  isPhoneNumberTaken,
  isCnicTaken,
  normalizePhone,
  normalizeCnicDigits,
} = require('../utils/profileUniqueness');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';

function getAdmin() {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  return createClient(String(SUPABASE_URL).replace(/\/$/, ''), SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * POST /api/registration/check-fields
 * POST /api/profile/check-registration-fields
 */
async function checkRegistrationFields(req, res) {
  try {
    const admin = getAdmin();
    if (!admin) {
      return res.status(503).json({
        success: false,
        message: 'Registration checks are not available (Supabase not configured).',
      });
    }

    const { phoneNumber, cnic, excludeUserId } = req.body || {};
    const exclude = excludeUserId ? String(excludeUserId) : null;

    const phoneDigits = normalizePhone(phoneNumber);
    const cnicDigits = normalizeCnicDigits(cnic);

    const result = {
      success: true,
      phone: { available: true, reason: null },
      cnic: { available: true, reason: null },
    };

    if (phoneDigits) {
      const taken = await isPhoneNumberTaken(admin, phoneDigits, exclude);
      if (taken) {
        result.phone = {
          available: false,
          reason:
            'This phone number is already in use. Please check your number or log in.',
          code: 'PHONE_ALREADY_REGISTERED',
        };
      }
    }

    if (cnicDigits.length === 13) {
      const taken = await isCnicTaken(admin, cnicDigits, exclude);
      if (taken) {
        result.cnic = {
          available: false,
          reason:
            'This CNIC is already in use. Please check your number or log in.',
          code: 'CNIC_ALREADY_REGISTERED',
        };
      }
    }

    return res.json(result);
  } catch (e) {
    console.error('[check-registration-fields]', e?.message || e);
    return res.status(e.statusCode || 500).json({
      success: false,
      message: e.message || 'Could not verify registration fields.',
    });
  }
}

module.exports = { checkRegistrationFields };
