/**
 * Read local file URIs for Supabase Storage upload (React Native + web).
 */
export async function readUriAsUploadBody(uri) {
  const res = await fetch(uri);
  if (!res.ok) {
    throw new Error(`Could not read file (${res.status}).`);
  }
  if (typeof res.arrayBuffer === 'function') {
    const buffer = await res.arrayBuffer();
    if (buffer?.byteLength > 0) return buffer;
  }
  const blob = await res.blob();
  if (blob?.size > 0) return blob;
  throw new Error('Could not read image data from device.');
}

export function extFromUri(uri) {
  const lower = String(uri || '').toLowerCase();
  if (lower.includes('.png')) return 'png';
  if (lower.includes('.webp')) return 'webp';
  if (lower.includes('.heic')) return 'heic';
  return 'jpg';
}

export function mimeFromExt(ext) {
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic') return 'image/heic';
  return 'image/jpeg';
}
