import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Platform,
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
  BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { AuthContext } from '../context/AuthContext';
import { submitKycAPI } from '../api/kyc';
import { parseRegistrationFieldError } from '../utils/registrationFieldErrors';
import { showPlatformAlert } from '../utils/platformAlert';
import {
  completeAuthAfterKycSubmit,
  completeKycRetrySubmit,
  waitForAuthStateCommit,
} from '../utils/kycPostSubmitAuth';
import {
  clearKycSignupDraft,
  resolveKycSignupPayload,
  saveKycSignupDraft,
} from '../utils/signupDraftStorage';
import { LocalCaptureImage } from '../utils/localMediaPreview';
import { colors, spacing, typography } from '../theme';

const SCREEN_BG = '#F4F6F8';
const INDIGO = '#1E3A8A';
const CAMERA_SIZE = 280;
const RING_SIZE = 296;
const SCAN_GREEN = '#22C55E';
const SCAN_GREEN_GLOW = 'rgba(34, 197, 94, 0.22)';
const FOOTER_BOTTOM = 40;

function BiometricScanRing({ scanning }) {
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!scanning) {
      spin.stopAnimation();
      spin.setValue(0);
      return undefined;
    }
    spin.setValue(0);
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 2200,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    loop.start();
 
    return () => loop.stop();
  }, [scanning, spin]);

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  if (!scanning) {
    return <View style={styles.successRing} pointerEvents="none" />;
  }

  return (
    <Animated.View
      style={[styles.scanRingRotate, { transform: [{ rotate }] }]}
      pointerEvents="none"
    >
      <View style={styles.scanRingArc} />
    </Animated.View>
  );
}

