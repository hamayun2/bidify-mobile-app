/**
 * Bidify — AuthContext.
 *
 * - Supabase: listens to `onAuthStateChange`, syncs `public.profiles` into state,
 *   and mirrors `access_token` + user JSON to AsyncStorage for axios.
 * - Legacy: AsyncStorage-only bootstrap when Supabase env is not set.
 */

import React, {
  createContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { AppState, Platform } from 'react-native';
import * as Linking from 'expo-linking';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isSupabaseConfigured, getSupabase } from '../services/supabaseClient';
import { signOutSupabase } from '../services/authService';
import { finalizePendingRegistrationIfNeeded } from '../services/registrationService';
import {
  applySupabaseAuthUrl,
  processWebAuthCallbackFromLocation,
  stashOAuthErrorForLoginScreen,
  stripAuthParamsFromBrowserUrl,
  urlLooksLikeSupabaseAuthCallback,
} from '../services/supabase/deepLinkSession';
import {
  fetchProfileById as fetchUserProfileById,
  mapProfileRowToAppUser,
  mapUsersRowToAppUser,
  updateProfile as updateUserProfileRow,
} from '../services/profileService';
import { logSupabaseError } from '../services/supabaseErrors';
import { ensureBuiltinAdminAccount } from '../services/supabase/builtinAdmin';
import { isAdminUser } from '../utils/userRole';
import { resolveCnicDigits } from '../utils/profileDisplay';
import { bridgeExpressApiSession } from '../api/expressBridge';
import { isAuxiliaryApiConfigured } from '../api/client';
import { syncUserEndedAuctionsToOrders } from '../services/auctionResolveScheduler';
import { syncVerificationStatusAPI } from '../api/kyc';
import {
  clearKycReviewLock,
  KYC_STATUS_KEY,
  KYC_STATUS_UNDER_REVIEW,
} from '../utils/kycBidLockStorage';
import {
  normalizeVerificationStatus,
  resolveEffectiveVerificationStatus,
} from '../utils/kycVerification';
import { isTerminalKycStatus } from '../utils/kycStatusSync';
import { clearKycLocalProfileSnapshot } from '../utils/kycLocalProfileCache';
import { resolvePostAuthNavigation } from '../utils/postAuthNavigation';

export const AuthContext = createContext();

const AUTH_USER_KEY = 'authUser';
const AUTH_TOKEN_KEY = 'authToken';

function normalizeUserPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const u = raw.user != null ? raw.user : raw;
  if (!u || typeof u !== 'object') return null;
  const { password, cnicFront, cnicBack, ...rest } = u;
  return Object.keys(rest).length ? rest : null;
}

