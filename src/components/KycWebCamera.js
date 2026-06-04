import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Platform } from 'react-native';

const INDIGO = '#1E3A8A';

/**
 * Live browser webcam inside a circular viewport (getUserMedia / WebRTC).
 * Web-only — returns null on native.
 */
export default function KycWebCamera({
  size = 280,
  active = true,
  onReady,
  onError,
  videoRef: externalVideoRef,
}) {
  const containerRef = useRef(null);
  const internalVideoRef = useRef(null);
  const streamRef = useRef(null);
  const [status, setStatus] = useState('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const videoRef = externalVideoRef || internalVideoRef;

  const stopStream = () => {
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    const el = videoRef.current;
    if (el) el.srcObject = null;
  };

  const startStream = async () => {
    if (Platform.OS !== 'web' || !active) return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      const msg = 'Webcam is not supported in this browser.';
      setErrorMsg(msg);
      setStatus('error');
      onError?.(new Error(msg));
      return;
    }

    setStatus('loading');
    setErrorMsg('');
    stopStream();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 640 },
        },
        audio: false,
      });
      streamRef.current = stream;
      const el = videoRef.current;
      if (el) {
        el.srcObject = stream;
        await el.play?.();
      }
      setStatus('live');
      onReady?.();
    } catch (e) {
      const msg = e?.message || 'Could not access webcam. Allow camera permission in the browser.';
      setErrorMsg(msg);
      setStatus('error');
      onError?.(e);
    }
  };

  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    if (active) {
      startStream();
    } else {
      stopStream();
      setStatus('idle');
    }
    return () => stopStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  if (Platform.OS !== 'web') return null;

  const radius = size / 2;

  if (status === 'error') {
    return (
      <View style={[styles.box, { width: size, height: size, borderRadius: radius }]}>
        <Text style={styles.errorText}>{errorMsg}</Text>
        <Pressable style={styles.retryBtn} onPress={startStream}>
          <Text style={styles.retryText}>Allow Webcam</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View
      ref={containerRef}
      style={[styles.ring, { width: size, height: size, borderRadius: radius }]}
    >
      {status === 'loading' ? (
        <View style={styles.loadingOverlay}>
          <Text style={styles.loadingText}>Starting webcam…</Text>
        </View>
      ) : null}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          width: size,
          height: size,
          objectFit: 'cover',
          borderRadius: radius,
          transform: 'scaleX(-1)',
          backgroundColor: '#0F172A',
        }}
      />
    </View>
  );
}

/** Capture current video frame to a JPEG data URL (web only). */
export function captureWebVideoFrame(videoEl, quality = 0.88) {
  if (!videoEl || typeof document === 'undefined') return null;
  const w = videoEl.videoWidth || 640;
  const h = videoEl.videoHeight || 640;
  if (!w || !h) return null;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, w, h);

  try {
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    return null;
  }
}

const styles = StyleSheet.create({
  ring: {
    overflow: 'hidden',
    backgroundColor: '#0F172A',
  },
  box: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    backgroundColor: '#FFFFFF',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    zIndex: 2,
  },
  loadingText: { color: '#E2E8F0', fontSize: 13, fontWeight: '600' },
  errorText: {
    textAlign: 'center',
    color: '#64748B',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 10,
    paddingHorizontal: 8,
  },
  retryBtn: {
    borderWidth: 1,
    borderColor: INDIGO,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  retryText: { color: INDIGO, fontWeight: '700', fontSize: 13 },
});
