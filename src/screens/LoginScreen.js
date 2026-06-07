import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import useAuth from '../hooks/useAuth';
import { loginAPI, loginWithGoogleAPI, completeGoogleOAuthIfPendingAPI } from '../api/auth';
import {
  consumeOAuthErrorFromStorage,
  getOAuthErrorFromBrowserLocation,
  urlLooksLikeSupabaseAuthCallback,
} from '../services/supabase/deepLinkSession';
import { isAdminUser } from '../utils/userRole';
import { isSupabaseConfigured } from '../services/supabaseClient';
import { isGoogleSignInConfigured } from '../services/googleAuthService';
import GoogleSignInButton from '../components/GoogleSignInButton';

const LoginScreen = ({ navigation }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordHidden, setPasswordHidden] = useState(true);
  const [emailFocused, setEmailFocused] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [googleRedirecting, setGoogleRedirecting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const { login } = useAuth();
  const showGoogleSignIn = isSupabaseConfigured() && isGoogleSignInConfigured();

  const handleLogin = async () => {
    setErrorMessage('');
    const emailRegex = /\S+@\S+\.\S+/;
    if (!email) return setErrorMessage('Please enter your email address');
    if (!emailRegex.test(email)) return setErrorMessage('Please enter a valid email address');
    if (!password) return setErrorMessage('Please enter your password');
    if (password.length < 8) return setErrorMessage('Password must be at least 8 characters');
    if (!/\d/.test(password)) return setErrorMessage('Password must contain at least one number');

    setLoading(true);
    try {
      const response = await loginAPI(email, password);
      const admin = isAdminUser(response.user);
      if (__DEV__) {
        console.log('[Bidify/Login] success', {
          email: response.user?.email,
          role: response.user?.role,
          admin,
        });
      }
      await login(response.token, response.user, admin ? { initialRoute: 'AdminPanel' } : undefined);
    } catch (error) {
      console.error('[Bidify/Login] FAILED', {
        email: email.trim(),
        message: error?.message,
        stack: error?.stack,
      });
      setErrorMessage(error.message || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  const finishGoogleLogin = async (response) => {
    if (!response?.token || !response?.user) return;
    const admin = isAdminUser(response.user);
    const nav = response.navigation;
    if (__DEV__) {
      console.log('[Bidify/Login] Google success', {
        email: response.user?.email,
        role: response.user?.role,
        admin,
        route: nav?.name,
      });
    }
    const loginOptions = {};
    if (nav?.name) {
      loginOptions.initialRoute = nav.name;
      if (nav.params) loginOptions.initialRouteParams = nav.params;
    } else if (admin) {
      loginOptions.initialRoute = 'AdminPanel';
    }
    await login(response.token, response.user, loginOptions);
  };

  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const storedErr = consumeOAuthErrorFromStorage();
    if (storedErr) setErrorMessage(storedErr);
    return undefined;
  }, []);

  useEffect(() => {
    // Clear stale PKCE flow state on mount to prevent "invalid flow state" errors on mobile
    if (Platform.OS === 'web') return;
    const clearStaleAuthFlow = async () => {
      try {
        const keys = await AsyncStorage.getAllKeys();
        const flowKeys = keys.filter(k => k.includes('-code-verifier'));
        if (flowKeys.length > 0) {
          await AsyncStorage.multiRemove(flowKeys);
          if (__DEV__) {
            console.log('[Bidify/Login] Cleared stale PKCE flow keys to prevent session mismatch:', flowKeys);
          }
        }
      } catch (e) {
        console.warn('Failed to clear stale auth state', e);
      }
    };
    void clearStaleAuthFlow();
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
    const href = window.location.href;
    if (!urlLooksLikeSupabaseAuthCallback(href) && !getOAuthErrorFromBrowserLocation()) {
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      setGoogleLoading(true);
      try {
        const response = await completeGoogleOAuthIfPendingAPI();
        if (cancelled || !response) return;
        await finishGoogleLogin(response);
      } catch (error) {
        if (!cancelled) {
          console.error('[Bidify/Login] Google OAuth callback FAILED', {
            message: error?.message,
            code: error?.code,
          });
          setErrorMessage(error.message || 'Google sign-in failed');
        }
      } finally {
        if (!cancelled) setGoogleLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [login]);

  const handleGoogleLogin = async () => {
    setErrorMessage('');
    setGoogleLoading(true);
    setGoogleRedirecting(false);
    try {
      const response = await loginWithGoogleAPI();
      if (response?.redirecting) {
        setGoogleRedirecting(true);
        return;
      }
      await finishGoogleLogin(response);
    } catch (error) {
      console.error('[Bidify/Login] Google FAILED', {
        message: error?.message,
        code: error?.code,
      });
      setErrorMessage(error.message || 'Google sign-in failed');
    } finally {
      setGoogleLoading(false);
    }
  };

  const authBusy = loading || googleLoading;

  return (
    <SafeAreaView style={styles.safe}>
      <LinearGradient
        colors={['#050B14', '#0A1628', '#0F2744', '#050B14']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.gradient}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.flex}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <LinearGradient
              colors={['#C9A227', '#F4E4BC', '#B8860B', '#D4AF37']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.cardGlow}
            >
            <View style={styles.card}>
              <Text style={styles.brandLogo}>Bidify</Text>
              <View style={styles.brandAccentLine} />
              <Text style={styles.title}>Welcome back</Text>
              <Text style={styles.subtitle}>Sign in to continue bidding on unique treasures.</Text>

            <View style={[styles.inputContainer, emailFocused && styles.inputContainerFocused]}>
              <Ionicons name="mail-outline" size={20} color={emailFocused ? '#D4AF37' : '#64748B'} style={styles.inputIcon} />
              <TextInput
                style={styles.inputField}
                placeholder="you@example.com"
                placeholderTextColor="#64748B"
                keyboardType="email-address"
                autoCapitalize="none"
                value={email}
                onChangeText={setEmail}
                onFocus={() => setEmailFocused(true)}
                onBlur={() => setEmailFocused(false)}
              />
            </View>

            <View style={[styles.inputContainer, passwordFocused && styles.inputContainerFocused]}>
              <Ionicons
                name="lock-closed-outline"
                size={20}
                color={passwordFocused ? '#D4AF37' : '#64748B'}
                style={styles.inputIcon}
              />
              <TextInput
                style={styles.inputField}
                placeholder="Enter your password"
                placeholderTextColor="#64748B"
                secureTextEntry={passwordHidden}
                value={password}
                onChangeText={setPassword}
                onFocus={() => setPasswordFocused(true)}
                onBlur={() => setPasswordFocused(false)}
              />
              <TouchableOpacity
                onPress={() => setPasswordHidden((h) => !h)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={styles.eyeBtn}
              >
                <Ionicons
                  name={passwordHidden ? 'eye-off-outline' : 'eye-outline'}
                  size={20}
                  color="#64748B"
                />
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              onPress={() =>
                navigation.navigate('ForgotPassword', email ? { prefillEmail: email } : undefined)
              }
              style={styles.forgotWrap}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Text style={styles.forgot}>Forgot Password?</Text>
            </TouchableOpacity>

            {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

            <TouchableOpacity
              style={[styles.loginBtnWrap, authBusy && styles.loginBtnDisabled]}
              onPress={handleLogin}
              disabled={authBusy}
              activeOpacity={0.88}
            >
              <LinearGradient
                colors={authBusy ? ['#475569', '#334155'] : ['#C9A227', '#D4AF37', '#B8860B']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.loginBtn}
              >
                {loading ? (
                  <ActivityIndicator color="#0A1628" />
                ) : (
                  <Text style={styles.loginBtnText}>Login</Text>
                )}
              </LinearGradient>
            </TouchableOpacity>

            <View style={styles.googleSection}>
              <View style={styles.dividerRow}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>OR</Text>
                <View style={styles.dividerLine} />
              </View>
              {googleRedirecting ? (
                <Text style={styles.googleRedirectHint}>
                  Redirecting to Google… Complete sign-in and you will return here automatically.
                </Text>
              ) : null}
              <GoogleSignInButton
                onPress={handleGoogleLogin}
                loading={googleLoading}
                disabled={authBusy}
                label="Continue with Google"
              />
            </View>

            <View style={styles.footer}>
              <Text style={styles.footerMuted}>Don't have an account? </Text>
              <TouchableOpacity onPress={() => navigation.navigate('Register')}>
                <Text style={styles.footerLink}>Sign Up</Text>
              </TouchableOpacity>
            </View>
            </View>
            </LinearGradient>
          </ScrollView>
        </KeyboardAvoidingView>
      </LinearGradient>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#050B14',
  },
  gradient: {
    flex: 1,
  },
  flex: { flex: 1 },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 36,
    paddingHorizontal: 20,
  },
  cardGlow: {
    width: '100%',
    maxWidth: 420,
    padding: 1.5,
    borderRadius: 26,
    ...Platform.select({
      ios: {
        shadowColor: '#D4AF37',
        shadowOffset: { width: 0, height: 12 },
        shadowOpacity: 0.35,
        shadowRadius: 24,
      },
      android: { elevation: 18 },
      default: {},
    }),
  },
  card: {
    backgroundColor: '#0A1628',
    width: '100%',
    paddingHorizontal: 32,
    paddingVertical: 40,
    borderRadius: 24.5,
    borderWidth: 1,
    borderColor: 'rgba(212, 175, 55, 0.12)',
  },
  brandLogo: {
    fontSize: 46,
    fontWeight: '800',
    letterSpacing: 4,
    color: '#F4E4BC',
    textAlign: 'center',
    marginBottom: 8,
  },
  brandAccentLine: {
    alignSelf: 'center',
    width: 56,
    height: 3,
    borderRadius: 2,
    backgroundColor: '#D4AF37',
    marginBottom: 20,
    opacity: 0.9,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#F8FAFC',
    marginBottom: 8,
    textAlign: 'center',
    letterSpacing: -0.2,
  },
  subtitle: {
    fontSize: 15,
    color: '#94A3B8',
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 22,
  },
  inputContainer: {
    backgroundColor: '#0F2744',
    borderWidth: 1.5,
    borderColor: '#1E3A5C',
    borderRadius: 14,
    height: 56,
    paddingHorizontal: 16,
    marginBottom: 18,
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputContainerFocused: {
    borderColor: '#C9A227',
    backgroundColor: '#132238',
    ...Platform.select({
      ios: {
        shadowColor: '#D4AF37',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.35,
        shadowRadius: 10,
      },
      android: { elevation: 4 },
      default: {},
    }),
  },
  inputIcon: {
    marginRight: 12,
  },
  inputField: {
    flex: 1,
    fontSize: 16,
    color: '#F1F5F9',
    paddingVertical: 0,
    fontWeight: '500',
  },
  eyeBtn: {
    paddingLeft: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  forgotWrap: {
    alignSelf: 'flex-end',
    marginTop: -2,
    marginBottom: 10,
  },
  forgot: {
    color: '#D4AF37',
    fontSize: 14,
    fontWeight: '600',
  },
  error: {
    color: '#F87171',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 12,
    textAlign: 'center',
  },
  loginBtnWrap: {
    borderRadius: 14,
    overflow: 'hidden',
    marginTop: 8,
  },
  loginBtn: {
    height: 56,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 14,
  },
  loginBtnDisabled: {
    opacity: 0.75,
  },
  loginBtnText: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0A1628',
    letterSpacing: 0.6,
  },
  googleSection: {
    marginTop: 22,
    width: '100%',
  },
  googleRedirectHint: {
    color: '#94A3B8',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    marginBottom: 12,
    paddingHorizontal: 8,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    gap: 14,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(212, 175, 55, 0.25)',
  },
  dividerText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748B',
    letterSpacing: 1.4,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 28,
    flexWrap: 'wrap',
  },
  footerMuted: {
    color: '#64748B',
    fontSize: 14,
  },
  footerLink: {
    color: '#D4AF37',
    fontSize: 14,
    fontWeight: '700',
  },
});

export default LoginScreen;
