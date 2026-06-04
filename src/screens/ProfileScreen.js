import React, { useContext, useCallback, useLayoutEffect, useState, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Pressable,
  ScrollView,
  Platform,
  Alert,
  Modal,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import { AuthContext } from '../context/AuthContext';
import { isAdminUser } from '../utils/userRole';
import {
  PROFILE_EMPTY,
  formatProfileCnicDisplay,
  formatProfileDisplayName,
  formatProfilePhone,
  formatProfileText,
  resolveCnicFromUser,
} from '../utils/profileDisplay';
import { getSupabase, isSupabaseConfigured } from '../services/supabaseClient';
import { spacing } from '../theme';
import { enterAdminPanel } from '../navigation/adminNavigation';
import {
  normalizeVerificationStatus,
  resolveEffectiveVerificationStatus,
} from '../utils/kycVerification';
import { syncVerificationStatusAPI } from '../api/kyc';
import { getKycMenuState } from '../utils/kycMenuState';
import {
  isKycUnderReviewFromStorage,
  readKycLocalProfileSnapshot,
  readKycLocalProfileSnapshotSync,
  clearKycLocalProfileSnapshot,
} from '../utils/kycLocalProfileCache';
import { clearKycReviewLock } from '../utils/kycBidLockStorage';
import {
  getMsUntilReviewComplete,
  isReviewWindowElapsed,
  isTerminalKycStatus,
} from '../utils/kycStatusSync';

const SCREEN_BG = '#F4F6F8';
const INDIGO = '#1E3A8A';
const SIGN_OUT = '#B91C1C';
const LABEL_GREY = '#666666';
const DATA_BLACK = '#000000';
const ICON_BG = '#EEEEEE';
const FIELD_GAP = 20;
const DEEP_ROYAL_BLUE = '#0B3D91';
const AVATAR_SIZE = 104;
const AVATAR_HALF = AVATAR_SIZE / 2;

function ProfileBlueHeader({ onExit }) {
  const navigation = useNavigation();

  const handleBack = useCallback(() => {
    try {
      if (typeof navigation.canGoBack === 'function' && navigation.canGoBack()) {
        navigation.goBack();
        return;
      }
    } catch (_) {
      /* fall through */
    }
    try {
      navigation.navigate('MainTabs');
    } catch (_) {
      /* ignore */
    }
  }, [navigation]);

  return (
    <View style={styles.blueHeader}>
      <SafeAreaView edges={['top']}>
        <View style={styles.blueHeaderBar}>
          <Pressable
            onPress={handleBack}
            style={styles.headerIconBtn}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="chevron-back" size={26} color="#FFFFFF" />
          </Pressable>
          <Text style={styles.blueHeaderTitle} pointerEvents="none">
            MY PROFILE
          </Text>
          <Pressable
            onPress={onExit}
            style={styles.headerIconBtn}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Sign out"
          >
            <Ionicons name="log-out-outline" size={24} color="#FFFFFF" />
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

const MENU_ITEMS = [
  {
    key: 'wallet',
    title: 'Wallet & Payments',
    icon: 'wallet-outline',
    action: 'wallet',
  },
  {
    key: 'bids',
    title: 'Bid History',
    icon: 'hammer-outline',
    action: 'bids',
  },
  {
    key: 'settings',
    title: 'Account Settings',
    icon: 'settings-outline',
    action: 'settings',
  },
  {
    key: 'help',
    title: 'Help & Support',
    icon: 'help-circle-outline',
    action: 'help',
  },
];

function VerifiedBadge() {
  return (
    <View style={styles.verifiedPill}>
      <Ionicons name="checkmark-circle" size={13} color="#FFFFFF" />
      <Text style={styles.verifiedPillText}>Verified</Text>
    </View>
  );
}

function UnderReviewBadge() {
  return (
    <View style={styles.underReviewPill}>
      <Ionicons name="hourglass-outline" size={13} color="#92400E" />
      <Text style={styles.underReviewPillText}>⏳ Under Review</Text>
    </View>
  );
}

function UnverifiedBadge() {
  return (
    <View style={styles.unverifiedPill}>
      <Ionicons name="close-circle" size={16} color="#DC2626" />
      <Text style={styles.unverifiedPillText}>Unverified</Text>
    </View>
  );
}

function RejectedBadge() {
  return (
    <View style={styles.rejectedPill}>
      <Ionicons name="close-circle" size={13} color="#991B1B" />
      <Text style={styles.rejectedPillText}>CNIC Verification Failed</Text>
    </View>
  );
}

function FieldCheckmark() {
  return <Ionicons name="checkmark-circle" size={14} color="#16A34A" accessibilityLabel="Verified" />;
}

function FieldUnverifiedIcon() {
  return (
    <Ionicons
      name="close-circle"
      size={14}
      color="#DC2626"
      accessibilityLabel="Not verified"
    />
  );
}

function KycStatusBadge({ status }) {
  const normalized = normalizeVerificationStatus({ verification_status: status });
  if (normalized === 'verified') return <VerifiedBadge />;
  if (normalized === 'under_review' || normalized === 'pending') return <UnderReviewBadge />;
  if (normalized === 'rejected') return <RejectedBadge />;
  return <UnverifiedBadge />;
}

function ProfileAvatarOverlay({ profileUri, onAddPhoto }) {
  return (
    <View style={styles.avatarFloat} pointerEvents="box-none">
      <View style={styles.avatarOverlayWrap} pointerEvents="box-none">
        <View style={styles.avatarRing}>
          {profileUri ? (
            <Image source={{ uri: profileUri }} style={styles.avatarImage} />
          ) : (
            <View style={styles.avatarPlaceholder}>
              <Ionicons name="person" size={44} color={LABEL_GREY} />
            </View>
          )}
        </View>
        <Pressable
          onPress={onAddPhoto}
          style={styles.addPhotoBtn}
          accessibilityRole="button"
          accessibilityLabel="Add profile photo"
        >
          <Ionicons name="add" size={18} color="#FFFFFF" />
        </Pressable>
      </View>
    </View>
  );
}

function ProfileHeroMeta({ name, verified }) {
  return (
    <View style={styles.profileHeroMeta}>
      <Text style={styles.heroName} numberOfLines={2} ellipsizeMode="tail">
        {name}
      </Text>
      {verified ? (
        <View style={styles.heroVerifiedRow}>
          <Ionicons name="checkmark-circle" size={14} color="#16A34A" />
          <Text style={styles.heroVerifiedText}>Verified</Text>
        </View>
      ) : null}
    </View>
  );
}

function InfoRow({ icon, label, value, showCheckmark, showUnverified, kycStatus }) {
  return (
    <View style={styles.infoRow}>
      <View style={styles.infoIconWrap}>
        <Ionicons name={icon} size={22} color={INDIGO} />
      </View>
      <View style={styles.infoTextCol}>
        <Text style={styles.infoLabel}>{label}</Text>
        <View style={styles.infoValueRow}>
          <Text style={styles.infoValue} numberOfLines={1} ellipsizeMode="tail">
            {value}
          </Text>
          {kycStatus != null ? (
            <KycStatusBadge status={kycStatus} />
          ) : showCheckmark ? (
            <FieldCheckmark />
          ) : showUnverified ? (
            <FieldUnverifiedIcon />
          ) : null}
        </View>
      </View>
    </View>
  );
}

function SignOutButton({ onPress }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.signOutBtn, pressed && styles.signOutBtnPressed]}
      accessibilityRole="button"
      accessibilityLabel="Sign out"
    >
      <Ionicons name="log-out-outline" size={20} color={SIGN_OUT} />
      <Text style={styles.signOutBtnText}>Sign Out</Text>
    </Pressable>
  );
}

