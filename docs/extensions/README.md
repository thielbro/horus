# OSIRIS Extensions

OSIRIS extensions are trusted, in-process customizations for a single operator. They are not sandboxed and should only contain code you authored or explicitly trust.

## Bundle Format

Settings imports and exports one JSON bundle:

```json
{
  "version": 1,
  "plugins": [],
  "customSources": []
}
```

Invalid bundle items are skipped and reported in Settings. Valid items still import.

## Examples

- `docs/extensions/example-bundle.json` imports a no-code custom source backed by `public/examples/extensions/incidents.json`.
- `docs/extensions/hello-osiris-plugin.js` registers a group, endpoint feed, layer, and popup interaction against the same static feed.

## Verification

Use the safe agent path:

```powershell
node --test tests/performance-stability.test.mjs tests/extension-hardening.test.mjs
npx tsc --noEmit
npm run lint
npm run build
npm run desktop:prepare
```

Do not run raw `next dev`; use the guarded desktop workflow from `HANDOFF.md` when a live preview is needed.
