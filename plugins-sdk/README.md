# @osiris/plugin-sdk

The contract every OSIRIS plugin is written against. Import it as `@osiris/plugin-sdk`.

> **Status:** the interface in [`index.ts`](./index.ts) is locked. The runtime helpers
> (`definePlugin`, `point`, `line`, `featureCollection`, `colors`) work today. The
> host-provided services (everything on `ctx`) are typed now and go live once the
> **registry engine (Phase 2)** is implemented. You can author and type-check plugins
> against this contract before the host exists.

## Mental model

Plugins are **trusted, in-process extensions** — authored by the operator or their
agents, never published. There is **no sandbox, no permission model, no IPC**. Your
transforms and React components run directly in the host, exactly like first-party code.
The whole point is customization *without editing core app files*: you add a folder, the
host discovers it.

Everything you build plugs into one **registry**:

```
Feed   → fetches data into named "buckets"   (ctx.registerFeed)
Layer  → a sidebar toggle + how to draw it   (ctx.registerLayer)
Panel  → a side/modal panel (your React)     (ctx.registerPanel)
+ recon tools, commands, groups, themes
```

## Two entry points

The desktop app splits the renderer from the embedded Node server, so a plugin folder
can have two files. Functions never cross between them — the client references a server
feed by id.

| File | Runs in | Use for |
|---|---|---|
| `index.ts` (required) | renderer | layers, panels, UI, client-side feeds |
| `server.ts` (optional) | Node / Next | feeds needing secrets, CORS-bypass, or Node libs; custom API routes |

## Minimal plugin — client only, off a builtin feed

```tsx
import { definePlugin, point } from '@osiris/plugin-sdk';

export default definePlugin({
  id: 'mil-ring', name: 'Military Highlight', version: '1.0.0', sdk: 1,
  activate(ctx) {
    ctx.registerLayer({
      id: 'mil-ring', label: 'Mil Rings', group: 'AVIATION', color: '#FF3D3D',
      feeds: ['flights'],                       // builtin feed — referenced unprefixed
      styleLayers: [{
        id: 'ring', type: 'circle',
        paint: { 'circle-radius': 14, 'circle-color': '#FF3D3D', 'circle-opacity': 0.15 },
      }],
      render: [{ mapSource: 'ring', source: {
        bucket: 'military_flights',             // builtin bucket
        toFeatures: (a) => a.map((f) => point(f.lng, f.lat, { callsign: f.callsign })),
      }}],
      interaction: { kind: 'entityGraph', map: (f) => ({ type: 'aircraft', id: f.callsign }) },
    });
  },
});
```

## Full plugin — server feed (secret + CORS) + client layer + panel

```ts
// server.ts
import { definePluginServer } from '@osiris/plugin-sdk';

export const server = definePluginServer({
  activate(ctx) {
    ctx.registerFeed({
      id: 'ais', intervalMs: 30_000,
      run: async ({ fetch, getSecret }) => {
        const rows = await fetch(`https://api.aishub.net/ws?key=${getSecret('AIS_KEY')}`)
          .then((r) => r.json());
        return { ais_ships: rows };             // writes a bucket
      },
    });
  },
});
```

```tsx
// index.ts
import { definePlugin, point } from '@osiris/plugin-sdk';
import ShipPanel from './ShipPanel';

export default definePlugin({
  id: 'ais', name: 'AIS Ships', version: '1.0.0', sdk: 1,
  activate(ctx) {
    ctx.registerLayer({
      id: 'ships', label: 'AIS Ships', group: 'MARITIME', color: 'token:maritime',
      feeds: ['ais:ais'],                       // your own server feed — namespaced
      styleLayers: [{ id: 'dots', type: 'circle',
        paint: { 'circle-radius': 4, 'circle-color': '#26C6DA' } }],
      render: [{ mapSource: 'dots', source: {
        bucket: 'ais_ships', toFeatures: (r) => r.map((s) => point(s.lng, s.lat, s)),
      }}],
      interaction: { kind: 'panel', render: (s) => <ShipPanel ship={s} /> },
    });
    ctx.registerPanel({ id: 'ais-tools', title: 'AIS', icon: 'Ship', component: ShipPanel });
  },
});
```

## Rules

1. **Namespacing.** Every id you register is auto-prefixed `pluginId:id`. Reference your
   own ids by the short form (`'ais'` → resolves to `'ais:ais'`); reference a **builtin**
   by its literal id (`'flights'`, `'military_flights'`). You cannot shadow a builtin.
2. **Client vs server.** `getSecret` and the SSRF-guarded `fetch` exist only in `server.ts`.
   A server feed registers there; the client layer references it by id.
3. **`pull` everywhere.** Because plugins are trusted, your `toFeatures` / `compute`
   functions run in the host render loop — same path as builtins. No serialization.
4. **Lifecycle.** Every `register*` returns a `Disposable`, and the host tracks
   registrations by plugin id, so disable/reload/uninstall cleans up automatically.
   `deactivate` is only for non-registry side effects (timers, sockets you opened).

## Appendix — builtin ids

- **Groups:** `SDK · AVIATION · MARITIME · SURVEIL · HAZARD · THREAT · NETWORK · DISPLAY`
- **Common buckets:** `commercial_flights · private_flights · private_jets · military_flights ·
  satellites · cameras · surveillance · live_feeds · earthquakes · fires · weather_events ·
  infrastructure · gdelt · malware_threats · maritime_ships · maritime_ports ·
  maritime_chokepoints · balloons · radiation · submarine_cables · news · markets`
- **Builtin layer ids:** `flights · private · jets · military · maritime · satellites · cctv ·
  surveillance · live_news · earthquakes · fires · weather · infrastructure · global_incidents ·
  gps_jamming · day_night · cables · sdk_sea · sdk_air · sdk_naval · malware`
- **Interaction kinds:** `popup · panel · camera · liveFeed · entityGraph · custom`
