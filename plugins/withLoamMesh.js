// withLoamMesh — Expo config plugin for the Loam BLE mesh bearer (ADR 0012). Like
// withLogosDelivery, it survives `expo prebuild` by re-copying native files and hand-
// registering the RN package (not autolinkable). It:
//   - copies native/blemesh/android/java/** → app/src/main/java/**
//   - registers xyz.vpavlin.loam.mesh.LoamMeshPackage() in MainApplication
//   - adds the Android 12+ BLE runtime permissions (+ legacy fallbacks)
const { withDangerousMod, withMainApplication, withAndroidManifest } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

const withCopy = (config) =>
  withDangerousMod(config, ["android", (cfg) => {
    const root = cfg.modRequest.projectRoot;
    const pkgRoot = path.join(__dirname, "..", "native", "blemesh", "android", "java");
    const javaDst = path.join(cfg.modRequest.platformProjectRoot, "app", "src", "main", "java");
    if (fs.existsSync(pkgRoot)) copyDir(pkgRoot, javaDst);
    return cfg;
  }]);

const withRegister = (config) =>
  withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes("xyz.vpavlin.loam.mesh.LoamMeshPackage()")) return cfg;
    if (/PackageList\(this\)\.packages\.apply\s*\{/.test(src)) {
      src = src.replace(/(PackageList\(this\)\.packages\.apply\s*\{)/,
        `$1\n            add(xyz.vpavlin.loam.mesh.LoamMeshPackage())`);
    } else if (/return\s+PackageList\(this\)\.packages\b(?!\.)/.test(src)) {
      src = src.replace(/return\s+PackageList\(this\)\.packages\b(?!\.)/,
        `return PackageList(this).packages.apply {\n            add(xyz.vpavlin.loam.mesh.LoamMeshPackage())\n          }`);
    } else {
      throw new Error("withLoamMesh: could not find PackageList(this).packages to register the package");
    }
    cfg.modResults.contents = src;
    return cfg;
  });

const PERMS = [
  { name: "android.permission.BLUETOOTH_SCAN", extra: { "android:usesPermissionFlags": "neverForLocation" } },
  { name: "android.permission.BLUETOOTH_ADVERTISE" },
  { name: "android.permission.BLUETOOTH_CONNECT" },
  // legacy (maxSdkVersion 30) fallbacks so pre-Android-12 devices still work
  { name: "android.permission.BLUETOOTH", extra: { "android:maxSdkVersion": "30" } },
  { name: "android.permission.BLUETOOTH_ADMIN", extra: { "android:maxSdkVersion": "30" } },
  { name: "android.permission.ACCESS_FINE_LOCATION", extra: { "android:maxSdkVersion": "30" } },
];
const withPerms = (config) =>
  withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest["uses-permission"] = manifest["uses-permission"] || [];
    const has = (n) => manifest["uses-permission"].some((p) => p.$ && p.$["android:name"] === n);
    for (const p of PERMS) {
      if (has(p.name)) continue;
      manifest["uses-permission"].push({ $: { "android:name": p.name, ...(p.extra || {}) } });
    }
    return cfg;
  });

module.exports = (config) => withPerms(withRegister(withCopy(config)));
