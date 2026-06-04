import React, { useEffect, useState } from 'react';
import { Modal, Platform, StyleSheet, View } from 'react-native';

/**
 * Renders modals above tab bars, FABs, and nested scroll views.
 * On web, portals to document.body with maximum z-index.
 */
export default function RootOverlayModal({ visible, children, onRequestClose }) {
  if (!visible) return null;

  if (Platform.OS === 'web') {
    return (
      <WebModalPortal onRequestClose={onRequestClose}>{children}</WebModalPortal>
    );
  }

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      presentationStyle="overFullScreen"
      statusBarTranslucent={Platform.OS === 'android'}
      onRequestClose={onRequestClose}
    >
      <View style={styles.nativeRoot}>{children}</View>
    </Modal>
  );
}

function WebModalPortal({ children, onRequestClose }) {
  const [portalEl, setPortalEl] = useState(null);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    let host = document.getElementById('bidify-root-overlay-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'bidify-root-overlay-host';
      host.setAttribute('data-bidify-overlay', 'true');
      document.body.appendChild(host);
    }
    host.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;pointer-events:auto;display:flex;flex-direction:column;';
    setPortalEl(host);

    const onKeyDown = (e) => {
      if (e.key === 'Escape') onRequestClose?.();
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (host && host.childNodes.length === 0) {
        host.style.pointerEvents = 'none';
      }
    };
  }, [onRequestClose]);

  if (!portalEl) return null;

  const { createPortal } = require('react-dom');
  return createPortal(
    <View style={styles.webPortalShell} pointerEvents="box-none">
      {children}
    </View>,
    portalEl
  );
}

const styles = StyleSheet.create({
  nativeRoot: {
    flex: 1,
  },
  webPortalShell: {
    flex: 1,
    width: '100%',
    height: '100%',
    zIndex: 2147483647,
    elevation: 2147483647,
    pointerEvents: 'box-none',
    ...Platform.select({
      web: {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        flexDirection: 'column',
      },
    }),
  },
});
