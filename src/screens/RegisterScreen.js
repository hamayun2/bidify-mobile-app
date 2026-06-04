import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AppInput from '../components/ui/AppInput';
import { colors, spacing, typography } from '../theme';
import { backToLogin } from '../utils/safeBack';
import { isSupabaseConfigured } from '../api/supabaseClient';
import { checkEmailAvailableAPI, checkPhoneAvailableAPI } from '../api/registration';
import { isAuxiliaryApiConfigured } from '../api/client';
import { isReservedAdminEmail } from '../constants/adminConfig';
import { showPlatformAlert } from '../utils/platformAlert';
import { saveKycSignupDraft } from '../utils/signupDraftStorage';
import { normalizeDigits, validatePakPhone } from '../utils/pakValidation';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function buildFullName(firstName, lastName) {
  return [String(firstName || '').trim(), String(lastName || '').trim()].filter(Boolean).join(' ');
}

const RegisterScreen = ({ navigation, route }) => {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [touched, setTouched] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [emailTakenError, setEmailTakenError] = useState('');
  const [phoneTakenError, setPhoneTakenError] = useState(null);

  const markTouched = useCallback((key) => {
    setTouched((t) => ({ ...t, [key]: true }));
  }, []);

  useEffect(() => {
    const draft = route?.params?.registration;
    if (!draft) return;
    if (draft.firstName) setFirstName(String(draft.firstName));
    if (draft.lastName) setLastName(String(draft.lastName));
    if (!draft.firstName && !draft.lastName && draft.fullName) {
      const parts = String(draft.fullName).trim().split(/\s+/);
      if (parts.length >= 2) {
        setFirstName(parts[0]);
        setLastName(parts.slice(1).join(' '));
      } else if (parts[0]) {
        setFirstName(parts[0]);
      }
    }
    if (draft.email) setEmail(String(draft.email));
    if (draft.phoneNumber || draft.phone) {
      setPhoneNumber(normalizeDigits(draft.phoneNumber || draft.phone).slice(0, 11));
    }
    if (draft.password) setPassword(String(draft.password));
    if (draft.confirmPassword) setConfirmPassword(String(draft.confirmPassword));
  }, [route?.params?.registration]);

  useEffect(() => {
    const msg = route?.params?.registrationEmailError;
    if (msg) {
      setEmailTakenError(String(msg));
      markTouched('email');
    }
  }, [route?.params?.registrationEmailError, markTouched]);

  useEffect(() => {
    const msg = route?.params?.registrationPhoneError;
    if (msg) {
      setPhoneTakenError(String(msg));
      markTouched('phoneNumber');
    }
  }, [route?.params?.registrationPhoneError, markTouched]);

  const errors = useMemo(() => {
    const e = {};
    if (!firstName.trim()) e.firstName = 'Please enter your first name.';
    if (!lastName.trim()) e.lastName = 'Please enter your last name.';
    if (!email.trim()) e.email = 'Please enter your email address.';
    else if (!EMAIL_RE.test(email.trim())) e.email = 'Please enter a valid email address.';
    const phoneErr = validatePakPhone(phoneNumber);
    if (phoneErr) e.phoneNumber = phoneErr;
    if (!password) e.password = 'Please enter a password.';
    else if (password.length < 8) e.password = 'Password must be at least 8 characters.';
    else if (!/\d/.test(password)) e.password = 'Password must contain at least one number.';
    if (!confirmPassword) e.confirmPassword = 'Please confirm your password.';
    else if (confirmPassword !== password) e.confirmPassword = 'Passwords do not match.';
    return e;
  }, [firstName, lastName, email, phoneNumber, password, confirmPassword]);

  const showError = (key) => (touched[key] || touched.__submitted) && errors[key];

  const handleCreateAccount = async () => {
    setEmailTakenError('');
    setPhoneTakenError('');
    setTouched((t) => ({
      ...t,
      __submitted: true,
      firstName: true,
      lastName: true,
      email: true,
      phoneNumber: true,
      password: true,
      confirmPassword: true,
    }));
    if (Object.keys(errors).length > 0) return;

    const em = email.trim().toLowerCase();
    if (isReservedAdminEmail(em)) {
      setEmailTakenError(
        'This email is reserved for the built-in admin account. Use Login with admin credentials instead.'
      );
      markTouched('email');
      return;
    }

    const registration = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      fullName: buildFullName(firstName, lastName),
      name: buildFullName(firstName, lastName),
      email: em,
      phoneNumber: normalizeDigits(phoneNumber),
      phone: normalizeDigits(phoneNumber),
      password,
      confirmPassword,
    };

    if (isSupabaseConfigured() || isAuxiliaryApiConfigured()) {
      setSubmitting(true);
      try {
        const { available, reason } = await checkEmailAvailableAPI(registration.email);
        if (!available) {
          setEmailTakenError(reason || 'This email is already registered.');
          markTouched('email');
          return;
        }

        if (isAuxiliaryApiConfigured()) {
          const phoneCheck = await checkPhoneAvailableAPI(registration.phoneNumber);
          if (!phoneCheck.available) {
            setPhoneTakenError(
              phoneCheck.reason ||
                'This phone number is already in use. Please check your number or log in.'
            );
            markTouched('phoneNumber');
            return;
          }
        }
      } catch (e) {
        showPlatformAlert('Could not verify registration', e?.message || 'Try again.');
        return;
      } finally {
        setSubmitting(false);
      }
    }

    await saveKycSignupDraft(registration);

    navigation.navigate('KycScan', {
      fromSignup: true,
      registration,
    });
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <View style={styles.topBar} pointerEvents="box-none">
          <Pressable
            style={({ pressed }) => [styles.backBtn, pressed && styles.backBtnPressed]}
            onPress={() => backToLogin(navigation)}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Back to Login"
          >
            <Ionicons name="arrow-back" size={22} color={colors.text} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          nestedScrollEnabled
        >
          <View style={styles.headerBlock}>
            <Text style={styles.title}>Create your account</Text>
            <Text style={styles.subtitle}>
              Enter your details securely, then verify your CNIC on the next screen.
            </Text>
          </View>

          <View style={styles.form}>
            <Text style={styles.fieldLabel}>First Name</Text>
            <AppInput
              iconName="person-outline"
              placeholder="First name"
              autoCapitalize="words"
              value={firstName}
              onChangeText={(t) => {
                setFirstName(t);
                if (touched.firstName) markTouched('firstName');
              }}
              onBlur={() => markTouched('firstName')}
            />
            {showError('firstName') ? (
              <Text style={styles.fieldError}>{errors.firstName}</Text>
            ) : null}

            <View style={styles.fieldGap} />
            <Text style={styles.fieldLabel}>Last Name</Text>
            <AppInput
              iconName="person-outline"
              placeholder="Last name"
              autoCapitalize="words"
              value={lastName}
              onChangeText={(t) => {
                setLastName(t);
                if (touched.lastName) markTouched('lastName');
              }}
              onBlur={() => markTouched('lastName')}
            />
            {showError('lastName') ? (
              <Text style={styles.fieldError}>{errors.lastName}</Text>
            ) : null}

            <View style={styles.fieldGap} />
            <Text style={styles.fieldLabel}>Email Address</Text>
            <AppInput
              iconName="mail-outline"
              placeholder="you@example.com"
              keyboardType="email-address"
              value={email}
              onChangeText={(t) => {
                setEmail(t);
                setEmailTakenError('');
                if (touched.email) markTouched('email');
              }}
              autoCapitalize="none"
              autoCorrect={false}
              onBlur={() => markTouched('email')}
            />
            {showError('email') || emailTakenError ? (
              <Text style={styles.fieldError}>{emailTakenError || errors.email}</Text>
            ) : null}

            <View style={styles.fieldGap} />
            <Text style={styles.fieldLabel}>Phone Number</Text>
            <AppInput
              iconName="call-outline"
              placeholder="03XXXXXXXXX"
              keyboardType="phone-pad"
              value={phoneNumber}
              onChangeText={(t) => {
                setPhoneNumber(normalizeDigits(t).slice(0, 11));
                setPhoneTakenError('');
                if (touched.phoneNumber) markTouched('phoneNumber');
              }}
              maxLength={11}
              onBlur={() => markTouched('phoneNumber')}
            />
            {showError('phoneNumber') || phoneTakenError ? (
              <Text style={styles.fieldError}>
                {phoneTakenError || errors.phoneNumber}
              </Text>
            ) : null}

            <View style={styles.fieldGap} />
            <Text style={styles.fieldLabel}>Password</Text>
            <AppInput
              iconName="lock-closed-outline"
              placeholder="At least 8 characters, include a number"
              secureTextEntry
              value={password}
              onChangeText={(t) => {
                setPassword(t);
                if (touched.password) markTouched('password');
                if (touched.confirmPassword) markTouched('confirmPassword');
              }}
              onBlur={() => markTouched('password')}
            />
            {showError('password') ? (
              <Text style={styles.fieldError}>{errors.password}</Text>
            ) : null}

            <View style={styles.fieldGap} />
            <Text style={styles.fieldLabel}>Confirm Password</Text>
            <AppInput
              iconName="shield-checkmark-outline"
              placeholder="Re-enter your password"
              secureTextEntry
              value={confirmPassword}
              onChangeText={(t) => {
                setConfirmPassword(t);
                if (touched.confirmPassword) markTouched('confirmPassword');
              }}
              onBlur={() => markTouched('confirmPassword')}
            />
            {showError('confirmPassword') ? (
              <Text style={styles.fieldError}>{errors.confirmPassword}</Text>
            ) : null}

            <Pressable
              style={({ pressed }) => [
                styles.submitBtn,
                submitting && styles.submitBtnDisabled,
                pressed && !submitting && styles.submitBtnPressed,
              ]}
              onPress={handleCreateAccount}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel="Create account"
            >
              {submitting ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.submitBtnText}>Create Account</Text>
              )}
            </Pressable>

            <View style={styles.footer}>
              <Text style={styles.footerMuted}>Already have an account? </Text>
              <Pressable onPress={() => navigation.navigate('Login')}>
                <Text style={styles.footerLink}>Login</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  topBar: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: 4,
    zIndex: 10,
  },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  backBtnPressed: { opacity: 0.85 },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
  },
  headerBlock: { marginBottom: spacing.lg },
  title: { ...typography.display, marginBottom: 4 },
  subtitle: { ...typography.bodyMuted, lineHeight: 20 },
  form: {},
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 6,
  },
  fieldGap: { height: spacing.md },
  fieldError: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 6,
  },
  submitBtn: {
    marginTop: spacing.lg,
    backgroundColor: colors.primary,
    borderRadius: 14,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    zIndex: 5,
    elevation: 5,
  },
  submitBtnPressed: { opacity: 0.9, transform: [{ scale: 0.99 }] },
  submitBtnDisabled: { opacity: 0.65 },
  submitBtnText: {
    color: colors.primaryText,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: spacing.md,
  },
  footerMuted: { color: colors.textMuted, fontSize: 14 },
  footerLink: { color: colors.text, fontSize: 14, fontWeight: '700' },
});

export default RegisterScreen;
