# OSIRIS Desktop Stability & Infrastructure Review

**Reviewer:** Desktop_Infra_Stability_Reviewer  
**Scope:** Performance and stability only. Security issues are explicitly out of scope.  
**Files reviewed:** 22 files across `desktop/`, `intel/`, `scanner/`, `scripts/`, `next.config.ts`, and `src/proxy.ts`.

---

## Executive Summary — Top 10 Issues by Impact

| # | Severity | File | Issue |
|---|----------|------|-------|
| 1 | **Critical** | `desktop/main.js:26` | `serverRestartAttempts` is never reset — after 3 embedded-server crashes, the app can never restart the server again in the same process lifetime. |
| 2 | **Critical** | `intel/server.js:895` | `setInterval` for sanctions refresh is never cleared; keeps firing during graceful shutdown and can prevent the process from exiting cleanly. |
| 3 | **High** | `desktop/main.js:245,249` | `render-process-gone` and `crashed` handlers reload the renderer indefinitely with no backoff or max-retry limit. |
| 4 | **High** | `desktop/main.js:165` | `server.log` is opened in append mode every server start but never rotated — unbounded disk growth. |
| 5 | **High** | `desktop/main.js:64` | `writeSettingsFile` writes directly to `settings.json` with no atomic write or temp-file pattern — corruption risk on crash or power loss. |
| 6 | **High** | `desktop/main.js:113` | `serverChild.kill()` has no timeout or SIGKILL fallback; a hung child becomes a zombie. |
| 7 | **High** | `scanner/server.js:234` | `httpHeaders` fetches response headers but never consumes the response body, leaking sockets in Node.js's undici pool. |
| 8 | **Medium** | `intel/server.js:192` | `isYenteAvailable` fetches `/healthz` but never consumes the response body, leaking sockets. |
| 9 | **Medium** | `desktop/main.js:241` | `win.show()` in `ready-to-show` has no `isDestroyed()` guard — throws if the window is destroyed before the event fires. |
| 10 | **Medium** | `scripts/sdk_ingester.js:179` | `setInterval` is never cleared; no `SIGTERM`/`SIGINT` handler means the process hangs on shutdown signals. |

---

## 1. Memory Leaks

| Severity | File | Issue | Impact | Recommendation |
|----------|------|-------|--------|----------------|
| Critical | `intel/server.js:895` | `setInterval(() => loadSanctions(), SDN_REFRESH_MS)` is never stored or cleared. | Interval fires every 24h forever; during `shutdown()` the server closes but the interval keeps the event loop alive and can trigger a fresh `loadSanctions()` while the process is trying to exit. | Store the interval handle: `const refreshInterval = setInterval(...)`; clear it in `shutdown()` with `clearInterval(refreshInterval)`. |
| Medium | `desktop/main.js:202-211` | `serverChild.on('error', ...)` and `serverChild.on('exit', ...)` listeners are never removed. | On child replacement, the old `ChildProcess` object still carries listeners; if the child lingers (zombie) the references persist. | Call `serverChild.removeAllListeners()` in `releaseChild()` before nulling the reference. |
| Medium | `desktop/main.js:245,249` | `win.webContents.on('render-process-gone', ...)` and `win.webContents.on('crashed', ...)` are added on every `createWindow()` call and never removed. | On macOS, repeated window recreate/close cycles can accumulate orphaned listener references on destroyed `webContents`. | Use `win.webContents.once(...)` instead of `.on(...)`, or remove listeners in `win.once('closed', ...)`. |
| Medium | `scripts/sdk_ingester.js:179` | `setInterval(runIngestCycle, 10000)` handle is never stored or cleared. | If the script is imported as a module or wrapped in a process manager, the interval keeps the process alive indefinitely. | Store the interval handle and add `process.on('SIGTERM', ...)` / `process.on('SIGINT', ...)` cleanup that calls `clearInterval`. |
| Low | `intel/server.js:192` | `isYenteAvailable` fetches `/healthz` but never reads `res.body`. | In Node.js's undici-backed `fetch`, unconsumed bodies can leave sockets in the connection pool longer than necessary. | Call `await res.body?.cancel?.()` or consume with `await res.text()` before returning. |
| Low | `scanner/server.js:234` | `httpHeaders` fetches a response but never consumes the body. | Same undici socket-pool issue as above; the socket is held until the abort signal fires (8s) or the pool reaps it. | Consume the body with `await res.blob()` or `await res.text()` before returning headers, or use `res.body?.cancel()`. |
| Low | `proxy.ts:31-37` | `send()` fires `fetch` with `.catch(() => {})` but never consumes the response body. | Undici may hold the socket until the 3s abort signal fires. | Add `await res.body?.cancel?.()` after the fetch, or switch to a fire-and-forget HTTP client that doesn't require body consumption. |

