import type { CctvCamera } from './types';

export type SurveillanceMapFoundationRegion =
  | 'australia'
  | 'europe'
  | 'france'
  | 'italy'
  | 'newzealand'
  | 'switzerland'
  | 'uk'
  | 'us-east'
  | 'us-west';

type SurveillanceMapFoundationCamera = CctvCamera & {
  region: SurveillanceMapFoundationRegion;
};

const SURVEILLANCE_MAP_FOUNDATION_CAMERAS: SurveillanceMapFoundationCamera[] = [
  {
    region: 'france',
    id: 'smf-fr-paris-eiffel-dauphine',
    lat: 48.8701102, lng: 2.2734842,
    name: 'Paris - Eiffel Tower View from Dauphine-PSL', city: 'Paris', country: 'France',
    stream_url: 'https://www.youtube.com/embed/UHlDzWrBEPI?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0',
    stream_type: 'iframe',
    source: 'SurveillanceMap Foundation',
  },
  {
    region: 'us-west',
    id: 'smf-us-ca-lax',
    lat: 33.9421675, lng: -118.4213591,
    name: 'Los Angeles LAX', city: 'Los Angeles', country: 'US',
    stream_url: 'https://www.youtube.com/embed/TdGXlEOxuOw?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0',
    stream_type: 'iframe',
    source: 'SurveillanceMap Foundation',
  },
  {
    region: 'europe',
    id: 'smf-fo-vagur-sw',
    lat: 61.4738859, lng: -6.8114622,
    name: 'Vagur South West View', city: 'Vagur', country: 'Faroe Islands',
    stream_url: 'https://www.youtube.com/embed/otu_D2_TiLM?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0',
    stream_type: 'iframe',
    source: 'SurveillanceMap Foundation',
  },
  {
    region: 'switzerland',
    id: 'smf-ch-zermatt-matterhorn',
    lat: 46.0212076, lng: 7.749254,
    name: 'Matterhorn View - Zermatt', city: 'Zermatt', country: 'Switzerland',
    stream_url: 'https://www.youtube.com/embed/JcHYcrO4PRE?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0',
    stream_type: 'iframe',
    source: 'SurveillanceMap Foundation',
  },
  {
    region: 'newzealand',
    id: 'smf-nz-auckland-sky-tower',
    lat: -36.8484632, lng: 174.762183,
    name: 'Sky Tower and Auckland Harbour', city: 'Auckland', country: 'New Zealand',
    stream_url: 'https://www.youtube.com/embed/Ql7graq0I9M?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0',
    stream_type: 'iframe',
    source: 'SurveillanceMap Foundation',
  },
  {
    region: 'us-east',
    id: 'smf-us-ny-empire-state-lower-manhattan',
    lat: 40.7484421, lng: -73.9856589,
    name: 'Lower Manhattan Skyline from Empire State Building', city: 'New York', country: 'US',
    stream_url: 'https://www.youtube.com/embed/KuzVYn1Ucbg?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0',
    stream_type: 'iframe',
    source: 'SurveillanceMap Foundation',
  },
  {
    region: 'europe',
    id: 'smf-fo-vagur-se',
    lat: 61.4738859, lng: -6.8114622,
    name: 'Vagur South East View', city: 'Vagur', country: 'Faroe Islands',
    stream_url: 'https://www.youtube.com/embed/EHaOI3U5M_s?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0',
    stream_type: 'iframe',
    source: 'SurveillanceMap Foundation',
  },
  {
    region: 'europe',
    id: 'smf-is-djupivogur-harbour',
    lat: 64.655775, lng: -14.2820953,
    name: 'Djupivogur Harbour', city: 'Djupivogur', country: 'Iceland',
    stream_url: 'https://www.youtube.com/embed/eAm6iAB1pQQ?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0',
    stream_type: 'iframe',
    source: 'SurveillanceMap Foundation',
  },
  {
    region: 'australia',
    id: 'smf-au-sydney-cafe-sydney',
    lat: -33.862228, lng: 151.2108234,
    name: 'Sydney Harbour from Cafe Sydney', city: 'Sydney', country: 'Australia',
    stream_url: 'https://www.youtube.com/embed/6Xxb5uikewE?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0',
    stream_type: 'iframe',
    source: 'SurveillanceMap Foundation',
  },
  {
    region: 'uk',
    id: 'smf-gb-plymouth-smeatons-tower',
    lat: 50.3643455, lng: -4.1418867,
    name: "Smeaton's Tower", city: 'Plymouth', country: 'UK',
    stream_url: 'https://www.youtube.com/embed/SfuCqR7RLHA?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0',
    stream_type: 'iframe',
    source: 'SurveillanceMap Foundation',
  },
  {
    region: 'italy',
    id: 'smf-it-anacapri-caesar-augustus',
    lat: 40.5587077, lng: 14.2233894,
    name: 'Capri from Hotel Caesar Augustus', city: 'Anacapri', country: 'Italy',
    stream_url: 'https://www.youtube.com/embed/t_bAWRtkvlQ?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0',
    stream_type: 'iframe',
    source: 'SurveillanceMap Foundation',
  },
  {
    region: 'us-east',
    id: 'smf-us-ny-times-square',
    lat: 40.7572614, lng: -73.9858998,
    name: 'Times Square', city: 'New York', country: 'US',
    stream_url: 'https://www.youtube.com/embed/mkX71WMAmNI?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0',
    stream_type: 'iframe',
    source: 'SurveillanceMap Foundation',
  },
];

export function fetchSurveillanceMapFoundationCameras(region: SurveillanceMapFoundationRegion): CctvCamera[] {
  return SURVEILLANCE_MAP_FOUNDATION_CAMERAS
    .filter((camera) => camera.region === region)
    .map((camera) => {
      const cctvCamera: Partial<SurveillanceMapFoundationCamera> = { ...camera };
      delete cctvCamera.region;
      return cctvCamera as CctvCamera;
    });
}
