// electron-builder afterPack hook: ad-hoc sign the mac .app. Apple Silicon
// refuses to launch unsigned arm64 binaries (Killed: 9), and we build without
// a Developer ID cert (CSC_IDENTITY_AUTO_DISCOVERY=false skips real signing).
// Ad-hoc ("-") is enough to launch; Gatekeeper "Open Anyway" still applies.
exports.default = async (ctx) => {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = `${ctx.appOutDir}/${ctx.packager.appInfo.productFilename}.app`;
  require('node:child_process').execFileSync(
    'codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