function MenuRow({ icon, title, onPress, isLast, danger, disabled, subdued }) {
  return (
    <>
      <TouchableOpacity
        style={[styles.menuRow, disabled && styles.menuRowDisabled]}
        onPress={disabled ? undefined : onPress}
        disabled={disabled}
        activeOpacity={disabled ? 1 : 0.75}
      >
        <View style={[styles.menuIconWrap, danger && styles.menuIconWrapDanger]}>
          <Ionicons
            name={icon}
            size={23}
            color={danger ? SIGN_OUT : subdued ? '#94A3B8' : INDIGO}
          />
        </View>
        <Text
          style={[
            styles.menuTitle,
            subdued && styles.menuTitleSubdued,
            danger && styles.menuTitleDanger,
          ]}
        >
          {title}
        </Text>
        {!danger && !disabled ? (
          <Ionicons name="chevron-forward" size={18} color="#CBD5E1" />
        ) : null}
      </TouchableOpacity>
      {!isLast ? <View style={styles.rowDivider} /> : null}
    </>
  );
}

const ProfileScreen = () => {
  const { user, logout, refreshProfile } = useContext(AuthContext);
  const navigation = useNavigation();
  const [isLogoutModalVisible, setLogoutModalVisible] = useState(false);
  const [profileRefreshing, setProfileRefreshing] = useState(false);
  const [localKyc, setLocalKyc] = useState(() => readKycLocalProfileSnapshotSync());
  const [profilePic, setProfilePic] = useState(null);
  const profile = { ...(user || {}) };
  const showAdmin = isAdminUser(user);

  const verificationStatus = showAdmin
    ? 'verified'
    : resolveEffectiveVerificationStatus(profile);
  const isUnderReview = !showAdmin && verificationStatus === 'under_review';
  const isKycVerifiedProfile = showAdmin || verificationStatus === 'verified';
  const kycMenu = useMemo(
    () => getKycMenuState(verificationStatus, { isAdmin: showAdmin }),
    [verificationStatus, showAdmin]
  );

  const displayProfile = useMemo(() => {
    if (!localKyc || isTerminalKycStatus(verificationStatus)) return profile;
    return {
      ...profile,
      fullName: localKyc.fullName || profile.fullName || profile.name,
      name: localKyc.fullName || profile.name,
      firstName: localKyc.firstName || profile.firstName,
      lastName: localKyc.lastName || profile.lastName,
      cnic: localKyc.cnic || profile.cnic,
      cnic_number: localKyc.cnic || profile.cnic_number,
      phoneNumber: localKyc.phoneNumber || profile.phoneNumber,
      phone: localKyc.phoneNumber || profile.phone,
    };
  }, [localKyc, profile, verificationStatus]);

  const profileUri = useMemo(() => {
    if (profilePic) return profilePic;
    const fromUser =
      user?.profileImage ||
      user?.profile_image ||
      user?.avatarUrl ||
      displayProfile?.profileImage ||
      displayProfile?.profile_image;
    return fromUser && String(fromUser).trim() ? String(fromUser).trim() : null;
  }, [profilePic, user, displayProfile]);

  const fullName = formatProfileText(
    formatProfileDisplayName(displayProfile) ||
      displayProfile?.fullName ||
      displayProfile?.name,
    PROFILE_EMPTY
  );
  const email = formatProfileText(displayProfile?.email, PROFILE_EMPTY);
  const phoneRaw =
    displayProfile?.phoneNumber ||
    displayProfile?.phone ||
    user?.phoneNumber ||
    user?.phone ||
    '';
  const phone =
    formatProfilePhone(phoneRaw) !== PROFILE_EMPTY ? formatProfilePhone(phoneRaw) : '—';
  const cnicDigits = resolveCnicFromUser(displayProfile);
  const cnicFormatted = formatProfileCnicDisplay(
    cnicDigits,
    displayProfile?.cnic,
    displayProfile?.id_card,
    displayProfile?.cnic_number
  );
  const cnic =
    cnicFormatted !== PROFILE_EMPTY ? cnicFormatted : '—';
  const showFieldVerified = isKycVerifiedProfile;
  const showFieldUnverified = !showAdmin && !isKycVerifiedProfile;
  const applyTerminalKycCleanup = useCallback(async (status) => {
    if (!isTerminalKycStatus(status)) return;
    setLocalKyc(null);
    try {
      await clearKycReviewLock();
      await clearKycLocalProfileSnapshot();
    } catch {
      /* non-fatal */
    }
  }, []);

  const loadProfile = useCallback(async () => {
    setProfileRefreshing(true);
    try {
      const underReviewStorage = await isKycUnderReviewFromStorage();
      if (underReviewStorage && normalizeVerificationStatus(user) === 'under_review') {
        const snap = await readKycLocalProfileSnapshot();
        setLocalKyc(snap || null);
      } else {
        setLocalKyc(null);
      }

      const dbStatus = normalizeVerificationStatus(user);
      const shouldSync =
        dbStatus === 'under_review' &&
        (isReviewWindowElapsed(user) || underReviewStorage);
      const shouldRepairStuck =
        dbStatus === 'unverified' &&
        !!(user?.cnic || user?.verification_submitted_at || user?.verificationSubmittedAt);

      if (shouldSync || shouldRepairStuck) {
        try {
          const synced = await syncVerificationStatusAPI();
          if (synced?.verification_status) {
            await applyTerminalKycCleanup(synced.verification_status);
          }
        } catch (syncErr) {
          if (__DEV__) console.warn('[Profile] verification-sync', syncErr?.message);
        }
      }

      const refreshed = await refreshProfile?.();
      const nextStatus = resolveEffectiveVerificationStatus(refreshed || user);
      if (isTerminalKycStatus(nextStatus)) {
        await applyTerminalKycCleanup(nextStatus);
      } else if (nextStatus !== 'under_review') {
        setLocalKyc(null);
      }
    } finally {
      setProfileRefreshing(false);
    }
  }, [applyTerminalKycCleanup, refreshProfile, user]);

  useFocusEffect(
    useCallback(() => {
      void loadProfile();
    }, [loadProfile])
  );

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          if (user?.id) {
            const pic = await AsyncStorage.getItem(`profilePic_${user.id}`);
            if (!cancelled) setProfilePic(pic || null);
          } else if (!cancelled) {
            setProfilePic(null);
          }
        } catch {
          if (!cancelled) setProfilePic(null);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [user?.id])
  );

  /**
   * 5-minute Mock NADRA state engine — poll server sync while under_review;
   * fire one-shot sync when the review window elapses (open app after 10+ min).
   */
  useEffect(() => {
    if (showAdmin || verificationStatus !== 'under_review') return undefined;

    const msUntilDone = getMsUntilReviewComplete(user);
    if (__DEV__) {
      console.log(
        '[Profile] KYC under_review — sync in',
        Math.ceil(msUntilDone / 1000),
        's (submitted_at:',
        user?.verification_submitted_at || user?.verificationSubmittedAt || 'unknown',
        ')'
      );
    }

    let intervalId = null;
    let timeoutId = null;

    if (msUntilDone > 0) {
      timeoutId = setTimeout(() => {
        if (__DEV__) console.log('[Profile] 5-min window elapsed — forcing verification-sync');
        void loadProfile();
      }, msUntilDone + 500);
    } else {
      void loadProfile();
    }

    intervalId = setInterval(() => void loadProfile(), 10000);

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
    };
  }, [showAdmin, verificationStatus, loadProfile, user]);

  const startKycFlow = useCallback(
    (isRetry = false) => {
      navigation.navigate('KycScan', {
        onboarding: true,
        fromSignup: false,
        kycRetry: isRetry,
        prefillProfile: {
          email: displayProfile?.email || user?.email || '',
          fullName: displayProfile?.fullName || displayProfile?.name || '',
          name: displayProfile?.fullName || displayProfile?.name || '',
          phoneNumber:
            displayProfile?.phoneNumber ||
            displayProfile?.phone ||
            user?.phoneNumber ||
            user?.phone ||
            '',
          phone:
            displayProfile?.phone ||
            displayProfile?.phoneNumber ||
            user?.phone ||
            user?.phoneNumber ||
            '',
          cnic:
            displayProfile?.cnic_number ||
            displayProfile?.cnic ||
            displayProfile?.id_card ||
            '',
        },
      });
    },
    [navigation, displayProfile, user]
  );

  const handleKycPress = useCallback(() => {
    switch (kycMenu.action) {
      case 'verified_alert':
        Alert.alert('Account Verified', 'Your account is already verified.');
        break;
      case 'kyc_retry':
        startKycFlow(true);
        break;
      case 'kyc_start':
        startKycFlow(false);
        break;
      default:
        break;
    }
  }, [kycMenu.action, startKycFlow]);

  const handleMenuAction = (action) => {
    switch (action) {
      case 'wallet':
        navigation.navigate('Wallet');
        break;
      case 'bids':
        navigation.navigate('MainTabs', { screen: 'MyBids' });
        break;
      case 'settings':
        navigation.navigate('AccountSettings');
        break;
      case 'help':
        navigation.navigate('HelpSupport');
        break;
      case 'admin':
        enterAdminPanel(navigation);
        break;
      default:
        break;
    }
  };

  const executeLogout = useCallback(async () => {
    try {
      if (isSupabaseConfigured()) {
        const supabase = getSupabase();
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
      }

      await logout?.({ force: true });
    } catch (error) {
      console.error('Logout failed', error);
      const message = error?.message || 'Failed to sign out. Please try again.';
      if (Platform.OS === 'web') {
        window.alert(`Error\n\n${message}`);
      } else {
        Alert.alert('Error', message);
      }
    }
  }, [logout]);

  const openLogoutModal = useCallback(() => {
    setLogoutModalVisible(true);
  }, []);

  const confirmLogoutFromModal = useCallback(() => {
    setLogoutModalVisible(false);
    void executeLogout();
  }, [executeLogout]);

  const handlePickProfilePhoto = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Photo access', 'Allow gallery access to update your profile photo.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.85,
      });
      if (result.canceled || !result.assets?.[0]?.uri) return;
      const uri = result.assets[0].uri;
      setProfilePic(uri);
      if (user?.id) {
        await AsyncStorage.setItem(`profilePic_${user.id}`, uri);
      }
    } catch (e) {
      Alert.alert('Photo', e?.message || 'Could not update profile photo.');
    }
  }, [user?.id]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerShown: false,
    });
  }, [navigation]);

  return (
    <View style={styles.screenRoot}>
      <View style={styles.heroStack}>
        <ProfileBlueHeader onExit={openLogoutModal} />
        <ProfileAvatarOverlay profileUri={profileUri} onAddPhoto={handlePickProfilePhoto} />
      </View>
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <View style={styles.profileHeaderCard}>
            <ProfileHeroMeta
              name={fullName}
              verified={isKycVerifiedProfile && fullName !== PROFILE_EMPTY}
            />
          </View>
          <View style={styles.profileHeaderDivider} />

          <View style={styles.card}>
          {isUnderReview ? (
            <View style={styles.reviewBanner}>
              <UnderReviewBadge />
              <Text style={styles.reviewBannerText}>
                Identity verification is in progress. Wallet top-up stays locked for up to 5
                minutes.
              </Text>
            </View>
          ) : null}
          {verificationStatus === 'rejected' ? (
            <View style={styles.rejectedBanner}>
              <RejectedBadge />
              <Text style={styles.rejectedBannerText}>
                CNIC Verification Failed. Your CNIC is not in the approved range. Wallet top-up
                remains locked.
              </Text>
            </View>
          ) : null}
          <View style={styles.fieldsStack}>
            <InfoRow icon="person-outline" label="Full Name" value={fullName} />
            <InfoRow
              icon="mail-outline"
              label="Email Address"
              value={email}
              showCheckmark={isKycVerifiedProfile && email !== PROFILE_EMPTY}
            />
            <InfoRow
              icon="call-outline"
              label="Phone Number"
              value={phone}
              showCheckmark={showFieldVerified && phone !== '—'}
              showUnverified={showFieldUnverified && phone !== '—'}
            />
            <InfoRow
              icon="card-outline"
              label="CNIC / National ID"
              value={cnic}
              showCheckmark={showFieldVerified && cnic !== '—'}
              showUnverified={showFieldUnverified && cnic !== '—'}
              kycStatus={
                verificationStatus === 'under_review' && cnic !== '—' && cnic !== 'Loading…'
                  ? verificationStatus
                  : null
              }
            />
          </View>
        </View>

        <View style={[styles.card, styles.cardGap]}>
          <Text style={styles.cardHeading}>Account Settings</Text>
          {MENU_ITEMS.map((item) => (
            <MenuRow
              key={item.key}
              icon={item.icon}
              title={item.title}
              onPress={() => handleMenuAction(item.action)}
            />
          ))}
          <MenuRow
            icon="scan-outline"
            title={kycMenu.title}
            onPress={handleKycPress}
            disabled={kycMenu.disabled}
            subdued={kycMenu.subdued}
          />
          {showAdmin ? (
            <MenuRow
              icon="shield-checkmark-outline"
              title="Admin Moderation"
              onPress={() => handleMenuAction('admin')}
              isLast={false}
            />
          ) : null}
          <SignOutButton onPress={openLogoutModal} />
        </View>

          <View style={{ height: 48 }} />
        </ScrollView>

        <Modal
        visible={isLogoutModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setLogoutModalVisible(false)}
      >
        <View style={styles.logoutOverlay}>
          <View style={styles.logoutCard}>
            <View style={styles.logoutIconWrap}>
              <Ionicons name="log-out-outline" size={28} color="#EF4444" />
            </View>
            <Text style={styles.logoutTitle}>Sign Out</Text>
            <Text style={styles.logoutMessage}>
              Are you sure you want to log out from your account?
            </Text>
            <View style={styles.logoutActions}>
              <TouchableOpacity
                style={styles.logoutCancelBtn}
                onPress={() => setLogoutModalVisible(false)}
                activeOpacity={0.88}
              >
                <Text style={styles.logoutCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.logoutConfirmBtn}
                onPress={confirmLogoutFromModal}
                activeOpacity={0.88}
              >
                <Text style={styles.logoutConfirmText}>Yes, Log Out</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
        </Modal>
      </SafeAreaView>
    </View>
  );
};

