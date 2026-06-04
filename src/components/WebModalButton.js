import React from 'react';
import { Platform, Pressable, Text, StyleSheet } from 'react-native';

/**
 * Web: native <button> (z-index 99999) — never blocked by RN Web touch bugs.
 * Native: Pressable with explicit zIndex.
 */
export default function WebModalButton({
  label,
  onPress,
  disabled,
  variant = 'primary',
  loading,
}) {
  const runPress = () => {
    if (disabled || loading) return;
    console.log(`[WebModalButton] runPress: ${label}`);
    Promise.resolve(onPress?.()).catch((err) => {
      console.error(`[WebModalButton] ${label} handler error`, err);
    });
  };

  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const isDanger = variant === 'danger';
    const isGhost = variant === 'ghost';
    return (
      <button
        type="button"
        disabled={disabled || loading}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          runPress();
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
        }}
        style={{
          flex: 1,
          minHeight: 48,
          padding: '14px 12px',
          borderRadius: 12,
          border: 'none',
          cursor: disabled || loading ? 'not-allowed' : 'pointer',
          fontWeight: 700,
          fontSize: 15,
          fontFamily: 'inherit',
          opacity: disabled || loading ? 0.65 : 1,
          backgroundColor: isDanger ? '#DC2626' : isGhost ? '#F1F5F9' : '#1E3A8A',
          color: isGhost ? '#475569' : '#FFFFFF',
          position: 'relative',
          zIndex: 99999,
          pointerEvents: disabled || loading ? 'none' : 'auto',
        }}
      >
        {loading ? '…' : label}
      </button>
    );
  }

  const btnStyle = variant === 'ghost' ? styles.ghost : styles.danger;
  const textStyle = variant === 'ghost' ? styles.ghostText : styles.dangerText;

  return (
    <Pressable
      style={({ pressed }) => [btnStyle, pressed && !disabled && styles.pressed]}
      onPress={runPress}
      disabled={disabled || loading}
      accessibilityRole="button"
    >
      <Text style={textStyle}>{loading ? '…' : label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  danger: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#DC2626',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 99999,
    elevation: 99999,
  },
  ghost: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 99999,
    elevation: 99999,
  },
  dangerText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
  ghostText: { fontSize: 15, fontWeight: '700', color: '#475569' },
  pressed: { opacity: 0.88 },
});
