import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Image,
  Platform,
  Pressable,
  useWindowDimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import BidifyLogoMark from './BidifyLogoMark';

const PROFILE_ICON = '#333333';
const LABEL_GREY = '#333333';
const NOTIF_GOLD = '#FF8C00';
const WALLET_BRONZE = ['#6B3A12', '#8B4513', '#A0522D', '#CD853F'];
const HEADER_BG = '#FBF7EE';
const HEADER_BORDER = '#EBE3D4';
const ICON_SIZE = 44;
const ICON_SIZE_ACTION = 36;
const ICON_GLYPH = 22;
const ICON_GLYPH_ACTION = 18;
const LABEL_SLOT = 14;
const SIDE_GAP = 8;
const LABEL_FONT_SIZE = 10;
const H_PAD = 16;
const COL_NOTIF = 72;
const COL_ACTION = 48;
const ACTION_RADIUS = 12;
const ACTION_INNER_RADIUS = 9;

const LAYER_SHADOW = Platform.select({
  ios: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
  },
  android: { elevation: 1 },
});

const HEADER_DIVIDER = Platform.select({
  ios: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
  },
  android: { elevation: 2 },
  default: {
    borderBottomWidth: 1,
    borderBottomColor: '#E8ECF0',
  },
});

function LayeredIconShell({ children, round = false, style, innerStyle }) {
  return (
    <View style={[styles.layeredShell, round && styles.layeredShellRound, style]}>
      <View style={[styles.layeredInner, round && styles.layeredInnerRound, innerStyle]}>
        {children}
      </View>
    </View>
  );
}

function HeaderColumn({ label, accessibilityLabel, onPress, children, testID, columnStyle }) {
  const scale = useRef(new Animated.Value(1)).current;
  const a11y = accessibilityLabel || label;
  const body = (
    <View style={[styles.column, columnStyle]}>
      <Animated.View style={[styles.iconSlot, { transform: [{ scale }] }]}>{children}</Animated.View>
      {label ? (
        <Text style={styles.actionLabel} numberOfLines={1}>
          {label}
        </Text>
      ) : (
        <View style={styles.labelSpacer} />
      )}
    </View>
  );

  if (!onPress) return body;

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => {
        Animated.spring(scale, { toValue: 0.94, friction: 7, useNativeDriver: true }).start();
      }}
      onPressOut={() => {
        Animated.spring(scale, { toValue: 1, friction: 7, useNativeDriver: true }).start();
      }}
      style={styles.columnPressable}
      testID={testID}
      accessibilityLabel={a11y}
      accessibilityRole="button"
    >
      {body}
    </Pressable>
  );
}

function WalletIconButton({ onPress }) {
  return (
    <HeaderColumn label="Wallet" onPress={onPress} testID="home-wallet-btn" columnStyle={styles.colAction}>
      <View style={styles.walletOuter}>
        <LinearGradient
          colors={WALLET_BRONZE}
          locations={[0, 0.35, 0.72, 1]}
          start={{ x: 0.1, y: 0 }}
          end={{ x: 0.9, y: 1 }}
          style={styles.walletFill}
        >
          <LinearGradient
            colors={['rgba(255,255,255,0.35)', 'rgba(255,255,255,0.05)', 'transparent']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.walletSheen}
            pointerEvents="none"
          />
          <Ionicons name="wallet" size={ICON_GLYPH_ACTION} color="#FFF8F0" />
        </LinearGradient>
      </View>
    </HeaderColumn>
  );
}

function NotificationButton({ count, onPress }) {
  const n = Number(count) || 0;
  const badgeLabel = n > 99 ? '99+' : String(n);

  return (
    <HeaderColumn
      label="Notifications"
      accessibilityLabel="Notifications"
      onPress={onPress}
      testID="home-notifications-btn"
      columnStyle={styles.colNotif}
    >
      <View style={styles.badgeAnchor}>
        <LayeredIconShell style={styles.notifShell} innerStyle={styles.notifShellInner}>
          <Ionicons name="notifications" size={ICON_GLYPH} color={NOTIF_GOLD} />
        </LayeredIconShell>
        {n > 0 ? (
          <View style={styles.countBadge}>
            <Text style={styles.countBadgeText}>{badgeLabel}</Text>
          </View>
        ) : null}
      </View>
    </HeaderColumn>
  );
}

function HomeProfileButton({ profileUri, onPress }) {
  return (
    <HeaderColumn label="Profile" accessibilityLabel="Profile" onPress={onPress} columnStyle={styles.colAction}>
      <LayeredIconShell
        round
        style={[styles.profileShell, styles.actionIconShell]}
        innerStyle={styles.actionLayeredInnerRound}
      >
        {profileUri ? (
          <Image source={{ uri: profileUri }} style={styles.profilePhoto} />
        ) : (
          <Ionicons name="person-outline" size={ICON_GLYPH_ACTION} color={PROFILE_ICON} />
        )}
      </LayeredIconShell>
    </HeaderColumn>
  );
}