---

## 2. Unbounded Growth

| Severity | File | Issue | Impact | Recommendation |
|----------|------|-------|--------|----------------|
| High | `desktop/main.js:165` | `server.log` is opened with `fs.openSync(logPath, 'a')` on every server start but never rotated or truncated. | Log file grows without bound; eventually fills the disk and can crash the app or the system. | Implement log rotation (e.g., rename to `server.log.1` when it exceeds a size threshold, or use a rotating file stream like `rotating-file-stream`). |
| Medium | `intel/server.js:65` | `sanctionsIndex` replaces the entire in-memory index on each refresh. | During `loadSanctions()`, both the old and new index coexist, doubling peak memory. For a large CSV this can spike RSS significantly. | Stream-parse the CSV or free the old index arrays before building the new one. |
| Low | `intel/server.js:246` | `wdCache` LRU cache has a max of 10,000 entries but cached values can be large graph objects. | Each cached entry is a deep object (`nodes` + `links`); with 10k entries, memory can grow to tens of MBs. | Add a size-based eviction policy or TTL with a lower cap, and prune old entries periodically. |
| Low | `scripts/generate_cables.js` | `features` array grows to 2,400 GeoJSON features and is written as a single JSON blob. | Static at generation time, but if the loop bounds are increased, this could generate multi-hundred-MB files. | Cap the loop counts or add a `MAX_FEATURES` guard. |

---

## 3. Error Handling

| Severity | File | Issue | Impact | Recommendation |
|----------|------|-------|--------|----------------|
| High | `desktop/main.js:245,249` | `render-process-gone` and `crashed` reload the window without any retry limit or backoff. | A persistent renderer crash (bad GPU driver, corrupted web storage) triggers an infinite reload loop, consuming CPU and potentially corrupting session state. | Add a `rendererCrashCount` with exponential backoff; after N crashes show a fatal-error page and exit. |
| Medium | `desktop/main.js:241` | `win.once('ready-to-show', () => win.show())` — no guard for destroyed window. | If `win` is destroyed before `ready-to-show` fires (race condition), `win.show()` throws "Object has been destroyed". | Change to `win.once('ready-to-show', () => { if (win && !win.isDestroyed()) win.show(); })`. |
| Medium | `desktop/main.js:35-44` | `writeSmoke()` silently swallows all write errors. | If the smoke output file can't be written, the CI verifier times out with no diagnostic output. | Log the error: `catch (e) { console.error('Smoke write failed:', e.message); }`. |
| Medium | `intel/server.js:101` | `loadSanctions()` has no guard against concurrent invocation. | If the 24h interval fires while a previous load is still running (e.g., network slow), two loads run concurrently, wasting bandwidth and memory. | Add a `isLoadingSanctions` boolean guard at the top of `loadSanctions()`. |
| Medium | `desktop/after-pack.js:21-22` | `fs.rmSync` and `fs.cpSync` have no error handling. | If the destination is locked or disk is full, the build throws an unhandled exception and the electron-builder hook fails. | Wrap in `try/catch` and throw a descriptive error. |
| Medium | `scripts/extract_v51.js:6` | `fs.readFileSync(transcriptPath, 'utf8')` with no existence check. | If the file is missing, a raw `ENOENT` stack trace is thrown. | Add `if (!fs.existsSync(transcriptPath)) { console.error(...); process.exit(1); }`. |
| Medium | `scripts/restore_telegeography_cables.js:25` | `fs.writeFileSync(outputFile, ...)` has no error handling. | If `public/data` doesn't exist or is read-only, the write fails silently. | Add `try/catch` around the write and check the directory exists first. |
| Low | `scripts/generate_cables.js:78` | `fs.writeFileSync` has no error handling. | Same as above — silent failure on disk full. | Wrap in `try/catch`. |
| Low | `scripts/patch_*.js` (multiple) | All patch scripts read and write files with no `try/catch`. | If the target files are missing or read-only, the scripts crash with unhandled exceptions. | Wrap `readFileSync`/`writeFileSync` in `try/catch` and exit with a non-zero code on failure. |

