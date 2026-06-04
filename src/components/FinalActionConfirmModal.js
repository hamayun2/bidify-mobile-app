import React, { useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  Pressable,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const INDIGO = '#1E3A8A';

export const FINAL_ACTION_MESSAGE =
  'Are you sure you want to proceed? This action is FINAL. Once live, this listing/bid cannot be edited, modified, or manually deleted.';

export default function FinalActionConfirmModal({
  visible,
  title = 'Confirm action',
  message = FINAL_ACTION_MESSAGE,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  loading = false,
}) {
  const handleConfirm = useCallback(() => {
    if (loading) return;
    onConfirm?.();
  }, [loading, onConfirm]);

  const handleCancel = useCallback(() => {
    if (loading) return;
    onCancel?.();
  }, [loading, onCancel]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleCancel}
      statusBarTranslucent={Platform.OS === 'android'}
    >
      <View style={styles.overlay} pointerEvents="box-none">
        <Pressable
          style={styles.backdrop}
          onPress={handleCancel}
          disabled={loading}
          accessibilityRole="button"
          accessibilityLabel="Close confirmation"
        />
        <View style={styles.card} pointerEvents="box-none">
          <View style={styles.iconWrap} pointerEvents="none">
            <Ionicons name="warning-outline" size={28} color={INDIGO} />
          </View>
          <Text style={styles.title} pointerEvents="none">
            {title}
          </Text>
          <Text style={styles.message} pointerEvents="none">
            {message}
          </Text>
          <View style={styles.actions} pointerEvents="auto">
            <Pressable
              style={({ pressed }) => [
                styles.cancelBtn,
                pressed && !loading && styles.btnPressed,
                loading && styles.btnDisabled,
              ]}
              onPress={handleCancel}
              disabled={loading}
              accessibilityRole="button"
            >
              <Text style={styles.cancelText}>{cancelLabel}</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.confirmBtn,
                pressed && !loading && styles.btnPressed,
                loading && styles.confirmBtnDisabled,
              ]}
              onPress={handleConfirm}
              disabled={loading}
              accessibilityRole="button"
            >
              {loading ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Text style={styles.confirmText}>{confirmLabel}</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    zIndex: 9999,
    ...Platform.select({ web: { position: 'fixed', inset: 0 } }),
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    zIndex: 0,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 22,
    zIndex: 1,
    elevation: 12,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.12,
        shadowRadius: 24,
      },
      android: { elevation: 12 },
      web: { position: 'relative', zIndex: 2 },
    }),
  },
  iconWrap: {
    alignSelf: 'center',
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#EEF2FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  title: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0F172A',
    textAlign: 'center',
    marginBottom: 10,
  },
  message: {
    fontSize: 14,
    lineHeight: 21,
    color: '#475569',
    textAlign: 'center',
    marginBottom: 20,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    zIndex: 2,
    elevation: 13,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  cancelText: { fontSize: 15, fontWeight: '700', color: '#475569' },
  confirmBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: INDIGO,
    alignItems: 'center',
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  confirmBtnDisabled: { opacity: 0.6 },
  confirmText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
  btnPressed: { opacity: 0.88 },
  btnDisabled: { opacity: 0.6 },
});
