const BUCKET_CNIC = 'cnic_images';

function extFromMime(mimetype) {
  const m = String(mimetype || '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  return 'jpg';
}

/**
 * Upload CNIC image buffer via service role (public onboarding — no client JWT).
 */
async function uploadCnicBuffer(admin, userId, side, file) {
  if (!admin || !userId || !file?.buffer) return null;
  const ext = extFromMime(file.mimetype);
  const path = `${userId}/${side}.${ext}`;
  const { error } = await admin.storage.from(BUCKET_CNIC).upload(path, file.buffer, {
    contentType: file.mimetype || 'image/jpeg',
    upsert: true,
  });
  if (error) {
    console.warn(`[cnicStorage] upload ${side} failed:`, error.message);
    return null;
  }
  const { data } = admin.storage.from(BUCKET_CNIC).getPublicUrl(path);
  return data?.publicUrl || null;
}

module.exports = {
  BUCKET_CNIC,
  uploadCnicBuffer,
};
