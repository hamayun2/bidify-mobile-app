import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Animated,
  Easing,
  Modal,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { CameraView, useCameraPermissions } from 'expo-camera';
import AppInput from '../components/ui/AppInput';
import { LocalCaptureImage } from '../utils/localMediaPreview';
import { AuthContext } from '../context/AuthContext';
import { scanCnicAPI } from '../api/kyc';
import { checkCnicAvailableAPI } from '../api/registration';
import { isAuxiliaryApiConfigured } from '../api/client';
import { formatPakistaniCnic } from '../utils/cnicFormat';
import { saveKycSignupDraft } from '../utils/signupDraftStorage';
import { showPlatformAlert } from '../utils/platformAlert';
import { colors, radius, spacing, typography } from '../theme';

const SCREEN_BG = '#F4F6F8';
const INDIGO = '#1E3A8A';
const LASER_COLOR = '#22D3EE';
const SUCCESS_BORDER = '#16A34A';

const MODES = {
  MANUAL: 'manual',
  SCAN: 'scan',
};

function ModeSegment({ mode, onChange }) {
  return (
    <View style={styles.segmentWrap} pointerEvents="box-none">
      <Pressable
        style={({ pressed }) => [
          styles.segmentBtn,
          mode === MODES.MANUAL && styles.segmentBtnActive,
          pressed && styles.segmentBtnPressed,
        ]}
        onPress={() => onChange(MODES.MANUAL)}
        accessibilityRole="button"
        accessibilityLabel="Enter details manually"
      >
        <Ionicons
          name="create-outline"
          size={16}
          color={mode === MODES.MANUAL ? '#FFFFFF' : INDIGO}
        />
        <Text style={[styles.segmentText, mode === MODES.MANUAL && styles.segmentTextActive]}>
          Enter Manually
        </Text>
      </Pressable>
      <Pressable
        style={({ pressed }) => [
          styles.segmentBtn,
          mode === MODES.SCAN && styles.segmentBtnActive,
          pressed && styles.segmentBtnPressed,
        ]}
        onPress={() => onChange(MODES.SCAN)}
        accessibilityRole="button"
        accessibilityLabel="Scan CNIC"
      >
        <Ionicons
          name="scan-outline"
          size={16}
          color={mode === MODES.SCAN ? '#FFFFFF' : INDIGO}
        />
        <Text style={[styles.segmentText, mode === MODES.SCAN && styles.segmentTextActive]}>
          Scan CNIC
        </Text>
      </Pressable>
    </View>
  );
}

function LaserScannerOverlay() {
  const laserY = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(laserY, {
          toValue: 1,
          duration: 2200,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(laserY, {
          toValue: 0,
          duration: 2200,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [laserY]);

  const translateY = laserY.interpolate({
    inputRange: [0, 1],
    outputRange: [4, 168],
  });

  return (
    <View style={styles.guideOverlay} pointerEvents="none">
      <View style={styles.guideBox} pointerEvents="none">
        <View style={[styles.corner, styles.cornerTL]} pointerEvents="none" />
        <View style={[styles.corner, styles.cornerTR]} pointerEvents="none" />
        <View style={[styles.corner, styles.cornerBL]} pointerEvents="none" />
        <View style={[styles.corner, styles.cornerBR]} pointerEvents="none" />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.laserLine,
            {
              transform: [{ translateY }],
            },
          ]}
        />
      </View>
      <Text style={styles.guideHint} pointerEvents="none">
        Align CNIC front inside the frame
      </Text>
    </View>
  );
}

function ScanProcessingModal({ visible }) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => {}}
    >
      <View style={styles.processingBackdrop} pointerEvents="auto">
        <View style={styles.processingCard}>
          <ActivityIndicator size="large" color={INDIGO} />
          <Text style={styles.processingMessage}>Verifying your CNIC ID details...</Text>
        </View>
      </View>
    </Modal>
  );
}

