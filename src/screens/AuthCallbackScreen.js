import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Platform, TouchableOpacity } from 'react-native';
import useAuth from '../hooks/useAuth';
import { completeGoogleOAuthIfPendingAPI } from '../api/auth';
import {
  consumeOAuthErrorFromStorage,
  getOAuthErrorFromBrowserLocation,
  urlLooksLikeSupabaseAuthCallback,
} from '../services/supabase/deepLinkSession';
import { isAdminUser } from '../utils/userRole';

/**
 * OAuth / email-confirmation return path (`/auth/callback?code=…`).
 * PKCE code verifier is restored from sessionStorage vault on mobile Safari/ngrok.
 */
export default function AuthCallbackScreen({ navigation }) {
  const { login, isAuthenticated } = useAuth();
  const [errorMessage, setErrorMessage] = useState('');
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') {
      navigation.replace('Login');
      return undefined;
    }

    if (isAuthenticated) {
      setBusy(false);
      return undefined;
    }

    const storedErr = consumeOAuthErrorFromStorage();
    const locationErr = getOAuthErrorFromBrowserLocation();
    if (storedErr || locationErr?.message) {
      setErrorMessage(storedErr || locationErr.message);
      setBusy(false);
      return undefined;
    }

    const href = window.location.href;
    if (!urlLooksLikeSupabaseAuthCallback(href)) {
      navigation.replace('Login');
      return undefined;
    }

    let cancelled = false;
    void (async () => {
      setBusy(true);
      try {
        const response = await completeGoogleOAuthIfPendingAPI();
        if (cancelled || !response?.token || !response?.user) return;

        const admin = isAdminUser(response.user);
        const nav = response.navigation;
        const loginOptions = {};
        if (nav?.name) {
          loginOptions.initialRoute = nav.name;
          if (nav.params) loginOptions.initialRouteParams = nav.params;
        } else if (admin) {
          loginOptions.initialRoute = 'AdminPanel';
        }
        await login(response.token, response.user, loginOptions);
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error?.message || 'Sign-in callback failed');
          setBusy(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, login, navigation]);

  if (busy && !errorMessage) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#2563EB" />
        <Text style={styles.hint}>Completing sign-in…</Text>
      </View>
    );
  }

  if (errorMessage) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Sign-in failed</Text>
        <Text style={styles.errorBody}>{errorMessage}</Text>
        <TouchableOpacity style={styles.button} onPress={() => navigation.replace('Login')}>
          <Text style={styles.buttonText}>Back to login</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color="#2563EB" />
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#FFFFFF',
  },
  hint: { marginTop: 16, fontSize: 15, color: '#64748B' },
  errorTitle: { fontSize: 18, fontWeight: '700', color: '#111', marginBottom: 8 },
  errorBody: { fontSize: 14, color: '#444', textAlign: 'center', marginBottom: 20 },
  button: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
  },
  buttonText: { color: '#FFF', fontWeight: '600', fontSize: 15 },
});