/** Merge stored profile fields into the shape screens expect. */
function projectProfile(sessionUser, profile, fallback) {
  const base = sessionUser || fallback;
  if (!base?.id && !base?.uid) return null;
  const id = base.uid || base.id;
  const pick = (...vals) => {
    for (const v of vals) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'string') {
        if (v.trim() !== '') return v;
      } else {
        return v;
      }
    }
    return undefined;
  };

  const email = pick(profile?.email, base?.email, fallback?.email) || '';
  const fullName = pick(
    profile?.fullName,
    profile?.name,
    fallback?.fullName,
    fallback?.name,
    base?.fullName,
    base?.name
  );
  const username = pick(profile?.username, fallback?.username, base?.username) || '';
  const display = fullName || username || (email ? email.split('@')[0] : '') || '';
  const phone =
    pick(
      profile?.phoneNumber,
      profile?.phone,
      fallback?.phoneNumber,
      fallback?.phone,
      base?.phoneNumber,
      base?.phone
    ) || '';
  const cnic =
    resolveCnicDigits(
      profile?.cnic,
      profile?.id_card,
      profile?.cnic_number,
      fallback?.cnic,
      fallback?.id_card,
      fallback?.cnic_number,
      base?.cnic,
      base?.id_card,
      base?.cnic_number
    ) || '';
  const cnicFrontUrl = pick(profile?.cnicFrontUrl, fallback?.cnicFrontUrl, base?.cnicFrontUrl) || null;
  const cnicBackUrl = pick(profile?.cnicBackUrl, fallback?.cnicBackUrl, base?.cnicBackUrl) || null;
  const cnicVerifiedAt =
    pick(profile?.cnicVerifiedAt, fallback?.cnicVerifiedAt, base?.cnicVerifiedAt) || null;
  const profileImage = pick(profile?.profileImage, fallback?.profileImage, base?.profileImage) || '';
  const profileCompleted =
    profile?.profileCompleted === true ||
    fallback?.profileCompleted === true ||
    base?.profileCompleted === true;
  const role = pick(profile?.role, fallback?.role, base?.role) || 'user';
  const isAdmin =
    role === 'admin' ||
    profile?.isAdmin === true ||
    fallback?.isAdmin === true ||
    base?.isAdmin === true;
  const walletBalance =
    Number(
      profile?.wallet_balance ??
        profile?.walletBalance ??
        fallback?.walletBalance ??
        base?.walletBalance ??
        0
    ) || 0;
  const heldBalance =
    Number(
      profile?.held_balance ?? profile?.heldBalance ?? fallback?.heldBalance ?? base?.heldBalance ?? 0
    ) || 0;

  const emailVerified =
    profile?.emailVerified === true ||
    fallback?.emailVerified === true ||
    base?.emailVerified === true;

  const verificationStatus = resolveEffectiveVerificationStatus({
    verification_status: pick(
      profile?.verification_status,
      profile?.verificationStatus,
      fallback?.verification_status,
      fallback?.verificationStatus,
      base?.verification_status,
      base?.verificationStatus
    ),
    verification_submitted_at: pick(
      profile?.verification_submitted_at,
      profile?.verificationSubmittedAt,
      fallback?.verification_submitted_at,
      fallback?.verificationSubmittedAt,
      base?.verification_submitted_at,
      base?.verificationSubmittedAt
    ),
    cnic,
    cnic_number: pick(profile?.cnic_number, fallback?.cnic_number, base?.cnic_number),
    id_card: pick(profile?.id_card, fallback?.id_card, base?.id_card),
    cnic_front_url: pick(profile?.cnic_front_url, fallback?.cnic_front_url, base?.cnic_front_url),
    cnic_back_url: pick(profile?.cnic_back_url, fallback?.cnic_back_url, base?.cnic_back_url),
  });

  return {
    id,
    uid: id,
    email,
    name: display,
    fullName: fullName || display,
    username,
    phoneNumber: phone,
    phone,
    cnic,
    cnicFrontUrl,
    cnicBackUrl,
    cnicVerifiedAt,
    profileImage,
    profileCompleted,
    role,
    isAdmin,
    walletBalance,
    heldBalance,
    emailVerified: !!emailVerified,
    verificationStatus,
    verification_status: verificationStatus,
    fatherName: pick(profile?.fatherName, profile?.father_name, fallback?.fatherName, base?.fatherName) || '',
    father_name: pick(profile?.father_name, profile?.fatherName, fallback?.father_name, base?.father_name) || '',
    dob: pick(profile?.dob, fallback?.dob, base?.dob) || '',
    isRealFace:
      profile?.isRealFace === true ||
      profile?.is_real_face === true ||
      fallback?.isRealFace === true ||
      base?.isRealFace === true,
    verificationSubmittedAt:
      pick(
        profile?.verificationSubmittedAt,
        profile?.verification_submitted_at,
        fallback?.verificationSubmittedAt,
        base?.verificationSubmittedAt
      ) || null,
  };
}

