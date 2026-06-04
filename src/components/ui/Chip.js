import React from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { colors, radius, spacing } from '../../theme';

const Chip = ({ label, active = false, onPress, style }) => (
  <TouchableOpacity
    onPress={onPress}
    activeOpacity={0.85}
    style={[styles.chip, active && styles.chipActive, style]}
  >
    <Text style={[styles.text, active && styles.textActive]}>{label}</Text>
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  chip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.chipBg,
    marginRight: spacing.sm,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  chipActive: {
    backgroundColor: colors.chipActiveBg,
  },
  text: {
    color: colors.chipText,
    fontSize: 13,
    fontWeight: '600',
  },
  textActive: {
    color: colors.chipActiveText,
  },
});

export default Chip;
