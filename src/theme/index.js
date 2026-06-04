/**
 * Global design tokens for the Bidify minimalist refresh.
 * Pure styling — no behavior, no side-effects.
 */

export const colors = {
  bg: '#FFFFFF',
  bgMuted: '#F7F7F8',
  surface: '#F2F2F4',
  surfaceAlt: '#F5F5F7',
  border: '#E5E5EA',
  borderStrong: '#D1D1D6',
  text: '#111111',
  textMuted: '#6B7280',
  textFaint: '#9CA3AF',
  primary: '#111111',
  primaryText: '#FFFFFF',
  accent: '#111111',
  success: '#16A34A',
  successSoft: '#DCFCE7',
  successSoftBorder: '#BBF7D0',
  danger: '#DC2626',
  warning: '#B45309',
  info: '#1D4ED8',
  white: '#FFFFFF',
  black: '#000000',
  chipBg: '#F2F2F4',
  chipText: '#111111',
  chipActiveBg: '#111111',
  chipActiveText: '#FFFFFF',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 14,
  xl: 18,
  pill: 999,
};

export const typography = {
  display: { fontSize: 28, fontWeight: '800', color: colors.text, letterSpacing: -0.4 },
  title: { fontSize: 22, fontWeight: '800', color: colors.text, letterSpacing: -0.3 },
  h2: { fontSize: 18, fontWeight: '700', color: colors.text },
  h3: { fontSize: 16, fontWeight: '700', color: colors.text },
  body: { fontSize: 14, color: colors.text },
  bodyMuted: { fontSize: 14, color: colors.textMuted },
  small: { fontSize: 12, color: colors.textMuted },
  label: { fontSize: 13, fontWeight: '600', color: colors.text },
};

export const shadows = {
  card: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 1,
  },
};