function CnicCameraPane({ onCaptured, cameraRef, scanning, previewUri }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [usePickerFallback, setUsePickerFallback] = useState(Platform.OS === 'web');

  useEffect(() => {
    if (usePickerFallback) return;
    if (!permission?.granted && permission?.canAskAgain !== false) {
      requestPermission?.().catch(() => setUsePickerFallback(true));
    }
    if (permission && !permission.granted && !permission.canAskAgain) {
      setUsePickerFallback(true);
    }
  }, [permission, requestPermission, usePickerFallback]);

  const captureFromDeviceCamera = useCallback(async () => {
    try {
      if (Platform.OS !== 'web') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          showPlatformAlert('Permission needed', 'Allow camera access to scan your CNIC.');
          return;
        }
      }
      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: Platform.OS !== 'web',
        quality: 0.92,
        exif: false,
        cameraType: ImagePicker.CameraType?.back ?? 'back',
      });
      const uri = !result.canceled && result.assets?.[0]?.uri ? result.assets[0].uri : null;
      if (uri) onCaptured(uri);
    } catch (e) {
      showPlatformAlert('Capture failed', e?.message || 'Could not open camera.');
    }
  }, [onCaptured]);

  const captureLive = useCallback(async () => {
    if (scanning) return;
    if (usePickerFallback || !cameraRef.current?.takePictureAsync) {
      return captureFromDeviceCamera();
    }
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.88,
        skipProcessing: Platform.OS === 'android',
      });
      if (photo?.uri) onCaptured(photo.uri);
    } catch (e) {
      console.error('[KycScan] takePictureAsync', e);
      await captureFromDeviceCamera();
    }
  }, [cameraRef, captureFromDeviceCamera, onCaptured, scanning, usePickerFallback]);

  if (usePickerFallback) {
    return (
      <View style={styles.cameraFallback}>
        <Ionicons name="camera-outline" size={40} color={INDIGO} />
        <Text style={styles.fallbackTitle}>Live camera required</Text>
        <Text style={styles.fallbackSub}>
          On this device, open the camera to capture the CNIC front.
        </Text>
        <Pressable
          style={({ pressed }) => [
            styles.fallbackPrimaryBtn,
            pressed && styles.btnPressed,
            scanning && styles.btnDisabled,
          ]}
          onPress={captureFromDeviceCamera}
          disabled={scanning}
        >
          <Text style={styles.fallbackPrimaryText}>Open Camera</Text>
        </Pressable>
      </View>
    );
  }

  if (!permission?.granted) {
    return (
      <View style={styles.cameraFallback}>
        <ActivityIndicator color={INDIGO} />
        <Text style={styles.fallbackSub}>Requesting camera permission…</Text>
      </View>
    );
  }

  return (
    <View style={styles.cameraShell}>
      <View style={styles.cameraViewport} pointerEvents="box-none">
        {previewUri ? (
          <LocalCaptureImage uri={previewUri} style={styles.camera} resizeMode="cover" />
        ) : (
          <CameraView ref={cameraRef} style={styles.camera} facing="back" />
        )}
        {!previewUri ? <LaserScannerOverlay /> : null}
      </View>
      <Text style={styles.captureHint}>
        {previewUri ? 'Photo captured — verifying…' : 'Tap shutter to scan CNIC front'}
      </Text>
      <Pressable
        style={({ pressed }) => [
          styles.shutterBtn,
          pressed && !scanning && styles.shutterBtnPressed,
          scanning && styles.btnDisabled,
        ]}
        onPress={captureLive}
        disabled={scanning}
        accessibilityRole="button"
        accessibilityLabel="Capture CNIC photo"
      >
        <View style={styles.shutterInner} />
      </Pressable>
    </View>
  );
}

