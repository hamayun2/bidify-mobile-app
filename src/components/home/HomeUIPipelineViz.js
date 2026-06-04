import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { HOME } from '../../constants/homePalette';

/**
 * Decorative flowchart — illustrates Home → View All cross-fade (no backend).
 */
export default function HomeUIPipelineViz({ viewAllActive }) {
  const flow = useRef(new Animated.Value(viewAllActive ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(flow, {
      toValue: viewAllActive ? 1 : 0,
      duration: 480,
      useNativeDriver: false,
    }).start();
  }, [viewAllActive, flow]);

  const btnBg = flow.interpolate({
    inputRange: [0, 1],
    outputRange: [HOME.black, HOME.charcoal],
  });

  const listOpacity = flow.interpolate({
    inputRange: [0, 0.45, 1],
    outputRange: [0.35, 0.7, 1],
  });

  return (
    <View style={styles.wrap}>
      <Text style={styles.heading}>UI flow</Text>
      <View style={styles.row}>
        <View style={styles.nodeCol}>
          <Animated.View style={[styles.nodeBtn, { backgroundColor: btnBg }]}>
            <Text style={styles.nodeBtnText}>View All</Text>
          </Animated.View>
          <Text style={styles.caption}>Home carousel</Text>
        </View>

        <View style={styles.arrowCol}>
          <Ionicons name="arrow-forward" size={18} color={HOME.charcoal} />
          <Text style={styles.arrowLabel}>cross-fade</Text>
        </View>

        <View style={styles.nodeCol}>
          <Animated.View style={[styles.nodeList, { opacity: listOpacity }]}>
            <View style={styles.listBar} />
            <View style={[styles.listBar, styles.listBarShort]} />
            <View style={[styles.listBar, styles.listBarMid]} />
          </Animated.View>
          <Text style={styles.caption}>List view</Text>
        </View>
      </View>
      <View style={styles.legend}>
        <View style={styles.swatchBlack} />
        <Text style={styles.legendText}>#000000 → #666666 on expand</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 20,
    marginTop: 28,
    padding: 16,
    borderRadius: 14,
    backgroundColor: HOME.white,
    borderWidth: 1,
    borderColor: HOME.divider,
  },
  heading: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: HOME.charcoal,
    marginBottom: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  nodeCol: { flex: 1, alignItems: 'center' },
  nodeBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    minWidth: 88,
    alignItems: 'center',
  },
  nodeBtnText: {
    color: HOME.white,
    fontSize: 12,
    fontWeight: '700',
  },
  nodeList: {
    width: 72,
    padding: 8,
    borderRadius: 8,
    backgroundColor: HOME.surface,
    borderWidth: 1,
    borderColor: HOME.divider,
    gap: 5,
  },
  listBar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: HOME.charcoal,
    opacity: 0.55,
  },
  listBarShort: { width: '65%', opacity: 0.35 },
  listBarMid: { width: '82%', opacity: 0.45 },
  caption: {
    marginTop: 8,
    fontSize: 11,
    color: HOME.charcoal,
    fontWeight: '500',
  },
  arrowCol: { alignItems: 'center', paddingHorizontal: 6 },
  arrowLabel: {
    fontSize: 9,
    color: HOME.charcoal,
    marginTop: 4,
    fontWeight: '600',
  },
  legend: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
    gap: 8,
  },
  swatchBlack: {
    width: 14,
    height: 14,
    borderRadius: 4,
    backgroundColor: HOME.black,
  },
  legendText: { fontSize: 11, color: HOME.charcoal },
});