---

## 4. Async & Concurrency

| Severity | File | Issue | Impact | Recommendation |
|----------|------|-------|--------|----------------|
| Medium | `intel/server.js:101` | `loadSanctions()` can be invoked concurrently by the `setInterval` timer. | Two concurrent fetches of the same large CSV, wasted bandwidth, and a race to replace `sanctionsIndex`. | Add an `isLoadingSanctions` boolean lock at the top of `loadSanctions()`. |
| Medium | `scripts/sdk_ingester.js:35` | `runIngestCycle()` has a `running` boolean guard, but the first invocation at line 178 is not awaited before the interval is set. | If `runIngestCycle()` throws synchronously (unlikely but possible), the interval is still set. | Move `setInterval` into the `finally` block or await the first call. |
| Low | `desktop/main.js:86-108` | `waitForServer` uses `maxAttempts = Math.ceil(timeoutMs / 300)` but the actual per-attempt wall-clock time is `~300ms + request_time`. | The `maxAttempts` check is redundant and slightly misleading, but the `Date.now()` check is the real guard. | Remove `maxAttempts` and rely purely on the `Date.now()` timeout check. |
| Low | `scanner/server.js:178-195` | `portScan` workers share `idx` via `idx++` across concurrent `await` boundaries. | In JavaScript's single-threaded event loop, `idx++` is atomic for the `while` loop, but this is a fragile pattern. | Use a proper task queue or `async-sema` / `p-limit` for concurrency control. |

---

## 5. Resource Management

| Severity | File | Issue | Impact | Recommendation |
|----------|------|-------|--------|----------------|
| Critical | `intel/server.js:895` | `setInterval` for sanctions refresh is never cleared during `shutdown()`. | Keeps the process alive during graceful shutdown; may trigger a new `loadSanctions()` while HTTP server is closing. | Store the interval handle and clear it in `shutdown()`. |
| High | `desktop/main.js:113` | `serverChild.kill()` has no timeout or fallback to `SIGKILL`. | If the child ignores SIGTERM (e.g., stuck in a busy loop), it becomes a zombie process. | Send `SIGTERM`, then `setTimeout(() => serverChild.kill('SIGKILL'), 5000)` as a fallback. |
| High | `scanner/server.js:234` | `httpHeaders` never consumes the fetch response body. | Undici holds the socket in the pool until the 8s abort fires, reducing available connections. | Consume or cancel the body before returning. |
| Medium | `desktop/main.js:119-126` | `logFd` is closed in `stopEmbeddedServer()` but also closed in `releaseChild()`; the second close is wrapped in `try/catch`. | Harmless but redundant; the double-close pattern is a code smell. | Only close `logFd` in one place; track a `logFdClosed` flag. |
| Medium | `scripts/sdk_ingester.js:179` | No cleanup of the `setInterval` on process exit. | Process hangs on `SIGTERM` until the next interval tick fires or the process is force-killed. | Add `process.on('SIGTERM', ...)` and `process.on('SIGINT', ...)` that clear the interval. |
| Low | `scanner/server.js:205-232` | `tlsInfo` calls `sock.end()` but not `sock.destroy()`. | The TLS socket may linger in a half-closed state until the peer closes it. | Call `sock.destroy()` after `resolve()` to ensure immediate socket release. |
| Low | `desktop/main.js:93-104` | `waitForServer` creates `http.get` requests but does not explicitly abort the `ClientRequest` on the success path. | `res.destroy()` closes the response, but the request object may persist briefly. | Call `req.destroy()` in the success path as well. |
| Low | `scripts/restore_telegeography_cables.js:7-31` | `https.get` response is accumulated into a single `data` string. | For a very large JSON payload, this uses more memory than streaming. | Use `pipeline` or pipe to a temporary file, then parse. |

