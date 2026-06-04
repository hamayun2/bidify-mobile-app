import React, { useContext, useEffect, useRef } from 'react';
import {
  View,
  Animated,
  PanResponder,
  StyleSheet,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useChatbotPanel } from '../context/ChatbotPanelContext';
import ListingsSyncContext from '../context/ListingsSyncContext';

const OUTER_SIZE = 62;
const INNER_SIZE = 57;
const RING_PADDING = 2.5;
const EDGE_MARGIN = 16;
const INNER_GRADIENT = ['#1E3A8A', '#6B21A8'];
const GOOGLE_RING_COLORS = ['#4285F4', '#EA4335', '#FBBC05', '#34A853', '#4285F4'];
const DRAG_THRESHOLD = 8;

/**
 * Draggable circle FAB — 62×62 hit box, Google multi-color ring, magnetic edge snap.
 */
export default function BidifyAIFab({ bottom = 88 }) {
  const { width: screenW, height: screenH } = useWindowDimensions();
  const { toggle } = useChatbotPanel();
  const listingsSync = useContext(ListingsSyncContext);
  const deleteModalOpen = listingsSync?.deleteModalVisible;

  const position = useRef(new Animated.ValueXY()).current;
  const movedRef = useRef(false);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current || !screenW || !screenH) return;
    initializedRef.current = true;
    const snapX = screenW - OUTER_SIZE - EDGE_MARGIN;
    const snapY = screenH - bottom - OUTER_SIZE;
    position.setValue({ x: snapX, y: snapY });
  }, [screenW, screenH, bottom, position]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gesture) =>
        Math.abs(gesture.dx) > 2 || Math.abs(gesture.dy) > 2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        movedRef.current = false;
        position.extractOffset();
      },
      onPanResponderMove: (_, gesture) => {
        if (Math.abs(gesture.dx) > DRAG_THRESHOLD || Math.abs(gesture.dy) > DRAG_THRESHOLD) {
          movedRef.current = true;
        }
        position.setValue({ x: gesture.dx, y: gesture.dy });
      },
      onPanResponderRelease: () => {
        position.flattenOffset();
        const rawX = position.x._value ?? 0;
        const rawY = position.y._value ?? 0;

        const centerX = screenW / 2;
        const fabCenterX = rawX + OUTER_SIZE / 2;
        const snapX =
          fabCenterX > centerX
            ? screenW - OUTER_SIZE - EDGE_MARGIN
            : EDGE_MARGIN;

        const minY = Platform.OS === 'ios' ? 52 : 48;
        const maxY = screenH - OUTER_SIZE - bottom;
        const snapY = clamp(rawY, minY, maxY);

        Animated.spring(position, {
          toValue: { x: snapX, y: snapY },
          useNativeDriver: false,
          friction: 7,
          tension: 45,
        }).start();

        if (!movedRef.current) toggle();
      },
    })
  ).current;

  if (deleteModalOpen) {
    return null;
  }

  return (
    <Animated.View
      style={[
        styles.fabOuter,
        {
          left: position.x,
          top: position.y,
        },
      ]}
      {...panResponder.panHandlers}
      collapsable={false}
      pointerEvents="box-only"
      accessibilityRole="button"
      accessibilityLabel="Open Bidify AI assistant"
    >
      <LinearGradient
        colors={GOOGLE_RING_COLORS}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.ringGradient}
      >
        <View style={styles.ringInnerCutout}>
          <LinearGradient
            colors={INNER_GRADIENT}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.fabCore}
          >
            <Ionicons name="sparkles" size={24} color="#FFFFFF" />
          </LinearGradient>
        </View>
      </LinearGradient>
    </Animated.View>
  );
}

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

const styles = StyleSheet.create({
  fabOuter: {
    position: 'absolute',
    width: OUTER_SIZE,
    height: OUTER_SIZE,
    borderRadius: OUTER_SIZE / 2,
    overflow: 'hidden',
    zIndex: 200,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.18,
        shadowRadius: 4,
      },
      android: { elevation: 4 },
    }),
  },
  ringGradient: {
    width: OUTER_SIZE,
    height: OUTER_SIZE,
    borderRadius: OUTER_SIZE / 2,
    padding: RING_PADDING,
  },
  ringInnerCutout: {
    width: INNER_SIZE,
    height: INNER_SIZE,
    borderRadius: INNER_SIZE / 2,
    overflow: 'hidden',
  },
  fabCore: {
    width: INNER_SIZE,
    height: INNER_SIZE,
    borderRadius: INNER_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
