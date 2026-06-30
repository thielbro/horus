// HORUS — country centroid lookup.
//
// Shared by the IP-less geo fallbacks across threat feeds (malware C2, ransomware victims).
// Coordinates are [lng, lat] — GeoJSON order — so the value drops straight into a Point geometry.
// Extracted verbatim from the original inline table in src/app/api/malware/route.ts.

export const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  AF:[65,33],AL:[20,41],DZ:[3,28],AO:[18.5,-12.5],AR:[-64,-34],AM:[45,40],AU:[134,-25],AT:[14,47.5],AZ:[50,40.5],
  BD:[90,24],BY:[28,53],BE:[4,50.8],BR:[-51,-10],BG:[25.5,42.7],CA:[-96,62],CL:[-71,-30],
  CN:[105,35],CO:[-72,4],HR:[16,45.2],CZ:[15.5,49.8],DK:[10,56],EG:[30,27],FI:[26,64],
  FR:[2,46],DE:[10,51],GR:[22,39],HK:[114.2,22.3],HU:[19.5,47],IN:[79,22],ID:[120,-5],
  IR:[53,32],IQ:[44,33],IE:[-8,53],IL:[34.8,31.5],IT:[12.5,42.8],JP:[138,36],KZ:[67,48],
  KE:[38,1],KR:[128,36],LT:[24,55.5],MY:[112,3],MX:[-102,23.5],NL:[5.5,52.5],NZ:[174,-41],
  NG:[8,10],NO:[8,62],PK:[70,30],PA:[-80,9],PH:[122,12.5],PL:[19.5,52],PT:[-8,39.5],
  RO:[25,46],RU:[100,60],SA:[45,25],SG:[103.8,1.35],ZA:[24,-29],ES:[-4,40],SE:[16,62],
  CH:[8,47],TW:[121,23.7],TH:[101,15],TR:[35,39],UA:[32,49],AE:[54,24],GB:[-2,54],
  US:[-97,38],VN:[106,16],
};

/**
 * Resolve a 2-letter ISO country code to a jittered centroid `[lng, lat]`, or null if unknown.
 * The ±4° jitter is deterministic in `seed` so repeated calls for the same record are stable
 * (mirrors the malware feed's per-node jitter so co-located markers don't stack on one pixel).
 */
export function countryCentroid(cc: string, seed = 0): [number, number] | null {
  const centroid = COUNTRY_CENTROIDS[(cc || '').toUpperCase()];
  if (!centroid) return null;
  const [lng, lat] = centroid;
  const jLng = ((seed * 173.7) % 200 - 100) / 100 * 4;
  const jLat = ((seed * 293.1) % 200 - 100) / 100 * 4;
  return [lng + jLng, lat + jLat];
}
