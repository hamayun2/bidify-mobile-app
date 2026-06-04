import React, { useEffect, useState } from 'react';
import { Image, View, StyleSheet, Platform } from 'react-native';
import { resolveMediaUrl } from '../utils/listingMedia';

/**
 * SmartImage — NUCLEAR REWRITE.
 *
 * Design contract (no fancy state machines):
 *   1. We start with an immediately-usable URI:
 *        - the caller's `uri` if it resolves to something usable;
 *        - otherwise FALLBACK_URL right away (no spinner, no empty box).
 *   2. On `onError` we swap the source to FALLBACK_URL exactly ONCE and stop.
 *   3. There is NO loading spinner. The OS draws nothing until the bytes arrive,
 *      which means the UI can never be "stuck on a spinner" — the worst case is
 *      that the FALLBACK_URL renders. That is intentional.
 *
 * NOTE on remote URLs:
 *   On native `<Image>`, HTTPS URLs typically load without browser CORS.
 *   On web (Expo), public CDN URLs should include appropriate CORS headers.
 */

// Hard fallback. Tiny, always-CDN-served, no auth, no edge cases.
export const FALLBACK_URL =
  'https://dummyimage.com/300x300/cccccc/000000.png&text=No+Image';

function pickInitialUri(rawUri) {
  const resolved = resolveMediaUrl(rawUri);
  if (resolved && typeof resolved === 'string' && resolved.trim()) {
    return resolved;
  }
  return FALLBACK_URL;
}

export default function SmartImage({
  uri,
  style,
  resizeMode = 'cover',
  imageProps,
  // accepted but ignored (kept for callsite compatibility):
  recycleKey,
  showLoader,
  placeholder,
  onLoad,
  onError,
  onFinalError,
}) {
  const initial = pickInitialUri(uri);
  const [currentUri, setCurrentUri] = useState(initial);
  const [didFallback, setDidFallback] = useState(initial === FALLBACK_URL);

  useEffect(() => {
    const next = pickInitialUri(uri);
    setCurrentUri(next);
    setDidFallback(next === FALLBACK_URL);
  }, [uri]);

  const handleError = (e) => {
    if (typeof onError === 'function') onError(e);
    if (didFallback) {
      if (typeof onFinalError === 'function') onFinalError();
      return;
    }
    setDidFallback(true);
    setCurrentUri(FALLBACK_URL);
    if (typeof onFinalError === 'function') onFinalError();
  };

  return (
    <View style={[styles.wrap, style]}>
      <Image
        // The `key` is bound to the URI itself, so when we swap to FALLBACK_URL
        // RN tears down and re-mounts the <Image> — guarantees the new source
        // actually starts a fresh decode instead of keeping the stale request.
        key={currentUri}
        source={{ uri: currentUri }}
        style={StyleSheet.absoluteFill}
        resizeMode={resizeMode}
        resizeMethod={Platform.OS === 'android' ? 'resize' : 'auto'}
        progressiveRenderingEnabled
        fadeDuration={0}
        onLoad={(e) => {
          if (typeof onLoad === 'function') onLoad(e);
        }}
        onError={handleError}
        {...imageProps}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    overflow: 'hidden',
    backgroundColor: '#f1f1f1',
  },
});
