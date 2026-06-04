import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { HOME, HOME_MARKET_TABS } from '../../constants/homePalette';

function MarketTab({ label, active, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.tab,
        active ? styles.tabActive : styles.tabInactive,
        pressed && !active && styles.tabPressed,
      ]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text
        style={[styles.tabText, active && styles.tabTextActive]}
        numberOfLines={2}
        adjustsFontSizeToFit
        minimumFontScale={0.78}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Exactly four marketplace filter tabs in one premium row. */
export default function HomeMarketplaceFilterBar({ activeTab, onChange }) {
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        {HOME_MARKET_TABS.map((tab) => (
          <MarketTab
            key={tab.key}
            label={tab.label}
            active={activeTab === tab.key}
            onPress={() => onChange(tab.key)}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 8,
  },
  tab: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 8,
    paddingVertical: 11,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: HOME.tabBorder,
    backgroundColor: HOME.white,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  tabInactive: {
    backgroundColor: HOME.white,
  },
  tabActive: {
    backgroundColor: '#1E293B',
    borderColor: '#1E293B',
  },
  tabPressed: {
    backgroundColor: HOME.segmentTint,
  },
  tabText: {
    fontSize: 11,
    fontWeight: '600',
    color: HOME.charcoal,
    textAlign: 'center',
    lineHeight: 14,
  },
  tabTextActive: {
    color: HOME.white,
    fontWeight: '800',
  },
});
