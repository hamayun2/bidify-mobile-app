import client, { API_URL, isAuxiliaryApiConfigured } from './client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  normalizeListing,
  unwrapListingsPayload,
  unwrapOneListing,
  isLocalDeviceMediaUri,
  isListingPubliclyVisible,
  isListingMarketplaceVisible,
} from '../utils/listingMedia';
import { recordPaymentActivity } from './adminFinance';
import { isSupabaseConfigured } from '../services/supabaseClient';
import {
  fetchListingsSupabase,
  fetchMyListingsSupabase,
  fetchAdminListingsSupabase,
  fetchListingByIdSupabase,
  setListingModerationSupabase,
  createListingWithSupabase,
  updateMyListing as updateMyListingSupabase,
  deleteMyListing as deleteMyListingSupabase,
} from '../services/listingsService';
import { computeAuctionEndIso, durationDaysForListing } from '../constants/auctionDuration';
import { placeBid as placeBidSupabase } from '../services/bidsService';
import { fetchListingWithSellerSummary } from '../services/sellerProfileService';
/** Union by id — primary first, then supplemental global/historical rows. */
function mergeListingsUnion(primary, supplemental) {
  const list = Array.isArray(primary) ? [...primary] : [];
  const seen = new Set(list.map((l) => String(l?.id)));
  for (const item of supplemental || []) {
    const normalized = normalizeListing(item);
    const id = String(normalized?.id);
    if (!id || seen.has(id)) continue;
    list.push(normalized);
    seen.add(id);
  }
  return list;
}

const marketplaceVisible = (listing) =>
  isListingMarketplaceVisible(listing) || isListingPubliclyVisible(listing);

