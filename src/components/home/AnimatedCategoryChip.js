import React, { useEffect, useRef } from 'react';
import { Text, StyleSheet, Pressable, Animated, Platform } from 'react-native';
import { HOME } from '../../constants/homePalette';

export default function AnimatedCategoryChip({ label, active, onPress, index = 0 }) {
  const slide = useRef(new Animated.Value(28)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const glow = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slide, {
        toValue: 0,
        duration: 420 + index * 55,
        delay: index * 70,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 380 + index * 45,
        delay: index * 70,
        useNativeDriver: true,
      }),
    ]).start();
  }, [index, opacity, slide]);

  useEffect(() => {
    if (!active) {
      glow.stopAnimation();
      glow.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glow, { toValue: 1, duration: 900, useNativeDriver: false }),
        Animated.timing(glow, { toValue: 0.35, duration: 900, useNativeDriver: false }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [active, glow]);

  const handlePressIn = () => {
    Animated.spring(scale, { toValue: 1.05, friction: 7, tension: 140, useNativeDriver: true }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scale, { toValue: 1, friction: 7, tension: 140, useNativeDriver: true }).start();
  };

  const underglowOpacity = glow.interpolate({
    inputRange: [0, 1],
    outputRange: [0.12, 0.38],
  });

  return (
    <Animated.View
      style={{
        opacity,
        transform: [{ translateX: slide }, { scale }],
        marginRight: 10,
      }}
    >
      <Pressable
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={({ pressed }) => [
          styles.chip,
          active && styles.chipActive,
          pressed && !active && styles.chipPressed,
        ]}
      >
        {active ? (
          <Animated.View
            pointerEvents="none"
            style={[styles.underglow, { opacity: underglowOpacity }]}
          />
        ) : null}
        <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  chip: {
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 22,
    backgroundColor: HOME.surface,
    borderWidth: 1,
    borderColor: HOME.divider,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: HOME.charcoal,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.06,
        shadowRadius: 4,
      },
      android: { elevation: 1 },
    }),
  },
  chipActive: {
    backgroundColor: HOME.charcoal,
    borderColor: HOME.charcoal,
  },
  chipPressed: {
    backgroundColor: '#EBEBEB',
  },
  underglow: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: HOME.black,
    borderRadius: 22,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: HOME.charcoal,
    letterSpacing: 0.15,
  },
  labelActive: {
    color: HOME.white,
    fontWeight: '700',
  },
});