---

## 6. Electron-Specific

| Severity | File | Issue | Impact | Recommendation |
|----------|------|-------|--------|----------------|
| High | `desktop/main.js:245,249` | `render-process-gone` and `crashed` handlers reload indefinitely. | Infinite reload loop on persistent renderer crashes; can hang the app and spike CPU. | Add a `rendererCrashCount` with a cap (e.g., 3 crashes) and show a fatal error page after the limit. |
| Medium | `desktop/main.js:241` | `win.once('ready-to-show', () => win.show())` lacks a destroyed-window check. | Throws if the window is destroyed before the event fires. | Guard with `if (win && !win.isDestroyed()) win.show()`. |
| Medium | `desktop/main.js:302-307` | `ipcMain.handle('osiris:relaunch', ...)` calls `app.relaunch()` then `app.quit()`. | On macOS, `app.quit()` can be blocked by `before-quit` handlers; if blocked, `relaunch()` has already queued a relaunch, causing a double-start. | Reverse the order: `app.quit(); app.relaunch();` or set `app.relaunch({ args: process.argv.slice(1).concat(['--relaunch']) })` and rely on `app.on('will-quit')`. |
| Medium | `desktop/main.js:329` | `app.on('activate', ...)` is registered inside `app.whenReady().then(...)` but uses `createWindow().catch(...)`. | If `createWindow()` throws on activate, the error is logged but the user sees no window. | Also notify the user via a dialog or native notification. |
| Low | `desktop/main.js:345` | `app.on('before-quit', ...)` calls `stopEmbeddedServer()` but doesn't wait for the child to exit. | Electron may quit before the child is fully terminated, leaving a zombie on some platforms. | Wait for the child `exit` event before allowing quit to proceed (use `event.preventDefault()` + `app.quit()` after confirmation). |
| Low | `desktop/main.js:350-359` | `process.on('SIGTERM')` and `process.on('SIGINT')` are not supported on Windows for packaged GUI apps. | On Windows, these signals don't fire in a packaged Electron app; cleanup is skipped. | Add `app.on('window-all-closed', ...)` cleanup or use Electron's `app.on('before-quit')` exclusively. |
| Low | `desktop/main.js:310-312` | `app.requestSingleInstanceLock()` failure calls `app.quit()` immediately. | No cleanup of partially initialized resources (though minimal at this point). | Fine as-is; just note that `app.quit()` before `ready` is a no-op on some platforms. |
| Low | `desktop/preload.js:10-21` | `contextBridge.exposeInMainWorld` is called once. | If the preload is reloaded (e.g., during a renderer crash), the bridge is re-registered. This is generally safe. | No action needed. |

---

## 7. Process Management