export default function KycSelfieScreen({ navigation: navigationProp, route }) {
  const navigation = useNavigation() || navigationProp;

  const { login, queuePendingRoute, lockSession, waitForAuthState, refreshProfile, user } =
    useContext(AuthContext);
  const kycPayload = route?.params?.kycPayload || {};
  const registration = route?.params?.registration || null;
  const kycRetry = route?.params?.kycRetry === true;
  const fromSignup = route?.params?.fromSignup === true || (!!registration && !kycRetry);

  const cameraRef = useRef(null);
  const [permission, requestPermission] = useCameraPermissions();

  const [usePickerFallback, setUsePickerFallback] = useState(false);
  const [capturedPhoto, setCapturedPhoto] = useState(null);
  const [capturing, setCapturing] = useState(false);
  const [showReviewModal, setShowReviewModal] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [commitError, setCommitError] = useState('');
  const submitSucceededRef = useRef(false);
  const capturedPhotoRef = useRef(null);

  const spinLoopRef = useRef(null);
  const [hasExitedOnboarding, setHasExitedOnboarding] = useState(false);

  useEffect(() => {
    return () => {
      spinLoopRef.current?.stop?.();
      capturedPhotoRef.current = null;
      setShowReviewModal(false);
      setIsSubmitting(false);
    };
  }, []);

  useEffect(() => {
    if (!hasExitedOnboarding) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [hasExitedOnboarding]);

  useEffect(() => {
    if (registration?.email && registration?.password) {
      void saveKycSignupDraft(registration);
    }
  }, [registration]);

  useEffect(() => {
    if (usePickerFallback) return;
    if (!permission) {
      requestPermission?.().catch(() => setUsePickerFallback(true));
    }
    if (permission && !permission.granted && !permission.canAskAgain) {
      setUsePickerFallback(true);
    }
  }, [permission, requestPermission, usePickerFallback]);

  const handleBack = useCallback(() => {
    if (submitSucceededRef.current || hasExitedOnboarding || isSubmitting) {
      return;
    }
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    if (fromSignup) {
      navigation.navigate('KycScan', { fromSignup: true, registration });
    }
  }, [fromSignup, hasExitedOnboarding, isSubmitting, navigation, registration]);

  const captureFromDeviceCamera = useCallback(async () => {
    try {
      if (Platform.OS !== 'web') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          showPlatformAlert('Permission needed', 'Allow camera access to capture your live selfie.');
          return;
        }
      }
      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: Platform.OS !== 'web',
        quality: 0.8,
        exif: false,
        cameraType: ImagePicker.CameraType?.front ?? 'front',
      });
      const uri = !result.canceled && result.assets?.[0]?.uri ? result.assets[0].uri : null;
      if (uri) {
        capturedPhotoRef.current = uri;
        setCapturedPhoto(uri);
      }
    } catch (e) {
      showPlatformAlert('Capture failed', e?.message || 'Could not open camera.');
    }
  }, []);

  const handleCapturePress = useCallback(async () => {
    if (capturing || capturedPhoto) return;

    if (usePickerFallback || !cameraRef.current?.takePictureAsync) {
      await captureFromDeviceCamera();
      return;
    }

    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.8,
        skipProcessing: Platform.OS === 'android',
      });
      if (photo?.uri) {
        capturedPhotoRef.current = photo.uri;
        setCapturedPhoto(photo.uri);
      }
    } catch (_) {
      await captureFromDeviceCamera();
    } finally {
      setCapturing(false);
    }
  }, [capturedPhoto, captureFromDeviceCamera, capturing, usePickerFallback]);

  const handleRetakePress = useCallback(() => {
    capturedPhotoRef.current = null;
    setCapturedPhoto(null);
  }, []);

  const handleSubmitPress = useCallback(() => {
    console.log('=== SELFIE BUTTON INTERACTION CLICKED SUCCESSFULLY ===');
    if (!capturedPhoto) return;
    setCommitError('');
    setShowReviewModal(true);
  }, [capturedPhoto]);

  const exitToDashboard = useCallback(() => {
    setShowReviewModal(false);
    setHasExitedOnboarding(true);
    if (navigation?.navigate) {
      navigation.navigate('MainTabs', { screen: 'Home' });
      return;
    }
    navigationProp?.navigate?.('MainTabs', { screen: 'Home' });
  }, [navigation, navigationProp]);

  const handleOkPress = useCallback(async () => {
    if (submitSucceededRef.current) {
      exitToDashboard();
      return;
    }

    const selfieUri = capturedPhotoRef.current || capturedPhoto;
    if (isSubmitting || !selfieUri) return;

    setIsSubmitting(true);
    setCommitError('');

    console.log('=== COMMITTING KYC APPLICATION TO DATABASE ===');

    const scanData = {
      name: String(kycPayload?.name || '').trim(),
      fatherName: String(kycPayload?.fatherName || '').trim(),
      cnic: String(kycPayload?.cnic || kycPayload?.cnicNumber || '').trim(),
      cnicNumber: String(kycPayload?.cnicNumber || kycPayload?.cnic || '').trim(),
      dob: String(kycPayload?.dob || '').trim(),
      address: String(kycPayload?.address || '').trim(),
      cnicFrontUri: kycPayload?.cnicFrontUri || null,
      cnicBackUri: kycPayload?.cnicBackUri || null,
    };
    const releaseSessionLock = lockSession?.() || (() => {});

    try {
      if (!fromSignup && !user?.id) {
        throw new Error('You must be signed in to submit KYC.');
      }

      let signupRegistration = null;
      if (fromSignup) {
        signupRegistration = await resolveKycSignupPayload(registration, scanData);
        if (!signupRegistration?.email || !signupRegistration?.password) {
          throw new Error(
            'Signup email and password are missing. Return to Register and start again.'
          );
        }
      }

      const data = await submitKycAPI({
        selfieUri,
        scanData,
        cnicNumber: scanData.cnicNumber,
        cnicFrontUri: scanData.cnicFrontUri,
        cnicBackUri: scanData.cnicBackUri,
        isRealFace: true,
        signupRegistration: fromSignup ? signupRegistration : null,
        profileUserId: !fromSignup ? user?.id : null,
      });

      if (!data?.success) {
        throw new Error(data?.message || data?.error || 'KYC submission failed.');
      }

      if (fromSignup) {
        await completeAuthAfterKycSubmit({
          data,
          signupPayload: signupRegistration,
          registration: signupRegistration,
          scanData,
          login,
          queuePendingRoute,
        });

        await waitForAuthStateCommit(100);

        try {
          await waitForAuthState(
            (snap) => snap.isAuthenticated && !!snap.user?.id,
            10000
          );
        } catch {
          /* RootNavigator may already have swapped stacks */
        }

        try {
          await clearKycSignupDraft();
        } catch {
          /* non-fatal */
        }
      } else {
        await completeKycRetrySubmit({
          data,
          scanData,
          login,
          existingUser: user,
        });
        await refreshProfile?.();
      }

      submitSucceededRef.current = true;
      setIsSubmitting(false);
      setCapturedPhoto(null);
      capturedPhotoRef.current = null;
      exitToDashboard();

    } catch (e) {
      const fieldErr = parseRegistrationFieldError(e);
      const msg =
        fieldErr?.message ||
        e?.response?.data?.error ||
        e?.response?.data?.message ||
        e?.message ||
        'Could not complete registration. Check your connection and try again.';
      setCommitError(msg);
      showPlatformAlert('Submission failed', msg);
      submitSucceededRef.current = false;
      setIsSubmitting(false);
      setShowReviewModal(false);

      if (fieldErr?.field === 'cnic' && navigation?.navigate) {
        navigation.navigate('KycScan', {
          fromSignup,
          registration,
          kycRetry,
          registrationCnicError: fieldErr.message,
        });
        return;
      }
      if (fieldErr?.field === 'phoneNumber' && fromSignup && navigation?.navigate) {
        navigation.navigate('Register', {
          registration,
          registrationPhoneError: fieldErr.message,
        });
        return;
      }
    } finally {
      releaseSessionLock();
    }
  }, [
    capturedPhoto,
    isSubmitting,
    fromSignup,
    kycPayload,
    lockSession,
    kycRetry,
    login,
    queuePendingRoute,
    registration,
    refreshProfile,
    user,
    waitForAuthState,
    exitToDashboard,
  ]);

  const hasCapture = !!capturedPhoto;
  const cameraReady = permission?.granted && !usePickerFallback;

  const previewUri = capturedPhotoRef.current || capturedPhoto;

  if (hasExitedOnboarding) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.exitingWrap}>
          <ActivityIndicator size="large" color={INDIGO} />
          <Text style={styles.exitingText}>Opening your Bidify dashboard…</Text>
        </View>
      </SafeAreaView>
    );
  }

  const renderCameraCircle = () => {
    if (hasCapture && previewUri) {
      return (
        <LocalCaptureImage uri={previewUri} style={styles.cameraPreview} resizeMode="cover" />
      );
    }

    if (usePickerFallback) {
      return (
        <View style={styles.fallbackInner} pointerEvents="none">
          <Ionicons name="camera-outline" size={48} color="#94A3B8" />
          <Text style={styles.fallbackText}>
            Tap Capture to open your front camera for a live selfie.
          </Text>
        </View>
      );
    }

    if (!permission) {
      return (
        <View style={styles.fallbackInner} pointerEvents="none">
          <ActivityIndicator color={INDIGO} />
          <Text style={styles.fallbackText}>Requesting camera permission…</Text>
        </View>
      );
    }

    if (!permission.granted) {
      return (
        <View style={styles.fallbackInner}>
          <Ionicons name="lock-closed-outline" size={40} color={INDIGO} />
          <Text style={styles.fallbackText}>Camera access is required for live face verification.</Text>
          <Pressable
            style={({ pressed }) => [styles.permissionBtn, pressed && styles.btnPressed]}
            onPress={() => requestPermission?.()}
          >
            <Text style={styles.permissionBtnText}>Allow Camera</Text>
          </Pressable>
        </View>
      );
    }

    return (
      <CameraView
        ref={cameraRef}
        style={styles.cameraPreview}
        facing="front"
        mirror={Platform.OS !== 'web'}
      />
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.root} pointerEvents="box-none">
        <View style={styles.headerBar} pointerEvents="box-none">
          <Pressable
            onPress={handleBack}
            style={({ pressed }) => [styles.backBtn, pressed && styles.backBtnPressed]}
            hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="arrow-back" size={22} color={INDIGO} />
          </Pressable>
          <Text style={styles.headerTitle}>Face Verification</Text>
          <View style={styles.headerSpacer} />
        </View>

        <View
          style={[styles.facePill, hasCapture ? styles.facePillOk : styles.facePillWarn]}
          pointerEvents="none"
        >
          <Ionicons
            name={hasCapture ? 'checkmark-circle' : 'scan-outline'}
            size={16}
            color={hasCapture ? '#166534' : '#B45309'}
          />
          <Text
            style={[
              styles.facePillText,
              hasCapture ? styles.facePillTextOk : styles.facePillTextWarn,
            ]}
          >
            {hasCapture
              ? 'Face captured — ready to submit'
              : cameraReady
                ? 'Align your face in the circle'
                : 'Enable front camera to continue'}
          </Text>
        </View>

        <View style={styles.content} pointerEvents="box-none">
          <Text style={styles.subtitle} pointerEvents="none">
            Position your face in the frame. Only a live front-camera capture is accepted — no gallery uploads.
          </Text>

          <View style={styles.cameraRingOuter} pointerEvents="none">
            <BiometricScanRing scanning={!hasCapture} />
            <View style={styles.cameraRing}>{renderCameraCircle()}</View>
          </View>
        </View>

        <View style={styles.footerActions} pointerEvents="box-none">
          <View style={styles.footerInner} pointerEvents="auto">
            {!hasCapture ? (
              <Pressable
                style={({ pressed }) => [
                  styles.captureBtnActive,
                  capturing && styles.btnDisabled,
                  pressed && !capturing && styles.btnPressed,
                ]}
                onPress={handleCapturePress}
                disabled={capturing}
                accessibilityRole="button"
                accessibilityLabel="Capture live selfie"
              >
                {capturing ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.captureBtnActiveText}>Capture Live Selfie</Text>
                )}
              </Pressable>
            ) : (
              <Pressable
                style={({ pressed }) => [styles.retakeBtn, pressed && styles.btnPressed]}
                onPress={handleRetakePress}
                accessibilityRole="button"
                accessibilityLabel="Retake live selfie"
              >
                <Text style={styles.retakeBtnText}>Retake Live Selfie</Text>
              </Pressable>
            )}

            <Pressable
              style={({ pressed }) => [
                styles.submitBtn,
                !hasCapture && styles.submitBtnDisabled,
                hasCapture && styles.submitBtnEnabled,
                pressed && hasCapture && styles.btnPressed,
              ]}
              onPress={handleSubmitPress}
              disabled={!hasCapture}
              accessibilityRole="button"
              accessibilityLabel="Submit and continue"
            >
              <Text
                style={[
                  styles.submitBtnText,
                  !hasCapture && styles.submitBtnTextDisabled,
                ]}
              >
                Submit & Continue
              </Text>
            </Pressable>
          </View>
        </View>

        <Modal
          visible={showReviewModal}
          transparent
          animationType="fade"
          onRequestClose={() => {
            if (!isSubmitting) setShowReviewModal(false);
          }}
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => {
              if (!isSubmitting) setShowReviewModal(false);
            }}
          >
            <View style={styles.modalCard}>
              <View style={styles.modalIconWrap}>
                <Ionicons name="hourglass-outline" size={40} color={INDIGO} />
              </View>
              <Text style={styles.modalTitle}>⏳ Your Account is Under Review</Text>
              <Text style={styles.modalDescription}>
                Our systems are assessing your identity parameters. Bidding will remain restricted for the next 5 minutes during this evaluation.
              </Text>
              {isSubmitting ? (
                <View style={styles.modalLoadingBlock}>
                  <ActivityIndicator size="large" color={INDIGO} />
                  <Text style={styles.modalLoadingText}>
                    Creating your account and saving verification data…
                  </Text>
                  <Text style={styles.modalLoadingSubtext}>Please do not close this screen.</Text>
                </View>
              ) : null}
              {commitError ? (
                <Text style={styles.modalErrorText}>{commitError}</Text>
              ) : null}
              <Pressable
                style={({ pressed }) => [
                  styles.modalOkBtn,
                  isSubmitting && styles.btnDisabled,
                  pressed && !isSubmitting && styles.btnPressed,
                ]}
                onPress={handleOkPress}
                disabled={isSubmitting}
                accessibilityRole="button"
                accessibilityLabel="OK"
              >
                {isSubmitting ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.modalOkBtnText}>OK</Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Modal>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: SCREEN_BG },
  exitingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
  },
  exitingText: {
    fontSize: 16,
    fontWeight: '700',
    color: INDIGO,
    textAlign: 'center',
  },
  root: { flex: 1, position: 'relative' },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    zIndex: 30,
    backgroundColor: SCREEN_BG,
  },
  backBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backBtnPressed: { opacity: 0.82 },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '800',
    color: INDIGO,
  },
  headerSpacer: { width: 44 },
  facePill: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 72 : 64,
    alignSelf: 'center',
    left: spacing.lg,
    right: spacing.lg,
    zIndex: 100,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderRadius: 999,
    borderWidth: 1,
  },
  facePillOk: {
    backgroundColor: '#DCFCE7',
    borderColor: '#86EFAC',
  },
  facePillWarn: {
    backgroundColor: '#FEF3C7',
    borderColor: '#FCD34D',
  },
  facePillText: { fontSize: 13, fontWeight: '700' },
  facePillTextOk: { color: '#166534' },
  facePillTextWarn: { color: '#B45309' },
  content: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xxl + spacing.lg,
    paddingBottom: 180,
  },
  subtitle: {
    ...typography.bodyMuted,
    lineHeight: 22,
    marginBottom: spacing.lg,
    textAlign: 'center',
  },
  cameraRingOuter: {
    width: RING_SIZE,
    height: RING_SIZE,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
  },
  scanRingRotate: {
    position: 'absolute',
    width: RING_SIZE,
    height: RING_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanRingArc: {
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth: 4,
    borderColor: SCAN_GREEN_GLOW,
    borderTopColor: SCAN_GREEN,
    borderRightColor: SCAN_GREEN,
    borderBottomColor: 'transparent',
    borderLeftColor: 'transparent',
    shadowColor: SCAN_GREEN,
    shadowOpacity: 0.75,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  successRing: {
    position: 'absolute',
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth: 4,
    borderColor: SCAN_GREEN,
    shadowColor: SCAN_GREEN,
    shadowOpacity: 0.55,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  cameraRing: {
    width: CAMERA_SIZE,
    height: CAMERA_SIZE,
    borderRadius: CAMERA_SIZE / 2,
    overflow: 'hidden',
    borderWidth: 3,
    borderColor: INDIGO,
    backgroundColor: '#EFF6FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraPreview: {
    width: CAMERA_SIZE,
    height: CAMERA_SIZE,
    borderRadius: CAMERA_SIZE / 2,
  },
  fallbackInner: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  fallbackText: {
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '600',
    color: '#64748B',
    lineHeight: 18,
  },
  permissionBtn: {
    marginTop: spacing.sm,
    backgroundColor: INDIGO,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: spacing.lg,
  },
  permissionBtnText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  footerActions: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: FOOTER_BOTTOM,
    zIndex: 999,
    pointerEvents: 'box-none',
  },
  footerInner: {
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
    pointerEvents: 'auto',
    ...(Platform.OS === 'web' ? { cursor: 'auto' } : {}),
  },
  captureBtnActive: {
    backgroundColor: INDIGO,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    minHeight: 52,
    justifyContent: 'center',
    pointerEvents: 'auto',
    zIndex: 999,
  },
  captureBtnActiveText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 16,
  },
  retakeBtn: {
    backgroundColor: colors.white,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    minHeight: 52,
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: INDIGO,
    pointerEvents: 'auto',
    zIndex: 999,
  },
  retakeBtnText: {
    color: INDIGO,
    fontWeight: '800',
    fontSize: 16,
  },
  submitBtn: {
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    minHeight: 52,
    justifyContent: 'center',
    position: 'relative',
    zIndex: 999,
    pointerEvents: 'auto',
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : {}),
  },
  submitBtnDisabled: {
    backgroundColor: '#CBD5E1',
    opacity: 0.4,
  },
  submitBtnEnabled: {
    backgroundColor: INDIGO,
    opacity: 1,
  },
  submitBtnText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 16,
  },
  submitBtnTextDisabled: {
    color: '#64748B',
  },
  btnPressed: { opacity: 0.9, transform: [{ scale: 0.98 }] },
  btnDisabled: { opacity: 0.65 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  modalCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.white,
    borderRadius: 20,
    padding: spacing.xl,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  modalIconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#EFF6FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: INDIGO,
    textAlign: 'center',
    marginBottom: spacing.md,
    lineHeight: 28,
  },
  modalDescription: {
    ...typography.bodyMuted,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.xl,
  },
  modalLoadingBlock: {
    width: '100%',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.lg,
    paddingVertical: spacing.sm,
  },
  modalLoadingText: {
    fontSize: 14,
    fontWeight: '700',
    color: INDIGO,
    textAlign: 'center',
    lineHeight: 20,
  },
  modalLoadingSubtext: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'center',
  },
  modalOkBtn: {
    width: '100%',
    backgroundColor: INDIGO,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    minHeight: 52,
    justifyContent: 'center',
    pointerEvents: 'auto',
  },
  modalOkBtnText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 16,
  },
  modalErrorText: {
    color: '#DC2626',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: spacing.md,
    lineHeight: 18,
  },
});