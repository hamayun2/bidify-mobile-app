import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { HOME } from '../../constants/homePalette';

const DEEP_BLACK = '#000000';

/** BIDIFY wordmark — single bold lockup (UI only). */
export default function BidifyLogoMark({ compact = false, onDark = false, prominent = false }) {
  return (
    <View style={[styles.wrap, compact && styles.wrapCompact]} accessibilityRole="header">
      <Text
        style={[
          styles.brand,
          compact && styles.brandCompact,
          prominent && styles.brandProminent,
          onDark && styles.brandOnDark,
          prominent && !onDark && styles.brandBlack,
        ]}
      >
        BIDIFY
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  wrapCompact: {
    paddingHorizontal: 16,
    paddingVertical: 2,
  },
  brand: {
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 4,
    color: HOME.black,
    textAlign: 'center',
  },
  brandCompact: {
    fontSize: 19,
    letterSpacing: 3.6,
  },
  brandProminent: {
    fontSize: 26,
    fontWeight: '900',
    letterSpacing: 5,
  },
  brandBlack: {
    color: DEEP_BLACK,
  },
  brandOnDark: {
    color: '#FFFFFF',
  },
});