export const AuthProvider = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingRoute, setPendingRoute] = useState(null);
  const [kycUnderReviewModalVisible, setKycUnderReviewModalVisible] = useState(false);

  const isAuthenticatedRef = useRef(isAuthenticated);
  isAuthenticatedRef.current = isAuthenticated;

  const userRef = useRef(user);
  userRef.current = user;

  const intentionalLogoutRef = useRef(false);
  const sessionLockCountRef = useRef(0);
  const queuedLogoutRef = useRef(false);

  const clearSessionStorage = useCallback(async () => {
    if (isSupabaseConfigured()) {
      try {
        console.log('[AuthContext] clearSessionStorage — Supabase signOut');
        await signOutSupabase();
      } catch (e) {
        if (__DEV__) console.warn('[AuthContext] Supabase signOut', e?.message || e);
      }
    }
    await AsyncStorage.multiRemove([AUTH_TOKEN_KEY, AUTH_USER_KEY]);
    setIsAuthenticated(false);
    setUser(null);
    intentionalLogoutRef.current = false;
  }, []);

  useEffect(() => {
    if (isSupabaseConfigured()) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const token = await AsyncStorage.getItem(AUTH_TOKEN_KEY);
        if (cancelled) return;
        if (token) {
          const cached = await AsyncStorage.getItem(AUTH_USER_KEY);
          const parsed = cached ? normalizeUserPayload(JSON.parse(cached)) : null;
          if (parsed) {
            setUser(parsed);
            setIsAuthenticated(true);
          } else {
            setIsAuthenticated(true);
          }
        }
      } catch (e) {
        if (__DEV__) console.warn('[AuthContext] cache load error', e);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured()) return undefined;
    let cancelled = false;
    void ensureBuiltinAdminAccount().then((r) => {
      if (__DEV__) console.log('[Bidify/Admin] ensureBuiltinAdmin boot result', r);
    });
    let supabase;
    try {
      if (__DEV__) console.log('[Bidify/boot] AuthContext — Supabase init');
      supabase = getSupabase();
    } catch (e) {
      logSupabaseError('AuthContext getSupabase()', e);
      setIsLoading(false);
      return undefined;
    }

    async function persistSessionUser(session) {
      if (!session?.user) {
        console.log('[AuthContext] Supabase — no session, clearing local auth cache');
        await AsyncStorage.multiRemove([AUTH_TOKEN_KEY, AUTH_USER_KEY]);
        setIsAuthenticated(false);
        setUser(null);
        return;
      }
      const token = session.access_token;
      const authUser = session.user;
      if (authUser?.email && String(authUser.email).trim() && !authUser.email_confirmed_at) {
        console.log('[AuthContext] Supabase — email not verified, signing out (login blocked until verify)');
        try {
          await supabase.auth.signOut();
        } catch (e) {
          if (__DEV__) console.warn('[AuthContext] signOut unverified', e?.message || e);
        }
        await AsyncStorage.multiRemove([AUTH_TOKEN_KEY, AUTH_USER_KEY]);
        setIsAuthenticated(false);
        setUser(null);
        return;
      }
      let profileRow = null;
      try {
        console.log('[AuthContext] Supabase — fetching user profile for', session.user.id);
        profileRow = await fetchUserProfileById(session.user.id);
        if (isAuxiliaryApiConfigured()) {
          try {
            const synced = await syncVerificationStatusAPI();
            if (synced?.verification_status) {
              profileRow = await fetchUserProfileById(session.user.id);
            }
          } catch (syncErr) {
            if (__DEV__) console.warn('[AuthContext] verification-sync on hydrate', syncErr?.message);
          }
        }
      } catch (e) {
        logSupabaseError('AuthContext.persistSessionUser.fetchUserProfileById', e);
      }
      if (!profileRow) {
        try {
          console.log('[AuthContext] persistSession — no profile row, trying finalizePendingRegistration');
          const fin = await finalizePendingRegistrationIfNeeded();
          if (fin?.appUser) {
            profileRow = await fetchUserProfileById(session.user.id);
            console.log('[AuthContext] persistSession — profile row after finalize:', !!profileRow);
          }
        } catch (e) {
          logSupabaseError('AuthContext.finalizePendingRegistrationIfNeeded', e);
        }
      }
      let appUser =
        mapUsersRowToAppUser(profileRow, session.user) || mapUsersRowToAppUser({}, session.user);

      let kycReviewLock = false;
      try {
        const stored = await AsyncStorage.getItem(KYC_STATUS_KEY);
        kycReviewLock = stored === KYC_STATUS_UNDER_REVIEW;
      } catch {
        kycReviewLock = false;
      }
      if (
        kycReviewLock &&
        normalizeVerificationStatus(appUser) !== 'verified' &&
        normalizeVerificationStatus(appUser) !== 'under_review'
      ) {
        appUser = {
          ...appUser,
          verification_status: 'under_review',
          verificationStatus: 'under_review',
        };
      }

      if (sessionLockCountRef.current > 0) {
        try {
          const cached = await AsyncStorage.getItem(AUTH_USER_KEY);
          const parsed = cached ? normalizeUserPayload(JSON.parse(cached)) : null;
          if (
            parsed?.id &&
            normalizeVerificationStatus(parsed) === 'under_review'
          ) {
            appUser = {
              ...appUser,
              ...parsed,
              verification_status: 'under_review',
              verificationStatus: 'under_review',
            };
          }
        } catch {
          /* non-fatal */
        }
      }

      let apiToken = token;
      if (isAuxiliaryApiConfigured() && appUser?.email) {
        const bridged = await bridgeExpressApiSession({
          email: appUser.email,
          fullName: appUser.fullName || appUser.name,
          supabaseUserId: session.user?.id || appUser.id,
        });
        if (bridged?.token) {
          apiToken = bridged.token;
          if (__DEV__) console.log('[AuthContext] Express API JWT bridged for wallet/Stripe');
        }
      }
      await AsyncStorage.setItem(AUTH_TOKEN_KEY, apiToken);
      await AsyncStorage.setItem(AUTH_USER_KEY, JSON.stringify(appUser));
      setIsAuthenticated(true);
      setUser(appUser);
      if (session.user?.id) {
        void syncUserEndedAuctionsToOrders(session.user.id).catch((e) => {
          if (__DEV__) console.warn('[AuthContext] auction order sync', e?.message);
        });
      }
      if (isTerminalKycStatus(resolveEffectiveVerificationStatus(appUser))) {
        clearKycReviewLock().catch(() => {});
        clearKycLocalProfileSnapshot().catch(() => {});
      }
      const postAuthNav = resolvePostAuthNavigation(appUser, profileRow);
      if (postAuthNav?.name === 'AdminPanel') {
        setPendingRoute('AdminPanel');
        if (__DEV__) console.log('[AuthContext] Admin session — will open AdminPanel');
      } else if (postAuthNav?.name === 'KycScan') {
        setPendingRoute(postAuthNav);
        if (__DEV__) console.log('[AuthContext] Post-auth — KYC onboarding (KycScan)');
      }
      console.log('[AuthContext] Supabase — session hydrated for', appUser?.email);
    }

    let bootFinished = false;
    const finishBoot = () => {
      if (bootFinished || cancelled) return;
      bootFinished = true;
      setIsLoading(false);
    };

    const bootSafetyTimer = setTimeout(() => {
      if (__DEV__) console.warn('[AuthContext] auth boot safety timeout — ending splash');
      finishBoot();
    }, 8000);

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (cancelled) return;
      setTimeout(() => {
        void (async () => {
          console.log('[AuthContext] Supabase auth event:', event, session?.user?.id || '(no user)');
          try {
            if (event === 'INITIAL_SESSION') {
              if (session) {
                await persistSessionUser(session);
              } else {
                const token = await AsyncStorage.getItem(AUTH_TOKEN_KEY);
                if (token) {
                  const cached = await AsyncStorage.getItem(AUTH_USER_KEY);
                  const parsed = cached ? normalizeUserPayload(JSON.parse(cached)) : null;
                  if (parsed) {
                    setUser(parsed);
                    setIsAuthenticated(true);
                  }
                }
              }
              finishBoot();
              return;
            }
            if (event === 'SIGNED_OUT' || !session) {
              if (sessionLockCountRef.current > 0) {
                if (intentionalLogoutRef.current) queuedLogoutRef.current = true;
                return;
              }
              await AsyncStorage.multiRemove([AUTH_TOKEN_KEY, AUTH_USER_KEY]);
              setIsAuthenticated(false);
              setUser(null);
              intentionalLogoutRef.current = false;
              return;
            }
            await persistSessionUser(session);
          } catch (e) {
            logSupabaseError('AuthContext onAuthStateChange', e);
          }
        })();
      }, 0);
    });

    const handleIncomingUrl = (url) => {
      if (!url || !urlLooksLikeSupabaseAuthCallback(url)) return;
      console.log('[AuthContext] auth callback URL detected, applying tokens / code');
      void (async () => {
        try {
          await applySupabaseAuthUrl(supabase, url);
        } catch (e) {
          logSupabaseError('AuthContext incoming auth URL', e);
        }
      })();
    };

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      void (async () => {
        try {
          const handled = await processWebAuthCallbackFromLocation(supabase);
          if (handled && !cancelled) {
            const {
              data: { session },
            } = await supabase.auth.getSession();
            if (session?.user) await persistSessionUser(session);
          }
        } catch (e) {
          logSupabaseError('AuthContext web OAuth callback on boot', e);
          stashOAuthErrorForLoginScreen(e?.message || 'Google sign-in failed');
          stripAuthParamsFromBrowserUrl();
        }
      })();
    }

    void Linking.getInitialURL().then((url) => {
      if (cancelled || !url) return;
      handleIncomingUrl(url);
    });

    const urlSub = Linking.addEventListener('url', ({ url }) => handleIncomingUrl(url));

    const appSub = AppState.addEventListener('change', (next) => {
      if (cancelled || next !== 'active' || !isAuthenticatedRef.current) return;
      void (async () => {
        try {
          await new Promise((r) => setTimeout(r, 350));
          if (cancelled) return;
          const {
            data: { session },
            error,
          } = await supabase.auth.getSession();
          if (cancelled || error) return;
          if (session?.user) {
            console.log('[AuthContext] AppState active — refreshing session + profile');
            await persistSessionUser(session);
          }
        } catch (e) {
          logSupabaseError('AuthContext AppState active getSession', e);
        }
      })();
    });

    void (async () => {
      try {
        const {
          data: { session },
          error: sessionErr,
        } = await supabase.auth.getSession();
        if (sessionErr) {
          logSupabaseError('AuthContext boot auth.getSession', sessionErr);
        }
        if (cancelled) return;
        if (session) {
          await persistSessionUser(session);
          finishBoot();
        }
      } catch (e) {
        logSupabaseError('AuthContext Supabase boot', e);
        finishBoot();
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(bootSafetyTimer);
      subscription?.unsubscribe();
      urlSub.remove();
      appSub.remove();
    };
  }, []);

  const consumePendingRoute = useCallback(() => {
    const r = pendingRoute;
    if (r) setPendingRoute(null);
    return r;
  }, [pendingRoute]);

  const queuePendingRoute = useCallback((route, params) => {
    if (!route) return;
    if (typeof route === 'object' && route?.name) {
      setPendingRoute(route);
      return;
    }
    if (params != null) {
      setPendingRoute({ name: route, params });
      return;
    }
    setPendingRoute(route);
  }, []);

  const login = useCallback(async (token, userData, options = {}) => {
    try {
      const safe = normalizeUserPayload(userData);
      let apiToken = token;
      if (isSupabaseConfigured() && isAuxiliaryApiConfigured() && safe?.email) {
        const bridged = await bridgeExpressApiSession({
          email: safe.email,
          fullName: safe.fullName || safe.name,
          supabaseUserId: safe.id || userData?.id,
        });
        if (bridged?.token) {
          apiToken = bridged.token;
          if (__DEV__) console.log('[AuthContext] login() — Express JWT bridged for wallet/Stripe');
        } else if (__DEV__) {
          console.warn('[AuthContext] login() — bridge-login returned no token (wallet API may 401)');
        }
      }
      let finalUser = safe;
      if (finalUser && options?.kycSubmitComplete) {
        finalUser = {
          ...finalUser,
          verification_status: 'under_review',
          verificationStatus: 'under_review',
        };
      }
      if (finalUser) {
        try {
          const stored = await AsyncStorage.getItem(KYC_STATUS_KEY);
          if (
            stored === KYC_STATUS_UNDER_REVIEW &&
            normalizeVerificationStatus(finalUser) === 'unverified'
          ) {
            finalUser = {
              ...finalUser,
              verification_status: 'under_review',
              verificationStatus: 'under_review',
            };
          }
        } catch {
          /* non-fatal */
        }
      }
      if (apiToken) await AsyncStorage.setItem(AUTH_TOKEN_KEY, apiToken);
      if (finalUser) await AsyncStorage.setItem(AUTH_USER_KEY, JSON.stringify(finalUser));
      if (options?.initialRoute) {
        if (options.initialRouteParams) {
          setPendingRoute({ name: options.initialRoute, params: options.initialRouteParams });
        } else {
          setPendingRoute(options.initialRoute);
        }
      }
      if (options?.showKycUnderReviewModal) setKycUnderReviewModalVisible(true);
      intentionalLogoutRef.current = false;
      setIsAuthenticated(true);
      if (finalUser) {
        setUser(finalUser);
        userRef.current = finalUser;
        if (__DEV__) console.log('[AuthContext] Current User:', finalUser);
      }
      isAuthenticatedRef.current = true;

      await new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => setTimeout(resolve, 0));
        } else {
          setTimeout(resolve, 0);
        }
      });

      if (isSupabaseConfigured()) {
        console.log('[AuthContext] login() — persisted; session ready for RootNavigator');
      }

      return { user: finalUser, token: apiToken };
    } catch (e) {
      if (__DEV__) console.error('[AuthContext] login persist error', e);
      throw e;
    }
  }, []);

  const waitForAuthState = useCallback((predicate, maxMs = 12000) => {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        const snap = {
          isAuthenticated: isAuthenticatedRef.current,
          user: userRef.current,
        };
        try {
          if (predicate(snap)) {
            resolve(snap);
            return;
          }
        } catch (e) {
          reject(e);
          return;
        }
        if (Date.now() - started >= maxMs) {
          reject(new Error('Timed out waiting for auth state to hydrate.'));
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }, []);

  const logout = useCallback(async (options = {}) => {
    const force = options?.force === true;
    intentionalLogoutRef.current = true;
    if (!force && sessionLockCountRef.current > 0) {
      queuedLogoutRef.current = true;
      return;
    }
    queuedLogoutRef.current = false;
    try {
      await clearSessionStorage();
    } catch (e) {
      if (__DEV__) console.error('[AuthContext] logout error', e);
    }
  }, [clearSessionStorage]);

  const refreshProfile = useCallback(async () => {
    if (isSupabaseConfigured()) {
      try {
        const supabase = getSupabase();
        const {
          data: { session },
          error: sessionErr,
        } = await supabase.auth.getSession();
        if (sessionErr) {
          logSupabaseError('AuthContext.refreshProfile auth.getSession', sessionErr);
        }
        if (!session?.user) return null;
        console.log('[AuthContext] refreshProfile — Supabase refetch');
        let row = await fetchUserProfileById(session.user.id);
        if (isAuxiliaryApiConfigured()) {
          try {
            const synced = await syncVerificationStatusAPI();
            if (synced?.verification_status) {
              row = await fetchUserProfileById(session.user.id);
            }
          } catch (syncErr) {
            if (__DEV__) console.warn('[AuthContext] verification-sync', syncErr?.message);
          }
        }
        const next = mapUsersRowToAppUser(row, session.user);
        if (next) {
          await AsyncStorage.setItem(AUTH_USER_KEY, JSON.stringify(next));
          setUser(next);
          if (isTerminalKycStatus(resolveEffectiveVerificationStatus(next))) {
            clearKycReviewLock().catch(() => {});
            clearKycLocalProfileSnapshot().catch(() => {});
          }
        }
        return next;
      } catch (e) {
        logSupabaseError('AuthContext.refreshProfile Supabase', e);
        return null;
      }
    }
    try {
      const cached = await AsyncStorage.getItem(AUTH_USER_KEY);
      if (!cached) return null;
      const parsed = normalizeUserPayload(JSON.parse(cached));
      if (parsed) {
        setUser((prev) => projectProfile(parsed, parsed, prev));
        return parsed;
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }, []);

  const updateProfile = useCallback(async (partial) => {
    if (isSupabaseConfigured()) {
      try {
        const supabase = getSupabase();
        const {
          data: { session },
          error: sessionErr,
        } = await supabase.auth.getSession();
        if (sessionErr) {
          logSupabaseError('AuthContext.updateProfile auth.getSession', sessionErr);
        }
        if (!session?.user) throw new Error('You are not signed in.');
        console.log('[AuthContext] updateProfile — Supabase patch', Object.keys(partial || {}));
        const row = await updateUserProfileRow(session.user.id, partial);
        const next = row
          ? mapUsersRowToAppUser(row, session.user)
          : { ...partial };
        setUser((prev) => {
          if (!prev) return projectProfile(session.user, next, next);
          const merged = projectProfile(session.user, next, { ...prev, ...partial });
          AsyncStorage.setItem(AUTH_USER_KEY, JSON.stringify(merged)).catch(() => {});
          return merged;
        });
        return;
      } catch (e) {
        logSupabaseError('AuthContext.updateProfile', e);
        throw e;
      }
    }
    setUser((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...partial };
      AsyncStorage.setItem(AUTH_USER_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  /** Keep KYC status in sync app-wide while under_review (5-min Mock NADRA window). */
  useEffect(() => {
    if (!isAuthenticated || !user) return undefined;
    const effective = resolveEffectiveVerificationStatus(user);
    const dbStatus = normalizeVerificationStatus(user);
    const needsServerSync =
      dbStatus === 'under_review' ||
      (dbStatus === 'unverified' &&
        !!(user?.cnic || user?.verification_submitted_at || user?.verificationSubmittedAt));
    if (effective === 'verified' || effective === 'rejected') return undefined;
    if (!needsServerSync && effective !== 'under_review') return undefined;
    if (!isAuxiliaryApiConfigured()) return undefined;

    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void refreshProfile();
    });
    const intervalId = setInterval(() => void refreshProfile(), 15000);

    return () => {
      sub.remove();
      clearInterval(intervalId);
    };
  }, [
    isAuthenticated,
    user?.id,
    user?.verification_status,
    user?.verificationSubmittedAt,
    user?.verification_submitted_at,
    refreshProfile,
  ]);

  const lockSession = useCallback(() => {
    sessionLockCountRef.current += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      sessionLockCountRef.current = Math.max(0, sessionLockCountRef.current - 1);
      if (sessionLockCountRef.current === 0 && queuedLogoutRef.current) {
        queuedLogoutRef.current = false;
        setTimeout(() => {
          clearSessionStorage().catch(() => {});
        }, 0);
      }
    };
  }, [clearSessionStorage]);

  const value = useMemo(
    () => ({
      isAuthenticated,
      user,
      isLoading,
      login,
      logout,
      consumePendingRoute,
      queuePendingRoute,
      refreshProfile,
      updateProfile,
      lockSession,
      waitForAuthState,
      kycUnderReviewModalVisible,
      showKycUnderReviewModal: () => setKycUnderReviewModalVisible(true),
      dismissKycUnderReviewModal: () => setKycUnderReviewModalVisible(false),
    }),
    [
      isAuthenticated,
      user,
      isLoading,
      login,
      logout,
      consumePendingRoute,
      queuePendingRoute,
      refreshProfile,
      updateProfile,
      lockSession,
      waitForAuthState,
      kycUnderReviewModalVisible,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