| Severity | File | Issue | Impact | Recommendation |
|----------|------|-------|--------|----------------|
| High | `desktop/main.js:113` | `serverChild.kill()` without timeout or `SIGKILL` fallback. | Hung child processes become zombies; on repeated restarts, the system accumulates orphan Node processes. | `serverChild.kill('SIGTERM'); setTimeout(() => { if (serverChild) serverChild.kill('SIGKILL'); }, 5000);` |
| Medium | `scripts/sdk_ingester.js:179` | No `SIGTERM`/`SIGINT` handlers to stop the interval. | The process hangs on shutdown signals; container orchestrators may force-kill after a timeout. | Add signal handlers that clear the interval and exit gracefully. |
| Medium | `intel/server.js:882-886` | `shutdown()` calls `server.close(() => process.exit(0))` with a 5s forced-exit fallback. | The `setInterval` for sanctions refresh is not cleared, so the process may not exit gracefully within 5s. | Clear the interval in `shutdown()`. |
| Medium | `scanner/server.js:418-422` | Same `shutdown()` pattern as `intel/server.js` — no timer cleanup. | Same issue, though `scanner/server.js` has no intervals to leak. | Still good practice to add a catch-all timer cleanup. |
| Low | `desktop/main.js:350-365` | `process.on('SIGTERM')`, `SIGINT`, `unhandledRejection`, `uncaughtException` all call `app.quit()` without setting `process.exitCode`. | If `app.quit()` is blocked (e.g., on macOS), the process exits with code 0, which may mislead process managers. | Set `process.exitCode = 1` in all error handlers. |
| Low | `desktop/main.js:46-51` | `quitWithCode()` sets `process.exitCode` but then calls `app.quit()`. | On macOS, `app.quit()` is asynchronous and may not exit immediately. | Consider calling `process.exit(code)` after a short timeout if the app hasn't quit. |

---

## 8. TypeScript / Runtime Safety

| Severity | File | Issue | Impact | Recommendation |
|----------|------|-------|--------|----------------|
| Medium | `desktop/main.js:293-298` | `ipcMain.handle('osiris:getPath', (_e, name) => ...)` passes `name` directly to `app.getPath(name)`. | `name` is untrusted renderer input. While `app.getPath` validates the name, an invalid name throws. | Validate `name` against a allowlist before calling `app.getPath`. |
| Medium | `scripts/patch_*.js` (multiple) | All patch scripts read files without checking existence first. | `fs.readFileSync` throws `ENOENT` if the target file is missing. | Add `fs.existsSync` checks before reads. |
| Medium | `scripts/extract_v51.js:12` | `obj.tool_calls[0].args.CodeContent` with no null/length checks. | If `tool_calls` is empty or `args` is missing, this throws. | Guard with `obj.tool_calls?.[0]?.args?.CodeContent`. |
| Low | `next.config.ts:8` | `outputFileTracingRoot: process.cwd()` assumes the build is run from the project root. | If built from a different directory, standalone tracing includes the wrong paths. | Validate `process.cwd()` or use `__dirname` resolution. |
| Low | `proxy.ts:11` | `process.env.UMAMI_ENDPOINT` is used directly in `fetch()` without URL validation. | If the env var contains an invalid URL, `fetch` throws. | Wrap in `try/catch` or validate with `new URL(endpoint)`. |
| Low | `scanner/server.js:38` | `process.env.PORT || process.env.SCANNER_PORT || 7700` — `PORT` is a generic env var. | May conflict with other services using `PORT`. | Prefer `SCANNER_PORT` only, or validate the port is in a valid range. |
| Low | `desktop/runtime-config.js:16` | `buildEngineEnv(processEnv = process.env, ...)` uses `process.env` as a default parameter. | Default parameters are evaluated at call time, but this is safe. | No action needed. |

---

## 9. Data Integrity

