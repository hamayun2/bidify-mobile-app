import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { HOME, HOME_BROWSE_FILTERS } from '../../constants/homePalette';

function FilterPill({ label, active, onPress }) {
  return (
    <TouchableOpacity
      style={[styles.pill, active ? styles.pillActive : styles.pillInactive]}
      onPress={onPress}
      activeOpacity={0.88}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

/** Marketplace browse filters (formerly on Explore). */
export default function HomeBrowseFilterPills({ activeFilter, onChange }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {HOME_BROWSE_FILTERS.map((label) => (
        <FilterPill
          key={label}
          label={label}
          active={activeFilter === label}
          onPress={() => onChange(label)}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 20,
    paddingBottom: 10,
    gap: 8,
    alignItems: 'center',
  },
  pill: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 20,
    marginRight: 2,
  },
  pillInactive: {
    backgroundColor: HOME.white,
    borderWidth: 1,
    borderColor: HOME.tabBorder,
  },
  pillActive: {
    backgroundColor: HOME.black,
    borderWidth: 1,
    borderColor: HOME.black,
  },
  pillText: {
    fontSize: 13,
    fontWeight: '600',
    color: HOME.charcoal,
  },
  pillTextActive: {
    color: HOME.white,
    fontWeight: '700',
  },
});
