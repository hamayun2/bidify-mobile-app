import React, { useCallback, useEffect, useRef } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  Pressable,
  Animated,
  Dimensions,
  Platform,
  ActivityIndicator,
  Easing,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const SHEET_BLUE = '#1E3A8A';
const { height: SCREEN_H } = Dimensions.get('window');

/**
 * Premium slide-up confirmation — bid placement only (UI).
 */
export default function BidConfirmModal({
  visible,
  onConfirm,
  onCancel,
  loading = false,
}) {
  const insets = useSafeAreaInsets();
  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(SCREEN_H)).current;

  useEffect(() => {
    if (visible) {
      slide.setValue(SCREEN_H * 0.4);
      fade.setValue(0);
      Animated.parallel([
        Animated.timing(fade, {
          toValue: 1,
          duration: 260,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.spring(slide, {
          toValue: 0,
          friction: 9,
          tension: 68,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, fade, slide]);

  const dismiss = useCallback(
    (after) => {
      if (loading) return;
      Animated.parallel([
        Animated.timing(fade, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(slide, {
          toValue: SCREEN_H * 0.35,
          duration: 220,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(() => after?.());
    },
    [fade, slide, loading]
  );

  const handleCancel = useCallback(() => {
    dismiss(onCancel);
  }, [dismiss, onCancel]);

  const handleConfirm = useCallback(() => {
    if (loading) return;
    onConfirm?.();
  }, [loading, onConfirm]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={handleCancel}
      statusBarTranslucent={Platform.OS === 'android'}
    >
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, { opacity: fade }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={handleCancel}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheet,
            {
              paddingBottom: Math.max(insets.bottom, 16),
              transform: [{ translateY: slide }],
            },
          ]}
        >
          <View style={styles.handle} />
          <View style={styles.iconCircle}>
            <Ionicons name="shield-checkmark" size={32} color={SHEET_BLUE} />
          </View>
          <Text style={styles.title}>Confirm Bid</Text>
          <Text style={styles.message}>
            Once placed, this bid cannot be edited or deleted.
          </Text>
          <View style={styles.actions}>
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
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.confirmBtn,
                pressed && !loading && styles.btnPressed,
                loading && styles.btnDisabled,
              ]}
              onPress={handleConfirm}
              disabled={loading}
              accessibilityRole="button"
            >
              {loading ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Text style={styles.confirmText}>Confirm</Text>
              )}
            </Pressable>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 24,
    paddingTop: 10,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: 0.12,
        shadowRadius: 16,
      },
      android: { elevation: 16 },
    }),
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#E2E8F0',
    marginBottom: 18,
  },
  iconCircle: {
    alignSelf: 'center',
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#EEF2FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: SHEET_BLUE,
    textAlign: 'center',
    marginBottom: 10,
    letterSpacing: -0.3,
  },
  message: {
    fontSize: 15,
    lineHeight: 22,
    color: '#64748B',
    textAlign: 'center',
    marginBottom: 24,
    paddingHorizontal: 8,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 15,
    borderRadius: 14,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#475569',
  },
  confirmBtn: {
    flex: 1,
    paddingVertical: 15,
    borderRadius: 14,
    backgroundColor: SHEET_BLUE,
    alignItems: 'center',
  },
  confirmText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  btnPressed: { opacity: 0.9 },
  btnDisabled: { opacity: 0.65 },
});
