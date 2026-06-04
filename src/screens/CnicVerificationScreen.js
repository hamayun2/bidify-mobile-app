import React, { useContext, useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Alert,
  Platform,
  Animated,
  Easing,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import * as ImagePicker from 'expo-image-picker';
import AppButton from '../components/ui/AppButton';
import SmartImage from '../components/SmartImage';
import { AuthContext } from '../context/AuthContext';
import {
  completeCnicRegistrationAPI,
  isEmailAlreadyRegisteredMessage,
  finalizeRegistrationAfterVerifyAPI,
  resendVerificationEmailAPI,
} from '../api/registration';
import { savePendingRegistration } from '../services/supabase/pendingRegistration';
import { getSupabase } from '../config/supabase';
import { fetchProfileById as fetchUserProfileById, mapUsersRowToAppUser } from '../services/profileService';
import { backToOr } from '../utils/safeBack';
import { mapProfileUniqueViolation } from '../utils/profileErrors';
import { colors, radius, spacing, typography, shadows } from '../theme';

const SIDES = [
  {
    key: 'front',
    title: 'Upload CNIC Front',
    subtitle: 'Photo of the front side (with your name and photo).',
    icon: 'card-outline',
  },
  {
    key: 'back',
    title: 'Upload CNIC Back',
    subtitle: 'Photo of the back side (address & validity).',
    icon: 'card',
  },
];

const EMPTY_SIDE = { uri: null, status: 'idle', error: null };

const CnicVerificationScreen = ({ navigation, route }) => {
  const { login } = useContext(AuthContext);
  const registration = route?.params?.registration || null;

  // status per side: 'idle' | 'ready' | 'uploading' | 'done' | 'error'
  const [sides, setSides] = useState({ front: { ...EMPTY_SIDE }, back: { ...EMPTY_SIDE } });
  const [busySide, setBusySide] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [blurCheck, setBlurCheck] = useState({ visible: false, side: null, uri: null });
  const [sourceSheet, setSourceSheet] = useState({ visible: false, side: null });
  const [pendingEmailModalVisible, setPendingEmailModalVisible] = useState(false);
  const [verifyEmail, setVerifyEmail] = useState('');
  const [resending, setResending] = useState(false);
  const submitInFlightRef = useRef(false);
  const emailGateAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!pendingEmailModalVisible) {
      emailGateAnim.setValue(0);
      return;
    }
    emailGateAnim.setValue(0);
    Animated.timing(emailGateAnim, {
      toValue: 1,
      duration: 320,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [pendingEmailModalVisible]);

  if (!registration) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <Text style={styles.title}>Session expired</Text>
          <Text style={styles.subtitle}>Start the signup again to continue.</Text>
          <AppButton
            title="Back to Sign Up"
            style={{ marginTop: spacing.xl }}
            onPress={() => navigation.replace('Register')}
          />
        </View>
      </SafeAreaView>
    );
  }

  const updateSide = (key, patch) =>
    setSides((s) => {
      const prev = Reflect.get(s, key);
      return { ...s, [key]: { ...prev, ...patch } };
    });

  /**
   * Web-only fallback: build a one-shot <input type="file"> and click it.
   * Used if expo-image-picker silently returns canceled or fails to open
   * the browser dialog (rare, but seen on some Chromium versions).
   */
  const pickViaHiddenInput = (side) =>
    new Promise((resolve) => {
      if (Platform.OS !== 'web' || typeof document === 'undefined') {
        resolve(null);
        return;
      }
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.display = 'none';
      input.onchange = () => {
        const f = input.files && input.files[0];
        if (!f) {
          resolve(null);
        } else {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(f);
        }
        document.body.removeChild(input);
      };
      document.body.appendChild(input);
      input.click();
    });

  const pickFromGallery = async (side) => {
    setSourceSheet({ visible: false, side: null });
    if (busySide) return; // re-entry guard — a previous picker is still resolving
    try {
      // Web: expo-image-picker pops the browser file dialog directly, no permission API.
      if (Platform.OS !== 'web') {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          Alert.alert('Permission needed', 'Allow photo library access to upload your CNIC image.');
          return;
        }
      }
      setBusySide(side);
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: Platform.OS !== 'web',
        // Full quality so the CNIC text stays legible after upload to Storage.
        quality: 1,
        exif: false,
      });
      let pickedUri = !result.canceled && result.assets?.[0]?.uri ? result.assets[0].uri : null;

      // Web fallback — if Expo's picker returned nothing, try the raw <input>.
      if (!pickedUri && Platform.OS === 'web') {
        pickedUri = await pickViaHiddenInput(side);
      }

      if (pickedUri) {
        setBlurCheck({ visible: true, side, uri: pickedUri });
      }
    } catch (e) {
      // Last-chance fallback on web errors.
      if (Platform.OS === 'web') {
        try {
          const u = await pickViaHiddenInput(side);
          if (u) {
            setBlurCheck({ visible: true, side, uri: u });
            return;
          }
        } catch (_) {
          /* fall through */
        }
      }
      Alert.alert('Could not pick image', e?.message || 'Try again.');
    } finally {
      setBusySide(null);
    }
  };

  const pickFromCamera = async (side) => {
    setSourceSheet({ visible: false, side: null });
    if (Platform.OS === 'web') {
      // Camera not reliable on web — fall back to gallery / file picker.
      return pickFromGallery(side);
    }
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission needed', 'Allow camera access to capture your CNIC.');
        return;
      }
      setBusySide(side);
      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: true,
        quality: 1,
        exif: false,
      });
      if (!result.canceled && result.assets?.[0]?.uri) {
        setBlurCheck({ visible: true, side, uri: result.assets[0].uri });
      }
    } catch (e) {
      Alert.alert('Could not capture image', e?.message || 'Try again.');
    } finally {
      setBusySide(null);
    }
  };

  /**
   * Open the source-picker sheet. On web we skip the sheet entirely and go
   * straight to the file dialog because `launchCameraAsync` is unreliable
   * across browsers (Safari blocks it without HTTPS, etc).
   */
  const askForSource = (side) => {
    setError('');
    if (Platform.OS === 'web') {
      return pickFromGallery(side);
    }
    setSourceSheet({ visible: true, side });
  };

  /** "Yes" on the blur popup — accept the image and mark it ready for upload. */
  const confirmBlurAccept = () => {
    const { side, uri } = blurCheck;
    setBlurCheck({ visible: false, side: null, uri: null });
    if (!side || !uri) return;
    updateSide(side, { uri, status: 'ready', error: null });
  };

  /** "No" on the blur popup — clear the file selection and offer to retake. */
  const confirmBlurReject = () => {
    const side = blurCheck.side;
    setBlurCheck({ visible: false, side: null, uri: null });
    if (side) updateSide(side, { ...EMPTY_SIDE });
    if (side) setTimeout(() => askForSource(side), 200);
  };

  /** After user taps the Supabase email link, session exists — finalize profile + enter app. */
  const handleVerifiedEmailTapped = async () => {
    setError('');
    setSubmitting(true);
    try {
      const supabase = getSupabase();
      const { error: refErr } = await supabase.auth.refreshSession();
      if (refErr && __DEV__) console.warn('[CnicVerification] refreshSession', refErr?.message);

      const {
        data: { session: peekSession },
        error: peekSessErr,
      } = await supabase.auth.getSession();
      if (__DEV__) {
        console.log('[CnicVerification] getSession after refresh', {
          peekSessErr: peekSessErr?.message,
          hasSession: !!peekSession,
          emailConfirmedAt: peekSession?.user?.email_confirmed_at,
        });
      }

      const {
        data: { user: jwtUser },
        error: userErr,
      } = await supabase.auth.getUser();
      if (userErr || !jwtUser) {
        try {
          Alert.alert('Email not verified yet.', 'Open Gmail and tap the confirmation link in the message we sent you.');
        } catch (_) {
          setError('Email not verified yet.');
        }
        return;
      }
      if (!jwtUser.email_confirmed_at) {
        try {
          Alert.alert(
            'Email not verified yet.',
            'We still do not see a confirmed email. Open the link in your email, then tap “I Have Verified” again.'
          );
        } catch (_) {
          setError('Email not verified yet.');
        }
        return;
      }

      const {
        data: { session },
        error: sessErr,
      } = await supabase.auth.getSession();
      if (sessErr || !session?.user) {
        try {
          Alert.alert('Email not verified yet.', 'Try opening the email link again, then retry.');
        } catch (_) {}
        return;
      }

      let fin = await finalizeRegistrationAfterVerifyAPI();
      if (!fin?.appUser) {
        let row = null;
        try {
          row = await fetchUserProfileById(session.user.id);
        } catch (_) {
          /* ignore */
        }
        const appUser = mapUsersRowToAppUser(row, session.user) || mapUsersRowToAppUser({}, session.user);
        await login(session.access_token, appUser);
      } else {
        await login(fin.token, fin.appUser);
      }
      setPendingEmailModalVisible(false);
      if (__DEV__) {
        console.log('[CnicVerification] Email verified — session + profile OK, entering app');
      }
    } catch (e) {
      const msg = e?.message || 'Could not complete sign-in.';
      setError(msg);
      try {
        Alert.alert('Sign-in', msg);
      } catch (_) {}
    } finally {
      setSubmitting(false);
    }
  };

  const handleResendVerification = async () => {
    const em = verifyEmail || registration?.email;
    if (!em) return;
    setResending(true);
    setError('');
    try {
      await resendVerificationEmailAPI(em);
      try {
        Alert.alert('Sent', 'Check your inbox (and spam) for a new verification email.');
      } catch (_) {}
    } catch (e) {
      setError(e?.message || 'Could not resend verification email.');
    } finally {
      setResending(false);
    }
  };

  const openGmailInbox = async () => {
    const webInbox = 'https://mail.google.com/mail/u/0/#inbox';
    if (Platform.OS !== 'web') {
      try {
        const canGmail = await Linking.canOpenURL('googlegmail://');
        if (canGmail) {
          await Linking.openURL('googlegmail://');
          return;
        }
      } catch (_) {
        /* fall through */
      }
    }
    try {
      await Linking.openURL(webInbox);
    } catch (_) {
      try {
        Alert.alert('Open email', 'Open Gmail (or your mail app) and find the Bidify verification message.');
      } catch (__) {}
    }
  };

  const submit = async () => {
    setError('');
    if (submitInFlightRef.current) return;
    if (!sides.front.uri) return setError('Please upload the CNIC front photo.');
    if (!sides.back.uri) return setError('Please upload the CNIC back photo.');

    submitInFlightRef.current = true;
    setSubmitting(true);
    updateSide('front', { status: 'uploading', error: null });
    updateSide('back', { status: 'uploading', error: null });

    // Absolute backstop. Even if every other timeout in the stack fails to
    // fire, this guarantees the spinner cannot spin forever and the user sees an error.
    let backstop;
    const guard = new Promise((_, reject) => {
      backstop = setTimeout(
        () => reject(new Error('Account creation took too long. Please check your connection and try again.')),
        120000
      );
    });

    try {
      // Normalize phone alias: the older RegisterScreen used `phone`, the
      // new one uses `phoneNumber`. registerAPI accepts either, but we
      // explicitly forward both to be safe.
      const phoneNumber = registration.phoneNumber || registration.phone || '';
      const apiPayload = {
        name: registration.fullName,
        fullName: registration.fullName,
        username: registration.username || '',
        email: registration.email,
        password: registration.password,
        phoneNumber,
        phone: phoneNumber, // back-compat for legacy registerAPI parameter
        cnic: registration.cnic,
        cnicFrontUri: sides.front.uri,
        cnicBackUri: sides.back.uri,
      };

      if (__DEV__) {
        const { password: _pw, ...safeLog } = apiPayload;
        console.log('[CnicVerificationScreen] CALLING registerAPI ->', safeLog);
      }

      const response = await Promise.race([completeCnicRegistrationAPI(apiPayload), guard]);

      const pendingVerify =
        response?.pendingEmailVerification === true ||
        (response &&
          typeof response === 'object' &&
          !response.token &&
          !!(response.authUserId || response.user?.id) &&
          !!(response.email || registration.email));

      if (pendingVerify) {
        const emailAddr = response.email || registration.email || '';
        const uid = response.authUserId || response.user?.id;
        console.log('[CnicVerificationScreen] email verification required — opening gate', { emailAddr, uid });
        await savePendingRegistration({
          authUserId: uid,
          email: emailAddr,
          fullName: registration.fullName,
          username: registration.username,
          phoneNumber,
          cnic: registration.cnic,
          cnicFrontUri: sides.front.uri,
          cnicBackUri: sides.back.uri,
        });
        setVerifyEmail(emailAddr);
        updateSide('front', { status: 'ready', error: null });
        updateSide('back', { status: 'ready', error: null });
        setPendingEmailModalVisible(true);
        if (__DEV__) {
          console.log('[CnicVerification] EMAIL GATE OPEN (Modal)', {
            email: emailAddr,
            authUserId: uid,
            pendingRegistrationSaved: true,
          });
        }
        return;
      }

      updateSide('front', { status: 'done' });
      updateSide('back', { status: 'done' });
      if (response?.token || response?.user) {
        await login(response.token || null, response.user || response);
      } else {
        await login(null, response);
      }
    } catch (e) {
      const unique = mapProfileUniqueViolation(e);
      const msg = unique || (e && (e.message || e.toString())) || 'Could not create account.';
      if (isEmailAlreadyRegisteredMessage(msg)) {
        navigation.replace('Register', {
          registrationEmailError: 'This email is already registered.',
        });
        return;
      }
      if (unique && unique.toLowerCase().includes('phone')) {
        navigation.replace('Register', {
          registrationPhoneError: unique,
        });
        return;
      }
      if (unique && unique.toLowerCase().includes('id card')) {
        navigation.replace('Register', {
          registrationCnicError: unique,
        });
        return;
      }
      // One place for the message: banner + alert. Do NOT mirror the same text
      // on both CNIC tiles (users read it as "upload failed" twice).
      setError(msg);
      updateSide('front', { status: 'ready', error: null });
      updateSide('back', { status: 'ready', error: null });
      try {
        Alert.alert('Account creation failed', msg);
      } catch (_) {
        /* web */
      }
    } finally {
      clearTimeout(backstop);
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const sideStatusLine = (side) => {
    if (side.status === 'uploading') return 'Submitting your profile…';
    if (side.status === 'done') return 'Uploaded.';
    if (side.status === 'error') return side.error || 'Upload failed. Tap to retry.';
    if (side.status === 'ready') return 'Ready to upload.';
    return null;
  };

  const emailGateBackdropOpacity = emailGateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });
  const emailGateCardOpacity = emailGateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });
  const emailGateCardScale = emailGateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.94, 1],
  });

  return (
    <>
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.topBar}>
          <TouchableOpacity
            onPress={() => backToOr(navigation, 'Register')}
            style={styles.backBtn}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.topTitle}>CNIC Verification</Text>
          <View style={styles.backBtn} />
        </View>

        <View style={styles.headerBlock}>
          <Text style={styles.title}>One last step</Text>
          <Text style={styles.subtitle}>
            Upload clear photos of both sides of your CNIC. Your account will be created only
            after both images are saved.
          </Text>
        </View>

        {SIDES.map((s) => {
          const side = sides[s.key];
          const isBusy = busySide === s.key;
          const isUploading = side.status === 'uploading';
          const isDone = side.status === 'done';
          const status = sideStatusLine(side);
          return (
            <TouchableOpacity
              key={s.key}
              activeOpacity={0.85}
              style={[styles.tile, side.status === 'error' && styles.tileError]}
              disabled={isBusy || submitting}
              onPress={() => askForSource(s.key)}
            >
              {side.uri ? (
                <View style={styles.tileFilled}>
                  <SmartImage
                    uri={side.uri}
                    style={styles.preview}
                    resizeMode="cover"
                    showLoader={false}
                  />
                  <View style={styles.tileBody}>
                    <Text style={styles.tileTitleDone}>{s.title.replace('Upload ', '')}</Text>
                    {status ? (
                      <Text
                        style={[
                          styles.tileStatus,
                          isDone && styles.tileStatusDone,
                          side.status === 'error' && styles.tileStatusError,
                        ]}
                      >
                        {status}
                      </Text>
                    ) : (
                      <Text style={styles.tileSub}>Tap to retake or change.</Text>
                    )}
                  </View>
                  {isUploading ? (
                    <ActivityIndicator color={colors.text} />
                  ) : isDone ? (
                    <Ionicons name="checkmark-circle" size={24} color="#16A34A" />
                  ) : side.status === 'error' ? (
                    <Ionicons name="alert-circle" size={22} color={colors.danger} />
                  ) : (
                    <Ionicons name="checkmark-circle-outline" size={22} color={colors.textMuted} />
                  )}
                </View>
              ) : (
                <View style={styles.tileEmpty}>
                  <View style={styles.tileIcon}>
                    {isBusy ? (
                      <ActivityIndicator color={colors.text} />
                    ) : (
                      <Ionicons name={s.icon} size={22} color={colors.text} />
                    )}
                  </View>
                  <View style={styles.tileBody}>
                    <Text style={styles.tileTitle}>{s.title}</Text>
                    <Text style={styles.tileSub}>{s.subtitle}</Text>
                  </View>
                  <Ionicons name="cloud-upload-outline" size={20} color={colors.textMuted} />
                </View>
              )}
            </TouchableOpacity>
          );
        })}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <AppButton
          title={submitting ? 'Uploading…' : 'Create Account'}
          onPress={submit}
          loading={submitting}
          style={styles.submit}
        />

        <Text style={styles.legal}>
          Your CNIC images are used only to verify identity and are stored securely.
        </Text>
      </ScrollView>

      {/* SOURCE PICKER — Camera vs Gallery (native only; web bypasses) */}
      <Modal
        visible={sourceSheet.visible}
        transparent
        animationType="slide"
        onRequestClose={() => setSourceSheet({ visible: false, side: null })}
      >
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>
              {sourceSheet.side === 'front' ? 'Upload CNIC Front' : 'Upload CNIC Back'}
            </Text>
            <Text style={styles.sheetSub}>Where do you want to pick the image from?</Text>

            <TouchableOpacity
              style={styles.sheetOption}
              activeOpacity={0.85}
              onPress={() => pickFromCamera(sourceSheet.side)}
            >
              <View style={styles.sheetOptionIcon}>
                <Ionicons name="camera-outline" size={22} color={colors.text} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetOptionTitle}>Use Camera</Text>
                <Text style={styles.sheetOptionSub}>Take a fresh photo of your CNIC.</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.sheetOption}
              activeOpacity={0.85}
              onPress={() => pickFromGallery(sourceSheet.side)}
            >
              <View style={styles.sheetOptionIcon}>
                <Ionicons name="image-outline" size={22} color={colors.text} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetOptionTitle}>Choose from Gallery</Text>
                <Text style={styles.sheetOptionSub}>Pick a saved photo from your device.</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.sheetCancel}
              activeOpacity={0.85}
              onPress={() => setSourceSheet({ visible: false, side: null })}
            >
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={blurCheck.visible}
        transparent
        animationType="fade"
        onRequestClose={confirmBlurReject}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Is this picture clear and not blurry?</Text>
            <Text style={styles.modalSub}>
              Re-take it if the text isn't readable — blurry CNICs are rejected.
            </Text>
            {blurCheck.uri ? (
              <SmartImage
                uri={blurCheck.uri}
                style={styles.modalPreview}
                resizeMode="cover"
              />
            ) : null}
            <View style={styles.modalRow}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={confirmBlurReject}
                activeOpacity={0.85}
              >
                <Text style={styles.modalBtnGhostText}>No, retake</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnSolid]}
                onPress={confirmBlurAccept}
                activeOpacity={0.85}
              >
                <Text style={styles.modalBtnSolidText}>Yes, use it</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>

    <Modal
      visible={pendingEmailModalVisible}
      transparent
      animationType="none"
      presentationStyle="overFullScreen"
      statusBarTranslucent={Platform.OS === 'android'}
      onRequestClose={() => {}}
    >
      <View style={styles.emailGateModalRoot} pointerEvents="box-none">
        <Animated.View
          pointerEvents="none"
          style={[styles.emailGateBackdrop, { opacity: emailGateBackdropOpacity }]}
        />
        <View style={styles.emailGateCenterWrap} pointerEvents="box-none">
          <Animated.View
            style={[
              styles.verifyCard,
              {
                opacity: emailGateCardOpacity,
                transform: [{ scale: emailGateCardScale }],
              },
            ]}
          >
            <View style={styles.verifySuccessIcon}>
              <Ionicons name="checkmark" size={40} color="#FFFFFF" />
            </View>
            <Text style={styles.verifyTitle}>Verify Your Email</Text>
            <Text style={styles.verifyBody}>
              We sent a verification link to:{'\n\n'}
              <Text style={styles.verifyEmail}>{verifyEmail || registration?.email || '—'}</Text>
              {'\n\n'}
              Please open your Gmail and verify your account before continuing.
            </Text>
            <TouchableOpacity
              style={[styles.verifyBtn, styles.verifyBtnSolid, styles.verifyBtnFull]}
              onPress={openGmailInbox}
              activeOpacity={0.85}
            >
              <Text style={styles.verifyBtnSolidText}>Open Gmail</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.verifyBtn, styles.verifyBtnGhost, styles.verifyBtnFull, styles.verifyBtnSpacing]}
              onPress={handleVerifiedEmailTapped}
              activeOpacity={0.85}
              disabled={submitting}
            >
              <Text style={styles.verifyBtnGhostText}>{submitting ? 'Checking…' : 'I Have Verified'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.verifyBtn, styles.verifyBtnOutline, styles.verifyBtnFull]}
              onPress={handleResendVerification}
              activeOpacity={0.85}
              disabled={resending}
            >
              <Text style={styles.verifyBtnOutlineText}>
                {resending ? 'Sending…' : 'Resend Email'}
              </Text>
            </TouchableOpacity>
          </Animated.View>
        </View>
      </View>
    </Modal>
    </>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.xl, paddingBottom: spacing.xxxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topTitle: { ...typography.h2, flex: 1, textAlign: 'center', marginHorizontal: spacing.sm },

  headerBlock: { marginBottom: spacing.xl },
  title: { ...typography.display, marginBottom: 6 },
  subtitle: { ...typography.bodyMuted, lineHeight: 20 },

  tile: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    ...shadows.card,
  },
  tileError: { borderColor: colors.danger },
  tileEmpty: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  tileFilled: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  tileIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileBody: { flex: 1 },
  tileTitle: { ...typography.h3 },
  tileTitleDone: { ...typography.h3 },
  tileSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  tileStatus: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  tileStatusDone: { color: '#16A34A', fontWeight: '700' },
  tileStatusError: { color: colors.danger, fontWeight: '700' },
  preview: { width: 60, height: 44, borderRadius: 8, backgroundColor: colors.surface },

  error: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
    marginTop: spacing.md,
    textAlign: 'center',
  },
  submit: { marginTop: spacing.xl },
  legal: {
    fontSize: 11,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    lineHeight: 16,
  },

  emailGateModalRoot: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  emailGateBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  emailGateCenterWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
  },

  verifyCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#FFFFFF',
    borderRadius: radius.xl,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.card,
  },
  verifyTitle: { ...typography.h2, marginBottom: spacing.sm, textAlign: 'center' },
  verifySuccessIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#16A34A',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: spacing.md,
    borderWidth: 3,
    borderColor: 'rgba(22, 163, 74, 0.25)',
  },
  verifyBody: {
    fontSize: 15,
    color: colors.text,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  verifyEmail: { fontWeight: '800', color: colors.text, fontSize: 15 },
  verifyActions: { flexDirection: 'row', gap: spacing.sm },
  verifyBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  verifyBtnFull: { flex: 0, width: '100%' },
  verifyBtnSpacing: { marginTop: spacing.sm },
  verifyBtnGhost: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  verifyBtnSolid: { backgroundColor: colors.text },
  verifyBtnGhostText: { color: colors.text, fontWeight: '700', fontSize: 14 },
  verifyBtnSolidText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },
  verifyBtnOutline: {
    marginTop: spacing.sm,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.textMuted,
    paddingVertical: 12,
  },
  verifyBtnOutlineText: { color: colors.textMuted, fontWeight: '700', fontSize: 14 },

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.bg,
    borderRadius: radius.xl,
    padding: spacing.xl,
  },
  modalTitle: { ...typography.h2, marginBottom: 6 },
  modalSub: { fontSize: 13, color: colors.textMuted, marginBottom: spacing.lg, lineHeight: 18 },
  modalPreview: {
    width: '100%',
    aspectRatio: 1.6,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    marginBottom: spacing.lg,
  },
  modalRow: { flexDirection: 'row', gap: spacing.sm },
  modalBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBtnGhost: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  modalBtnSolid: { backgroundColor: colors.text },
  modalBtnGhostText: { color: colors.text, fontWeight: '700', fontSize: 14 },
  modalBtnSolidText: { color: colors.bg, fontWeight: '700', fontSize: 14 },

  // Source picker sheet
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: spacing.xl,
    paddingBottom: spacing.xxl,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: spacing.md,
  },
  sheetTitle: { ...typography.h2, marginBottom: 4 },
  sheetSub: { fontSize: 13, color: colors.textMuted, marginBottom: spacing.lg },
  sheetOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  sheetOptionIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetOptionTitle: { fontSize: 14, fontWeight: '700', color: colors.text },
  sheetOptionSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  sheetCancel: {
    marginTop: spacing.md,
    paddingVertical: 14,
    alignItems: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  sheetCancelText: { color: colors.text, fontWeight: '700', fontSize: 14 },
});

export default CnicVerificationScreen;
