import React from 'react';
import { useListingsSync, resolveListingId } from '../context/ListingsSyncContext';
import DeleteListingConfirmModal from './DeleteListingConfirmModal';
import { getListingDisplayTitle } from './listings/AuctionListingCard';

/**
 * SINGLE delete modal mount point for the entire app (see App.js).
 * Do not render DeleteListingConfirmModal anywhere else.
 */
export default function GlobalDeleteListingModal() {
  const {
    deleteModalVisible,
    deleteTarget,
    performDelete,
    closeDeleteListingModal,
    deletingListingId,
  } = useListingsSync();

  const listingId = resolveListingId(deleteTarget);

  if (!deleteModalVisible) {
    return null;
  }

  return (
    <DeleteListingConfirmModal
      visible
      listingTitle={deleteTarget ? getListingDisplayTitle(deleteTarget) : ''}
      listingId={listingId}
      performDelete={performDelete}
      onCancel={closeDeleteListingModal}
      loading={!!deletingListingId}
    />
  );
}
