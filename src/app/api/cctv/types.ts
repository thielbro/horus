export type CctvStreamType = 'snapshot' | 'mjpeg' | 'hls' | 'mp4' | 'iframe';

export interface CctvCamera {
  id: string;
  lat: number;
  lng: number;
  name: string;
  city: string;
  country: string;
  /** Static image URL (MJPEG/JPG snapshot) */
  feed_url?: string;
  /** Live video stream (HLS .m3u8) or embed URL (YouTube/rtsp.me) */
  stream_url?: string;
  stream_type?: CctvStreamType;
  /** Provider-safe snapshot refresh cadence. */
  refresh_interval_ms?: number;
  external_url?: string;
  source: string;
}

export function inferStreamType(url: string): CctvStreamType {
  if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
  if (/youtube\.com\/embed|youtube-nocookie\.com\/embed|rtsp\.me\/embed|ipcamlive\.com\/player|click2stream\.com|windy\.com\/webcams\/\d+\/embed/i.test(url)) {
    return 'iframe';
  }
  if (/\.mpe?g(?:\?|$)|mjpeg/i.test(url)) return 'mjpeg';
  if (/\.mp4(?:\?|$)/i.test(url)) return 'mp4';
  return 'snapshot';
}
