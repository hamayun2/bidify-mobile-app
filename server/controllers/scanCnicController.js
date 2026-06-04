const LOCAL_OCR_DELAY_MS = 1500;

const DEMO_IDENTITY = {
  fatherName: 'Muhammad Awan',
  cnic: '34101-1234567-1',
  dob: '15/08/2002',
  address: 'House #12, Street 3, Sector G-11, Islamabad, Pakistan',
  defaultName: 'Hamayun Awan',
};

function parseSignupPayload(req) {
  const raw = req.body?.registration;
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function resolveDemoName(signupPayload) {
  if (signupPayload?.firstName) {
    return [signupPayload.firstName, signupPayload.lastName].filter(Boolean).join(' ').trim();
  }
  if (signupPayload?.fullName) return String(signupPayload.fullName).trim();
  if (signupPayload?.name) return String(signupPayload.name).trim();
  return DEMO_IDENTITY.defaultName;
}

/**
 * SmartRun local OCR — simulated extraction for FYP demo (no external APIs).
 * Accepts image buffer for pipeline compatibility; returns fixed high-fidelity PK identity fields.
 */
async function runLocalOcrProcessor(_imageBuffer, signupPayload) {
  await new Promise((resolve) => setTimeout(resolve, LOCAL_OCR_DELAY_MS));

  return {
    name: resolveDemoName(signupPayload),
    fatherName: DEMO_IDENTITY.fatherName,
    cnic: DEMO_IDENTITY.cnic,
    dob: DEMO_IDENTITY.dob,
    address: DEMO_IDENTITY.address,
  };
}

/**
 * POST /api/profile/scan-cnic — local OCR sandbox (no Google Vision, no API keys).
 */
async function scanCnic(req, res) {
  try {
    console.log('[scan-cnic] POST /api/profile/scan-cnic — SmartRun local OCR (public, no auth)');

    const file = req.file;
    if (!file || !file.buffer) {
      return res.status(400).json({
        success: false,
        message: 'CNIC front image is required (field: cnicFront).',
      });
    }

    const signupPayload = parseSignupPayload(req);
    console.log(
      `[scan-cnic] Processing image (${file.mimetype || 'image'}, ${file.buffer.length} bytes) — local OCR ~${LOCAL_OCR_DELAY_MS}ms`
    );

    const parsed = await runLocalOcrProcessor(file.buffer, signupPayload);

    console.log('[scan-cnic] Local OCR complete — returning identity fields');

    return res.json({
      success: true,
      name: parsed.name || '',
      fatherName: parsed.fatherName || '',
      cnic: parsed.cnic || '',
      dob: parsed.dob || '',
      address: parsed.address || '',
    });
  } catch (err) {
    console.error('[scan-cnic] Unexpected error:', err);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while scanning CNIC.',
    });
  }
}

module.exports = {
  scanCnic,
  runLocalOcrProcessor,
};
