import { getSupabase, isSupabaseConfigured } from '../services/supabaseClient';
import { mapListingRowToApp } from '../services/listingsService';
import { isListingMarketplaceVisible } from './listingMedia';
import { logPostgrestError } from '../services/supabaseErrors';

/**
 * Related listings in the same category (UI-only read).
 * Schema uses `category` text; also tries `category_id` when provided as a distinct column.
 *
 * Equivalent SQL:
 *   SELECT * FROM listings
 *   WHERE category = :categoryId AND id != :currentId AND status = 'active'
 *   LIMIT 6;
 */
export async function fetchRelatedAds(categoryId, currentId) {
  if (!isSupabaseConfigured()) return [];

  const categoryKey = categoryId != null ? String(categoryId).trim() : '';
  const listingId = currentId != null ? String(currentId).trim() : '';
  if (!categoryKey || !listingId) return [];

  const supabase = getSupabase();
  if (!supabase) return [];

  const runQuery = (column) =>
    supabase
      .from('listings')
      .select('*')
      .eq(column, categoryKey)
      .neq('id', listingId)
      .eq('status', 'active')
      .limit(6);

  let { data, error } = await runQuery('category');

  if (error) {
    const retry = await runQuery('category_id');
    data = retry.data;
    error = retry.error;
  }
  if (error) {
    logPostgrestError('listings.select.related', error, { categoryKey, listingId });
    return [];
  }

  const rows = Array.isArray(data) ? data : [];
  return rows
    .map(mapListingRowToApp)
    .filter((row) => row && isListingMarketplaceVisible(row));
}
