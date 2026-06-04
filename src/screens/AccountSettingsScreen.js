import React, { useContext, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  LayoutAnimation,
  UIManager,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { AuthContext } from '../context/AuthContext';
import { deleteMyAccount } from '../services/profileService';
import { mapProfileUniqueViolation } from '../utils/profileErrors';
import { getSupabase, isSupabaseConfigured } from '../services/supabaseClient';
import { normalizeDigits } from '../utils/pakValidation';
import AppButton from '../components/ui/AppButton';
import { spacing } from '../theme';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const SCREEN_BG = '#F4F6F8';
const INDIGO = '#1E3A8A';
const DANGER = '#B91C1C';
const ERROR_RED = '#DC2626';

const PHONE_ELEVEN_DIGITS_RE = /^\d{11}$/;
const NEW_PASSWORD_RE = /^(?=.*[0-9]).{8,}$/;
const PHONE_ERROR = 'Please enter a valid 11-digit phone number.';
const PASSWORD_RULE_ERROR = 'Password must be at least 8 characters and include a number.';
const OLD_PASSWORD_AUTH_ERROR = 'Error: The old password you entered is incorrect. Please try again.';
const DELETE_CONFIRM_MESSAGE = '⚠️ Warning: Deleting your account will permanently wipe all your data. Are you absolutely sure?';

// 🚀 Fixed the multiline string syntax error here
const DELETE_WARNING_TEXT = '⚠️ Warning: Deleting your account will permanently wipe all your data.\nAny remaining funds in your wallet will be permanently lost and cannot be recovered.';

function isWebPlatform() {
  return (
    Platform.OS === 'web' ||
    (typeof window !== 'undefined' && typeof document !== 'undefined')
  );
}

function DeleteAccountConfirmModal({ visible, onCancel, onConfirm, isDeleting }) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <Pressable style={styles.deleteModalOverlay} onPress={onCancel}>
        <Pressable style={styles.deleteModalCard} onPress={(e) => e.stopPropagation()}>
          <View style={styles.deleteModalIconWrap}>
            <Ionicons name="warning" size={32} color={DANGER} />
          </View>
 
          <Text style={styles.deleteModalTitle}>Delete Account</Text>
          <Text style={styles.deleteModalMessage}>{DELETE_CONFIRM_MESSAGE}</Text>
          <View style={styles.deleteModalActions}>
            <TouchableOpacity
              style={styles.deleteModalCancelBtn}
              onPress={onCancel}
              disabled={isDeleting}
              activeOpacity={0.85}
            >
              <Text style={styles.deleteModalCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.deleteModalConfirmBtn, isDeleting && styles.deleteModalConfirmDisabled]}
              onPress={onConfirm}
              disabled={isDeleting}
              activeOpacity={0.85}
            >
              {isDeleting ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Text style={styles.deleteModalConfirmText}>Delete</Text>
              )}
            </TouchableOpacity>
          </View>
        </Pressable>
   </Pressable>
    </Modal>
  );
}

function animateAccordion() {
  LayoutAnimation.configureNext(LayoutAnimation.create(220, 'easeInEaseOut', 'opacity'));
}

function SuccessModal({ visible, message, onClose }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
          <View style={styles.modalIconCircle}>
            <Ionicons name="checkmark-circle" size={56} color="#16A34A" />
          </View>
          <Text style={styles.modalTitle}>Success!</Text>
          <Text style={styles.modalMessage}>{message}</Text>
    
          <TouchableOpacity style={styles.modalOkBtn} onPress={onClose} activeOpacity={0.88}>
            <Text style={styles.modalOkText}>OK</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function PasswordField({
  label,
  value,
  onChangeText,
  visible,
  onToggleVisible,
  placeholder,
  hasError,
  errorMessage,
}) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={[styles.passwordRow, hasError && styles.passwordRowError]}>
        <TextInput
          style={styles.passwordInput}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor="#94A3B8"
          secureTextEntry={!visible}
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="password"
        />
        <TouchableOpacity
          onPress={onToggleVisible}
          style={styles.eyeBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel={visible ? 'Hide password' : 'Show password'}
        >
          <Ionicons name={visible ? 'eye-off-outline' : 'eye-outline'} size={22} color="#94A3B8" />
        </TouchableOpacity>
      </View>
      {hasError && errorMessage ? (
        <Text style={styles.errorText}>{errorMessage}</Text>
      ) : null}
    </View>
  );
}

