// Canonical Waze "fetch GeoRSS from inside a Waze page" routine.
// Runs in THREE contexts: unit tests (Node with stubs), Playwright page.evaluate,
// Electron executeJavaScript. Keep it plain JS with zero external references —
// both embedders serialize it with Function.prototype.toString().
// Token-action fallback rationale: Waze changed its reCAPTCHA Enterprise action
// from 'livemap' to 'api' at some point in 2025/26; tokens are single-use, so on a
// 401/403 we mint the next candidate action and retry. Keep order most-proven-first.
const WAZE_TOKEN_ACTIONS = ['livemap', 'api'];

async function wazeInPageFetchGeoRss(arg) {
  const attempts = [];
  // #gon is the page's JSON config blob. A bot interstitial or a partially
  // rendered DOM can leave it absent or non-JSON: fall back to {} so we degrade
  // to the tokenless path instead of throwing out of the embedder's evaluate.
  let gon = {};
  try {
    gon = JSON.parse((globalThis.document && globalThis.document.querySelector('#gon')
      ? globalThis.document.querySelector('#gon').textContent : '') || '{}') || {};
  } catch {
    gon = {};
  }
  const recaptcha = globalThis.grecaptcha;
  const siteKey = gon.recaptchaActionSiteKey || null;

  const attempt = async (token, action) => {
    const headers = { Accept: 'application/json, text/plain, */*' };
    if (token) headers['x-recaptcha-token'] = token;
    const response = await globalThis.fetch(arg.url, { headers, credentials: 'include' });
    const result = { ok: response.ok, status: response.status, text: await response.text() };
    // Diagnostics trail: which token action was minted for this HTTP attempt, and
    // what Waze answered. A null action means no site key / no recaptcha on the
    // page (tokenless path); a named action whose mint rejected or timed out is
    // still recorded here even though that request carried no token.
    attempts.push({ action: action, status: result.status });
    return result;
  };

  const withAttempts = (result) => ({
    ok: result.ok,
    status: result.status,
    text: result.text,
    attempts: attempts,
  });

  if (siteKey && recaptcha && recaptcha.enterprise) {
    let last = null;
    // Literal, not a module constant: this function is serialized with
    // .toString(), so its body may not close over anything outside itself.
    const mintTimeoutMs = typeof arg.mintTimeoutMs === 'number' ? arg.mintTimeoutMs : 10_000;
    const actionList = Array.isArray(arg.actions) ? arg.actions : [];
    for (const action of actionList) {
      let token = null;
      // recaptcha.enterprise.ready/execute can stall forever on a throttled page,
      // so each mint is raced against a timeout. A timed-out mint takes the same
      // path as a rejected one: tokenless attempt for this action, then continue.
      let mintTimer = null;
      try {
        const mint = new Promise((resolve, reject) => {
          recaptcha.enterprise.ready(() => {
            recaptcha.enterprise.execute(siteKey, { action }).then(resolve, reject);
          });
        });
        const timeout = new Promise((_, reject) => {
          mintTimer = globalThis.setTimeout(() => reject(new Error('mint timeout')), mintTimeoutMs);
        });
        token = await Promise.race([mint, timeout]);
      } catch {
        token = null; // mint failed or stalled for this action; try it tokenless, then next action
      } finally {
        if (mintTimer !== null) globalThis.clearTimeout(mintTimer);
      }
      last = await attempt(token, action);
      if (last.ok || (last.status !== 401 && last.status !== 403)) return withAttempts(last);
    }
    // Empty/missing actions with recaptcha present: one tokenless attempt, no crash.
    return withAttempts(last ?? await attempt(null, null));
  }
  return withAttempts(await attempt(null, null));
}

// Electron/Playwright string form: an immediately-invoked serialized copy.
function buildWazeFetchScript(url, actions) {
  const arg = JSON.stringify({ url, actions: actions || WAZE_TOKEN_ACTIONS });
  return `(${wazeInPageFetchGeoRss.toString()})(${arg})`;
}

module.exports = { wazeInPageFetchGeoRss, buildWazeFetchScript, WAZE_TOKEN_ACTIONS };
