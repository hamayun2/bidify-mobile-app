import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import SmartImage from './SmartImage';
import { resolveMediaUrl } from '../utils/listingMedia';

/**
 * Heuristic — local `file://` URIs from `expo-image-picker` are perfectly valid
 * during the session that created them, but can become stale after an app
 * reinstall / OS cache wipe. We can't synchronously check for existence here,
 * but we CAN at least reject obviously bogus values so the avatar shows the
 * initial letter instead of an empty circle.
 */
function looksLikeUsableUri(uri) {
  if (uri == null) return false;
  if (typeof uri !== 'string') return false;
  const t = uri.trim();
  if (!t) return false;
  if (t === 'null' || t === 'undefined') return false;
  return true;
}

/**
 * AvatarImage — circular avatar with bulletproof fallback to the user's
 * initial letter when the image is missing, stale, or fails to load.
 *
 * Why this exists:
 *   Bare `<Image source={{ uri }} />` for a profile picture is dangerous.
 *   When the URI is stale (e.g. a `file://` path from a previous app install)
 *   React Native silently shows nothing — the user sees an empty circle or a
 *   forever-loading spinner depending on the parent. AvatarImage guarantees a
 *   visible result: real image if it loads, otherwise the initial letter.
 *
 * Props:
 *   uri:        string | null     — image URI (file://, http(s)://, data:, blob:)
 *   size:       number            — diameter in pixels (defaults 64)
 *   name:       string            — used to compute the fallback letter
 *   email:      string            — used as a secondary source for the letter
 *   style:      ViewStyle         — additional wrapper styles
 *   textStyle:  TextStyle         — overrides for the initial-letter text
 *   onPress:    not handled here — wrap with a TouchableOpacity if you need it
 */
export default function AvatarImage({
  uri,
  size = 64,
  name,
  email,
  style,
  textStyle,
}) {
  const initialLetter = useMemo(() => {
    const src = (name || email || 'U').toString().trim();
    return src.charAt(0).toUpperCase() || 'U';
  }, [name, email]);

  // We render the letter immediately whenever the URI is unusable, so the
  // user is never staring at a blank circle. If the URI looks fine, we try
  // to load — and if SmartImage reports `onFinalError` we flip back to letter.
  const safeUri = looksLikeUsableUri(uri) ? uri : null;
  const [renderFailed, setRenderFailed] = useState(false);

  // Reset failure state whenever the URI changes — the user might have picked
  // a new picture, which should be re-attempted.
  useEffect(() => {
    setRenderFailed(false);
  }, [safeUri]);

  const wrapperStyle = [
    styles.wrap,
    { width: size, height: size, borderRadius: size / 2 },
    style,
  ];

  if (!safeUri || renderFailed) {
    return (
      <View style={wrapperStyle}>
        <Text
          style={[
            styles.letter,
            { fontSize: Math.max(14, Math.round(size * 0.4)) },
            textStyle,
          ]}
        >
          {initialLetter}
        </Text>
      </View>
    );
  }

  return (
    <View style={wrapperStyle}>
      <SmartImage
        uri={safeUri}
        style={[styles.image, { borderRadius: size / 2 }]}
        resizeMode="cover"
        // We don't want a spinner overlay on the avatar — the letter is the
        // instant fallback and a spinner over a 44px circle looks busy.
        showLoader={false}
        onFinalError={() => setRenderFailed(true)}
        placeholder={
          <Text
            style={[
              styles.letter,
              { fontSize: Math.max(14, Math.round(size * 0.4)) },
              textStyle,
            ]}
          >
            {initialLetter}
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: '#ECECEC',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    // Android: ensure overflow clipping doesn't flicker on first paint.
    ...Platform.select({ android: { borderWidth: 0 } }),
  },
  image: {
    width: '100%',
    height: '100%',
    backgroundColor: '#ECECEC',
  },
  letter: {
    color: '#111',
    fontWeight: '800',
    letterSpacing: 0.2,
  },
});
