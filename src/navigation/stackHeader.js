import React, { useCallback } from 'react';
import { Pressable, Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';

export const STACK_HEADER_BG = '#F4F6F8';
export const STACK_HEADER_TINT = '#0F172A';

/**
 * Stack header back control — uses useNavigation() because native-stack
 * headerLeft does not always pass a valid navigation prop.
 */
export function StackBackButton({ tintColor = STACK_HEADER_TINT }) {
  const navigation = useNavigation();

  const onPress = useCallback(() => {
    try {
      if (typeof navigation.canGoBack === 'function' && navigation.canGoBack()) {
        navigation.goBack();
        return;
      }
    } catch (_) {
      /* fall through */
    }
    try {
      navigation.navigate('MainTabs');
    } catch (_) {
      /* ignore */
    }
  }, [navigation]);

  return (
    <Pressable
      onPress={onPress}
      hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
      style={({ pressed }) => [styles.backHit, pressed && styles.backPressed]}
      accessibilityLabel="Go back"
      accessibilityRole="button"
    >
      <Ionicons name="chevron-back" size={26} color={tintColor} />
    </Pressable>
  );
}

export function premiumStackScreenOptions(overrides = {}) {
  const { headerLeft: _ignored, ...rest } = overrides;

  return {
    headerShown: true,
    headerStyle: { backgroundColor: STACK_HEADER_BG },
    headerTintColor: STACK_HEADER_TINT,
    headerTitleStyle: {
      fontWeight: '800',
      fontSize: 17,
      color: STACK_HEADER_TINT,
    },
    headerShadowVisible: false,
    headerBackVisible: false,
    headerLeft: () => <StackBackButton tintColor={rest.headerTintColor || STACK_HEADER_TINT} />,
    contentStyle: { backgroundColor: STACK_HEADER_BG },
    ...rest,
  };
}

const styles = {
  backHit: {
    marginLeft: Platform.OS === 'ios' ? 0 : 4,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backPressed: {
    opacity: 0.55,
  },
};
