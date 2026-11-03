// Types for the CJS module desktop/waze-in-page.js (imported by src/**/*.ts as
// '../../../desktop/waze-in-page.js'). `attempts` is the per-HTTP-attempt
// diagnostics trail: action = the reCAPTCHA token action minted for that attempt
// (null when no token was attached), status = the HTTP status Waze answered with.
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
}): Promise<WazeInPageFetchResult>;
export function buildWazeFetchScript(url: string, actions?: readonly string[]): string;
