import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Animated, StyleSheet, Text, View, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const ToastContext = createContext({
  showToast: () => {},
});

export function ToastProvider({ children }) {
  const insets = useSafeAreaInsets();
  const [message, setMessage] = useState('');
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-12)).current;
  const hideTimer = useRef(null);

  const hide = useCallback(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: -12, duration: 220, useNativeDriver: true }),
    ]).start(() => setMessage(''));
  }, [opacity, translateY]);

  const showToast = useCallback(
    (text) => {
      const body = text != null ? String(text).trim() : '';
      if (!body) return;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setMessage(body);
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 0, duration: 220, useNativeDriver: true }),
      ]).start();
      hideTimer.current = setTimeout(hide, 3800);
    },
    [hide, opacity, translateY]
  );

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {message ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.wrap,
            {
              top: insets.top + 8,
              opacity,
              transform: [{ translateY }],
            },
          ]}
        >
          <View style={styles.toast}>
            <Text style={styles.text} numberOfLines={4}>
              {message}
            </Text>
          </View>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 9999,
    alignItems: 'center',
  },
  toast: {
    maxWidth: 420,
    width: '100%',
    backgroundColor: 'rgba(15, 23, 42, 0.94)',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.25,
        shadowRadius: 10,
      },
      android: { elevation: 8 },
    }),
  },
  text: {
    color: '#FFFFFF',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
    textAlign: 'center',
  },
});
