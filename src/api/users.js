import {
  fetchSellerPublicProfile,
  fetchSellerListings,
} from '../services/sellerProfileService';

export async function getSellerPublicProfileAPI(userId) {
  return fetchSellerPublicProfile(userId);
}

export async function getSellerListingsAPI(userId) {
  return fetchSellerListings(userId);
}