| Severity | File | Issue | Impact | Recommendation |
|----------|------|-------|--------|----------------|
| High | `desktop/main.js:64` | `writeSettingsFile` writes directly to `settings.json` with no temp-file + rename pattern. | If the process crashes or power is lost during the write, `settings.json` is truncated/corrupted. | Write to `settings.json.tmp`, then `fs.renameSync` to `settings.json`. |
| High | `scanner/server.js:272` | `subdomains` uses `encodeURIComponent('%.${domain}')` with single quotes, so `${domain}` is **not interpolated**. | The crt.sh query always searches for the literal string `%.${domain}` instead of the actual domain. | Use template literal or concatenation: `encodeURIComponent('%.' + domain)` or `\`%.\${domain}\``. |
| Medium | `scripts/upgrade_v5.js:49` | `fs.writeFileSync('src/app/page.tsx', page)` writes even if no changes were made. | Unnecessary filesystem churn and potential timestamp changes. | Only write if `page !== original`. |
| Medium | `scripts/upgrade_v5_1.js:163` | `fs.writeFileSync('public/data/submarine-cables.json', JSON.stringify(cablesData))` writes in-place with no temp file. | Crash during write corrupts the GeoJSON. | Use temp-file + rename pattern. |
| Medium | `scripts/patch_*.js` (multiple) | All patch scripts use fragile string-replacement and silently skip if the anchor is not found. | If source code drifts, the patch fails silently and the app may ship with broken features. | Exit with a non-zero code if any expected anchor is not found. |
| Medium | `scripts/restore_telegeography_cables.js:25` | `fs.writeFileSync(outputFile, ...)` with no temp file. | Same crash-during-write corruption risk. | Use temp-file + rename. |
| Low | `scripts/disable_sdk_links.js:6` | `fs.writeFileSync` with no temp file or backup. | Corruption risk if the write is interrupted. | Write to `.tmp` and rename. |
| Low | `scripts/generate_cables.js:78` | `fs.writeFileSync` with no temp file. | Same as above. | Use temp-file + rename. |
| Low | `desktop/after-pack.js:21` | `fs.rmSync(dest, { recursive: true, force: true })` followed by `fs.cpSync`. | Not atomic; if the copy fails partway, the destination is in a partial state. | Stage to a temp directory and rename. |
| Low | `desktop/prepare-standalone.js:25` | Same pattern: `fs.rmSync` then `fs.cpSync`. | Same partial-state risk. | Use temp staging + rename. |

---

## 10. Configuration Stability

| Severity | File | Issue | Impact | Recommendation |
|----------|------|-------|--------|----------------|
| Medium | `next.config.ts:15` | `images.remotePatterns: [{ protocol: 'https', hostname: '**' }]` allows images from any HTTPS origin. | Out of security scope, but from a stability standpoint, untrusted image servers can cause timeouts, large payloads, and renderer memory pressure. | Restrict to known domains, or add `deviceSizes`/`imageSizes` limits. |
| Medium | `proxy.ts:11` | `process.env.UMAMI_ENDPOINT` is used without validation. | An invalid URL causes `fetch` to throw; while caught, it spams the error log. | Validate with `URL` constructor before use. |
| Low | `intel/server.js:27` | `PORT = process.env.INTEL_PORT || 4000` with no validation. | If `INTEL_PORT` is set to a non-numeric string, `app.listen` throws. | Parse with `parseInt` and validate `Number.isFinite`. |
| Low | `scanner/server.js:38` | `PORT = process.env.PORT || process.env.SCANNER_PORT || 7700` with no validation. | Same as above. | Parse and validate the port. |
| Low | `desktop/runtime-config.js:2` | `DESKTOP_ENGINE_DEFAULTS` hardcodes `http://127.0.0.1:4000` and `7700`. | If these ports are already in use on the user's machine, the services fail to start. | Consider port scanning or randomization for the defaults. |

---

## Positive Findings (Worth Noting)

- **`desktop/main.js`**: `requestSingleInstanceLock`, `before-quit` cleanup, `SIGTERM`/`SIGINT` handlers, and `unhandledRejection`/`uncaughtException` handlers are all present. Good foundation.
- **`desktop/main.js`**: `getFreePort()` dynamically allocates a port to avoid conflicts. The `waitForServer` probe uses `http.get` with timeouts.
- **`intel/server.js`**: Rate limiter (`isRateLimited`) has TTL cleanup and a max entry cap. `wdCache` has a bounded size with LRU eviction.
- **`scanner/server.js`**: `validateTarget` has robust SSRF protection with IP blocklists, hostname validation, and DNS resolution checks. `portScan` uses bounded concurrency (`PORT_SCAN_CONCURRENCY`).
- **`scanner/server.js`**: `MAX_WHOIS_BYTES` caps WHOIS response size to prevent memory abuse.
- **`proxy.ts`**: Uses `AbortSignal.timeout(3000)` to prevent analytics hangs, and `event.waitUntil` for fire-and-forget tracking.
- **`scripts/sdk_ingester.js`**: `running` boolean guard prevents overlapping ingest cycles.

---

*End of report.*
