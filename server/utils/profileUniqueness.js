/**
 * Uniqueness checks for public.profiles (phone_number, cnic / id_card).
 * Uses service role — run before auth signUp or profile upsert.
 */

const { formatPakistaniCnic } = require('./profileRowMapper');

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeCnicDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

async function findConflictingProfile(admin, filters, excludeUserId) {
  let q = admin.from('profiles').select('id').limit(1);
  for (const [col, val] of filters) {
    if (val != null && String(val).trim() !== '') {
      q = q.eq(col, val);
    }
  }
  if (excludeUserId) {
    q = q.neq('id', String(excludeUserId));
  }
  const { data, error } = await q;
  if (error) {
    const err = new Error(error.message || 'Could not verify profile uniqueness.');
    err.statusCode = 500;
    err.supabase = error;
    throw err;
  }
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

/**
 * @returns {Promise<boolean>} true if phone is already on another profile
 */
async function isPhoneNumberTaken(admin, phoneInput, excludeUserId = null) {
  const phone = normalizePhone(phoneInput);
  if (!phone || phone.length < 10) return false;
  const row = await findConflictingProfile(admin, [['phone_number', phone]], excludeUserId);
  return !!row;
}

/**
 * @returns {Promise<boolean>} true if CNIC is already on another profile
 */
async function isCnicTaken(admin, cnicInput, excludeUserId = null) {
  const digits = normalizeCnicDigits(cnicInput);
  if (digits.length !== 13) return false;

  const formatted = formatPakistaniCnic(digits);
  const attempts = [
    ['cnic', digits],
    ['id_card', digits],
    ['cnic_number', formatted],
    ['cnic_number', digits],
  ];

  for (const [col, val] of attempts) {
    const row = await findConflictingProfile(admin, [[col, val]], excludeUserId);
    if (row) return true;
  }
  return false;
}

/**
 * Throws with statusCode 409 and field/code for API + UI.
 */
async function assertRegistrationFieldsUnique(
  admin,
  { phoneNumber, cnic, excludeUserId } = {}
) {
  if (!admin) {
    const err = new Error('Supabase service role is not configured.');
    err.statusCode = 503;
    throw err;
  }

  const phone = normalizePhone(phoneNumber);
  if (phone) {
    const phoneTaken = await isPhoneNumberTaken(admin, phone, excludeUserId);
    if (phoneTaken) {
      const err = new Error('Phone number already registered');
      err.statusCode = 409;
      err.code = 'PHONE_ALREADY_REGISTERED';
      err.field = 'phoneNumber';
      throw err;
    }
  }

  const cnicDigits = normalizeCnicDigits(cnic);
  if (cnicDigits.length === 13) {
    const cnicTaken = await isCnicTaken(admin, cnicDigits, excludeUserId);
    if (cnicTaken) {
      const err = new Error('CNIC already registered');
      err.statusCode = 409;
      err.code = 'CNIC_ALREADY_REGISTERED';
      err.field = 'cnic';
      throw err;
    }
  }
}

module.exports = {
  normalizePhone,
  normalizeCnicDigits,
  isPhoneNumberTaken,
  isCnicTaken,
  assertRegistrationFieldsUnique,
};
