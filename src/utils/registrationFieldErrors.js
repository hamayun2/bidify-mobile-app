/**
 * Map API / backend registration uniqueness errors to form fields.
 */

export const PHONE_TAKEN_MESSAGE =
  'This phone number is already in use. Please check your number or log in.';

export const CNIC_TAKEN_MESSAGE =
  'This CNIC is already in use. Please check your number or log in.';

export function parseRegistrationFieldError(errOrMessage) {
  const code =
    errOrMessage?.response?.data?.code ||
    errOrMessage?.code ||
    null;
  const field =
    errOrMessage?.response?.data?.field ||
    errOrMessage?.field ||
    null;
  const message = String(
    errOrMessage?.response?.data?.message ||
      errOrMessage?.response?.data?.error ||
      errOrMessage?.message ||
      errOrMessage ||
      ''
  ).trim();
  const hay = `${code || ''} ${field || ''} ${message}`.toLowerCase();

  if (
    code === 'PHONE_ALREADY_REGISTERED' ||
    field === 'phoneNumber' ||
    field === 'phone' ||
    (hay.includes('phone') && hay.includes('already'))
  ) {
    return { field: 'phoneNumber', message: PHONE_TAKEN_MESSAGE };
  }

  if (
    code === 'CNIC_ALREADY_REGISTERED' ||
    field === 'cnic' ||
    field === 'cnicNumber' ||
    (hay.includes('cnic') && hay.includes('already')) ||
    (hay.includes('id card') && hay.includes('already'))
  ) {
    return { field: 'cnic', message: CNIC_TAKEN_MESSAGE };
  }

  return null;
}
