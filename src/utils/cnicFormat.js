/**
 * Normalize Pakistani CNIC to XXXXX-XXXXXXX-X when 13 digits are present.
 */
export function formatPakistaniCnic(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const dashed = raw.match(/^(\d{5})-(\d{7})-(\d)$/);
  if (dashed) return `${dashed[1]}-${dashed[2]}-${dashed[3]}`;
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 13) return raw;
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
}
