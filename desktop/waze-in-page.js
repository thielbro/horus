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
  const gon = JSON.parse((globalThis.document && globalThis.document.querySelector('#gon')
    ? globalThis.document.querySelector('#gon').textContent : '') || '{}');
  const recaptcha = globalThis.grecaptcha;
  const siteKey = gon.recaptchaActionSiteKey || null;

  const attempt = async (token, action) => {
    const headers = { Accept: 'application/json, text/plain, */*' };
    if (token) headers['x-recaptcha-token'] = token;
    const response = await globalThis.fetch(arg.url, { headers, credentials: 'include' });
    const result = { ok: response.ok, status: response.status, text: await response.text() };
    // Diagnostics trail: which token action was minted for this HTTP attempt
    // (null = no token attached, e.g. page has no site key), and what Waze answered.
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
    for (const action of arg.actions) {
      let token = null;
      try {
        token = await new Promise((resolve, reject) => {
          recaptcha.enterprise.ready(() => {
            recaptcha.enterprise.execute(siteKey, { action }).then(resolve, reject);
          });
        });
      } catch {
        token = null; // mint failed for this action; try it tokenless, then next action
      }
      last = await attempt(token, action);
      if (last.ok || (last.status !== 401 && last.status !== 403)) return withAttempts(last);
    }
    return withAttempts(last);
  }
  return withAttempts(await attempt(null, null));
}

// Electron/Playwright string form: an immediately-invoked serialized copy.
function buildWazeFetchScript(url, actions) {
  const arg = JSON.stringify({ url, actions: actions || WAZE_TOKEN_ACTIONS });
  return `(${wazeInPageFetchGeoRss.toString()})(${arg})`;
}

module.exports = { wazeInPageFetchGeoRss, buildWazeFetchScript, WAZE_TOKEN_ACTIONS };
