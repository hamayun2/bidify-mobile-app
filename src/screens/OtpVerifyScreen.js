import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TouchableOpacity,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AppButton from '../components/ui/AppButton';
import { requestPasswordOtpAPI, verifyPasswordOtpAPI } from '../api/auth';
import { backToLogin } from '../utils/safeBack';
import { colors, radius, spacing, typography } from '../theme';

const OTP_LENGTH = 6;
const RESEND_COOLDOWN_SEC = 30;

const OtpVerifyScreen = ({ navigation, route }) => {
  const email = route?.params?.email || '';
  const devOtp = route?.params?.devOtp || null;
  const [digits, setDigits] = useState(Array(OTP_LENGTH).fill(''));
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const inputs = useRef([]);

  useEffect(() => {
    // Auto-focus the first cell on mount.
    setTimeout(() => inputs.current[0]?.focus(), 200);
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const setDigit = (i, val) => {
    const v = val.replace(/\D/g, '').slice(-1);
    setErrorMessage('');
    setDigits((prev) => {
      const next = [...prev];
      next[i] = v;
      return next;
    });
    if (v && i < OTP_LENGTH - 1) {
      inputs.current[i + 1]?.focus();
    }
  };

  const handleKeyPress = (i, e) => {
    if (e.nativeEvent.key === 'Backspace' && !digits[i] && i > 0) {
      inputs.current[i - 1]?.focus();
    }
  };

  const handleVerify = async () => {
    const code = digits.join('');
    if (code.length !== OTP_LENGTH) {
      setErrorMessage('Enter the full 6-digit code.');
      return;
    }
    if (!email) {
      setErrorMessage('Email missing. Go back and start again.');
      return;
    }
    setLoading(true);
    try {
      const res = await verifyPasswordOtpAPI({ email, code });
      if (!res || !res.resetToken) {
        throw new Error('Server did not return a reset token. Try resending the OTP.');
      }
      navigation.navigate('ResetPassword', { email, resetToken: res.resetToken });
    } catch (e) {
      setErrorMessage((e && (e.message || e.toString())) || 'Invalid OTP.');
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (cooldown > 0) return;
    setErrorMessage('');
    if (!email) {
      setErrorMessage('Email missing. Go back and start again.');
      return;
    }
    try {
      await requestPasswordOtpAPI({ email });
      setCooldown(RESEND_COOLDOWN_SEC);
    } catch (e) {
      setErrorMessage((e && (e.message || e.toString())) || 'Could not resend OTP.');
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <TouchableOpacity
            onPress={() => backToLogin(navigation)}
            style={styles.backBtn}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </TouchableOpacity>

          <View style={styles.headerBlock}>
            <Text style={styles.title}>Enter verification code</Text>
            <Text style={styles.subtitle}>
              We sent a 6-digit code to{' '}
              <Text style={styles.subtitleStrong}>{email || 'your inbox'}</Text>. It expires in
              10 minutes.
            </Text>
            {devOtp ? (
              <Text style={styles.devHint}>Dev OTP: {devOtp}</Text>
            ) : null}
          </View>

          <View style={styles.otpRow}>
            {digits.map((d, i) => (
              <TextInput
                key={i}
                ref={(el) => {
                  inputs.current[i] = el;
                }}
                style={[styles.otpCell, d ? styles.otpCellFilled : null]}
                value={d}
                onChangeText={(t) => setDigit(i, t)}
                onKeyPress={(e) => handleKeyPress(i, e)}
                keyboardType="number-pad"
                maxLength={1}
                textContentType="oneTimeCode"
                returnKeyType="next"
              />
            ))}
          </View>

          {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

          <AppButton
            title="Verify"
            onPress={handleVerify}
            loading={loading}
            style={styles.submit}
          />

          <View style={styles.resendRow}>
            <Text style={styles.footerMuted}>Didn't receive a code? </Text>
            <TouchableOpacity onPress={handleResend} disabled={cooldown > 0}>
              <Text style={[styles.footerLink, cooldown > 0 && styles.footerLinkMuted]}>
                {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend'}
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, padding: spacing.xl, paddingTop: spacing.lg },
  backBtn: { width: 36, height: 36, alignItems: 'flex-start', justifyContent: 'center' },
  headerBlock: { marginTop: spacing.lg, marginBottom: spacing.xxxl },
  title: { ...typography.display, marginBottom: 6 },
  subtitle: { ...typography.bodyMuted, lineHeight: 20 },
  subtitleStrong: { color: colors.text, fontWeight: '700' },
  devHint: {
    marginTop: spacing.md,
    fontSize: 12,
    color: colors.warning,
    fontWeight: '700',
  },
  otpRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  otpCell: {
    flex: 1,
    height: 56,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    textAlign: 'center',
    fontSize: 22,
    fontWeight: '800',
    color: colors.text,
  },
  otpCellFilled: { borderColor: colors.text, backgroundColor: colors.bg },
  error: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: spacing.md,
    textAlign: 'center',
  },
  submit: { marginTop: spacing.md },
  resendRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: spacing.xl,
  },
  footerMuted: { color: colors.textMuted, fontSize: 14 },
  footerLink: { color: colors.text, fontSize: 14, fontWeight: '700' },
  footerLinkMuted: { color: colors.textFaint, fontWeight: '600' },
});

export default OtpVerifyScreen;
