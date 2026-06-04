import { Platform } from 'react-native';
import client, { isAuxiliaryApiConfigured } from './client';
import { formatPakistaniCnic } from '../utils/cnicFormat';
import { extractKycSessionToken } from '../utils/kycPostSubmitAuth';

async function appendImageWeb(fd, field, uri, filename) {
  const res = await fetch(uri);
  const blob = await res.blob();
  const ext = (blob.type && blob.type.split('/').pop()) || 'jpg';
  fd.append(field, blob, filename || `${field}.${ext}`);
}

function appendImageNative(fd, field, uri, filename) {
  const ext = (uri.split('.').pop() || 'jpg').split('?')[0].toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  fd.append(field, { uri, name: filename || `${field}.${ext}`, type: mime });
}

function normalizeSignupRegistration(registration) {
  if (!registration || typeof registration !== 'object') return null;
  const email = String(registration.email || '').trim();
  const password = String(registration.password || '');
  if (!email || !password) return null;
  return {
    email,
    password,
    confirmPassword: String(registration.confirmPassword || password),
    firstName: String(registration.firstName || registration.first_name || '').trim(),
    lastName: String(registration.lastName || registration.last_name || '').trim(),
    fullName:
      registration.fullName ||
      registration.name ||
      [registration.firstName || registration.first_name, registration.lastName || registration.last_name]
        .filter(Boolean)
        .join(' '),
    name:
      registration.name ||
      registration.fullName ||
      [registration.firstName, registration.lastName].filter(Boolean).join(' '),
    phoneNumber: registration.phoneNumber || registration.phone_number || registration.phone || '',
    phone: registration.phone || registration.phoneNumber || registration.phone_number || '',
    cnicNumber: registration.cnicNumber || registration.cnic_number || registration.cnic || '',
    cnic: registration.cnic || registration.cnicNumber || registration.cnic_number || '',
  };
}

/**
 * KYC scan payload — CNIC + identity fields only (no phone; stored at signup).
 */
export function normalizeScanData(scanData) {
  if (!scanData || typeof scanData !== 'object') return {};
  const cnicRaw = String(
    scanData.cnic || scanData.cnicNumber || ''
  ).trim();
  return {
    name: String(scanData.name || '').trim(),
    fatherName: String(scanData.fatherName || '').trim(),
    cnic: formatPakistaniCnic(cnicRaw),
    cnicNumber: formatPakistaniCnic(cnicRaw),
    dob: String(scanData.dob || '').trim(),
    address: String(scanData.address || '').trim(),
    cnicFrontUri: scanData.cnicFrontUri || null,
    cnicBackUri: scanData.cnicBackUri || null,
  };
}

/**
 * OCR CNIC front image via POST /api/profile/scan-cnic (SmartRun local OCR on server).
 */
export async function scanCnicAPI(imageUri, { registration } = {}) {
  if (!imageUri) {
    throw new Error('No image to scan.');
  }
  if (!isAuxiliaryApiConfigured()) {
    throw new Error(
      'CNIC scanner API is not configured. Set EXPO_PUBLIC_API_URL (e.g. http://YOUR_PC_IP:4000/api) and run npm run api.'
    );
  }

  const fd = new FormData();
  if (Platform.OS === 'web') {
    await appendImageWeb(fd, 'cnicFront', imageUri, 'cnic-front.jpg');
  } else {
    appendImageNative(fd, 'cnicFront', imageUri, 'cnic-front.jpg');
  }

  const signupRegistration = normalizeSignupRegistration(registration);
  if (signupRegistration) {
    fd.append('registration', JSON.stringify(signupRegistration));
  }

  const { data } = await client.post('/profile/scan-cnic', fd, {
    timeout: 45000,
    headers: { 'Content-Type': 'multipart/form-data' },
    __skipAuth: true,
  });

  if (!data?.success) {
    throw new Error(data?.message || data?.error || 'Could not extract CNIC details from the image.');
  }

  return {
    cnic: formatPakistaniCnic(data.cnic || ''),
    name: String(data.name || '').trim(),
    fatherName: String(data.fatherName || '').trim(),
    dob: String(data.dob || '').trim(),
    address: String(data.address || '').trim(),
  };
}

/**
 * Submit KYC: selfie + CNIC scan data.
 * - Logged-in retry/resubmit: JWT identifies user (no email/password).
 * - First-time signup: pass signupRegistration from Register (email + password).
 */
