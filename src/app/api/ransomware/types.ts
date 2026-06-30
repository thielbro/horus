// HORUS — Ransomware leak-site feed types.

export interface RansomwarePost {
  /** Stable id (hash of group + victim + discovered). */
  id: string;
  /** Ransomware group / leak-site name (e.g. "qilin", "akira"). */
  group: string;
  /** Victim org name or domain as published on the leak site. */
  victim: string;
  /** Industry / sector when the source provides it (RansomLook `description`). */
  sector?: string;
  /** ISO-8601 UTC timestamp the post was first discovered. */
  discovered: string;
  /** 2-letter country code, when geolocation resolved one. */
  country?: string;
  /** City from IP geolocation, when available. */
  city?: string;
  /** Map coordinates (best-effort, from the victim's server IP). Absent ⇒ not placed on the map. */
  lat?: number;
  lng?: number;
  /** Absolute URL to the leak post. */
  link?: string;
  /** Absolute URL to a screenshot, when the source has one. */
  screenshot?: string;
  /** Originating feed. */
  source: 'ransomlook';
}

export interface RansomwareResponse {
  posts: RansomwarePost[];
  total: number;
  /** How many posts carry map coordinates. */
  geolocated: number;
  /** Post count per group, for the panel/summary. */
  groups: Record<string, number>;
  timestamp: string;
  sources: { ransomlook: number };
  error?: string;
}