/** OLX-style main marketplace header (Home). Navigation handlers unchanged. */
export default function HomeFloatingHeader({
  navigation,
  profileUri,
  notificationUnread,
}) {
  const { width: screenWidth } = useWindowDimensions();
  const compact = screenWidth < 380;
  const headerPadH = compact ? 14 : H_PAD;

  const logoOpacity = useRef(new Animated.Value(0)).current;
  const logoY = useRef(new Animated.Value(-4)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(logoOpacity, {
        toValue: 1,
        duration: 480,
        useNativeDriver: true,
      }),
      Animated.spring(logoY, {
        toValue: 0,
        friction: 10,
        tension: 58,
        useNativeDriver: true,
      }),
    ]).start();
  }, [logoOpacity, logoY]);

  return (
    <View style={[styles.headerShell, HEADER_DIVIDER, { paddingHorizontal: headerPadH }]}>
      <View style={styles.headerRow} testID="home-top-bar">
        <View style={[styles.sideSlot, styles.sideSlotLeft]}>
          <NotificationButton
            count={notificationUnread}
            onPress={() => navigation.navigate('Notifications')}
          />
        </View>

        <Animated.View
          pointerEvents="none"
          style={[
            styles.logoSlot,
            { opacity: logoOpacity, transform: [{ translateY: logoY }] },
          ]}
        >
          <BidifyLogoMark compact prominent />
        </Animated.View>

        <View style={[styles.sideSlot, styles.sideSlotRight, compact && styles.sideSlotCompact]}>
          <HomeProfileButton
            profileUri={profileUri}
            onPress={() => navigation.navigate('Profile')}
          />
          <WalletIconButton onPress={() => navigation.navigate('Wallet')} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  headerShell: {
    backgroundColor: HEADER_BG,
    paddingTop: 10,
    paddingBottom: 10,
    zIndex: 20,
    borderBottomWidth: 1,
    borderBottomColor: HEADER_BORDER,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    minHeight: ICON_SIZE + LABEL_SLOT + 2,
  },
  sideSlot: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    zIndex: 2,
    minWidth: 0,
  },
  sideSlotLeft: {
    justifyContent: 'flex-start',
  },
  sideSlotRight: {
    justifyContent: 'flex-end',
    gap: SIDE_GAP,
  },
  sideSlotCompact: {
    gap: 6,
  },
  logoSlot: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    alignItems: 'center',
    justifyContent: 'flex-start',
    zIndex: 1,
    paddingTop: 2,
  },
  column: {
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  columnPressable: {
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  iconSlot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelSpacer: {
    height: LABEL_SLOT,
  },
  colNotif: {
    width: COL_NOTIF,
    minWidth: COL_NOTIF,
  },
  colAction: {
    width: COL_ACTION,
    minWidth: COL_ACTION,
  },
  actionLabel: {
    marginTop: 5,
    width: '100%',
    fontSize: LABEL_FONT_SIZE,
    fontWeight: '500',
    color: LABEL_GREY,
    letterSpacing: 0.05,
    textAlign: 'center',
    alignSelf: 'center',
  },
  notifShell: {
    borderColor: 'rgba(255, 140, 0, 0.35)',
    backgroundColor: '#FFF8EE',
  },
  notifShellInner: {
    backgroundColor: '#FFF4E0',
  },
  actionIconShell: {
    width: ICON_SIZE_ACTION,
    height: ICON_SIZE_ACTION,
    borderRadius: ACTION_RADIUS,
  },
  actionLayeredInnerRound: {
    borderRadius: (ICON_SIZE_ACTION - 4) / 2,
    overflow: 'hidden',
  },
  walletOuter: {
    width: ICON_SIZE_ACTION,
    height: ICON_SIZE_ACTION,
    borderRadius: ACTION_RADIUS,
    padding: 2,
    backgroundColor: HEADER_BG,
    borderWidth: 1,
    borderColor: 'rgba(107, 58, 18, 0.35)',
    ...LAYER_SHADOW,
    ...Platform.select({
      ios: { shadowColor: '#6B3A12', shadowOpacity: 0.18 },
      android: { elevation: 2 },
    }),
  },
  walletFill: {
    flex: 1,
    borderRadius: ACTION_INNER_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  walletSheen: {
    ...StyleSheet.absoluteFillObject,
  },
  layeredShell: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    borderRadius: 14,
    padding: 2,
    backgroundColor: '#FAFAFA',
    borderWidth: 1,
    borderColor: '#EBEBEB',
    ...LAYER_SHADOW,
  },
  layeredShellRound: {
    borderRadius: ICON_SIZE / 2,
  },
  layeredInner: {
    flex: 1,
    borderRadius: 11,
    backgroundColor: HEADER_BG,
    alignItems: 'center',
    justifyContent: 'center',
  },
  layeredInnerRound: {
    borderRadius: (ICON_SIZE - 4) / 2,
    overflow: 'hidden',
  },
  badgeAnchor: {
    position: 'relative',
  },
  countBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: '#DC2626',
    borderWidth: 2,
    borderColor: HEADER_BG,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countBadgeText: {
    color: HEADER_BG,
    fontSize: 9,
    fontWeight: '800',
  },
  profileShell: {
    overflow: 'hidden',
  },
  profilePhoto: {
    width: '100%',
    height: '100%',
    borderRadius: (ICON_SIZE_ACTION - 4) / 2,
  },
});