function AccordionSection({ title, icon, open, onToggle, children }) {
  return (
    <View>
      <TouchableOpacity style={styles.accordionHeader} onPress={onToggle} activeOpacity={0.75}>
        <View style={styles.accordionHeaderLeft}>
          <View style={styles.accordionIconWrap}>
            <Ionicons name={icon} size={20} color={INDIGO} />
          </View>
          <Text style={styles.accordionTitle}>{title}</Text>
        </View>
        <Ionicons
          name="chevron-forward"
          size={20}
          color="#94A3B8"
          style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}
        />
      </TouchableOpacity>
      {open ? <View style={styles.accordionBody}>{children}</View> : null}
    </View>
  );
}

const AccountSettingsScreen = () => {
  const { user, updateProfile, refreshProfile, logout } = useContext(AuthContext);
  const [openSection, setOpenSection] = useState(null);
  const [successModal, setSuccessModal] = useState({ visible: false, message: '' });

  const [phone, setPhone] = useState('');
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [updatingPassword, setUpdatingPassword] = useState(false);
  const [oldPasswordError, setOldPasswordError] = useState(null);

  const phoneDigits = useMemo(() => normalizeDigits(phone), [phone]);
  const phoneValid = PHONE_ELEVEN_DIGITS_RE.test(phoneDigits);
  const showPhoneError = (phoneTouched || phoneDigits.length > 0) && !phoneValid;

  const newPasswordValid = NEW_PASSWORD_RE.test(newPassword);
  const showPasswordRuleError =
    (passwordTouched || newPassword.length > 0) && newPassword.length > 0 && !newPasswordValid;
  const confirmMismatch =
    confirmPassword.length > 0 && newPassword.length > 0 && newPassword !== confirmPassword;
  const canSavePhone = phoneValid && !saving;
  const canUpdatePassword =
    oldPassword.trim().length > 0 &&
    newPasswordValid &&
    newPassword === confirmPassword &&
    oldPassword.trim() !== newPassword &&
    !updatingPassword;

  useFocusEffect(
    useCallback(() => {
      const current = user?.phoneNumber || user?.phone || '';
      setPhone(current ? normalizeDigits(current) : '');
      setPhoneTouched(false);
    }, [user?.phoneNumber, user?.phone])
  );

  const toggleSection = (key) => {
    animateAccordion();
    setOpenSection((prev) => (prev === key ? null : key));
  };

  const showSuccess = (message) => {
    setSuccessModal({ visible: true, message });
  };

  const handleSavePhone = async () => {
    setPhoneTouched(true);
    if (!phoneValid) return;

    setSaving(true);
    try {
      await updateProfile({ phoneNumber: phoneDigits, phone: phoneDigits });
      await refreshProfile?.();
      setOpenSection(null);
      showSuccess('Your phone number has been updated.');
    } catch (e) {
      const unique = mapProfileUniqueViolation(e);
      Alert.alert('Could not save', unique || e?.message || 'Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const clearPasswordFields = () => {
    setOldPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setOldPasswordError(null);
    setPasswordTouched(false);
    setShowOld(false);
    setShowNew(false);
    setShowConfirm(false);
  };

  const failOldPasswordVerification = (signInError) => {
    if (signInError?.message) {
      console.log('Supabase Auth Error:', signInError.message);
    } else {
      console.log('Supabase Auth Error:', signInError || 'signInWithPassword failed — no session');
    }
    setOldPasswordError(OLD_PASSWORD_AUTH_ERROR);
    setOldPassword('');
    Alert.alert('Error', OLD_PASSWORD_AUTH_ERROR);
  };

  const handleUpdatePassword = async () => {
    setPasswordTouched(true);
    setOldPasswordError(null);

    const oldPw = oldPassword;
    const newPw = newPassword;
    const confirmPw = confirmPassword;

    if (!oldPw.trim() || !newPw.trim() || !confirmPw.trim()) {
      Alert.alert('Missing fields', 'Please fill in all password fields.');
      return;
    }

    if (newPw !== confirmPw) {
      Alert.alert('New passwords do not match.');
      return;
    }
    if (!NEW_PASSWORD_RE.test(newPw)) {
      return;
    }
    if (oldPw === newPw) {
      Alert.alert('Same password', 'Choose a new password that is different from your current one.');
      return;
    }

    if (!isSupabaseConfigured()) {
      Alert.alert('Unavailable', 'Password change requires a Supabase sign-in session.');
      return;
    }

    let email = String(user?.email || '').trim();
    const supabase = getSupabase();
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session?.user?.email) {
        email = String(session.user.email).trim();
      }
    } catch (sessionErr) {
      console.log('Supabase Auth Error:', sessionErr?.message || sessionErr);
    }

    if (!email) {
      Alert.alert('Error', 'No email on file for this account.');
      return;
    }

    setUpdatingPassword(true);

    try {
      let signInData = null;
      let signInError = null;

      try {
        const signInResult = await supabase.auth.signInWithPassword({
          email,
          password: oldPw,
        });
        signInData = signInResult.data;
        signInError = signInResult.error;
      } catch (authThrown) {
        signInError = authThrown;
        console.log('Supabase Auth Error:', authThrown?.message || String(authThrown));
      }

      if (signInError != null) {
        failOldPasswordVerification(signInError);
        return;
      }

      if (!signInData?.session?.access_token) {
        console.log('Supabase Auth Error:', 'signInWithPassword returned no active session');
        failOldPasswordVerification({ message: 'No active session returned' });
        return;
      }

      let updateData = null;
      let updateError = null;

      try {
        const updateResult = await supabase.auth.updateUser({ password: newPw });
        updateData = updateResult.data;
        updateError = updateResult.error;
      } catch (updateThrown) {
        updateError = updateThrown;
        console.log('Supabase Auth Error:', updateThrown?.message || String(updateThrown));
      }

      if (updateError != null) {
        Alert.alert(
          'Could not update password',
          updateError?.message || 'Please try again.'
        );
        return;
      }

      if (!updateData?.user) {
        Alert.alert('Could not update password', 'No user returned after password update.');
        return;
      }

      clearPasswordFields();
      setOpenSection(null);
      showSuccess(
        'Your password has been updated successfully. You can use your new password next time you log in.'
      );
    } catch (e) {
      console.log('Supabase Auth Error:', e?.message || String(e));
      Alert.alert('Could not update password', e?.message || 'Please try again.');
    } finally {
      setUpdatingPassword(false);
    }
  };

  const performDeletion = useCallback(async () => {
    if (isDeleting) return;
    setIsDeleting(true);
    try {
      let accessToken = null;
      if (isSupabaseConfigured()) {
        const supabase = getSupabase();
        const {
          data: { session },
          error: sessionErr,
        } = await supabase.auth.getSession();
        if (sessionErr || !session?.access_token) {
          throw new Error('You are not signed in.');
        }
        accessToken = session.access_token;
      }
      await deleteMyAccount(accessToken);
      setDeleteModalVisible(false);
      await logout?.({ force: true });
    } catch (e) {
      const message = e?.message || 'Could not delete your account.';
      if (__DEV__) console.error('[AccountSettings] performDeletion failed', message);
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.alert(`Delete failed\n\n${message}`);
      } else {
        Alert.alert('Delete failed', message);
      }
    } finally {
      setIsDeleting(false);
    }
  }, [isDeleting, logout]);

  const promptDeleteAccount = useCallback(() => {
    if (isDeleting) return;

    // 🚀 Fixed Web Compatibility for triggers
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const accepted = window.confirm(DELETE_CONFIRM_MESSAGE);
      if (accepted) void performDeletion();
      return;
    }

    setDeleteModalVisible(true);
  }, [isDeleting, performDeletion]);

  const handleDeleteAccountPress = useCallback(() => {
    if (__DEV__) console.log('[AccountSettings] Delete Account pressed');
    promptDeleteAccount();
  }, [promptDeleteAccount]);

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
          nestedScrollEnabled
        >
          <View style={styles.settingsCard}>
            <AccordionSection
              title="Update Phone Number"
              icon="call-outline"
              open={openSection === 'phone'}
              onToggle={() => toggleSection('phone')}
            >
              <Text style={styles.cardHint}>
                Pakistan mobile format — exactly 11 digits (e.g. 03001234567).
              </Text>
              <TextInput
                style={[styles.input, showPhoneError && styles.inputError]}
                value={phone}
                onChangeText={(t) => {
                  setPhone(normalizeDigits(t).slice(0, 11));
                  setPhoneTouched(true);
                }}
                onBlur={() => setPhoneTouched(true)}
                placeholder="03001234567"
                placeholderTextColor="#94A3B8"
                keyboardType="phone-pad"
                maxLength={11}
                autoComplete="tel"
              />
              {showPhoneError ? <Text style={styles.errorText}>{PHONE_ERROR}</Text> : null}
              <AppButton
                title="Save"
                onPress={handleSavePhone}
                loading={saving}
                disabled={!canSavePhone}
                style={styles.saveBtn}
              />
            </AccordionSection>
          </View>

          <View style={styles.settingsCard}>
            <AccordionSection
              title="Change Password"
              icon="lock-closed-outline"
              open={openSection === 'password'}
              onToggle={() => toggleSection('password')}
            >
              <Text style={styles.cardHint}>
                At least 8 characters with one number. You will stay signed in on this device.
              </Text>
              <PasswordField
                label="Old Password"
                value={oldPassword}
                onChangeText={(t) => {
                  setOldPassword(t);
                  if (oldPasswordError) setOldPasswordError(null);
                }}
                visible={showOld}
                onToggleVisible={() => setShowOld((v) => !v)}
                placeholder="Current password"
                hasError={!!oldPasswordError}
                errorMessage={oldPasswordError}
              />
              <PasswordField
                label="New Password"
                value={newPassword}
                onChangeText={(t) => {
                  setNewPassword(t);
                  setPasswordTouched(true);
                }}
                visible={showNew}
                onToggleVisible={() => setShowNew((v) => !v)}
                placeholder="New password"
              />
              {showPasswordRuleError ? (
                <Text style={styles.errorText}>{PASSWORD_RULE_ERROR}</Text>
              ) : null}
              <PasswordField
                label="Confirm New Password"
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                visible={showConfirm}
                onToggleVisible={() => setShowConfirm((v) => !v)}
                placeholder="Re-enter new password"
              />
              {confirmMismatch ? (
                <Text style={styles.errorText}>New passwords do not match.</Text>
              ) : null}
              <AppButton
                title="Update Password"
                onPress={handleUpdatePassword}
                loading={updatingPassword}
                disabled={!canUpdatePassword}
                style={styles.saveBtn}
              />
            </AccordionSection>
          </View>

          <View style={styles.deactivationCard}>
            <Text style={styles.deactivationTitle}>Account Deactivation</Text>
            <Text style={styles.deactivationHint}>
              Permanently remove your profile and sign out. This action cannot be undone.
            </Text>
            
            {/* 🚀 Changed to Pressable for guaranteed Web click registration */}
            <Pressable
              style={({ pressed }) => [
                styles.deleteBtnOutline,
                isDeleting && styles.deleteBtnOutlineDisabled,
                pressed && styles.deleteBtnOutlinePressed
              ]}
              onPress={handleDeleteAccountPress}
              disabled={isDeleting}
              accessibilityRole="button"
              accessibilityLabel="Delete your account"
            >
              {isDeleting ? (
                <ActivityIndicator color={DANGER} />
              ) : (
                <>
                  <Ionicons name="trash-outline" size={20} color={DANGER} />
                  <Text style={styles.deleteBtnOutlineText}>Delete Your Account</Text>
                </>
              )}
            </Pressable>

            <View style={styles.deleteWarningBox} accessibilityRole="text">
              <View style={styles.deleteWarningAccent} />
              <Text style={styles.deleteWarningText}>{DELETE_WARNING_TEXT}</Text>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <SuccessModal
        visible={successModal.visible}
        message={successModal.message}
        onClose={() => setSuccessModal({ visible: false, message: '' })}
      />

      <DeleteAccountConfirmModal
        visible={deleteModalVisible}
        isDeleting={isDeleting}
        onCancel={() => {
          if (!isDeleting) setDeleteModalVisible(false);
        }}
        onConfirm={() => void performDeletion()}
      />
    </SafeAreaView>
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
  safe: { flex: 1, backgroundColor: SCREEN_BG },
  flex: { flex: 1 },
  scroll: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: 48,
  },
  settingsCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    paddingVertical: spacing.xs,
    marginBottom: spacing.lg,
    overflow: 'hidden',
    ...cardShadow,
  },
  accordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: 18,
  },
  accordionHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    flex: 1,
  },
  accordionIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  accordionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0F172A',
    flex: 1,
  },
  accordionBody: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  cardHint: {
    fontSize: 13,
    color: '#64748B',
    lineHeight: 19,
    marginBottom: spacing.md,
  },
  input: {
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 14 : 12,
    fontSize: 16,
    fontWeight: '600',
    color: '#0F172A',
    backgroundColor: '#F8FAFC',
    marginBottom: spacing.xs,
  },
  inputError: {
    borderColor: ERROR_RED,
    backgroundColor: '#FEF2F2',
  },
  errorText: {
    fontSize: 13,
    fontWeight: '600',
    color: ERROR_RED,
    marginBottom: spacing.md,
    lineHeight: 18,
  },
  saveBtn: { marginTop: spacing.sm },
  fieldWrap: { marginBottom: spacing.md },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748B',
    marginBottom: 6,
    letterSpacing: 0.3,
  },
  passwordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    backgroundColor: '#F8FAFC',
    paddingRight: spacing.sm,
  },
  passwordRowError: {
    borderColor: ERROR_RED,
    backgroundColor: '#FEF2F2',
  },
  passwordInput: {
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 14 : 12,
    fontSize: 16,
    fontWeight: '600',
    color: '#0F172A',
  },
  eyeBtn: { padding: 8 },
  deactivationCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    ...cardShadow,
  },
  deactivationTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: spacing.sm,
    letterSpacing: -0.2,
  },
  deactivationHint: {
    fontSize: 13,
    color: '#64748B',
    lineHeight: 20,
    marginBottom: spacing.lg,
  },
  deleteBtnOutline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderWidth: 1.5,
    borderColor: DANGER,
    borderRadius: 12,
    paddingVertical: 14,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 4,
      },
      android: { elevation: 2 },
    }),
  },
  deleteBtnOutlineText: {
    color: DANGER,
    fontSize: 16,
    fontWeight: '800',
  },
  deleteBtnOutlinePressed: {
    opacity: 0.88,
    backgroundColor: '#FEF2F2',
  },
  deleteBtnOutlineDisabled: {
    opacity: 0.65,
  },
  deleteWarningBox: {
    flexDirection: 'row',
    marginTop: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    paddingLeft: spacing.sm + 4,
    backgroundColor: '#FFF7ED',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#FDBA74',
    overflow: 'hidden',
  },
  deleteWarningAccent: {
    width: 4,
    alignSelf: 'stretch',
    backgroundColor: '#EA580C',
    borderRadius: 2,
    marginRight: spacing.sm,
  },
  deleteWarningText: {
    flex: 1,
    fontSize: 12.5,
    fontStyle: 'italic',
    color: '#9A3412',
    lineHeight: 19,
    letterSpacing: 0.1,
  },
  deleteModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  deleteModalCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: spacing.lg,
    alignItems: 'center',
    ...cardShadow,
  },
  deleteModalIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#FEE2E2',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  deleteModalTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: spacing.sm,
  },
  deleteModalMessage: {
    fontSize: 15,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.lg,
  },
  deleteModalActions: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
  },
  deleteModalCancelBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
  },
  deleteModalCancelText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#475569',
  },
  deleteModalConfirmBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: DANGER,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  deleteModalConfirmDisabled: {
    opacity: 0.7,
  },
  deleteModalConfirmText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  modalCard: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    ...cardShadow,
  },
  modalIconCircle: {
    marginBottom: spacing.md,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: spacing.sm,
  },
  modalMessage: {
    fontSize: 15,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.lg,
  },
  modalOkBtn: {
    width: '100%',
    backgroundColor: INDIGO,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  modalOkText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
});

export default AccountSettingsScreen;