const cardShadow = Platform.select({
  ios: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
  },
  android: { elevation: 2 },
});

const styles = StyleSheet.create({
  screenRoot: {
    flex: 1,
    backgroundColor: SCREEN_BG,
    overflow: 'visible',
  },
  heroStack: {
    position: 'relative',
    zIndex: 2,
    elevation: 2,
    overflow: 'visible',
  },
  blueHeader: {
    width: '100%',
    backgroundColor: DEEP_ROYAL_BLUE,
    paddingBottom: AVATAR_HALF,
    zIndex: 1,
    overflow: 'visible',
  },
  blueHeaderBar: {
    minHeight: 56,
    paddingVertical: 14,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    position: 'relative',
  },
  blueHeaderTitle: {
    position: 'absolute',
    left: 56,
    right: 56,
    textAlign: 'center',
    fontSize: 19,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 1.4,
  },
  headerIconBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  logoutOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoutCard: {
    width: '80%',
    maxWidth: 360,
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.15,
        shadowRadius: 20,
      },
      android: { elevation: 10 },
      default: {},
    }),
  },
  logoutIconWrap: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#FEE2E2',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  logoutTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#0F172A',
    marginBottom: 8,
  },
  logoutMessage: {
    fontSize: 16,
    color: '#64748B',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 22,
  },
  logoutActions: {
    flexDirection: 'row',
    width: '100%',
    justifyContent: 'space-between',
  },
  logoutCancelBtn: {
    flex: 1,
    backgroundColor: '#F1F5F9',
    paddingVertical: 14,
    borderRadius: 12,
    marginRight: 8,
    alignItems: 'center',
  },
  logoutCancelText: {
    color: '#475569',
    fontWeight: 'bold',
    fontSize: 16,
  },
  logoutConfirmBtn: {
    flex: 1,
    backgroundColor: '#EF4444',
    paddingVertical: 14,
    borderRadius: 12,
    marginLeft: 8,
    alignItems: 'center',
  },
  logoutConfirmText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 16,
  },
  safe: {
    flex: 1,
    backgroundColor: SCREEN_BG,
    zIndex: 0,
  },
  avatarFloat: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: -AVATAR_HALF,
    height: AVATAR_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    elevation: 10,
  },
  avatarOverlayWrap: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    zIndex: 10,
  },
  addPhotoBtn: {
    position: 'absolute',
    right: 0,
    bottom: 4,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: DEEP_ROYAL_BLUE,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 11,
    elevation: 11,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 4,
      },
      android: { elevation: 6 },
    }),
  },
  avatarRing: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    padding: 2,
    backgroundColor: '#FFFFFF',
    borderWidth: 4,
    borderColor: '#FFFFFF',
    overflow: 'hidden',
    ...cardShadow,
  },
  profileHeaderCard: {
    backgroundColor: '#F0F2F5',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginTop: AVATAR_HALF + 10,
    marginBottom: 0,
    paddingTop: AVATAR_HALF + 8,
    paddingBottom: spacing.lg,
    paddingHorizontal: spacing.lg,
    ...Platform.select({
      ios: {
        shadowColor: '#0F172A',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.06,
        shadowRadius: 10,
      },
      android: { elevation: 2 },
      default: {},
    }),
  },
  profileHeaderDivider: {
    height: 1,
    backgroundColor: '#E2E8F0',
    marginBottom: spacing.lg,
    marginHorizontal: 2,
  },
  profileHeroMeta: {
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
  },
  avatarImage: {
    width: '100%',
    height: '100%',
    borderRadius: (AVATAR_SIZE - 8) / 2,
  },
  avatarPlaceholder: {
    flex: 1,
    borderRadius: (AVATAR_SIZE - 8) / 2,
    backgroundColor: ICON_BG,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    paddingHorizontal: spacing.lg,
    paddingTop: 4,
    paddingBottom: spacing.xl,
  },
  heroName: {
    marginTop: 0,
    fontSize: 22,
    fontWeight: '800',
    color: DATA_BLACK,
    textAlign: 'center',
    letterSpacing: -0.4,
    maxWidth: '100%',
    paddingHorizontal: 8,
  },
  heroVerifiedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 8,
  },
  heroVerifiedText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#16A34A',
  },
  fieldsStack: {
    gap: FIELD_GAP,
    paddingTop: 4,
    paddingBottom: 4,
  },
  ordersFeatured: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 16,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    gap: spacing.md,
    ...Platform.select({
      ios: {
        shadowColor: '#1E3A8A',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.28,
        shadowRadius: 10,
      },
      android: { elevation: 6 },
    }),
  },
  ordersFeaturedIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ordersFeaturedText: { flex: 1 },
  ordersFeaturedTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: -0.2,
  },
  ordersFeaturedSub: {
    fontSize: 12,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.82)',
    marginTop: 4,
    lineHeight: 17,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 20,
    borderWidth: 1,
    borderColor: '#E8ECF0',
    ...cardShadow,
  },
  cardGap: {
    marginTop: 20,
  },
  cardHeading: {
    fontSize: 17,
    fontWeight: '800',
    color: DATA_BLACK,
    marginBottom: spacing.md,
    letterSpacing: -0.2,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
  },
  infoIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: ICON_BG,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  infoTextCol: {
    flex: 1,
    minWidth: 0,
    gap: 6,
  },
  infoLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: LABEL_GREY,
    letterSpacing: 0.15,
  },
  infoValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  infoValue: {
    flexShrink: 1,
    fontSize: 17,
    fontWeight: '700',
    color: DATA_BLACK,
    lineHeight: 22,
  },
  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  signOutBtnPressed: {
    opacity: 0.88,
  },
  signOutBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: SIGN_OUT,
  },
  verifiedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#16A34A',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
  },
  verifiedPillText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  underReviewPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#FEF3C7',
    borderWidth: 1,
    borderColor: '#FCD34D',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
  },
  underReviewPillText: {
    color: '#92400E',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  unverifiedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#FEE2E2',
    borderWidth: 1,
    borderColor: '#FECACA',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
  },
  unverifiedPillText: {
    color: '#991B1B',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  rejectedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#FEE2E2',
    borderWidth: 1,
    borderColor: '#FECACA',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
  },
  rejectedPillText: {
    color: '#991B1B',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  reviewBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: '#FFFBEB',
    borderWidth: 1,
    borderColor: '#FDE68A',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  reviewBannerText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: '#92400E',
    fontWeight: '600',
  },
  rejectedBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  rejectedBannerText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: '#991B1B',
    fontWeight: '600',
  },
  rowDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#E2E8F0',
    marginLeft: 60,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: spacing.md,
  },
  menuIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: ICON_BG,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuIconWrapDanger: {
    backgroundColor: '#FEF2F2',
  },
  menuTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: '#0F172A',
  },
  menuTitleSubdued: {
    color: '#94A3B8',
  },
  menuRowDisabled: {
    opacity: 0.72,
  },
  menuTitleDanger: {
    color: SIGN_OUT,
    fontWeight: '700',
  },
});

export default ProfileScreen;
