/**
 * Server-side uniqueness checks (avoids circular imports with api/registration.js).
 */
import client, { isAuxiliaryApiConfigured } from '../api/client';
import {
  CNIC_TAKEN_MESSAGE,
  PHONE_TAKEN_MESSAGE,
} from '../utils/registrationFieldErrors';

export async function assertPhoneNotRegistered(phoneNumber, excludeUserId) {
  if (!isAuxiliaryApiConfigured()) return;
  const { data } = await client.post(
    '/profile/check-registration-fields',
    { phoneNumber, excludeUserId },
    { timeout: 10000, __skipAuth: true }
  );
  if (data?.phone?.available === false) {
    throw new Error(data.phone.reason || PHONE_TAKEN_MESSAGE);
  }
}

export async function assertCnicNotRegistered(cnic, excludeUserId) {
  if (!isAuxiliaryApiConfigured()) return;
  const { data } = await client.post(
    '/profile/check-registration-fields',
    { cnic, excludeUserId },
    { timeout: 10000, __skipAuth: true }
  );
  if (data?.cnic?.available === false) {
    throw new Error(data.cnic.reason || CNIC_TAKEN_MESSAGE);
  }
}
