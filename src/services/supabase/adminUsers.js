import { fetchAdminProfiles, mapProfileRowToAppUser } from '../profileService';

function rowIsAdminFromDb(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.is_admin === true) return true;
  return String(row.role || '').toLowerCase() === 'admin';
}

export async function fetchAdminUsersSupabase() {
  console.log('[Bidify/adminUsers] fetchAdminProfiles');
  const rows = await fetchAdminProfiles();
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    username: row.username ?? '',
    phone: row.phone_number,
    role: rowIsAdminFromDb(row) ? 'admin' : 'user',
    cnic: row.cnic ?? '',
    cnicVerifiedAt: row.cnic_verified_at ?? null,
    cnicFrontUrl: row.cnic_front_url,
    cnicBackUrl: row.cnic_back_url,
    createdAt: row.created_at,
    walletBalance: Number(row.wallet_balance) || 0,
    appUser: mapProfileRowToAppUser(row, { email: row.email, id: row.id }),
  }));
}
