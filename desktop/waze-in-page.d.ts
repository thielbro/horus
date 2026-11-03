// Types for the CJS module desktop/waze-in-page.js (imported by src/**/*.ts as
// '../../../desktop/waze-in-page.js'). `attempts` is the per-HTTP-attempt
// diagnostics trail: action = the reCAPTCHA token action for that attempt,
// status = the HTTP status Waze answered with. A null action means the page had
// no site key / no recaptcha (tokenless path); a named action whose mint
// rejected or timed out is recorded even though that request carried no token.
export type WazeInPageFetchResult = {
  ok: boolean;
  status: number;
  text: string;
  attempts: { action: string | null; status: number }[];
};
export const WAZE_TOKEN_ACTIONS: readonly string[];
export function wazeInPageFetchGeoRss(arg: {
  url: string;
  actions: readonly string[];
  // Per-mint cap (recaptcha.enterprise.ready/execute can stall); default 10s.
  mintTimeoutMs?: number;
}): Promise<WazeInPageFetchResult>;
export function buildWazeFetchScript(url: string, actions?: readonly string[]): string;