async function fetchExpressGlobalListings() {
  if (!isAuxiliaryApiConfigured()) return [];
  try {
    const path = listingsResourcePath();
    const response = await client.get(path, { timeout: 8000, __skipAuth: true });
    const payload = parseResponseJson(response.data);
    const rows = unwrapListingsPayload(payload);
    let mapped = rows.map((item) => normalizeListing(item));
    mapped = mapped.filter(marketplaceVisible);
    return mapped;
  } catch (e) {
    if (__DEV__) console.warn('[getListingsAPI] Express global listings fallback', e?.message);
    return [];
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label} timed out after ${Math.round(ms / 1000)} seconds. Check your internet and try again.`
          )
        ),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Outer safety timeout for the WHOLE listing creation pipeline when using the Express API.
const CREATE_LISTING_OUTER_TIMEOUT_MS = 120000; // 2 minutes

/** Axios sometimes gives a string body; APIs occasionally stringify JSON. */
function parseResponseJson(body) {
  if (body == null) return body;
  if (typeof body === 'string') {
    const t = body.trim();
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return body;
    }
  }
  return body;
}

function guessImageMime(uri) {
  const lower = (uri || '').toLowerCase();
  if (lower.includes('.png')) return 'image/png';
  if (lower.includes('.webp')) return 'image/webp';
  if (lower.includes('.heic')) return 'image/heic';
  if (lower.includes('.gif')) return 'image/gif';
  return 'image/jpeg';
}

function fileNameFromUri(uri, index) {
  try {
    const segment = decodeURIComponent(uri.split('/').pop() || '');
    const base = segment.split('?')[0];
    if (base && base.includes('.')) return base;
  } catch (_) {}
  return `photo_${index}.jpg`;
}

/** Canonicalize the listing type for the backend.
 *  - 'auction' stays 'auction'
 *  - Anything else (including legacy 'buynow') becomes 'standard'.
 */
function canonicalListingType(rawType) {
  return rawType === 'auction' ? 'auction' : 'standard';
}

function buildListingFormData(listingData) {
  const form = new FormData();
  const {
    title,
    description,
    price,
    type,
    duration,
    sellerId,
    images,
    category,
    buyNowPrice,
  } = listingData;

  if (title != null) form.append('title', String(title));
  if (description != null) form.append('description', String(description));
  if (price != null) form.append('price', String(price));
  if (type != null) form.append('type', canonicalListingType(type));
  if (duration != null) form.append('duration', String(duration));
  if (sellerId != null) form.append('sellerId', String(sellerId));
  if (category != null) form.append('category', String(category));
  if (buyNowPrice != null) form.append('buyNowPrice', String(buyNowPrice));

  const imgs = Array.isArray(images) ? images : [];
  const remoteUrls = [];

  imgs.forEach((uri, index) => {
    if (uri == null || uri === '') return;
    if (isLocalDeviceMediaUri(uri)) {
      form.append('images', {
        uri,
        name: fileNameFromUri(uri, index),
        type: guessImageMime(uri),
      });
    } else {
      remoteUrls.push(uri);
    }
  });

  if (remoteUrls.length > 0) {
    form.append('remoteImageUrls', JSON.stringify(remoteUrls));
  }

  return form;
}

function listingsResourcePath() {
  const p = typeof process !== 'undefined' ? process.env?.EXPO_PUBLIC_LISTINGS_PATH : null;
  if (p && typeof p === 'string') {
    const t = p.trim();
    if (t) return t.startsWith('/') ? t : `/${t}`;
  }
  return '/listings';
}

function listingDetailPath(id) {
  const base = listingsResourcePath().replace(/\/$/, '');
  return `${base}/${encodeURIComponent(String(id))}`;
}

function myListingsPath() {
  const base = listingsResourcePath().replace(/\/$/, '');
  return `${base}/mine`;
}

function adminListingsCollectionPath() {
  const p = typeof process !== 'undefined' ? process.env?.EXPO_PUBLIC_ADMIN_LISTINGS_PATH : null;
  if (p && typeof p === 'string') {
    const t = p.trim();
    if (t) return t.startsWith('/') ? t : `/${t}`;
  }
  return '/admin/listings';
}

function adminListingItemPath(id) {
  const base = adminListingsCollectionPath().replace(/\/$/, '');
  return `${base}/${encodeURIComponent(String(id))}`;
}

function sortListingsNewestFirst(a, b) {
  const na = Number(a.id);
  const nb = Number(b.id);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return nb - na;
  return String(b.id).localeCompare(String(a.id));
}

async function mockListingsMutateById(id, applyFn) {
  const listingsStr = await AsyncStorage.getItem('mockListings');
  if (!listingsStr) return null;
  const arr = JSON.parse(listingsStr);
  if (!Array.isArray(arr)) return null;
  const idx = arr.findIndex((x) => String(x.id ?? x._id) === String(id));
  if (idx < 0) return null;
  const nextRow = applyFn(arr[idx]);
  arr[idx] = nextRow;
  await AsyncStorage.setItem('mockListings', JSON.stringify(arr));
  return normalizeListing(nextRow);
}

export const getListingsAPI = async (params = {}, options = {}) => {
  const { includeAllModeration = false } = options;
  if (isSupabaseConfigured()) {
    try {
      console.log('[getListingsAPI] Loading listings from Supabase');
      let mapped = await fetchListingsSupabase({
        includeAllModeration,
        marketplaceMode: true,
      });
      console.log('[getListingsAPI] Supabase returned', mapped.length, 'listings');
      if (mapped.length === 0 && isAuxiliaryApiConfigured()) {
        const fromApi = await fetchExpressGlobalListings();
        mapped = mergeListingsUnion([], fromApi);
        console.log('[getListingsAPI] Supabase empty — merged Express store feed', mapped.length);
      }
      return mapped;
    } catch (e) {
      console.error('[getListingsAPI] Supabase error', e?.message || e);
      if (isAuxiliaryApiConfigured()) {
        const fromApi = await fetchExpressGlobalListings();
        if (fromApi.length > 0) {
          console.log('[getListingsAPI] Supabase error — using Express store feed');
          return fromApi;
        }
      }
      throw e;
    }
  }
  try {
    const path = listingsResourcePath();
    const response = await client.get(path, {
      params,
      timeout: 6000,
    });
    const payload = parseResponseJson(response.data);
    const rows = unwrapListingsPayload(payload);
    if (
      __DEV__ &&
      (!rows || rows.length === 0) &&
      payload != null &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      Object.keys(payload).length > 0
    ) {
      console.warn(
        '[getListingsAPI] Unwrap found 0 listings. Top-level keys:',
        Object.keys(payload),
        'GET',
        path
      );
    }
    let mapped = rows.map((item) => normalizeListing(item));
    if (!includeAllModeration) {
      mapped = mapped.filter(marketplaceVisible);
    }
    return mapped;
  } catch (error) {
    if (error.message === 'Network Error' || error.message.includes('Network') || error.message.includes('timeout')) {
      console.warn('[getListingsAPI] Network error — no mock fallback; returning empty feed');
      return [];
    }
    throw error.response?.data || { message: 'Failed to fetch listings' };
  }
};

/** Listings created by the signed-in user. Tries GET /listings/mine when the backend supports it; otherwise filters the full listing set (offline mock). */
export const getMyListingsAPI = async (sellerId) => {
  if (sellerId == null || sellerId === '') return [];
  if (isSupabaseConfigured()) {
    try {
      console.log('[getMyListingsAPI] Supabase for seller', sellerId);
      const rows = await fetchMyListingsSupabase(sellerId);
      return rows.sort(sortListingsNewestFirst);
    } catch (e) {
      console.error('[getMyListingsAPI] Supabase error', e?.message || e);
      return [];
    }
  }
  const sid = String(sellerId);
  try {
    try {
      const response = await client.get(myListingsPath(), { timeout: 6000 });
      const payload = parseResponseJson(response.data);
      const rows = unwrapListingsPayload(payload);
      if (Array.isArray(rows)) {
        return rows.map((item) => normalizeListing(item)).sort(sortListingsNewestFirst);
      }
    } catch (_) {
      /* endpoint missing — fall back */
    }
    const all = await getListingsAPI({}, { includeAllModeration: true });
    if (!Array.isArray(all) || all.length === 0) return [];
    const mine = all.filter((l) => l.sellerId != null && String(l.sellerId) === sid);
    return mine.sort(sortListingsNewestFirst);
  } catch {
    return [];
  }
};

export const updateMyListingAPI = async (sellerId, listingId, patch) => {
  if (!sellerId || !listingId) throw new Error('Seller and listing id are required.');
  if (isSupabaseConfigured()) {
    const updated = await updateMyListingSupabase(sellerId, listingId, patch);
    return normalizeListing(updated);
  }
  const updated = await mockListingsMutateById(listingId, (row) => {
    if (String(row.sellerId) !== String(sellerId)) return row;
    const next = { ...row, ...patch, updatedAt: new Date().toISOString() };
    if (patch.price != null) next.price = Number(patch.price);
    if (patch.buyNowPrice != null) next.buyNowPrice = Number(patch.buyNowPrice) || undefined;
    return next;
  });
  if (!updated) {
    try {
      const response = await client.patch(listingDetailPath(listingId), patch, { timeout: 10000 });
      const payload = parseResponseJson(response.data);
      return normalizeListing(unwrapOneListing(payload) || payload?.listing);
    } catch (error) {
      throw error.response?.data || { message: 'Failed to update listing' };
    }
  }
  return updated;
};

export function getDeleteListingRequestUrl(listingId) {
  const path = listingDetailPath(listingId);
  const base = API_URL ? String(API_URL).replace(/\/$/, '') : '';
  return base ? `${base}${path}` : path;
}

export const deleteMyListingAPI = async (sellerId, listingId) => {
  const sid = String(sellerId ?? '').trim();
  const lid = String(listingId ?? '').trim();
  console.log('DEBUG: Sending Delete Request for ID:', lid, {
    sellerId: sid,
    listingIdType: typeof listingId,
    listingIdRaw: listingId,
  });
  if (!sid || !lid) throw new Error('Seller and listing id are required.');

  const requestPath = listingDetailPath(lid);
  const requestUrl = getDeleteListingRequestUrl(lid);
  console.log(
    `[deleteMyListingAPI] The request is going to ${requestUrl} with listingId=${lid} sellerId=${sid}`
  );

  if (isAuxiliaryApiConfigured()) {
    let response;
    try {
      response = await client.delete(requestPath, { timeout: 20000 });
    } catch (axiosErr) {
      const status = axiosErr?.response?.status;
      const data = parseResponseJson(axiosErr?.response?.data) || {};
      console.error('[deleteMyListingAPI] HTTP error', {
        status,
        message: data?.message || axiosErr?.message,
        listingId: lid,
        sellerId: sid,
        url: requestUrl,
      });
      throw new Error(data?.message || axiosErr?.message || `Delete failed with status ${status}.`);
    }
    const status = response.status;
    const data = parseResponseJson(response.data) || {};
    if (status !== 200 && status !== 204) {
      console.error('[deleteMyListingAPI] non-OK status', { status, data, listingId: lid });
      throw new Error(data?.message || `Delete failed with status ${status}.`);
    }
    if (data?.success === false) {
      throw new Error(data?.message || 'Could not delete listing.');
    }
    if (data?.deleted === false) {
      throw new Error(data?.message || 'Listing was not removed from the database.');
    }
    if (data?.deleted !== true) {
      throw new Error(data?.message || 'Server did not confirm database deletion.');
    }
    if (__DEV__) {
      console.log('[deleteMyListingAPI] server confirmed delete', listingId, data);
    }
    return {
      success: true,
      deleted: true,
      message: data?.message || 'Listing deleted successfully.',
      feeRefunded: !!data?.feeRefunded,
      sellerTotalAds: data?.sellerTotalAds ?? data?.total_ads ?? data?.totalListingsCount,
      ...data,
    };
  }

  if (isSupabaseConfigured()) {
    return deleteMyListingSupabase(sellerId, listingId);
  }

  const listingsStr = await AsyncStorage.getItem('mockListings');
  if (listingsStr) {
    const arr = JSON.parse(listingsStr);
    const next = arr.filter((x) => String(x.id ?? x._id) !== lid);
    if (next.length < arr.length) {
      await AsyncStorage.setItem('mockListings', JSON.stringify(next));
      return { success: true, message: 'Listing deleted successfully.' };
    }
  }

  throw { message: 'Could not delete listing. Check API connection and try again.' };
};

/** All listings for moderation (admin). Uses GET /admin/listings when backend is up; otherwise full mock list. */
export const getAdminListingsAPI = async () => {
  if (isSupabaseConfigured()) {
    try {
      console.log('[getAdminListingsAPI] Supabase');
      const rows = await fetchAdminListingsSupabase();
      return rows;
    } catch (e) {
      console.error('[getAdminListingsAPI] Supabase error', e?.message || e);
      throw e;
    }
  }
  const path = adminListingsCollectionPath();
  try {
    const response = await client.get(path, { timeout: 6000 });
    const payload = parseResponseJson(response.data);
    const rows = unwrapListingsPayload(payload);
    return rows.map((item) => normalizeListing(item));
  } catch (error) {
    const status = error?.response?.status;
    if (status === 401 || status === 403) {
      throw error.response?.data || { message: 'Admin access required' };
    }
    if (error.message === 'Network Error' || error.message.includes('Network') || error.message.includes('timeout')) {
      return getListingsAPI({}, { includeAllModeration: true });
    }
    try {
      return await getListingsAPI({}, { includeAllModeration: true });
    } catch {
      return [];
    }
  }
};

export const DEFAULT_REJECT_REASON =
  'Sorry, your product is not according to our guidelines.';

/**
 * Approve or reject a listing (admin). Tries PATCH /admin/listings/:id; updates local mock store when offline.
 * @param {'approved'|'rejected'} nextStatus
 * @param {{ reason?: string }} options Optional rejection reason; only used when rejecting.
 */
export const setListingModerationAPI = async (id, nextStatus, options = {}) => {
  const status = nextStatus === 'rejected' ? 'rejected' : 'approved';
  const reason =
    status === 'rejected'
      ? (typeof options.reason === 'string' && options.reason.trim()
          ? options.reason.trim()
          : DEFAULT_REJECT_REASON)
      : null;
  const nowIso = new Date().toISOString();
  const applyMockUpdate = (row) => ({
    ...row,
    moderationStatus: status,
    status: status === 'approved' ? 'active' : 'rejected',
    rejectionReason: status === 'rejected' ? reason : null,
    rejectedAt: status === 'rejected' ? nowIso : null,
    approvedAt: status === 'approved' ? nowIso : (row.approvedAt || null),
  });
  if (isSupabaseConfigured()) {
    try {
      console.log('[setListingModerationAPI] Supabase', id, status);
      const one = await setListingModerationSupabase(id, status, reason);
      return normalizeListing(one);
    } catch (e) {
      console.error('[setListingModerationAPI] Supabase error', e?.message || e);
      throw e;
    }
  }
  try {
    const body = {
      moderationStatus: status,
      status,
    };
    if (status === 'rejected') body.rejectionReason = reason;
    const response = await client.patch(adminListingItemPath(id), body);
    const payload = parseResponseJson(response.data);
    const one = unwrapOneListing(payload);
    if (one && typeof one === 'object') {
      await mockListingsMutateById(id, applyMockUpdate);
      return normalizeListing(one);
    }
    const updated = await mockListingsMutateById(id, applyMockUpdate);
    if (updated) return updated;
    return normalizeListing({
      id,
      moderationStatus: status,
      rejectionReason: status === 'rejected' ? reason : null,
    });
  } catch (error) {
    if (error.message === 'Network Error' || error.message.includes('Network') || error.message.includes('timeout')) {
      const updated = await mockListingsMutateById(id, applyMockUpdate);
      if (updated) return updated;
    }
    throw error.response?.data || { message: 'Failed to update listing' };
  }
};

export const getListingDetailsAPI = async (id) => {
  if (isSupabaseConfigured()) {
    try {
      console.log('[getListingDetailsAPI] Supabase', id);
      const { listing, sellerSummary } = await fetchListingWithSellerSummary(id);
      const normalized = normalizeListing(listing);
      if (sellerSummary) normalized.sellerSummary = sellerSummary;
      return normalized;
    } catch (e) {
      console.error('[getListingDetailsAPI] Supabase', e?.message || e);
      throw e?.message ? { message: String(e.message) } : e;
    }
  }
  try {
    const response = await client.get(listingDetailPath(id), { timeout: 8000, __skipAuth: true });
    const payload = parseResponseJson(response.data);
    const listing = normalizeListing(unwrapOneListing(payload) || payload?.listing);
    const sellerSummary = payload?.sellerSummary || null;
    if (sellerSummary) listing.sellerSummary = sellerSummary;
    return listing;
  } catch (error) {
    throw error.response?.data || { message: 'Failed to fetch listing details' };
  }
};

export const createListingAPI = async (listingData) => {
  if (__DEV__) {
    console.log('[createListingAPI] LISTING SUBMIT STARTED', {
      title: listingData?.title,
      category: listingData?.category,
      type: listingData?.type,
      imagesCount: Array.isArray(listingData?.images) ? listingData.images.length : 0,
      hasUserId: !!listingData?.userId,
    });
  }
  if (isSupabaseConfigured()) {
    try {
      console.log('[createListingAPI] Using Supabase pipeline');
      const data = await withTimeout(
        createListingWithSupabase(listingData),
        CREATE_LISTING_OUTER_TIMEOUT_MS,
        'Publishing the listing'
      );
      const listingId =
        data?.listingId ??
        data?.listing?.id ??
        data?.listing?._id ??
        null;
      if (!listingId) {
        throw new Error('Listing publish did not return a listing id. Please try again.');
      }
      const listing = data?.listing
        ? normalizeListing(data.listing)
        : normalizeListing({ id: listingId, ...data });
      if (!listing?.id) {
        throw new Error('Listing could not be confirmed. Please try again.');
      }
      if (__DEV__) console.log('[createListingAPI] Supabase success — confirmed id', listing.id);
      return { ...data, success: true, listingId: String(listing.id), listing };
    } catch (e) {
      console.error('[createListingAPI] Supabase FAILED', e?.message || e);
      throw e;
    }
  }
  try {
    const imgs = Array.isArray(listingData.images) ? listingData.images : [];
    const useMultipart = imgs.some((u) => u && isLocalDeviceMediaUri(u));

    // Canonicalize the type before sending so the backend receives 'standard' or 'auction' only.
    const normalizedData = {
      ...listingData,
      type: canonicalListingType(listingData.type),
    };

    const path = listingsResourcePath();
    const response = useMultipart
      ? await client.post(path, buildListingFormData(normalizedData), {
          timeout: 120000,
        })
      : await client.post(path, normalizedData, {
          timeout: 15000,
        });

    const data = parseResponseJson(response.data);
    if (data == null) return data;

    if (data.listing != null && typeof data.listing === 'object') {
      return { ...data, listing: normalizeListing(data.listing) };
    }

    const one = unwrapOneListing(data);
    if (
      one &&
      typeof one === 'object' &&
      (one.id != null || one._id != null || one.title != null)
    ) {
      return normalizeListing(one);
    }

    return data;
  } catch (error) {
    if (error.message === 'Network Error' || error.message.includes('Network') || error.message.includes('timeout')) {
      console.log('Backend not connected! Simulating successful listing creation...');
      
      // Get existing mock listings or use default DUMMY_FEATURED to initialize
      let currentListings = [];
      const listingsStr = await AsyncStorage.getItem('mockListings');
      if (listingsStr) {
        currentListings = JSON.parse(listingsStr);
      } else {
        // Initialize with basic dummy data if empty
        currentListings = [
          {
            id: '1',
            title: 'Vintage Rolex Submariner',
            price: 1000000,
            currentBid: 1450000,
            type: 'auction',
            moderationStatus: 'approved',
            endTime: new Date(Date.now() + 1000 * 60 * 60 * 24 * 2).toISOString(),
            image: 'https://images.unsplash.com/photo-1523170335258-f5ed11844a49?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
          },
        ];
      }
      
      const canonicalType = canonicalListingType(listingData.type);
      const durationValue =
        canonicalType === 'auction'
          ? String(listingData.duration != null ? listingData.duration : '3').trim()
          : null;
      const durationDays =
        canonicalType === 'auction' ? durationDaysForListing(durationValue) : null;

      const newListing = {
        ...listingData,
        type: canonicalType,
        duration: durationValue,
        id: Date.now().toString(),
        createdAt: new Date().toISOString(),
        moderationStatus: 'pending',
        currentBid: canonicalType === 'auction' ? listingData.price : undefined,
        // Auction listings may have an optional buy-now-during-auction price.
        // Standard listings have only a single asking price (no automated payment).
        buyNowPrice:
          canonicalType === 'auction' && listingData.buyNowPrice != null
            ? Number(listingData.buyNowPrice)
            : undefined,
        image: listingData.images && listingData.images.length > 0 ? listingData.images[0] : 'https://via.placeholder.com/150',
      };

      if (canonicalType === 'auction' && durationValue) {
        newListing.endTime = computeAuctionEndIso(durationValue);
        newListing.durationDays = durationDays;
      }
      
      const storedListing = normalizeListing(newListing);
      const updatedListings = [
        storedListing,
        ...currentListings.map((item) => normalizeListing(item)),
      ];
      await AsyncStorage.setItem('mockListings', JSON.stringify(updatedListings));

      return { success: true, listing: storedListing };
    }
    throw error.response?.data || { message: 'Failed to create listing' };
  }
};

export const placeBidAPI = async (listingId, amount, meta = {}) => {
  const amt = Number(amount);
  const id = listingId != null ? String(listingId).trim() : '';
  if (isSupabaseConfigured()) {
    try {
      const data = await placeBidSupabase(id, amt, {
        userId: meta.buyerId,
        startingPrice: Number(meta.startingPrice ?? meta.listingPrice ?? 0),
      });
      if (Number.isFinite(amt) && amt > 0) {
        await recordPaymentActivity({
          kind: 'auction_bid',
          listingId: id,
          listingTitle: meta.listingTitle,
          amount: amt,
          buyerId: meta.buyerId != null ? String(meta.buyerId) : undefined,
          buyerName: meta.buyerName,
          status: 'logged',
        });
      }
      return data != null && typeof data === 'object' ? data : { success: true, newBid: amt };
    } catch (error) {
      const msg = error?.message || String(error);
      console.error('[placeBidAPI] place_bid_with_wallet_lock FAILED — full error:', {
        message: msg,
        code: error?.code,
        insufficientBalance: error?.insufficientBalance,
        topUpRequired: error?.topUpRequired,
        bidTooLow: error?.bidTooLow,
        authRequired: error?.authRequired,
        raw: error,
      });
      throw error instanceof Error ? error : new Error(msg || 'Could not place bid.');
    }
  }

  try {
    const response = await client.post(`${listingDetailPath(id)}/bid`, { amount });
    const data = response.data;
    if (Number.isFinite(amt) && amt > 0) {
      await recordPaymentActivity({
        kind: 'auction_bid',
        listingId: id,
        listingTitle: meta.listingTitle,
        amount: amt,
        buyerId: meta.buyerId != null ? String(meta.buyerId) : undefined,
        buyerName: meta.buyerName,
        status: 'logged',
      });
    }
    return data;
  } catch (error) {
    const status = error?.response?.status;
    const data = error?.response?.data;
    if (status === 402 && data?.topUpRequired) {
      const err = new Error(data.message || 'Top-up required');
      err.topUpRequired = true;
      err.minBalance = data.minBalance;
      err.balance = data.balance;
      throw err;
    }
    if (status === 402 && data?.tokenRequired) {
      const err = new Error(data.message || 'Bid token required');
      err.tokenRequired = true;
      err.tokenAmount = data.tokenAmount;
      throw err;
    }
    if (error.message === 'Network Error' || error.message.includes('Network') || error.message.includes('timeout')) {
      console.log('Backend not connected! Simulating successful bid placement...');
      if (Number.isFinite(amt) && amt > 0) {
        await recordPaymentActivity({
          kind: 'auction_bid',
          listingId: id,
          listingTitle: meta.listingTitle,
          amount: amt,
          buyerId: meta.buyerId != null ? String(meta.buyerId) : undefined,
          buyerName: meta.buyerName,
          status: 'logged',
        });
      }
      return { success: true, newBid: amount };
    }
    const fallback = error.response?.data || { message: 'Failed to place bid' };
    const err = new Error(typeof fallback.message === 'string' ? fallback.message : 'Failed to place bid');
    Object.assign(err, fallback);
    throw err;
  }
};

export const buyNowAPI = async (listingId, meta = {}) => {
  const amt = Number(meta.amount);
  const logPurchase = async () => {
    if (!Number.isFinite(amt) || amt <= 0) return;
    await recordPaymentActivity({
      kind: 'buy_now',
      listingId: String(listingId),
      listingTitle: meta.listingTitle,
      amount: amt,
      buyerId: meta.buyerId != null ? String(meta.buyerId) : undefined,
      buyerName: meta.buyerName,
      status: 'completed',
    });
  };
  try {
    const response = await client.post(`${listingDetailPath(listingId)}/buy-now`);
    await logPurchase();
    return response.data;
  } catch (error) {
    if (error.message === 'Network Error' || error.message.includes('Network') || error.message.includes('timeout')) {
      console.log('Backend not connected! Simulating successful purchase...');
      await logPurchase();
      return { success: true };
    }
    throw error.response?.data || { message: 'Failed to process purchase' };
  }
};
