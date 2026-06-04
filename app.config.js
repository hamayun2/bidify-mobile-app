/**
 * Expo config — merges app.json and injects Google Sign-In plugin from env (no hardcoded client IDs).
 */
const appJson = require('./app.json');

const iosUrlScheme = String(process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME || '').trim();

const plugins = [...(appJson.expo.plugins || [])];

if (iosUrlScheme) {
  const googlePlugin = [
    '@react-native-google-signin/google-signin',
    { iosUrlScheme },
  ];
  const hasGoogle = plugins.some(
    (p) => Array.isArray(p) && p[0] === '@react-native-google-signin/google-signin'
  );
  if (!hasGoogle) plugins.push(googlePlugin);
}

module.exports = {
  expo: {
    ...appJson.expo,
    plugins,
  },
};
