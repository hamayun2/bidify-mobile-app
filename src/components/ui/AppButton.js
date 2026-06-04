import React from 'react';
import { TouchableOpacity, Text, ActivityIndicator, StyleSheet, View } from 'react-native';
import { colors, radius, spacing } from '../../theme';

/**
 * Solid black primary button + outline / ghost variants.
 * variant: 'primary' (default, black), 'outline', 'ghost'
 */
const AppButton = ({
  title,
  onPress,
  loading = false,
  disabled = false,
  variant = 'primary',
  style,
  textStyle,
  iconLeft = null,
  iconRight = null,
}) => {
  const isDisabled = disabled || loading;
  const containerStyles = [
    styles.base,
    variant === 'outline' && styles.outline,
    variant === 'ghost' && styles.ghost,
    variant === 'primary' && styles.primary,
    isDisabled && styles.disabled,
    style,
  ];
  const textStyles = [
    styles.text,
    variant === 'outline' && styles.outlineText,
    variant === 'ghost' && styles.ghostText,
    variant === 'primary' && styles.primaryText,
    textStyle,
  ];

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={isDisabled}
      activeOpacity={0.85}
      style={containerStyles}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? '#fff' : colors.text} />
      ) : (
        <View style={styles.inner}>
          {iconLeft ? <View style={styles.iconLeft}>{iconLeft}</View> : null}
          <Text style={textStyles}>{title}</Text>
          {iconRight ? <View style={styles.iconRight}>{iconRight}</View> : null}
        </View>
      )}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  base: {
    minHeight: 52,
    borderRadius: radius.lg,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
  },
  primary: {
    backgroundColor: colors.primary,
  },
  outline: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  ghost: {
    backgroundColor: 'transparent',
  },
  disabled: {
    opacity: 0.55,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconLeft: { marginRight: 8 },
  iconRight: { marginLeft: 8 },
  text: {
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  primaryText: { color: colors.primaryText },
  outlineText: { color: colors.text },
  ghostText: { color: colors.text },
});

export default AppButton;