export default function KycScanScreen({ navigation: navigationProp, route }) {
  const navigation = useNavigation() || navigationProp;
  const { user, logout } = useContext(AuthContext);
  const registration = route?.params?.registration || null;
  const kycRetry = route?.params?.kycRetry === true;
  const prefillProfile = route?.params?.prefillProfile || null;
  const fromSignup = route?.params?.fromSignup === true || (!!registration && !kycRetry);
  const onboarding = route?.params?.onboarding === true || kycRetry;
  const cameraRef = useRef(null);
  const scrollRef = useRef(null);

  const [mode, setMode] = useState(MODES.SCAN);
  const [capturedCnicUri, setCapturedCnicUri] = useState(null);
  const [name, setName] = useState(
    registration?.fullName || registration?.name || user?.fullName || user?.name || ''
  );
  const [fatherName, setFatherName] = useState('');
  const [cnic, setCnic] = useState(
    formatPakistaniCnic(
      prefillProfile?.cnic || user?.cnic_number || user?.cnic || ''
    ) || ''
  );
  const [dob, setDob] = useState('');
  const [address, setAddress] = useState('');
  const [scanning, setScanning] = useState(false);
  const [checkingCnic, setCheckingCnic] = useState(false);
  const [error, setError] = useState('');
  const [cnicTakenError, setCnicTakenError] = useState('');

  useEffect(() => {
    const cnicMsg = route?.params?.registrationCnicError;
    if (cnicMsg) {
      setCnicTakenError(String(cnicMsg));
    }
  }, [route?.params?.registrationCnicError]);

  const [successFields, setSuccessFields] = useState({
    name: false,
    fatherName: false,
    cnic: false,
    dob: false,
    address: false,
  });

  const cnicFormatted = formatPakistaniCnic(cnic);
  const cnicValid = /^\d{5}-\d{7}-\d$/.test(cnicFormatted);
  const fieldsComplete =
    String(name).trim().length > 0 &&
    String(fatherName).trim().length > 0 &&
    cnicValid &&
    String(dob).trim().length > 0 &&
    String(address).trim().length > 0;

  const canContinue = fieldsComplete;

  useEffect(() => {
    if (!kycRetry || !prefillProfile) return;
    if (prefillProfile.name || prefillProfile.fullName) {
      setName(String(prefillProfile.name || prefillProfile.fullName).trim());
    }
    if (prefillProfile.cnic) {
      setCnic(formatPakistaniCnic(prefillProfile.cnic));
    }
  }, [kycRetry, prefillProfile]);

  const clearScanState = useCallback(() => {
    setScanning(false);
    setError('');
    setSuccessFields({
      name: false,
      fatherName: false,
      cnic: false,
      dob: false,
      address: false,
    });
  }, []);

  const handleBack = useCallback(() => {
    clearScanState();
    if (fromSignup) {
      navigation.navigate('Register', {
        registration: {
          ...registration,
          firstName: registration?.firstName || '',
          lastName: registration?.lastName || '',
          fullName:
            registration?.fullName ||
            [registration?.firstName, registration?.lastName].filter(Boolean).join(' '),
          email: registration?.email || '',
          phoneNumber: registration?.phoneNumber || registration?.phone || '',
          password: registration?.password || '',
          confirmPassword: registration?.confirmPassword || '',
        },
      });
      return;
    }
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    if (onboarding && typeof logout === 'function') {
      void logout({ force: true });
      return;
    }
    navigation.goBack();
  }, [clearScanState, fromSignup, name, navigation, onboarding, logout, registration]);

  const flashSuccessBorders = useCallback((parsed) => {
    setSuccessFields({
      name: !!parsed.name,
      fatherName: !!parsed.fatherName,
      cnic: !!parsed.cnic,
      dob: !!parsed.dob,
      address: !!parsed.address,
    });
    setTimeout(() => {
      setSuccessFields({
        name: false,
        fatherName: false,
        cnic: false,
        dob: false,
        address: false,
      });
    }, 2800);
  }, []);

  const applyParsedFields = useCallback(
    (parsed) => {
      if (parsed.name) setName(parsed.name);
      if (parsed.fatherName) setFatherName(parsed.fatherName);
      if (parsed.cnic) setCnic(formatPakistaniCnic(parsed.cnic));
      if (parsed.dob) setDob(parsed.dob);
      if (parsed.address) setAddress(parsed.address);
      flashSuccessBorders(parsed);
      const ready =
        !!String(parsed.name || '').trim() &&
        !!String(parsed.fatherName || '').trim() &&
        /^\d{5}-\d{7}-\d$/.test(formatPakistaniCnic(parsed.cnic)) &&
        !!String(parsed.dob || '').trim() &&
        !!String(parsed.address || '').trim();
      if (ready) setMode(MODES.MANUAL);
    },
    [flashSuccessBorders]
  );

  const handleImageCaptured = useCallback(
    async (uri) => {
      if (!uri) return;
      setError('');
      setCapturedCnicUri(uri);
      setScanning(true);
      try {
        const parsed = await scanCnicAPI(uri, {
          registration: fromSignup ? registration : undefined,
        });
        applyParsedFields(parsed);
        setTimeout(() => {
          scrollRef.current?.scrollTo?.({ y: 320, animated: true });
        }, 120);
      } catch (e) {
        console.error('[KycScan] scanCnicAPI', e);
        if (e?.response?.status === 403) {
          console.log('Detailed 403 Error Log:', e.response?.data);
        }
        const msg =
          e?.response?.data?.message ||
          e?.response?.data?.error ||
          e?.message ||
          'CNIC scan failed.';
        setError(msg);
        showPlatformAlert('Scan failed', msg);
        setCapturedCnicUri(null);
      } finally {
        setScanning(false);
      }
    },
    [applyParsedFields, fromSignup, registration]
  );

  const handleCnicChange = useCallback((text) => {
    setCnic(formatPakistaniCnic(text));
    setCnicTakenError('');
  }, []);

  const handleContinue = async () => {
    if (!fieldsComplete || checkingCnic) return;
    setError('');
    setCnicTakenError('');

    if (isAuxiliaryApiConfigured()) {
      setCheckingCnic(true);
      try {
        const excludeUserId = kycRetry && user?.id ? user.id : undefined;
        const { available, reason } = await checkCnicAvailableAPI(cnicFormatted, excludeUserId);
        if (!available) {
          setCnicTakenError(
            reason ||
              'This CNIC is already in use. Please check your number or log in.'
          );
          return;
        }
      } catch (e) {
        const status = e?.response?.status;
        if (status === 404) {
          if (__DEV__) {
            console.warn(
              '[KycScan] check-registration-fields 404 — restart API (npm run api). Continuing to selfie step.'
            );
          }
        } else {
          setError(e?.message || 'Could not verify CNIC. Try again.');
          return;
        }
      } finally {
        setCheckingCnic(false);
      }
    }

    const kycPayload = {
      name: String(name).trim(),
      fatherName: String(fatherName).trim(),
      cnic: cnicFormatted,
      cnicNumber: cnicFormatted,
      dob: String(dob).trim(),
      address: String(address).trim(),
      cnicFrontUri: capturedCnicUri || null,
      cnicBackUri: route?.params?.cnicBackUri || capturedCnicUri || null,
    };

    const registrationBundle =
      fromSignup && registration
        ? {
            ...registration,
            firstName: String(registration.firstName || '').trim(),
            lastName: String(registration.lastName || '').trim(),
            fullName:
              registration.fullName ||
              [registration.firstName, registration.lastName].filter(Boolean).join(' '),
            name:
              registration.name ||
              registration.fullName ||
              [registration.firstName, registration.lastName].filter(Boolean).join(' '),
            email: String(registration.email || '').trim(),
            phoneNumber: registration.phoneNumber || registration.phone || '',
            phone: registration.phone || registration.phoneNumber || '',
            password: registration.password || '',
            confirmPassword: registration.confirmPassword || registration.password || '',
          }
        : undefined;

    if (registrationBundle) {
      void saveKycSignupDraft(registrationBundle);
    }

    const selfieParams = {
      kycPayload,
      onboarding,
      fromSignup,
      kycRetry,
      registration: registrationBundle,
    };

    if (navigation?.navigate) {
      navigation.navigate('KycSelfie', selfieParams);
      return;
    }
    navigationProp?.navigate?.('KycSelfie', selfieParams);
  };

  const inputBorder = (key) =>
    successFields[key] ? { borderColor: SUCCESS_BORDER, borderWidth: 2 } : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
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
        <Text style={styles.headerTitle}>CNIC Verification</Text>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
      >
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          nestedScrollEnabled
        >
          <Text style={styles.lead}>
            Verify your CNIC details to unlock full account features — Binance-style KYC step 1.
          </Text>

          <ModeSegment mode={mode} onChange={setMode} />

          {mode === MODES.SCAN ? (
            <CnicCameraPane
              cameraRef={cameraRef}
              onCaptured={handleImageCaptured}
              scanning={scanning}
              previewUri={capturedCnicUri}
            />
          ) : null}

          <View style={styles.formBlock}>
            <Text style={styles.formHeading}>Your details</Text>
            <Text style={styles.fieldLabel}>Full Name</Text>
            <AppInput
              value={name}
              onChangeText={setName}
              placeholder="As on CNIC"
              autoCapitalize="words"
              iconName="person-outline"
              style={[styles.input, inputBorder('name')]}
            />
            <Text style={styles.fieldLabel}>Father&apos;s Name</Text>
            <AppInput
              value={fatherName}
              onChangeText={setFatherName}
              placeholder="Father / guardian name"
              autoCapitalize="words"
              iconName="people-outline"
              style={[styles.input, inputBorder('fatherName')]}
            />
            <Text style={styles.fieldLabel}>CNIC Number *</Text>
            <AppInput
              value={cnicFormatted}
              onChangeText={handleCnicChange}
              placeholder="12345-1234567-1"
              keyboardType="numbers-and-punctuation"
              iconName="card-outline"
              style={[styles.input, inputBorder('cnic')]}
            />
            {cnicTakenError ? (
              <Text style={styles.fieldError}>{cnicTakenError}</Text>
            ) : null}
            <Text style={styles.fieldLabel}>Date of Birth</Text>
            <AppInput
              value={dob}
              onChangeText={setDob}
              placeholder="DD/MM/YYYY"
              keyboardType="numbers-and-punctuation"
              iconName="calendar-outline"
              style={[styles.input, inputBorder('dob')]}
            />
            <Text style={styles.fieldLabel}>Address</Text>
            <AppInput
              value={address}
              onChangeText={setAddress}
              placeholder="As printed on CNIC"
              autoCapitalize="words"
              iconName="location-outline"
              multiline
              numberOfLines={2}
              style={[styles.input, inputBorder('address')]}
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>

          <Text style={styles.legal}>
            Images are processed securely. OCR runs on our server; we do not store scan photos unless
            you complete full KYC.
          </Text>
        </ScrollView>

        <View style={styles.footerBar}>
          <Pressable
            style={({ pressed }) => [
              styles.continueBtn,
              !canContinue && styles.continueBtnDisabled,
              pressed && canContinue && styles.continueBtnPressed,
            ]}
            onPress={handleContinue}
            disabled={!canContinue || checkingCnic}
            accessibilityRole="button"
            accessibilityLabel="Continue to face verification"
          >
            {checkingCnic ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <>
                <Text
                  style={[
                    styles.continueBtnText,
                    !canContinue && styles.continueBtnTextDisabled,
                  ]}
                >
                  Continue with Face Verification
                </Text>
                <Ionicons
                  name="arrow-forward"
                  size={18}
                  color={canContinue ? '#FFFFFF' : '#94A3B8'}
                />
              </>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      <ScanProcessingModal visible={scanning} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: SCREEN_BG },
  flex: { flex: 1 },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    zIndex: 20,
    elevation: 20,
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
  backBtnPressed: { opacity: 0.82, transform: [{ scale: 0.97 }] },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '800',
    color: INDIGO,
    marginHorizontal: spacing.sm,
  },
  headerSpacer: { width: 44 },
  scroll: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl },
  lead: { ...typography.bodyMuted, lineHeight: 22, marginBottom: spacing.lg },

  segmentWrap: {
    flexDirection: 'row',
    backgroundColor: colors.white,
    borderRadius: radius.pill,
    padding: 4,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.lg,
    zIndex: 10,
  },
  segmentBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: radius.pill,
  },
  segmentBtnActive: { backgroundColor: INDIGO },
  segmentBtnPressed: { opacity: 0.88 },
  segmentText: { fontSize: 13, fontWeight: '700', color: INDIGO },
  segmentTextActive: { color: '#FFFFFF' },

  cameraShell: {
    borderRadius: radius.xl,
    overflow: 'hidden',
    backgroundColor: '#0F172A',
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cameraViewport: {
    width: '100%',
    height: 280,
    position: 'relative',
  },
  camera: { ...StyleSheet.absoluteFillObject },
  shutterBtn: {
    alignSelf: 'center',
    marginVertical: spacing.md,
    width: 68,
    height: 68,
    borderRadius: 34,
    borderWidth: 4,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
    zIndex: 5,
  },
  shutterBtnPressed: { opacity: 0.85, transform: [{ scale: 0.96 }] },
  shutterInner: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#FFFFFF',
  },

  guideOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.35)',
    zIndex: 2,
  },
  guideBox: {
    width: '82%',
    maxWidth: 320,
    height: 180,
    borderWidth: 2,
    borderColor: 'rgba(34, 211, 238, 0.85)',
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.12)',
  },
  corner: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderColor: LASER_COLOR,
  },
  cornerTL: { top: -1, left: -1, borderTopWidth: 3, borderLeftWidth: 3 },
  cornerTR: { top: -1, right: -1, borderTopWidth: 3, borderRightWidth: 3 },
  cornerBL: { bottom: -1, left: -1, borderBottomWidth: 3, borderLeftWidth: 3 },
  cornerBR: { bottom: -1, right: -1, borderBottomWidth: 3, borderRightWidth: 3 },
  laserLine: {
    position: 'absolute',
    left: 8,
    right: 8,
    height: 3,
    borderRadius: 2,
    backgroundColor: LASER_COLOR,
    shadowColor: LASER_COLOR,
    shadowOpacity: 0.95,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  guideHint: {
    marginTop: spacing.md,
    color: '#E2E8F0',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },

  cameraFallback: {
    backgroundColor: colors.white,
    borderRadius: radius.xl,
    padding: spacing.xl,
    alignItems: 'center',
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  fallbackTitle: { ...typography.h3, marginTop: spacing.md, marginBottom: spacing.sm },
  fallbackSub: { ...typography.bodyMuted, textAlign: 'center', lineHeight: 20, marginBottom: spacing.md },
  fallbackPrimaryBtn: {
    width: '100%',
    backgroundColor: INDIGO,
    borderRadius: radius.lg,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  fallbackPrimaryText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  fallbackOutlineBtn: {
    width: '100%',
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  fallbackOutlineText: { color: INDIGO, fontWeight: '700', fontSize: 15 },
  btnPressed: { opacity: 0.88 },
  btnDisabled: { opacity: 0.55 },

  formBlock: {
    backgroundColor: colors.white,
    borderRadius: radius.xl,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  formHeading: { ...typography.h2, marginBottom: spacing.md },
  fieldLabel: { ...typography.label, marginBottom: spacing.xs, marginTop: spacing.sm },
  input: { marginBottom: spacing.xs },
  fieldError: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 6,
    marginBottom: 4,
  },
  error: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
    marginTop: spacing.md,
    textAlign: 'center',
  },
  saveBtn: {
    marginTop: spacing.lg,
    backgroundColor: INDIGO,
    borderRadius: radius.lg,
    paddingVertical: 14,
    alignItems: 'center',
  },
  saveBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },

  footerBar: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    backgroundColor: SCREEN_BG,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    zIndex: 30,
    elevation: 30,
  },
  continueBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: INDIGO,
    borderRadius: radius.lg,
    paddingVertical: 16,
    paddingHorizontal: spacing.lg,
  },
  continueBtnPressed: { opacity: 0.9, transform: [{ scale: 0.99 }] },
  continueBtnDisabled: { backgroundColor: '#CBD5E1' },
  continueBtnText: { color: '#FFFFFF', fontWeight: '800', fontSize: 16 },
  continueBtnTextDisabled: { color: '#64748B' },

  legal: {
    fontSize: 11,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 16,
    paddingHorizontal: spacing.sm,
    marginTop: spacing.sm,
  },

  processingBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.88)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  processingCard: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: colors.white,
    borderRadius: radius.xl,
    padding: spacing.xl,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  captureHint: {
    textAlign: 'center',
    color: '#CBD5E1',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  processingMessage: {
    marginTop: spacing.lg,
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
    lineHeight: 22,
  },
});
