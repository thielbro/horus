// electron-builder afterPack hook.
//
// Copies the assembled standalone trees (desktop/.staging/*, each including its own
// node_modules) into the packaged app's resources/*. We do this here instead of via
// extraResources because electron-builder strips node_modules out of extraResources
// directories — which would leave server.js unable to require('next') and the backends
// unable to require('express'). afterPack runs after the app is packed but before the NSIS
// installer is built, so the copies land in both win-unpacked and the installer.
//
//   server    -> resources/server    (Next standalone; must carry node_modules/next)
//   scanner   -> resources/scanner   (RECON backend; must carry node_modules/express)
//   intel     -> resources/intel     (ontology engine; must carry node_modules/express)
//   live-feed -> resources/live-feed (activation broker; must carry node_modules/express)

const fs = require('fs');
const path = require('path');

const TREES = [
  { name: 'server', requireModule: 'next' },
  { name: 'scanner', requireModule: 'express' },
  { name: 'intel', requireModule: 'express' },
  { name: 'live-feed', requireModule: 'express' },
];

exports.default = async function afterPack(context) {
  for (const tree of TREES) {
    const src = path.join(__dirname, '.staging', tree.name);
    const dest = path.join(context.appOutDir, 'resources', tree.name);

    if (!fs.existsSync(src)) {
      throw new Error(`[after-pack] staged ${tree.name} missing — run \`npm run desktop:prepare\` first`);
    }

    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });

    const hasModule = fs.existsSync(path.join(dest, 'node_modules', tree.requireModule));
    console.log(`[after-pack] embedded ${tree.name} → ${dest} (node_modules/${tree.requireModule} present: ${hasModule})`);
    if (!hasModule) throw new Error(`[after-pack] node_modules/${tree.requireModule} missing in ${tree.name} after copy`);
  }
};
