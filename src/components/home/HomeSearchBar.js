import React, { useRef, useState } from 'react';
import {
  View,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { HOME } from '../../constants/homePalette';

export default function HomeSearchBar({
  value,
  onChangeText,
  onFilterPress,
  placeholder = 'Search listings, categories, cities...',
}) {
  const [focused, setFocused] = useState(false);
  const focusAnim = useRef(new Animated.Value(0)).current;

  const setFocus = (on) => {
    setFocused(on);
    Animated.timing(focusAnim, {
      toValue: on ? 1 : 0,
      duration: 220,
      useNativeDriver: false,
    }).start();
  };

  const borderColor = focusAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [HOME.divider, HOME.black],
  });

  const shadowOpacity = focusAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.04, 0.12],
  });

  const backgroundColor = focusAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['rgba(245, 245, 245, 0.92)', 'rgba(255, 255, 255, 0.98)'],
  });

  return (
    <View style={styles.shell}>
      <Animated.View
        style={[
          styles.container,
          {
            borderColor,
            backgroundColor,
            shadowOpacity,
          },
        ]}
      >
        <Ionicons name="search-outline" size={18} color={focused ? HOME.black : HOME.charcoal} />
        <TextInput
          style={styles.input}
          placeholder={placeholder}
          placeholderTextColor={HOME.charcoal}
          value={value}
          onChangeText={onChangeText}
          returnKeyType="search"
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
        />
        <TouchableOpacity
          onPress={onFilterPress}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel="Search filters"
          accessibilityRole="button"
        >
          <Ionicons name="options-outline" size={19} color={HOME.black} />
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    paddingHorizontal: 24,
    paddingBottom: 16,
  },
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    paddingHorizontal: 18,
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
    ...Platform.select({
      ios: {
        shadowColor: HOME.black,
        shadowOffset: { width: 0, height: 4 },
        shadowRadius: 12,
      },
      android: { elevation: 2 },
    }),
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: HOME.black,
    paddingVertical: 0,
    fontWeight: '500',
  },
});
