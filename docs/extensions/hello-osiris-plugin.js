// Trusted in-process OSIRIS plugin example.
// Paste this into Settings -> Extensions -> Plugins, or load it as a .js file.
const plugin = {
  id: 'dogfood-local-incidents',
  name: 'Dogfood Local Incidents',
  version: '1.0.0',
  sdk: 1,
  activate(ctx) {
    const point = window.OsirisSDK?.point ?? ((lng, lat, props = {}) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: props,
    }));

    ctx.registerGroup({
      id: 'DOGFOOD',
      label: 'DOG',
      fullLabel: 'DOGFOOD',
      color: '#00E5FF',
      order: 95,
    });

    ctx.registerFeed({
      id: 'local-incidents',
      fetch: {
        kind: 'endpoint',
        url: '/examples/extensions/incidents.json',
        transform: (raw) => ({ dogfood_incidents: Array.isArray(raw?.items) ? raw.items : [] }),
      },
      priority: 'lazy',
    });

    ctx.registerLayer({
      id: 'local_incidents',
      label: 'Local Incidents',
      group: 'DOGFOOD',
      color: '#00E5FF',
      icon: 'AlertTriangle',
      feeds: ['local-incidents'],
      countBuckets: ['dogfood_incidents'],
      styleLayers: [{
        id: 'dots',
        mapSource: 'incidents',
        type: 'circle',
        paint: {
          'circle-radius': 6,
          'circle-color': '#00E5FF',
          'circle-opacity': 0.9,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#000',
          'circle-stroke-opacity': 0.6,
        },
      }],
      render: [{
        mapSource: 'incidents',
        source: {
          bucket: 'dogfood_incidents',
          toFeatures: (items) => items.map((it) => point(it.lng, it.lat, it)),
        },
      }],
      interaction: {
        kind: 'popup',
        html: (p) => '<b>' + p.name + '</b><br/>' + p.status,
      },
    });
  },
};

export default plugin;
