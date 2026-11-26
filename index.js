// Metro runtime must initialize first. Load Router only after cleaning inbound
// web URLs: static Router imports would run before this initialization code.
require("@expo/metro-runtime");

if (typeof window !== "undefined" && window.location && window.history) {
  const { installInboundWebUrlSanitizer } = require("./lib/inboundWeb");
  installInboundWebUrlSanitizer(window);
}

require("expo-router/entry");
