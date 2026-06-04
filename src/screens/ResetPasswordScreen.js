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
import { resetPasswordWithTokenAPI } from '../api/auth';
import { backToLogin } from '../utils/safeBack';
import { colors, spacing, typography } from '../theme';

const ResetPasswordScreen = ({ navigation, route }) => {
  const email = route?.params?.email || '';
  const resetToken = route?.params?.resetToken || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const handleSubmit = async () => {
    setErrorMessage('');
    if (password.length < 8) {
      return setErrorMessage('Password must be at least 8 characters.');
    }
    if (!/\d/.test(password)) {
      return setErrorMessage('Password must contain at least one number.');
    }
    if (password !== confirm) {
      return setErrorMessage('Passwords do not match.');
    }
    if (!email || !resetToken) {
      return setErrorMessage('Reset session expired. Please start again.');
    }
    setLoading(true);
    try {
      await resetPasswordWithTokenAPI({ email, resetToken, newPassword: password });
      Alert.alert('Password updated', 'You can sign in with your new password.', [
        {
          text: 'Login',
          onPress: () => navigation.reset({ index: 0, routes: [{ name: 'Login' }] }),
        },
      ]);
    } catch (e) {
      setErrorMessage((e && (e.message || e.toString())) || 'Could not reset password.');
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
            accessibilityLabel="Back"
          >
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </TouchableOpacity>

          <View style={styles.headerBlock}>
            <Text style={styles.title}>Set a new password</Text>
            <Text style={styles.subtitle}>
              Choose a strong password — at least 8 characters and 1 number.
            </Text>
          </View>

          <View style={styles.form}>
            <Text style={styles.label}>New password</Text>
            <AppInput
              iconName="lock-closed-outline"
              placeholder="Enter a new password"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />

            <Text style={[styles.label, styles.labelSpaced]}>Confirm password</Text>
            <AppInput
              iconName="lock-closed-outline"
              placeholder="Re-enter password"
              secureTextEntry
              value={confirm}
              onChangeText={setConfirm}
            />

            {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

            <AppButton
              title="Update Password"
              onPress={handleSubmit}
              loading={loading}
              style={styles.submit}
            />
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
  labelSpaced: { marginTop: spacing.lg },
  error: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
    marginTop: spacing.lg,
    textAlign: 'center',
  },
  submit: { marginTop: spacing.xl },
});

export default ResetPasswordScreen;
