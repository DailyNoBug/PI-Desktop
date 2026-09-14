/**
 * Ad-hoc seal the packed macOS app when no signing identity is configured.
 *
 * Packing rewrites Info.plist, which invalidates Electron's factory ad-hoc
 * signature; arm64 macOS then refuses the app as damaged. Target artifacts
 * (DMG/ZIP) are produced after this hook, so the sealed app is what ships.
 * The signed-and-notarized lane (CSC_LINK) performs its own signing and
 * skips this hook.
 */
const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_LINK) return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  if (!existsSync(appPath)) return;
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
  console.log(`Ad-hoc sealed ${appPath}`);
};
