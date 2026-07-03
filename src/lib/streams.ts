// HORUS — Stream Wall URL classification.
//
// Turns any pasted URL into something a StreamTile can play:
//   youtube → privacy-agnostic iframe embed (enablejsapi so tiles can mute/unmute)
//   twitch  → player.twitch.tv embed (parent must match the serving hostname)
//   hls     → raw .m3u8 handed to hls.js
//   file    → direct <video src> (.mp4/.webm)
//   iframe  → last-resort raw iframe (target may refuse framing — tiles always
//             keep an "open externally" affordance since iframes give no
//             reliable load-failure signal)

export type StreamKind = 'youtube' | 'twitch' | 'hls' | 'file' | 'iframe';

export interface ClassifiedStream {
  kind: StreamKind;
  /** iframe src / hls loadSource / video src depending on kind. */
  embedUrl: string;
  /** External "open in new tab" link. */
  watchUrl: string;
  suggestedName: string;
}

const YT_EMBED_PARAMS = 'autoplay=1&mute=1&enablejsapi=1';

/** Extracts a watchable YouTube URL from embed/channel URLs. */
export function getYouTubeWatchUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const channel = parsed.searchParams.get('channel');
    if (channel) return `https://www.youtube.com/channel/${channel}/live`;
    const embedMatch = /^\/embed\/([^/]+)$/.exec(parsed.pathname);
    if (embedMatch?.[1] && embedMatch[1] !== 'live_stream') return `https://www.youtube.com/watch?v=${embedMatch[1]}`;
  } catch {
    // Keep the original URL when browser parsing rejects it.
  }
  return url;
}

function youtubeVideoId(parsed: URL): string | null {
  const host = parsed.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') return parsed.pathname.slice(1).split('/')[0] || null;
  if (parsed.pathname === '/watch') return parsed.searchParams.get('v');
  const pathMatch = /^\/(?:live|embed|shorts)\/([\w-]+)/.exec(parsed.pathname);
  if (pathMatch?.[1] && pathMatch[1] !== 'live_stream') return pathMatch[1];
  return null;
}

function hostLabel(parsed: URL): string {
  return parsed.hostname.replace(/^www\./, '');
}

/**
 * Classify a stream URL for tile playback.
 * `parentHost` is required for Twitch embeds — player.twitch.tv refuses to load
 * unless `parent` equals the hostname actually serving the page (localhost in dev).
 */
export function classifyStreamUrl(raw: string, opts?: { parentHost?: string }): ClassifiedStream | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const host = parsed.hostname.replace(/^www\./, '');

  // ── YouTube ──
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com') {
    const videoId = youtubeVideoId(parsed);
    if (videoId) {
      return {
        kind: 'youtube',
        embedUrl: `https://www.youtube.com/embed/${videoId}?${YT_EMBED_PARAMS}`,
        watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
        suggestedName: `YouTube ${videoId}`,
      };
    }
    // Channel live stream: /channel/<id>/live or embed/live_stream?channel=<id>.
    const channelId = /^\/channel\/([\w-]+)/.exec(parsed.pathname)?.[1] || parsed.searchParams.get('channel');
    if (channelId) {
      return {
        kind: 'youtube',
        embedUrl: `https://www.youtube.com/embed/live_stream?channel=${channelId}&${YT_EMBED_PARAMS}`,
        watchUrl: `https://www.youtube.com/channel/${channelId}/live`,
        suggestedName: 'YouTube Live',
      };
    }
    // @handle URLs can't be resolved to a channel id client-side → external only.
    return { kind: 'iframe', embedUrl: raw, watchUrl: raw, suggestedName: 'YouTube' };
  }

  // ── Twitch ──
  if (host === 'twitch.tv' || host === 'm.twitch.tv') {
    const channel = parsed.pathname.split('/').filter(Boolean)[0];
    if (channel && !['videos', 'directory', 'settings'].includes(channel)) {
      const parent = opts?.parentHost || 'localhost';
      return {
        kind: 'twitch',
        embedUrl: `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&muted=true&parent=${encodeURIComponent(parent)}`,
        watchUrl: `https://www.twitch.tv/${channel}`,
        suggestedName: `Twitch ${channel}`,
      };
    }
  }

  // ── Raw streams / media files ──
  const path = parsed.pathname.toLowerCase();
  if (path.endsWith('.m3u8')) {
    return { kind: 'hls', embedUrl: raw, watchUrl: raw, suggestedName: hostLabel(parsed) };
  }
  if (path.endsWith('.mp4') || path.endsWith('.webm')) {
    return { kind: 'file', embedUrl: raw, watchUrl: raw, suggestedName: hostLabel(parsed) };
  }

  // ── Fallback: try framing it ──
  return { kind: 'iframe', embedUrl: raw, watchUrl: raw, suggestedName: hostLabel(parsed) };
}
