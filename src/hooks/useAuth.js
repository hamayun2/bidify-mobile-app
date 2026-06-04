import { useContext, useMemo } from 'react';
import { AuthContext } from '../context/AuthContext';

/**
 * UI hook for auth state — wraps AuthContext (session, login, logout, profile refresh).
 */
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return useMemo(
    () => ({
      user: ctx.user,
      isAuthenticated: ctx.isAuthenticated,
      isLoading: ctx.isLoading,
      login: ctx.login,
      logout: ctx.logout,
      refreshProfile: ctx.refreshProfile,
      updateProfile: ctx.updateProfile,
      consumePendingRoute: ctx.consumePendingRoute,
      pendingRoute: ctx.pendingRoute,
    }),
    [
      ctx.user,
      ctx.isAuthenticated,
      ctx.isLoading,
      ctx.login,
      ctx.logout,
      ctx.refreshProfile,
      ctx.updateProfile,
      ctx.consumePendingRoute,
      ctx.pendingRoute,
    ]
  );
}

export default useAuth;
