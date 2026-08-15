// Config plugin: bind the device-wide Logos Delivery service. Copies the AIDL + client
// Kotlin into android/ each prebuild, registers the RN module, enables AIDL, and declares
// the uses-permission + package <queries> needed to see/bind co.logos.delivery on Android 11+.
const { withDangerousMod, withMainApplication, withAppBuildGradle, withAndroidManifest, AndroidConfig } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const PERMISSION = "co.logos.delivery.permission.BIND";
const PKG = "co.logos.delivery.client.LogosDeliveryClientPackage";

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

const withCopy = (config) =>
  withDangerousMod(config, ["android", (cfg) => {
    
    const nr = path.join(__dirname, "..", "native", "deliveryclient");
    const main = path.join(cfg.modRequest.platformProjectRoot, "app", "src", "main");
    copyDir(path.join(nr, "aidl"), path.join(main, "aidl"));
    copyDir(path.join(nr, "android", "java"), path.join(main, "java"));
    return cfg;
  }]);

const withPackage = (config) =>
  withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes(PKG)) return cfg;
    if (/PackageList\(this\)\.packages\.apply\s*\{/.test(src)) {
      src = src.replace(/(PackageList\(this\)\.packages\.apply\s*\{)/, `$1\n            add(${PKG}())`);
    } else if (/return\s+PackageList\(this\)\.packages\b(?!\.)/.test(src)) {
      src = src.replace(/return\s+PackageList\(this\)\.packages\b(?!\.)/, `return PackageList(this).packages.apply {\n            add(${PKG}())\n          }`);
    } else { throw new Error("withDeliveryClient: PackageList not found"); }
    cfg.modResults.contents = src;
    return cfg;
  });

const withAidl = (config) =>
  withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.contents.includes("aidl true")) return cfg;
    cfg.modResults.contents = cfg.modResults.contents.replace(/android\s*\{/, `android {\n    buildFeatures { aidl true }`);
    return cfg;
  });

const withPerms = (config) =>
  withAndroidManifest(config, (cfg) => {
    const m = cfg.modResults;
    AndroidConfig.Manifest.ensureToolsAvailable(m);
    m.manifest["uses-permission"] = m.manifest["uses-permission"] || [];
    if (!m.manifest["uses-permission"].find((p) => p.$ && p.$["android:name"] === PERMISSION)) {
      m.manifest["uses-permission"].push({ $: { "android:name": PERMISSION } });
    }
    // Android 11+ package visibility: needed to bind another package's service.
    m.manifest.queries = m.manifest.queries || [{}];
    const q = m.manifest.queries[0];
    q["package"] = q["package"] || [];
    // the Loam app hosts the shared node (applicationId xyz.vpavlin.loam)
    if (!q["package"].find((p) => p.$ && p.$["android:name"] === "xyz.vpavlin.loam")) {
      q["package"].push({ $: { "android:name": "xyz.vpavlin.loam" } });
    }
    return cfg;
  });

module.exports = (config) => withPerms(withAidl(withPackage(withCopy(config))));
