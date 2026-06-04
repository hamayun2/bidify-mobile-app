import React, { useRef } from 'react';
import { View, Text, StyleSheet, Pressable, Animated } from 'react-native';
import { HOME, HOME_TABS } from '../../constants/homePalette';

const TAB_GAP = 10;
const TAB_RADIUS = 12;

function TabCell({ label, active, onPress, flex }) {
  const scale = useRef(new Animated.Value(1)).current;

  const handlePress = () => {
    Animated.sequence([
      Animated.spring(scale, { toValue: 1.03, friction: 4, tension: 200, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, friction: 6, tension: 160, useNativeDriver: true }),
    ]).start();
    onPress();
  };

  return (
    <Pressable style={[styles.cell, { flex }]} onPress={handlePress}>
      <Animated.View
        style={[
          styles.tab,
          active ? styles.tabActive : styles.tabInactive,
          { transform: [{ scale }] },
        ]}
      >
        <Text style={[styles.tabText, active && styles.tabTextActive]} numberOfLines={1}>
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

export default function HomeFilterTabBar({ activeTab, onChange }) {
  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        {HOME_TABS.map((tab) => (
          <TabCell
            key={tab}
            label={tab}
            active={activeTab === tab}
            onPress={() => onChange(tab)}
            flex={1}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 20,
    paddingBottom: 0,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: TAB_GAP,
  },
  cell: {
    minWidth: 0,
  },
  tab: {
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: TAB_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  tabInactive: {
    backgroundColor: HOME.white,
    borderWidth: 1,
    borderColor: HOME.tabBorder,
  },
  tabActive: {
    backgroundColor: HOME.black,
    borderWidth: 1,
    borderColor: HOME.black,
  },
  tabText: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.15,
    color: HOME.charcoal,
  },
  tabTextActive: {
    color: HOME.white,
    fontWeight: '700',
  },
});
