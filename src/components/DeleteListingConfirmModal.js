import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, Platform, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import RootOverlayModal from './RootOverlayModal';
import WebModalButton from './WebModalButton';
import { showPlatformAlert } from '../utils/platformAlert';

const INDIGO = '#1E3A8A';
const DANGER = '#DC2626';

export const DELETE_LISTING_MESSAGE =
  'Are you sure? This action will permanently remove your listing.';

function resolveIdToDelete(explicitListingId, listingId) {
  if (explicitListingId != null && String(explicitListingId).trim() !== '') {
    return String(explicitListingId).trim();
  }
  if (listingId != null && String(listingId).trim() !== '') {
    return String(listingId).trim();
  }
  return '';
}

/** Web-only: one DOM portal — do not also use RootOverlayModal on web. */
function WebDeleteListingModalHtml({
  listingTitle,
  message,
  loading,
  onCancel,
  onConfirmDelete,
}) {
  const [host, setHost] = useState(null);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    let el = document.getElementById('bidify-delete-modal-web');
    if (!el) {
      el = document.createElement('div');
      el.id = 'bidify-delete-modal-web';
      el.setAttribute('data-bidify-delete-modal', 'true');
      document.body.appendChild(el);
    }

    el.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:flex;align-items:center;justify-content:center;padding:24px;';

    const legacy = document.getElementById('bidify-root-overlay-host');
    if (legacy) {
      legacy.innerHTML = '';
      legacy.style.pointerEvents = 'none';
      legacy.style.display = 'none';
    }

    setHost(el);

    return () => {
      el.innerHTML = '';
      el.style.pointerEvents = 'none';
      el.style.display = 'none';
      if (legacy) {
        legacy.style.display = '';
        legacy.style.pointerEvents = 'auto';
      }
    };
  }, []);

  if (!host) return null;

  const { createPortal } = require('react-dom');

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        pointerEvents: 'none',
      }}
    >
      <div
        role="presentation"
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgba(15, 23, 42, 0.55)',
          pointerEvents: 'none',
        }}
      />

      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: 'relative',
          zIndex: 9999,
          width: '100%',
          maxWidth: 400,
          backgroundColor: '#fff',
          borderRadius: 16,
          padding: 22,
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
          pointerEvents: 'auto',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 14, fontSize: 28 }}>🗑️</div>
        <div style={{ fontSize: 18, fontWeight: 800, textAlign: 'center', marginBottom: 6 }}>
          Delete listing?
        </div>
        {listingTitle ? (
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: INDIGO,
              textAlign: 'center',
              marginBottom: 8,
            }}
          >
            {listingTitle}
          </div>
        ) : null}
        <div
          style={{
            fontSize: 14,
            lineHeight: '21px',
            color: '#475569',
            textAlign: 'center',
            marginBottom: 20,
          }}
        >
          {message}
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            gap: 10,
            position: 'relative',
            zIndex: 9999,
            pointerEvents: 'auto',
          }}
        >
          <button
            type="button"
            onClick={() => onCancel()}
            style={webBtnStyle('#F1F5F9', '#475569')}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirmDelete()}
            style={webBtnStyle(DANGER, '#FFFFFF')}
          >
            {loading ? 'Deleting…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>,
    host
  );
}

function webBtnStyle(bg, color) {
  return {
    flex: 1,
    minHeight: 48,
    padding: '14px 12px',
    borderRadius: 12,
    border: 'none',
    backgroundColor: bg,
    color,
    fontWeight: 700,
    cursor: 'pointer',
    position: 'relative',
    zIndex: 9999,
    pointerEvents: 'auto',
  };
}

/**
 * Single delete confirmation modal — rendered only via GlobalDeleteListingModal.
 */
export default function DeleteListingConfirmModal({
  visible,
  listingTitle,
  listingId,
  message = DELETE_LISTING_MESSAGE,
  performDelete,
  onCancel,
  loading = false,
}) {
  const handleConfirmDelete = useCallback(
    async (explicitListingId) => {
      const idToDelete = resolveIdToDelete(explicitListingId, listingId);

      if (typeof performDelete !== 'function') {
        console.error('[DeleteListingConfirmModal] performDelete is not a function');
        showPlatformAlert('Delete error', 'performDelete handler is missing.');
        return;
      }
      if (!idToDelete) {
        console.error('[DeleteListingConfirmModal] missing listingId');
        showPlatformAlert('Delete error', 'Listing id is missing.');
        return;
      }

      console.log('Delete pipeline triggered successfully', { listingId: idToDelete });

      try {
        await performDelete(idToDelete);
        onCancel?.();
      } catch (e) {
        console.error('[DeleteListingConfirmModal] delete failed', e?.message || e);
      }
    },
    [listingId, performDelete, onCancel]
  );

  const handleCancel = useCallback(() => {
    if (loading) return;
    onCancel?.();
  }, [loading, onCancel]);

  if (!visible) return null;

  if (Platform.OS === 'web') {
    return (
      <WebDeleteListingModalHtml
        listingTitle={listingTitle}
        message={message}
        loading={loading}
        onCancel={handleCancel}
        onConfirmDelete={() => void handleConfirmDelete(listingId)}
      />
    );
  }

  return (
    <RootOverlayModal visible onRequestClose={handleCancel}>
      <View style={styles.shell} pointerEvents="box-none">
        <View style={styles.backdrop} pointerEvents="none" />
        <View style={styles.card} pointerEvents="auto">
          <View style={styles.iconWrap}>
            <Ionicons name="trash-outline" size={26} color={DANGER} />
          </View>
          <Text style={styles.title}>Delete listing?</Text>
          {listingTitle ? (
            <Text style={styles.listingTitle} numberOfLines={2}>
              {listingTitle}
            </Text>
          ) : null}
          <Text style={styles.message}>{message}</Text>

          <View style={[styles.actions, styles.confirmActionsContainer]}>
            <WebModalButton
              label="Cancel"
              variant="ghost"
              onPress={handleCancel}
              disabled={loading}
            />
            <Pressable
              style={[styles.confirmBtn, styles.confirmBtnTop, loading && styles.confirmBtnDisabled]}
              onPress={() => void handleConfirmDelete(listingId)}
              accessibilityRole="button"
              accessibilityLabel="Confirm delete listing"
            >
              {loading ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Text style={styles.confirmText}>Confirm</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </RootOverlayModal>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    zIndex: 9999,
    elevation: 9999,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    zIndex: 1,
  },
  card: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 22,
    zIndex: 9999,
    elevation: 9999,
    position: 'relative',
  },
  iconWrap: {
    alignSelf: 'center',
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#FEE2E2',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  title: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0F172A',
    textAlign: 'center',
    marginBottom: 6,
  },
  listingTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: INDIGO,
    textAlign: 'center',
    marginBottom: 8,
  },
  message: {
    fontSize: 14,
    lineHeight: 21,
    color: '#475569',
    textAlign: 'center',
    marginBottom: 20,
  },
  confirmActionsContainer: {
    zIndex: 9999,
    elevation: 9999,
    position: 'relative',
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    zIndex: 9999,
    position: 'relative',
  },
  confirmBtnTop: {
    zIndex: 9999,
    position: 'relative',
  },
  confirmBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: DANGER,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    zIndex: 9999,
    position: 'relative',
  },
  confirmBtnDisabled: { opacity: 0.7 },
  confirmText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
});
