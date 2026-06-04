import AsyncStorage from '@react-native-async-storage/async-storage';

const SIGNUP_DRAFT_KEY = 'bidify_kyc_signup_draft_v1';

/**
 * Persist Register → KycScan → KycSelfie credentials (navigation params can be dropped).
 */
export async function saveKycSignupDraft(draft) {
  if (!draft || typeof draft !== 'object') return;
  const email = String(draft.email || '').trim();
  const password = String(draft.password || '');
  if (!email) return;
  const payload = {
    email,
    password,
    confirmPassword: String(draft.confirmPassword || password),
    firstName: String(draft.firstName || draft.first_name || '').trim(),
    lastName: String(draft.lastName || draft.last_name || '').trim(),
    fullName: String(draft.fullName || draft.name || '').trim(),
    name: String(draft.name || draft.fullName || '').trim(),
    phoneNumber: String(draft.phoneNumber || draft.phone_number || draft.phone || '').replace(/\D/g, ''),
    phone: String(draft.phone || draft.phoneNumber || draft.phone_number || '').replace(/\D/g, ''),
  };
  await AsyncStorage.setItem(SIGNUP_DRAFT_KEY, JSON.stringify(payload));
}

export async function loadKycSignupDraft() {
  try {
    const raw = await AsyncStorage.getItem(SIGNUP_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.email) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function clearKycSignupDraft() {
  await AsyncStorage.removeItem(SIGNUP_DRAFT_KEY);
}

/** Merge route params + stored draft (route wins when present). */
export async function resolveKycSignupPayload(routeRegistration, scanData = {}) {
  const stored = await loadKycSignupDraft();
  const route = routeRegistration && typeof routeRegistration === 'object' ? routeRegistration : {};
  const merged = {
    ...stored,
    ...route,
    email: String(route.email || stored?.email || '').trim(),
    password: String(route.password || stored?.password || ''),
    confirmPassword: String(
      route.confirmPassword || route.password || stored?.confirmPassword || stored?.password || ''
    ),
    firstName: String(route.firstName || route.first_name || stored?.firstName || '').trim(),
    lastName: String(route.lastName || route.last_name || stored?.lastName || '').trim(),
    fullName:
      route.fullName ||
      route.name ||
      stored?.fullName ||
      [route.firstName || stored?.firstName, route.lastName || stored?.lastName]
        .filter(Boolean)
        .join(' '),
    phoneNumber:
      route.phoneNumber ||
      route.phone ||
      stored?.phoneNumber ||
      stored?.phone ||
      '',
    phone:
      route.phone ||
      route.phoneNumber ||
      stored?.phone ||
      stored?.phoneNumber ||
      '',
    cnicNumber: String(
      scanData.cnicNumber || scanData.cnic || route.cnicNumber || route.cnic || ''
    ).trim(),
    cnic: String(scanData.cnic || scanData.cnicNumber || route.cnic || '').trim(),
  };
  return merged;
}
