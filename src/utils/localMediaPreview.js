import React from 'react';
import { Image, Platform } from 'react-native';
import { isLocalDeviceMediaUri } from './listingMedia';

/** True for camera/gallery captures — must use raw Image, not SmartImage (no CDN fallback). */
export function isLocalCaptureUri(uri) {
  if (!uri || typeof uri !== 'string') return false;
  const u = uri.trim();
  if (isLocalDeviceMediaUri(u)) return true;
  return u.startsWith('data:image/');
}

/**
 * Preview for captured CNIC/selfie URIs. Never swaps to placeholder dummy URLs.
 */
export function LocalCaptureImage({ uri, style, resizeMode = 'cover' }) {
  if (!uri) return null;
  return (
    <Image
      key={uri}
      source={{ uri }}
      style={style}
      resizeMode={resizeMode}
      accessibilityIgnoresInvertColors
      {...(Platform.OS === 'web' ? { accessibilityLabel: 'Captured photo preview' } : {})}
    />
  );
}
