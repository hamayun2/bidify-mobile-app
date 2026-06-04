const express = require('express');
const multer = require('multer');
const { scanCnic } = require('../controllers/scanCnicController');
const { submitKyc, syncVerificationStatus } = require('../controllers/submitKycController');
const { checkRegistrationFields } = require('../controllers/checkRegistrationFields');

const router = express.Router();

/**
 * PUBLIC KYC routes — registered BEFORE any router.use(authRequired).
 * Signup/onboarding may call these without a valid JWT.
 */

const cnicImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed for CNIC scan.'));
    }
    cb(null, true);
  },
}).single('cnicFront');

function handleMulterErrors(err, req, res, next) {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    console.error('[profile/scan-cnic] Multer error:', err.code, err.message);
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Image must be 8 MB or smaller.'
        : err.message || 'Invalid file upload.';
    return res.status(400).json({ success: false, message });
  }
  console.error('[profile/scan-cnic] Upload error:', err.message);
  return res.status(400).json({
    success: false,
    message: err.message || 'Invalid file upload.',
  });
}

const imageOnlyFilter = (_req, file, cb) => {
  if (!file.mimetype || !file.mimetype.startsWith('image/')) {
    return cb(new Error('Only image files are allowed.'));
  }
  cb(null, true);
};

/** Selfie + CNIC front/back — public register-with-KYC multipart bundle. */
const registerKycUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: imageOnlyFilter,
}).fields([
  { name: 'selfie', maxCount: 1 },
  { name: 'cnicFront', maxCount: 1 },
  { name: 'cnicBack', maxCount: 1 },
]);

/**
 * Public — no authRequired / verifyJWT on this path (signup runs before login).
 * Multer field: cnicFront (unchanged).
 */
router.post('/scan-cnic', (req, res, next) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[profile/scan-cnic] route hit — no global auth guard on profile router');
  }
  cnicImageUpload(req, res, (err) => {
    if (err) return handleMulterErrors(err, req, res, next);
    return scanCnic(req, res);
  });
});

router.post('/submit-kyc', (req, res, next) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[profile/submit-kyc] public route — no authRequired on profile router');
  }
  registerKycUpload(req, res, (err) => {
    if (err) return handleMulterErrors(err, req, res, next);
    return submitKyc(req, res);
  });
});

/**
 * Protected sync — optional bearer (Supabase or Express bridge resolved in controller).
 * Kept after public routes; profile router never applies global authRequired.
 */
router.get('/verification-sync', syncVerificationStatus);

/** CNIC / phone uniqueness — same handler as POST /api/registration/check-fields */
router.post('/check-registration-fields', checkRegistrationFields);

module.exports = router;
