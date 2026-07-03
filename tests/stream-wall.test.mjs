import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const file = (path) => readFileSync(join(root, path), 'utf8');

test('stream classifier covers YouTube, Twitch, HLS, and generic iframe fallback', () => {
  const streams = file('src/lib/streams.ts');

  assert.match(streams, /export function classifyStreamUrl/);
  assert.match(streams, /export function getYouTubeWatchUrl/);
  // YouTube embeds carry enablejsapi so tiles can mute/unmute without remounting.
  assert.match(streams, /enablejsapi=1/);
  // Twitch requires the runtime hostname as parent — must not be hardcoded.
  assert.match(streams, /player\.twitch\.tv/);
  assert.match(streams, /parentHost/);
  // Raw stream detection.
  assert.match(streams, /\.m3u8/);
  assert.match(streams, /'iframe'/);
});

test('stream tile is a header-dragged, resizable tile with proper HLS teardown', () => {
  const tile = file('src/components/StreamTile.tsx');

  assert.match(tile, /dragMomentum=\{false\}/);
  assert.match(tile, /dragListener=\{false\}/);
  assert.match(tile, /useDragControls/);
  // Iframes swallow pointer events mid-drag; media must go inert while interacting.
  assert.match(tile, /pointer-events-none/);
  // HLS lifecycle: destroy on cleanup (CameraViewer pattern).
  assert.match(tile, /hlsRef\.current\.destroy\(\)/);
  assert.match(tile, /setPointerCapture/);
});

test('stream wall persists tiles to settings and accepts external add requests', () => {
  const wall = file('src/components/StreamWall.tsx');
  const settings = file('src/lib/settings/index.ts');

  assert.match(settings, /streamWall:\s*\{\s*tiles:\s*StreamTileState\[\]\s*\}/);
  assert.match(settings, /streamWall:\s*\{\s*tiles:\s*\[\]\s*\}/);
  assert.match(wall, /update\(\{\s*streamWall:\s*\{\s*tiles\s*\}\s*\}\)/);
  assert.match(wall, /addRequest/);
  assert.match(wall, /\/api\/live-news/);
});

test('page routes watch-feed intents into the stream wall instead of the old single modal', () => {
  const page = file('src/app/page.tsx');

  assert.doesNotMatch(page, /liveFeedUrl/);
  assert.doesNotMatch(page, /setLiveFeedName/);
  assert.match(page, /openStreamTile\(entity\.url,\s*entity\.name/);
  assert.match(page, /openLiveFeed:\s*\(url,\s*name\)\s*=>\s*openStreamTile\(url,\s*name,\s*true\)/);
  assert.match(page, /<StreamWall/);
});
