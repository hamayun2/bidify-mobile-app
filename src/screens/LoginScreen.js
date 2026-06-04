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
        colors={['#0F172A', '#020617']}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
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
            <View style={styles.card}>
              <Text style={styles.brandLogo}>Bidify</Text>
              <Text style={styles.title}>Welcome back</Text>
              <Text style={styles.subtitle}>Sign in to continue bidding on unique treasures.</Text>

            <View style={styles.inputContainer}>
              <Ionicons name="mail-outline" size={20} color="#94A3B8" style={styles.inputIcon} />
              <TextInput
                style={styles.inputField}
                placeholder="you@example.com"
                placeholderTextColor="#94A3B8"
                keyboardType="email-address"
                autoCapitalize="none"
                value={email}
                onChangeText={setEmail}
              />
            </View>

            <View style={styles.inputContainer}>
              <Ionicons
                name="lock-closed-outline"
                size={20}
                color="#94A3B8"
                style={styles.inputIcon}
              />
              <TextInput
                style={styles.inputField}
                placeholder="Enter your password"
                placeholderTextColor="#94A3B8"
                secureTextEntry={passwordHidden}
                value={password}
                onChangeText={setPassword}
              />
              <TouchableOpacity
                onPress={() => setPasswordHidden((h) => !h)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={styles.eyeBtn}
              >
                <Ionicons
                  name={passwordHidden ? 'eye-off-outline' : 'eye-outline'}
                  size={20}
                  color="#94A3B8"
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
              style={[styles.loginBtn, authBusy && styles.loginBtnDisabled]}
              onPress={handleLogin}
              disabled={authBusy}
              activeOpacity={0.88}
            >
              {loading ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.loginBtnText}>Login</Text>
              )}
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
          </ScrollView>
        </KeyboardAvoidingView>
      </LinearGradient>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0B1120',
  },
  gradient: {
    flex: 1,
  },
  flex: { flex: 1 },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 16,
  },
  card: {
    backgroundColor: '#FFFFFF',
    width: '90%',
    maxWidth: 420,
    paddingHorizontal: 32,
    paddingVertical: 40,
    borderRadius: 24,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 15 },
        shadowOpacity: 0.25,
        shadowRadius: 35,
      },
      android: { elevation: 20 },
      default: {},
    }),
  },
  brandLogo: {
    fontSize: 44,
    fontWeight: '900',
    letterSpacing: 2,
    color: '#1E3A8A',
    textAlign: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: 8,
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 15,
    color: '#64748B',
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 22,
  },
  inputContainer: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1.5,
    borderColor: '#E2E8F0',
    borderRadius: 16,
    height: 56,
    paddingHorizontal: 16,
    marginBottom: 20,
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputIcon: {
    marginRight: 12,
  },
  inputField: {
    flex: 1,
    fontSize: 16,
    color: '#0F172A',
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
    marginTop: -4,
    marginBottom: 8,
  },
  forgot: {
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '600',
  },
  error: {
    color: '#DC2626',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 12,
    textAlign: 'center',
  },
  loginBtn: {
    backgroundColor: '#0F172A',
    borderRadius: 16,
    height: 56,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 10,
  },
  loginBtnDisabled: {
    opacity: 0.75,
  },
  loginBtnText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  googleSection: {
    marginTop: 20,
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
    backgroundColor: '#E2E8F0',
  },
  dividerText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#94A3B8',
    letterSpacing: 1.2,
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
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '700',
  },
});

export default LoginScreen;
