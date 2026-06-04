import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AppInput from '../components/ui/AppInput';
import AppButton from '../components/ui/AppButton';
import { requestPasswordOtpAPI } from '../api/auth';
import { backToLogin } from '../utils/safeBack';
import { colors, spacing, typography } from '../theme';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ForgotPasswordScreen = ({ navigation }) => {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const handleSend = async () => {
    const trimmed = (email || '').trim();
    setErrorMessage('');
    if (!trimmed) return setErrorMessage('Please enter your email address.');
    if (!EMAIL_RE.test(trimmed)) return setErrorMessage('Enter a valid email address.');

    setLoading(true);
    try {
      const res = await requestPasswordOtpAPI({ email: trimmed });
      if (res && res.emailLinkFlow) {
        Alert.alert('Check your email', res.message || 'Open the link in the email to reset your password.', [
          { text: 'OK', onPress: () => navigation.navigate('Login') },
        ]);
        return;
      }
      navigation.navigate('OtpVerify', {
        email: trimmed,
        devOtp: (res && res.devOtp) || null,
      });
    } catch (e) {
      const msg = (e && (e.message || e.toString())) || 'Could not send OTP. Try again.';
      setErrorMessage(msg);
    } finally {
      setLoading(false);
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
            accessibilityLabel="Back to Login"
          >
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </TouchableOpacity>

          <View style={styles.headerBlock}>
            <Text style={styles.title}>Forgot password?</Text>
            <Text style={styles.subtitle}>
              Enter the email linked to your account and we will send a 6-digit code to reset your password.
            </Text>
          </View>

          <View style={styles.form}>
            <Text style={styles.label}>Email</Text>
            <AppInput
              iconName="mail-outline"
              placeholder="you@example.com"
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
            />

            {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

            <AppButton
              title="Send OTP"
              onPress={handleSend}
              loading={loading}
              style={styles.submit}
            />
          </View>

          <View style={styles.footer}>
            <Text style={styles.footerMuted}>Remembered it? </Text>
            <TouchableOpacity onPress={() => navigation.navigate('Login')}>
              <Text style={styles.footerLink}>Login</Text>
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
  form: { marginBottom: spacing.xl },
  label: { ...typography.label, marginBottom: spacing.sm },
  error: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
    marginTop: spacing.md,
    textAlign: 'center',
  },
  submit: { marginTop: spacing.xl },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  footerMuted: { color: colors.textMuted, fontSize: 14 },
  footerLink: { color: colors.text, fontSize: 14, fontWeight: '700' },
});

export default ForgotPasswordScreen;
