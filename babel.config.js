/** Expo / Metro — required for `EXPO_PUBLIC_*` env inlining and correct RN transforms. */
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
