// Expo config plugin: survive `expo prebuild`. Expo CNG regenerates android/
// from scratch on every prebuild, so anything hand-added there is dropped and JS
// then throws "undefined is not a function" on a bridge call. This plugin keeps
// the native integration OUTSIDE android/ and re-applies it every prebuild:
//   - copy native/logosdelivery/arm64-v8a/*.so -> app/src/main/jniLibs/arm64-v8a/
//     (libc++_shared.so, librln.so, liblogosdelivery.so, liblogosjni.so)
//   - copy native/logosdelivery/android/java/**.kt -> app/src/main/java/**
//     (the LogosMessaging RN module + package; the @ReactMethod channel methods
//      MUST live in this copied template, not the generated android/ copy)
//   - register the package by hand (not autolinkable): withMainApplication add()
//   - gson dep for config serialization; expo.useLegacyPackaging=true so the .so
//     is an uncompressed real file System.loadLibrary can open.
//
// This is a SCAFFOLD: the four prebuilt arm64 .so files and the JNI shim / Kotlin
// bridge (logos_messaging_ffi.c + LogosMessagingModule.kt) are supplied by the
// Logos delivery build - see native/logosdelivery/README.md. Mirrors KYM's
// mobile/plugins/withLogosDelivery.js.
const { withDangerousMod, withMainApplication, withAppBuildGradle, withGradleProperties } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const LIBS = ["libc++_shared.so", "librln.so", "liblogosdelivery.so", "liblogos_messaging_jni.so"];

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

const withCopyNative = (config) =>
  withDangerousMod(config, ["android", (cfg) => {
    const root = cfg.modRequest.projectRoot;
    const nativeRoot = path.join(root, "native", "logosdelivery");
    const androidMain = path.join(cfg.modRequest.platformProjectRoot, "app", "src", "main");
    // .so
    const jniDst = path.join(androidMain, "jniLibs", "arm64-v8a");
    fs.mkdirSync(jniDst, { recursive: true });
    for (const so of LIBS) {
      const s = path.join(nativeRoot, "arm64-v8a", so);
      if (!fs.existsSync(s)) throw new Error(`withLogosDelivery: missing native lib ${s}`);
      fs.copyFileSync(s, path.join(jniDst, so));
    }
    // Kotlin bridge (incl. the channel @ReactMethods)
    copyDir(path.join(nativeRoot, "android", "java"), path.join(androidMain, "java"));
    return cfg;
  }]);

const withPackageRegistration = (config) =>
  withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes("com.receiverandroid.LogosMessagingPackage")) return cfg;
    const ADD = `apply {\n            // Native Logos Delivery (embedded Waku node) - manual JNI, not autolinkable.\n            add(com.receiverandroid.LogosMessagingPackage())\n          }`;
    // Two known template shapes: `.packages.apply { ... }` (newer) and a bare
    // `return PackageList(this).packages` (expo 51 / RN 0.74).
    if (/PackageList\(this\)\.packages\.apply\s*\{/.test(src)) {
      src = src.replace(
        /(PackageList\(this\)\.packages\.apply\s*\{)/,
        `$1\n            add(com.receiverandroid.LogosMessagingPackage())`
      );
    } else if (/return\s+PackageList\(this\)\.packages\b(?!\.)/.test(src)) {
      src = src.replace(
        /return\s+PackageList\(this\)\.packages\b(?!\.)/,
        `return PackageList(this).packages.${ADD}`
      );
    } else {
      throw new Error("withLogosDelivery: could not find PackageList(this).packages to register the native package");
    }
    cfg.modResults.contents = src;
    return cfg;
  });

const withGson = (config) =>
  withAppBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes("com.google.code.gson")) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /dependencies\s*\{/, `dependencies {\n    implementation("com.google.code.gson:gson:2.10.1")`
      );
    }
    return cfg;
  });

const withLegacyPackaging = (config) =>
  withGradleProperties(config, (cfg) => {
    cfg.modResults = cfg.modResults.filter((p) => !(p.type === "property" && p.key === "expo.useLegacyPackaging"));
    cfg.modResults.push({ type: "property", key: "expo.useLegacyPackaging", value: "true" });
    return cfg;
  });

module.exports = (config) =>
  withLegacyPackaging(withGson(withPackageRegistration(withCopyNative(config))));
