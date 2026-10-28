module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      // NativeWind's preset supplies Worklets. Disable Expo's automatic copy so
      // each function is processed once by the SDK-aligned Worklets plugin.
      ["babel-preset-expo", {
        jsxImportSource: "nativewind",
        reanimated: false,
        worklets: false,
      }],
      "nativewind/babel",
    ],
  };
};
