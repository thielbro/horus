// electron-builder afterPack hook.
//
// Copies the assembled Next standalone server (desktop/.staging/server, including its
// node_modules) into the packaged app's resources/server. We do this here instead of
// via extraResources because electron-builder strips node_modules out of extraResources
// directories, which leaves server.js unable to require('next'). afterPack runs after
// the app is packed but before the NSIS installer is built, so the copy lands in both
// win-unpacked and the installer.

const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const src = path.join(__dirname, '.staging', 'server');
  const dest = path.join(context.appOutDir, 'resources', 'server');

  if (!fs.existsSync(src)) {
    throw new Error('[after-pack] staged server missing — run `npm run desktop:prepare` first');
  }

  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });

  const hasNext = fs.existsSync(path.join(dest, 'node_modules', 'next'));
  console.log(`[after-pack] embedded server → ${dest} (node_modules/next present: ${hasNext})`);
  if (!hasNext) throw new Error('[after-pack] node_modules/next missing after copy');
};
