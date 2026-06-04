/**
 * KYC auto-verification — Mock NADRA CNIC range (5-minute window).
 * @see mockNadraCnic.js
 */
const {
  FIVE_MINUTES_MS,
  MOCK_NADRA_DELAY_MS,
  isCnicValid,
  processMockNadraReview,
  sweepMockNadraUnderReview,
  scheduleMockNadraVerification,
} = require('./mockNadraCnic');

const REVIEW_MS = MOCK_NADRA_DELAY_MS;

async function maybeAutoVerifyProfile(admin, profileRow) {
  return processMockNadraReview(admin, profileRow);
}

async function sweepAutoVerifyUnderReviewProfiles(admin) {
  const result = await sweepMockNadraUnderReview(admin);
  return { checked: result.checked, verified: result.updated };
}

module.exports = {
  FIVE_MINUTES_MS,
  REVIEW_MS,
  MOCK_NADRA_DELAY_MS,
  isCnicValid,
  maybeAutoVerifyProfile,
  sweepAutoVerifyUnderReviewProfiles,
  scheduleMockNadraVerification,
  processMockNadraReview,
  sweepMockNadraUnderReview,
};
