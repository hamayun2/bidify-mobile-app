import 'react-native-url-polyfill/auto';
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from './src/navigation/RootNavigator';
import { AuthProvider } from './src/context/AuthContext';
import { WalletProvider } from './src/context/WalletContext';
import { ListingsSyncProvider } from './src/context/ListingsSyncContext';
import { ChatbotPanelProvider } from './src/context/ChatbotPanelContext';
import { ToastProvider } from './src/components/InAppToast';
import { NotificationsProvider } from './src/context/NotificationsContext';
import { ChatUnreadProvider } from './src/context/ChatUnreadContext';
import GlobalDeleteListingModal from './src/components/GlobalDeleteListingModal';
import StripeAppProvider from './src/providers/StripeAppProvider';
import { logSupabaseConnectivity } from './src/services/apiService';

if (__DEV__) {
  console.log('[Bidify/boot] App.js module loaded');
  try {
    logSupabaseConnectivity();
  } catch (e) {
    console.warn('[Bidify/boot] Supabase connectivity check failed', e?.message);
  }
}

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[Bidify/boot] UI render error:', error?.message || error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      const msg = String(this.state.error?.message ?? this.state.error);
      return (
        <View style={errStyles.outer}>
          <Text style={errStyles.title}>Bidify could not start</Text>
          <Text style={errStyles.body}>{msg}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const errStyles = StyleSheet.create({
  outer: { flex: 1, padding: 24, justifyContent: 'center', backgroundColor: '#FFFFFF' },
  title: { fontSize: 18, fontWeight: '700', marginBottom: 8, color: '#111' },
  body: { fontSize: 14, color: '#444' },
});

export default function App() {
  if (__DEV__) console.log('[Bidify/boot] App() render');
  return (
    <AppErrorBoundary>
      <SafeAreaProvider>
        <StripeAppProvider>
          <AuthProvider>
            <ToastProvider>
              <NotificationsProvider>
                <ChatUnreadProvider>
                  <WalletProvider>
                    <ListingsSyncProvider>
                      <ChatbotPanelProvider>
                        <RootNavigator />
                      </ChatbotPanelProvider>
                      <GlobalDeleteListingModal />
                    </ListingsSyncProvider>
                  </WalletProvider>
                </ChatUnreadProvider>
              </NotificationsProvider>
            </ToastProvider>
          </AuthProvider>
        </StripeAppProvider>
      </SafeAreaProvider>
    </AppErrorBoundary>
  );
}
