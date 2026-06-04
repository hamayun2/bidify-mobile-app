import { StyleSheet, Platform } from 'react-native';
import { HOME } from '../../constants/homePalette';

/** Twin-identical home listing card shell (auction + buy now). */
export const LISTING_CARD_SHELL = {
  width: HOME.listingCardWidth,
  marginRight: 20,
  outerRadius: HOME.listingCardOuterRadius,
  innerPadding: HOME.listingCardBodyPadding,
  imageHeight: HOME.listingCardImageHeight,
  imageRadius: 12,
  surface: '#FFFFFF',
  border: 'rgba(226, 232, 240, 0.5)',
  actionPanelRadius: 12,
  actionBottomGap: 8,
};

const CARD_SHADOW = Platform.select({
  ios: {
    shadowColor: HOME.listingCardShadow.shadowColor,
    shadowOffset: HOME.listingCardShadow.shadowOffset,
    shadowOpacity: HOME.listingCardShadow.shadowOpacity,
    shadowRadius: HOME.listingCardShadow.shadowRadius,
  },
  android: { elevation: HOME.listingCardShadow.elevation },
});

export const listingCardShellStyles = StyleSheet.create({
  cardOuter: {
    width: LISTING_CARD_SHELL.width,
    marginRight: LISTING_CARD_SHELL.marginRight,
    borderRadius: LISTING_CARD_SHELL.outerRadius,
    backgroundColor: LISTING_CARD_SHELL.surface,
    borderWidth: 1,
    borderColor: LISTING_CARD_SHELL.border,
    padding: LISTING_CARD_SHELL.innerPadding,
    paddingBottom: LISTING_CARD_SHELL.innerPadding + LISTING_CARD_SHELL.actionBottomGap,
    ...CARD_SHADOW,
  },
  cardPressable: {
    width: '100%',
  },
  imageFrame: {
    position: 'relative',
    width: '100%',
    height: LISTING_CARD_SHELL.imageHeight,
    borderRadius: LISTING_CARD_SHELL.imageRadius,
    overflow: 'hidden',
    backgroundColor: HOME.surface,
    marginBottom: 12,
  },
  image: {
    width: '100%',
    height: LISTING_CARD_SHELL.imageHeight,
  },
  imagePlaceholder: {
    width: '100%',
    height: LISTING_CARD_SHELL.imageHeight,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: HOME.surface,
  },
  metaBlock: {
    marginBottom: 12,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: HOME.charcoal,
    letterSpacing: -0.2,
    lineHeight: 20,
  },
  seller: {
    marginTop: 4,
    fontSize: 13,
    fontWeight: '500',
    color: '#64748B',
    lineHeight: 18,
  },
  actionPanel: {
    borderRadius: LISTING_CARD_SHELL.actionPanelRadius,
    backgroundColor: HOME.surface,
    borderWidth: 1,
    borderColor: HOME.divider,
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 14,
    gap: 12,
  },
  priceLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: HOME.charcoal,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  price: {
    fontSize: 28,
    fontWeight: '900',
    color: HOME.priceNavy,
    letterSpacing: -0.6,
    lineHeight: 32,
  },
  priceBlock: {
    gap: 4,
  },
  primaryActionWrap: {
    borderRadius: 14,
    overflow: 'hidden',
    marginBottom: 2,
    ...Platform.select({
      ios: {
        shadowColor: HOME.black,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.12,
        shadowRadius: 6,
      },
      android: { elevation: 3 },
    }),
  },
  primaryActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    minHeight: 50,
    gap: 8,
  },
  primaryActionText: {
    color: HOME.white,
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  primaryActionSheen: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '42%',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  primaryActionFill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#1E293B',
  },
});
