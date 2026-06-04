import React from 'react';
import { View, Text, StyleSheet, Modal, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing, typography } from '../theme';

const INDIGO = '#1E3A8A';

export default function KycUnderReviewModal({ visible, onContinue }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onContinue}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <Ionicons name="hourglass-outline" size={40} color={INDIGO} />
          </View>
          <Text style={styles.title}>⏳ Your Account is Under Review</Text>
          <Text style={styles.message}>
            Our compliance engine is verifying your documents and live selfie. This process takes
            approximately 5 minutes.
          </Text>
          <Pressable
            style={({ pressed }) => [styles.continueBtn, pressed && styles.continueBtnPressed]}
            onPress={onContinue}
            accessibilityRole="button"
            accessibilityLabel="Continue to app"
          >
            <Text style={styles.continueBtnText}>Continue to App</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.white,
    borderRadius: radius.xl,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#EFF6FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  title: { ...typography.h2, textAlign: 'center', marginBottom: spacing.sm },
  message: {
    ...typography.bodyMuted,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.lg,
  },
  continueBtn: {
    width: '100%',
    backgroundColor: INDIGO,
    borderRadius: radius.lg,
    paddingVertical: 16,
    alignItems: 'center',
  },
  continueBtnPressed: { opacity: 0.9 },
  continueBtnText: { color: '#FFFFFF', fontWeight: '800', fontSize: 16 },
});
