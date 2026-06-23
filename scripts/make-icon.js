// Generates the Windows app icon (desktop/build/icon.ico) from the OSIRIS brand mark.
//
// electron-builder picks up `${buildResources}/icon.ico` (buildResources = desktop/build)
// for the NSIS installer + the packaged OSIRIS.exe. We assemble a multi-resolution
// PNG-in-ICO (Vista+) from public/osiris-icon.png using sharp — no extra dependency.
//
// Run:  node scripts/make-icon.js   (re-run if the source art changes)

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const src = path.join(root, 'public', 'osiris-icon.png');
const outDir = path.join(root, 'desktop', 'build');
const out = path.join(outDir, 'icon.ico');

// Standard Windows icon sizes (256 first so it leads the directory).
const SIZES = [256, 128, 64, 48, 32, 24, 16];

async function main() {
  if (!fs.existsSync(src)) throw new Error(`source art missing: ${src}`);
  fs.mkdirSync(outDir, { recursive: true });

  // Render each size as a 32-bit RGBA PNG embedded directly in the ICO.
  const pngs = await Promise.all(
    SIZES.map((size) =>
      sharp(src)
        .resize(size, size, { fit: 'cover' })
        .ensureAlpha()
        .png({ compressionLevel: 9 })
        .toBuffer(),
    ),
  );

  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(count, 4);

  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count; // image data starts after header + directory
  pngs.forEach((png, i) => {
    const size = SIZES[i];
    const base = i * 16;
    entries.writeUInt8(size >= 256 ? 0 : size, base + 0); // width (0 ⇒ 256)
    entries.writeUInt8(size >= 256 ? 0 : size, base + 1); // height (0 ⇒ 256)
    entries.writeUInt8(0, base + 2); // palette colors
    entries.writeUInt8(0, base + 3); // reserved
    entries.writeUInt16LE(1, base + 4); // color planes
    entries.writeUInt16LE(32, base + 6); // bits per pixel
    entries.writeUInt32LE(png.length, base + 8); // bytes in resource
    entries.writeUInt32LE(offset, base + 12); // offset to image data
    offset += png.length;
  });

  fs.writeFileSync(out, Buffer.concat([header, entries, ...pngs]));
  console.log(`[make-icon] wrote ${path.relative(root, out)} (${count} sizes: ${SIZES.join(', ')})`);
}

main().catch((err) => {
  console.error('[make-icon]', err.message);
  process.exit(1);
});
