import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ListingCoverImage } from '../ListingCoverImage';
import { resolveListingCoverForDisplay } from '../../utils/listingMedia';
import { getListingDisplayTitle, getListingSellerLabel } from './AuctionListingCard';
import { HOME } from '../../constants/homePalette';
import { listingCardShellStyles as shell } from './listingCardShellStyles';

function formatRs(n) {
  const x = Number(n ?? 0);
  return Number.isFinite(x) ? `Rs. ${x.toLocaleString()}` : 'Rs. —';
}

export default function StandardListingCard({ listing, onPress, onChat: _onChat, recycleKey }) {
  const cover = useMemo(() => resolveListingCoverForDisplay(listing), [listing]);
  const displayTitle = getListingDisplayTitle(listing);
  const sellerLabel = getListingSellerLabel(listing);
  const price = Number(listing?.buyNowPrice ?? listing?.price ?? 0);

  const openDetail = (e) => {
    e?.stopPropagation?.();
    if (onPress) onPress();
  };

  return (
    <View style={shell.cardOuter}>
      <TouchableOpacity style={shell.cardPressable} activeOpacity={0.94} onPress={onPress}>
        <View style={shell.imageFrame}>
          {cover ? (
            <ListingCoverImage uri={cover} style={shell.image} recycleKey={recycleKey} />
          ) : (
            <View style={shell.imagePlaceholder}>
              <Ionicons name="image-outline" size={40} color="#94A3B8" />
            </View>
          )}
        </View>

        <View style={shell.metaBlock}>
          <Text style={shell.title} numberOfLines={2}>
            {displayTitle}
          </Text>
          {sellerLabel ? (
            <Text style={shell.seller} numberOfLines={1}>
              {sellerLabel}
            </Text>
          ) : null}
        </View>

        <View style={shell.actionPanel}>
          <View style={shell.priceBlock}>
            <Text style={shell.priceLabel}>Buy now</Text>
            <Text style={shell.price}>{formatRs(price)}</Text>
          </View>
          <TouchableOpacity
            style={shell.primaryActionWrap}
            activeOpacity={0.88}
            onPress={openDetail}
          >
            <View style={shell.primaryActionFill} pointerEvents="none" />
            <View style={shell.primaryActionSheen} pointerEvents="none" />
            <View style={shell.primaryActionBtn}>
              <Text style={shell.primaryActionText}>View Ad</Text>
              <Ionicons name="arrow-forward" size={16} color={HOME.white} />
            </View>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </View>
  );
}
