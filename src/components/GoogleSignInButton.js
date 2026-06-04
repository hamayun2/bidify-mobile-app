import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';

const GOOGLE_BLUE = '#4285F4';
const GOOGLE_GREEN = '#34A853';
const GOOGLE_YELLOW = '#FBBC05';
const GOOGLE_RED = '#EA4335';

/** Official four-color Google "G" mark (View-only, no auth logic). */
function GoogleLogo({ size = 22 }) {
  const ring = size;
  const inner = size * 0.56;
  const barH = ring * 0.2;
  const barW = ring * 0.46;
  const barTop = ring * 0.4;

  return (
    <View style={[logoStyles.wrap, { width: size, height: size }]}>
      <View style={[logoStyles.ring, { width: ring, height: ring, borderRadius: ring / 2 }]}>
        <View style={[logoStyles.quad, logoStyles.quadTL]} />
        <View style={[logoStyles.quad, logoStyles.quadTR]} />
        <View style={[logoStyles.quad, logoStyles.quadBL]} />
        <View style={[logoStyles.quad, logoStyles.quadBR]} />
        <View
          style={{
            position: 'absolute',
            left: (ring - inner) / 2,
            top: (ring - inner) / 2,
            width: inner,
            height: inner,
            borderRadius: inner / 2,
            backgroundColor: '#FFFFFF',
          }}
        />
        <View
          style={{
            position: 'absolute',
            right: 0,
            top: barTop,
            width: barW,
            height: barH,
            backgroundColor: GOOGLE_BLUE,
          }}
        />
      </View>
    </View>
  );
}

const logoStyles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    overflow: 'hidden',
    position: 'relative',
  },
  quad: {
    position: 'absolute',
    width: '50%',
    height: '50%',
  },
  quadTL: { left: 0, top: 0, backgroundColor: GOOGLE_BLUE },
  quadTR: { right: 0, top: 0, backgroundColor: GOOGLE_RED },
  quadBL: { left: 0, bottom: 0, backgroundColor: GOOGLE_YELLOW },
  quadBR: { right: 0, bottom: 0, backgroundColor: GOOGLE_GREEN },
});

/**
 * Styled "Sign in with Google" control (custom UI; native SDK invoked by parent).
 */
export default function GoogleSignInButton({ onPress, disabled, loading, label = 'Sign in with Google' }) {
  return (
    <TouchableOpacity
      style={[styles.btn, (disabled || loading) && styles.btnDisabled]}
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.82}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID="google-sign-in-btn"
    >
      {loading ? (
        <ActivityIndicator color="#3C4043" />
      ) : (
        <View style={styles.inner}>
          <View style={styles.iconSlot}>
            <GoogleLogo size={22} />
          </View>
          <Text style={styles.label}>{label}</Text>
          <View style={styles.iconSlot} />
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    height: 52,
    borderWidth: 1,
    borderColor: '#DADCE0',
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 2,
      },
      android: { elevation: 1 },
      default: {},
    }),
  },
  btnDisabled: {
    opacity: 0.65,
  },
  inner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    height: '100%',
  },
  iconSlot: {
    width: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    flex: 1,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '600',
    color: '#3C4043',
    letterSpacing: 0.15,
  },
});
