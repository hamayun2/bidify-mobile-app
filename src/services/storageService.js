import { getSupabase, BUCKET_CNIC_IMAGES, BUCKET_LISTING_IMAGES } from './supabaseClient';
import { logSupabaseError } from './supabaseErrors';
import { extFromUri, mimeFromExt, readUriAsUploadBody } from '../utils/storageUpload';

export async function uploadCnicImage(userId, side, uri) {
  const supabase = getSupabase();
  const ext = extFromUri(uri);
  const path = `${userId}/${side}.${ext}`;
  console.log('[Bidify/storageService] uploadCnic', path);
  const body = await readUriAsUploadBody(uri);
  const { error } = await supabase.storage.from(BUCKET_CNIC_IMAGES).upload(path, body, {
    contentType: mimeFromExt(ext),
    upsert: true,
  });
  if (error) {
    logSupabaseError('storage.cnic upload', error);
    throw new Error(error.message || 'CNIC upload failed.');
  }
  const { data: pub } = supabase.storage.from(BUCKET_CNIC_IMAGES).getPublicUrl(path);
  console.log('[Bidify/storageService] uploadCnic OK');
  return pub?.publicUrl || null;
}

export async function uploadListingImage(userId, uri, index = 0) {
  const supabase = getSupabase();
  const ext = extFromUri(uri);
  const path = `${userId}/${Date.now()}-${index}.${ext}`;
  console.log('[Bidify/storageService] uploadListing', path);
  const body = await readUriAsUploadBody(uri);
  const { error } = await supabase.storage.from(BUCKET_LISTING_IMAGES).upload(path, body, {
    contentType: mimeFromExt(ext),
    upsert: false,
  });
  if (error) {
    logSupabaseError('storage.listing upload', error);
    throw new Error(error.message || 'Listing image upload failed.');
  }
  const { data: pub } = supabase.storage.from(BUCKET_LISTING_IMAGES).getPublicUrl(path);
  return pub?.publicUrl || null;
}
