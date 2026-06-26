import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { bboxOfPoints, circlePolygon, pointBbox, pointToSegmentMeters } from '../src/lib/geo.ts';

const root = process.cwd();

function file(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('review c98ab97 geo helpers clamp coordinates and handle antimeridian math', () => {
  assert.ok(pointToSegmentMeters(0, 180, 0, 179, 0, -179) < 1000);

  const padded = bboxOfPoints([[160, 0], [170, 0]], 20 * 111_320);
  assert.ok(padded);
  assert.ok(padded[1] <= padded[3], `non-crossing padded bbox should not invert: ${padded}`);
  assert.equal(padded[3], 180);

  const polarBbox = pointBbox(89, 179, 500_000);
  assert.ok(polarBbox[0] >= -90 && polarBbox[2] <= 90, `pointBbox latitude out of range: ${polarBbox}`);

  const ring = circlePolygon(89, 179, 500_000);
  assert.ok(ring.every(([lng, lat]) => lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90));
});

test('review c98ab97 DossierPanel SSE parsing and render hot paths are bounded', () => {
  const panel = file('src/components/DossierPanel.tsx');

  assert.match(panel, /MAX_BUF_LEN/);
  assert.match(panel, /\.replace\(\s*\/\\r\\n\/g,\s*'\\n'\s*\)/);
  assert.match(panel, /reader\.releaseLock\(\)/);
  assert.match(panel, /latestOnLoadedRef/);
  assert.match(panel, /if \(controller\.signal\.aborted\) return;[\s\S]*latestOnLoadedRef\.current\?\.\(nextDossier,\s*runRequestId\)/);
  assert.match(panel, /sectionIdsRef/);
  assert.match(panel, /useMemo/);
  assert.match(panel, /MarkdownBlock/);
  assert.match(panel, /isNearbyFeature/);
  assert.match(panel, /lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180/);
  assert.match(panel, /alt=\{`Street view from \$\{m\.source\}/);
  assert.match(panel, /onError=\{\(e\) =>/);
  assert.doesNotMatch(panel, /export default memo\(DossierPanel\)/);
  assert.doesNotMatch(panel, /eslint-disable-next-line react-hooks\/exhaustive-deps/);
});

test('review c98ab97 dossier page integration validates request ids and payload geometry', () => {
  const page = file('src/app/page.tsx');

  assert.match(page, /dossierRequestIdRef/);
  assert.match(page, /openDossierRequest/);
  assert.match(page, /currentDossierRequestId/);
  assert.match(page, /safeDossierPoint/);
  assert.match(page, /nextLat >= -90 && nextLat <= 90 && nextLng >= -180 && nextLng <= 180/);
  assert.match(page, /MAX_DOSSIER_NEARBY/);
  assert.match(page, /\.slice\(0,\s*MAX_DOSSIER_NEARBY\)/);
  assert.match(page, /requestId !== dossierRequestIdRef\.current/);
  assert.match(page, /regionDossierAbort/);
});

test('review c98ab97 HorusMap batches dossier overlay updates and escapes popup HTML', () => {
  const map = file('src/components/HorusMap.tsx');

  assert.match(map, /DOSSIER_KIND_COLOR/);
  assert.match(map, /escapeHtml/);
  assert.match(map, /requestAnimationFrame/);
  assert.match(map, /dossierOverlayFrameRef/);
  assert.match(map, /setDossierGeoBatch/);
  assert.match(map, /setVis\(\['dossier-radius-fill'[\s\S]*'dossier-pin-dot'\]/);
  assert.match(map, /escapeHtml\(String\(p\.name/);
  assert.match(map, /escapeHtml\(String\(p\.osmUrl/);
});