export async function submitKycAPI({
  selfieUri,
  scanData: scanDataProp,
  cnicNumber,
  cnicFrontUri,
  cnicBackUri,
  isRealFace = true,
  signupRegistration = null,
  /** Logged-in KYC retry — profile update only (no signup fields). */
  profileUserId = null,
}) {
  if (!selfieUri) throw new Error('Live selfie is required.');
  if (!isAuxiliaryApiConfigured()) {
    throw new Error(
      'KYC API is not configured. Set EXPO_PUBLIC_API_URL and run npm run api.'
    );
  }

  const scanData = normalizeScanData(scanDataProp);
  const cnicRaw = String(cnicNumber || scanData.cnicNumber || scanData.cnic || '').trim();
  if (cnicRaw) {
    const formatted = formatPakistaniCnic(cnicRaw);
    scanData.cnic = formatted;
    scanData.cnicNumber = formatted;
  }

  const digits = String(scanData.cnicNumber || '').replace(/\D/g, '');
  if (digits.length !== 13) {
    throw new Error('CNIC number is required (13 digits).');
  }

  const frontUri = cnicFrontUri || scanData.cnicFrontUri;
  const backUri = cnicBackUri || scanData.cnicBackUri;
  if (frontUri) scanData.cnicFrontUri = frontUri;
  if (backUri) scanData.cnicBackUri = backUri;

  const registration = normalizeSignupRegistration(signupRegistration);
  const isSignupFlow = !!registration;

  const fd = new FormData();
  if (Platform.OS === 'web') {
    await appendImageWeb(fd, 'selfie', selfieUri, 'selfie.jpg');
    if (frontUri) await appendImageWeb(fd, 'cnicFront', frontUri, 'cnic-front.jpg');
    if (backUri) await appendImageWeb(fd, 'cnicBack', backUri, 'cnic-back.jpg');
  } else {
    appendImageNative(fd, 'selfie', selfieUri, 'selfie.jpg');
    if (frontUri) appendImageNative(fd, 'cnicFront', frontUri, 'cnic-front.jpg');
    if (backUri) appendImageNative(fd, 'cnicBack', backUri, 'cnic-back.jpg');
  }

  fd.append('scanData', JSON.stringify(scanData));
  if (scanData.name) fd.append('name', scanData.name);
  if (scanData.fatherName) fd.append('fatherName', scanData.fatherName);
  if (scanData.cnic) fd.append('cnic', scanData.cnic);
  if (scanData.cnicNumber) fd.append('cnicNumber', scanData.cnicNumber);
  if (scanData.dob) fd.append('dob', scanData.dob);
  if (scanData.address) fd.append('address', scanData.address);

  if (isSignupFlow) {
    const signupJson = JSON.stringify(registration);
    fd.append('signupPayload', signupJson);
    fd.append('registration', signupJson);
    fd.append('email', registration.email);
    fd.append('password', registration.password);
    if (registration.firstName) fd.append('firstName', registration.firstName);
    if (registration.lastName) fd.append('lastName', registration.lastName);
    if (registration.phoneNumber) fd.append('phoneNumber', registration.phoneNumber);
    if (registration.cnicNumber) fd.append('cnicNumber', registration.cnicNumber);
  } else {
    fd.append('sessionKyc', 'true');
    if (profileUserId) {
      fd.append('profileUserId', String(profileUserId));
    }
  }

  if (isRealFace) {
    fd.append('isRealFace', 'true');
  }

  const postConfig = {
    timeout: 60000,
    headers: { 'Content-Type': 'multipart/form-data' },
  };
  if (isSignupFlow) {
    postConfig.__skipAuth = true;
  }

  let data;
  try {
    const res = await client.post('/profile/submit-kyc', fd, postConfig);
    data = res.data;
  } catch (httpErr) {
    const payload = httpErr?.response?.data;
    const err = new Error(
      payload?.message || payload?.error || httpErr?.message || 'KYC submission failed.'
    );
    err.code = payload?.code;
    err.field = payload?.field;
    err.response = httpErr.response;
    throw err;
  }

  if (!data?.success) {
    const err = new Error(data?.message || data?.error || 'KYC submission failed.');
    err.code = data?.code;
    err.field = data?.field;
    throw err;
  }

  const token = extractKycSessionToken(data);
  if (token) {
    return { ...data, token, accessToken: token, access_token: token };
  }

  return data;
}

/**
 * Sync verification status (runs Mock NADRA auto-verify on server when window elapsed).
 */
export async function syncVerificationStatusAPI() {
  if (!isAuxiliaryApiConfigured()) return null;
  try {
    const { data } = await client.get('/profile/verification-sync', { timeout: 20000 });
    return data?.success ? data : null;
  } catch (e) {
    if (__DEV__) {
      console.warn(
        '[syncVerificationStatusAPI]',
        e?.response?.data?.message || e?.message
      );
    }
    throw e;
  }
}
