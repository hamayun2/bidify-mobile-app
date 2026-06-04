import React, { useCallback, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, Animated, Easing } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { setKycReviewLock } from '../utils/kycBidLockStorage';
import { spacing } from '../theme';

const DEEP_BG = '#0B0E11';
const PANEL_BG = '#181A20';
const ACCENT = '#F0B90B';
const TEXT_PRIMARY = '#EAECEF';
const TEXT_MUTED = '#848E9C';
const INDIGO_GLOW = '#1E3A8A';

function PulsingTimerIcon() {
  const pulse = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1400,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1400,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );
    const spinLoop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 8000,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    pulseLoop.start();
    spinLoop.start();
    return () => {
      pulseLoop.stop();
      spinLoop.stop();
    };
  }, [pulse, spin]);

  const scale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.14],
  });
  const ringOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.35, 0.95],
  });
  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <View style={styles.heroWrap}>
      <Animated.View
        style={[
          styles.pulseRingOuter,
          { opacity: ringOpacity, transform: [{ scale }] },
        ]}
        pointerEvents="none"
      />
      <Animated.View
        style={[styles.pulseRingSpin, { transform: [{ rotate }] }]}
        pointerEvents="none"
      />
      <LinearGradient
        colors={['#1E3A8A', '#0F172A']}
        style={styles.iconCore}
      >
        <Ionicons name="timer-outline" size={52} color={ACCENT} />
      </LinearGradient>
    </View>
  );
}

export default function KycReviewStatusScreen() {
  const navigation = useNavigation();

  const handleOk = useCallback(async () => {
    await setKycReviewLock();
    try {
      navigation.replace('MainTabs');
    } catch (_) {
      const parent = navigation.getParent?.();
      if (parent?.replace) {
        parent.replace('MainTabs');
      }
    }
  }, [navigation]);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <LinearGradient colors={['#0B0E11', '#12151C', '#0B0E11']} style={styles.gradient}>
        <View style={styles.root}>
          <View style={styles.centerBlock}>
            <PulsingTimerIcon />
            <Text style={styles.title}>⏳ Your Account is Under Review</Text>
            <Text style={styles.description}>
              Our automated validation engine is assessing your identity documents and metadata.
              You will receive an immediate push notification once verification is complete.
            </Text>
            <View style={styles.statusChip}>
              <View style={styles.statusDot} />
              <Text style={styles.statusChipText}>Review in progress · ~5 minutes</Text>
            </View>
          </View>

          <Pressable
            style={({ pressed }) => [styles.okBtn, pressed && styles.okBtnPressed]}
            onPress={handleOk}
            accessibilityRole="button"
            accessibilityLabel="OK, Go to App"
          >
            <LinearGradient
              colors={['#FCD34D', '#F0B90B', '#D97706']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.okBtnGradient}
            >
              <Text style={styles.okBtnText}>OK, Go to App</Text>
            </LinearGradient>
          </Pressable>
        </View>
      </LinearGradient>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: DEEP_BG },
  gradient: { flex: 1 },
  root: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
    justifyContent: 'space-between',
  },
  centerBlock: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  heroWrap: {
    width: 148,
    height: 148,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
  },
  pulseRingOuter: {
    position: 'absolute',
    width: 148,
    height: 148,
    borderRadius: 74,
    borderWidth: 2,
    borderColor: ACCENT,
  },
  pulseRingSpin: {
    position: 'absolute',
    width: 132,
    height: 132,
    borderRadius: 66,
    borderWidth: 3,
    borderColor: 'transparent',
    borderTopColor: '#22C55E',
    borderRightColor: 'rgba(34, 197, 94, 0.35)',
  },
  iconCore: {
    width: 108,
    height: 108,
    borderRadius: 54,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(240, 185, 11, 0.35)',
    shadowColor: INDIGO_GLOW,
    shadowOpacity: 0.45,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: TEXT_PRIMARY,
    textAlign: 'center',
    marginBottom: spacing.md,
    lineHeight: 32,
    letterSpacing: 0.2,
  },
  description: {
    fontSize: 15,
    color: TEXT_MUTED,
    textAlign: 'center',
    lineHeight: 24,
    maxWidth: 340,
    marginBottom: spacing.lg,
  },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: PANEL_BG,
    borderWidth: 1,
    borderColor: '#2B3139',
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: spacing.lg,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#22C55E',
  },
  statusChipText: {
    color: TEXT_PRIMARY,
    fontSize: 13,
    fontWeight: '600',
  },
  okBtn: {
    width: '100%',
    borderRadius: 14,
    overflow: 'hidden',
    minHeight: 54,
    shadowColor: ACCENT,
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  okBtnPressed: { opacity: 0.92, transform: [{ scale: 0.985 }] },
  okBtnGradient: {
    paddingVertical: 17,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 54,
  },
  okBtnText: {
    color: '#0B0E11',
    fontWeight: '800',
    fontSize: 16,
    letterSpacing: 0.3,
  },
});
