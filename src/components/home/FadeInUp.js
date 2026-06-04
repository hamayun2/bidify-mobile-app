import React, { useEffect, useRef } from 'react';
import { Animated } from 'react-native';

/** Fade-in + slight slide-up entrance (UI only). */
export default function FadeInUp({ children, delay = 0, style, resetKey }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(16)).current;

  useEffect(() => {
    opacity.setValue(0);
    translateY.setValue(16);
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 480,
        delay,
        useNativeDriver: true,
      }),
      Animated.spring(translateY, {
        toValue: 0,
        friction: 9,
        tension: 68,
        delay,
        useNativeDriver: true,
      }),
    ]).start();
  }, [delay, opacity, translateY, resetKey]);

  return (
    <Animated.View style={[style, { opacity, transform: [{ translateY }] }]}>
      {children}
    </Animated.View>
  );
}
