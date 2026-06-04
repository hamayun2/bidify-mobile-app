import React from 'react';
import { View, ActivityIndicator, Text, StyleSheet } from 'react-native';

const INDIGO = '#1E3A8A';

/**
 * Shown while AuthContext reads AsyncStorage / Supabase session — prevents Login flash.
 */
export default function AuthBootSplash() {
  return (
    <View style={styles.root}>
      <Text style={styles.brand}>Bidify</Text>
      <ActivityIndicator size="large" color={INDIGO} style={styles.spinner} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F4F6F8',
  },
  brand: {
    fontSize: 28,
    fontWeight: '800',
    color: INDIGO,
    marginBottom: 24,
  },
  spinner: {
    marginTop: 8,
  },
});
