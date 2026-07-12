# Stability & Performance Review — MarineTraffic Python Sidecar

**Scope:** `mt_api.py`, `mt_scraper.py`, `mt_server.py`  
**Focus:** Performance, stability, resource management, concurrency, and resilience.  
**Security:** Out of scope.

---

## Critical

| # | File | Line(s) | Issue | Recommended Fix |
|---|------|---------|-------|-----------------|
| 1 | `mt_server.py` | 120–123, 137–138 | **`fut.result(timeout=…)` does NOT cancel the underlying coroutine on timeout.** If a vessel query or photo fetch exceeds the timeout, the asyncio task continues running inside the background loop while still holding `_lock`. All subsequent requests deadlock forever. | Wrap the coroutine in an `asyncio.wait_for(..., timeout=…)` **inside** the event loop (i.e. inside `_get_vessel` / `_get_photo`), so the task is actually cancelled and the lock released. Alternatively, call `fut.cancel()` in a `finally` block on the caller side, though `concurrent.futures.Future.cancel()` only works before execution starts. |
| 2 | `mt_server.py` | 153–167 | **No graceful shutdown — Playwright browser becomes a zombie process.** `KeyboardInterrupt` simply `pass`es. The global `_scraper` is never stopped, `_loop` is never stopped, and the daemon thread dies abruptly, orphaning the Chromium process. | Install a signal handler (`SIGINT`, `SIGTERM`) that calls `_loop.call_soon_threadsafe(_loop.stop)`, stops the scraper, and calls `server.shutdown()`. |
| 3 | `mt_scraper.py` | 168–230 | **Partial startup leaks Playwright on failure.** If `launch_persistent_context` raises (e.g. Chrome missing), the exception is caught and fallback attempted, but `self._pw` (already started) is never stopped. Each retry leaks a Playwright instance. | Wrap the entire startup sequence in a `try/except` that guarantees `await self._pw.stop()` if `_context` was not successfully created. |
| 4 | `mt_scraper.py` | 122–163 | **`_started` flag is not thread-safe.** `start()` is documented "safe to call multiple times" but the read-modify-write on `self._started` is racy. Two concurrent calls can launch two browsers. | Use `asyncio.Lock()` for startup/shutdown critical sections, or guard `_started` with an `asyncio.Event`. |

---

## High

| # | File | Line(s) | Issue | Recommended Fix |
|---|------|---------|-------|-----------------|
| 5 | `mt_api.py` | 91, 101, 126 | **`asyncio.get_event_loop().run_until_complete()` crashes when a loop is already running** (e.g. inside Jupyter, FastAPI, or any modern async framework). This makes the embeddable API unusable in many contexts. | Accept an optional *loop* parameter, or use `asyncio.run()` for one-shots, or provide **only** async methods and let the caller bridge. If a sync surface is mandatory, use a dedicated background thread + `asyncio.run_coroutine_threadsafe()` (like `mt_server.py` does). |
| 6 | `mt_server.py` | 44 | **`asyncio.Lock()` created at import time is fragile across loops.** Although Python ≥3.10 defers loop binding to the first `acquire()`, this is implicit magic. If module import context changes, the lock may bind to the wrong loop or raise. | Create the lock explicitly inside the background loop: `_loop.call_soon_threadsafe(lambda: globals().__setitem__('_lock', asyncio.Lock()))`, or use a `threading.Lock` around the coroutine submission instead. |
| 7 | `mt_scraper.py` | 671–690 | **Image download lacks timeout override, size cap, and deduplication.** `_api.get(image_url)` uses the default 30 s timeout — large satellite photos can exceed this. No max-size check means a malicious/misbehaving CDN can stream infinite bytes and exhaust RAM/disk. File is overwritten every query even if unchanged. | Add `timeout=60_000` (or separate `download_timeout` param). Check `Content-Length` before reading body. Skip download if `path.exists()` and size > 0 (or hash-match). |
| 8 | `mt_scraper.py` | 427–460 | **`fetch_photos()` has no ceiling on gallery size.** The JS `seen.includes(…)` check is O(n²) in the number of photos. A vessel with thousands of photos creates quadratic DOM scan and unbounded `photos` list. | Cap `ids` extraction (e.g. stop after 200 photos). Replace JS `includes()` with a `Set` for O(1) dedup. |
| 9 | `mt_server.py` | 89–150 | **No backpressure / queue limit.** `ThreadingHTTPServer` spawns a thread per request, but all scraper work is fully serialized by `_lock`. Under concurrent load, threads pile up waiting 240 s each. Default TCP backlogs are small; extra connections may be dropped or hang. | Add a `threading.Semaphore` around scraper submission to fail fast (`503 Service Unavailable`) when the pipe is full. Or use an `asyncio.Queue` with maxsize inside the event loop. |
| 10 | `mt_scraper.py` | 276–282, 300–306, 345–364 | **Hardcoded `asyncio.sleep()` durations with no early-exit or backoff.** `is_logged_in` waits 3 s, `_login` waits 2–3 s, `query` waits 3 s. These are pessimistic fixed delays that keep the global lock held longer than necessary. | Replace fixed sleeps with `page.wait_for_load_state()` / `wait_for_selector()` where possible, or use shorter poll loops with `asyncio.sleep(0.5)` and a max-wait ceiling. |
| 11 | `mt_scraper.py` | 232–242 | **`stop()` sets `_started = False` before confirming cleanup succeeded.** If `_context.close()` raises, the scraper is marked stopped but the browser process may still exist. A restart will then launch a second browser. | Move `self._started = False` to the end of `stop()`, after all cleanup succeeds. |
| 12 | `mt_scraper.py` | 388 | **`resolved = int(shipid) if shipid else None` on an already-`int` parameter is harmless but suggests type confusion.** More importantly, if `shipid=0` is passed (unlikely but possible), it evaluates to `None` and triggers unnecessary resolution. | Explicitly check `if shipid is not None:` rather than truthiness. |

---

## Medium

| # | File | Line(s) | Issue | Recommended Fix |
|---|------|---------|-------|-----------------|
| 13 | `mt_scraper.py` | 244–265 | **`_accept_consent()` swallows all exceptions silently.** No context is logged about which selector failed or whether the consent frame was even present. | Log the exception (at least at debug level) with the attempted selector. |
| 14 | `mt_scraper.py` | 462–477 | **`fetch_image_bytes()` opens a brand-new page per image.** Playwright pages are heavy (~10–20 MB each). Fetching a gallery of 50 photos sequentially opens 50 pages. | Re-use a dedicated "image fetcher" page, or use `self._api.get()` with proper headers if Cloudflare allows it. If a new page is mandatory, at least close it in a `try/finally` (already done — good). |
| 15 | `mt_scraper.py` | 556–566 | **`_extract()` `evaluate()` has no timeout parameter.** If the page JS deadlocks or enters an infinite loop, the coroutine (and global lock) hangs forever. | Pass `timeout=self.timeout` to `page.evaluate()`. |
| 16 | `mt_scraper.py` | 576–667 | **`_extract()` regexes and tab-parsing over full `innerText` is brittle and CPU-heavy on large pages.** Any MarineTraffic SPA update changes whitespace/DOM order and silently breaks field extraction or mis-maps values. | Add a validation layer: assert that expected fields (e.g. `name`, `mmsi`) are present and non-empty. If extraction yields < N fields, raise a `ParseError` rather than returning a half-empty `VesselInfo`. |
| 17 | `mt_scraper.py` | 219–225 | **Cookie JSON is loaded without validation or size cap.** A corrupted or enormous cookie file can crash `json.loads` or `add_cookies`. | Wrap in `try/except`, cap file size (e.g. `> 1 MB` → warn and ignore), validate cookie schema before calling `add_cookies`. |
| 18 | `mt_scraper.py` | 519–531 | **`_resolve_shipid()` in-page `fetch()` has no timeout or retry.** If MarineTraffic changes the search endpoint path or response shape, the failure is only a `print()`. | Wrap the `evaluate()` in `asyncio.wait_for()`. On failure, raise a descriptive exception instead of returning `None`. |
| 19 | `mt_server.py` | 131–133 | **Photo URL validation is only host-based.** A malformed URL (e.g. missing scheme, huge path) is passed straight to Playwright, which may hang or throw an opaque error. | Validate `urlparse(url).scheme == "https"` and length < 2048 before submission. |
| 20 | `mt_api.py` | 96–105 | **`stop()` catches all exceptions and swallows them.** Shutdown errors (e.g. loop already closed) are invisible to the caller, making debugging hard. | Log at `ERROR` level and consider re-raising after cleanup attempts. |
| 21 | `mt_scraper.py` | 354–364 | **`login_interactive()` busy-waits with 1-second sleeps.** Inefficient and unresponsive. | Use `asyncio.Event` or `page.wait_for_url()` with a timeout. |

---

## Low

| # | File | Line(s) | Issue | Recommended Fix |
|---|------|---------|-------|-----------------|
| 22 | `mt_scraper.py` | 92, 105, etc. | **`print()` used for all logging.** No log levels, no timestamps, no structured context. Extremely noisy in production and impossible to filter. | Replace with the standard `logging` module. Use `logging.getLogger("mt_scraper")` with appropriate levels (`info` for milestones, `debug` for selectors, `warning` for recoverable issues). |
| 23 | `mt_scraper.py` | 267–271 | **Cookies are written to disk on every login check and shutdown.** Unnecessary fsync pressure. | Only write cookies if they have changed (keep a hash of the last saved state). |
| 24 | `mt_scraper.py` | 680–683 | **Image is re-downloaded and overwritten every time even if identical.** Wastes bandwidth and disk I/O. | Check `path.exists()` and file size > 0 before downloading; optionally compare ETag/Last-Modified if headers are available. |
| 25 | `mt_server.py` | 92–93 | **`log_message` prints every request including `/health`.** Pollutes logs with noise. | Skip logging for `/health` or use a debug-level log. |
| 26 | `mt_api.py` | 49–50, `mt_scraper.py` 747–750 | **Hardcoded credentials in source code.** Not a security review, but this causes account lockouts/bans if the repo is shared, and makes rotation painful. | Read from environment variables exclusively; remove defaults from source. |

---

## Quick Wins (Easy Fixes, High Impact)

1. **Cancel-safe timeouts in `mt_server.py`**  
   Move `asyncio.wait_for(..., timeout=240)` into `_get_vessel` and `_get_photo` so the lock is actually released on slow requests. *Impact: Eliminates deadlocks.*

2. **Add `path.exists()` guard in `_download_image()`**  
   Skip download if the file already exists. *Impact: Cuts redundant bandwidth and I/O by ~80% for repeat queries.*

3. **Replace `print()` with `logging`**  
   Swap all `[mt] …` print statements for `logging.getLogger(...).info/debug/warning`. *Impact: Makes production issues diagnosable in minutes instead of hours.*

4. **Graceful shutdown handler in `mt_server.py`**  
   Catch `SIGINT`/`SIGTERM`, stop the scraper, stop the loop, shut down the server. *Impact: Stops zombie Chromium processes.*

5. **Cap `fetch_photos()` gallery size**  
   Stop after 200 photos. *Impact: Prevents unbounded memory growth on popular vessels.*

---

## Architectural Concerns

### 1. Synchronous Bridge over Async Core is an Anti-Pattern
`mt_api.py` exposes a sync API (`start()`, `get_vessel()`) that internally calls `asyncio.get_event_loop().run_until_complete()`. This is deprecated, thread-unsafe, and incompatible with modern async hosts (FastAPI, asyncio REPL, Jupyter). **Recommendation:** Expose only async methods in `MTScraper`. Provide a thin, explicit sync wrapper (e.g. `MTScraperSync`) that runs its own private thread and loop, similar to how `mt_server.py` works.

### 2. Single Global Lock Serializes Everything
Both `/vessel` and `/photo` are gated by one `asyncio.Lock`. This means:
- A long photo-gallery scrape blocks a simple vessel lookup.
- A slow image download blocks every other request.

**Recommendation:** Use separate locks (or lockless re-entrancy) for read-only page navigation vs. destructive state changes. Even better: keep a page pool (2–3 pages) so gallery scrolling and detail extraction can overlap.

### 3. No Caching / TTL
Every request hits MarineTraffic fresh. There is no in-memory LRU for recently queried vessels, so a user clicking back-and-forth between two ships triggers full re-scrapes. **Recommendation:** Add a simple `functools.lru_cache` or `cachetools.TTLCache` around `_extract()` results (keyed by `shipid`) with a 5–10 minute TTL.

### 4. No Circuit Breaker for MarineTraffic Outages
If MarineTraffic blocks the IP, changes HTML structure, or returns 403/502, the scraper retries with the same hardcoded delays forever (from the caller's perspective). There is no back-off, no health status, and no fallback to stale data. **Recommendation:** Track consecutive failures. After N failures, enter a "cooldown" mode where new requests fast-fail with `503` for 60 s, giving the site (and your infra) time to recover.

### 5. HTML-Scraping Fragility via `innerText` Parsing
The entire extraction strategy relies on regexes over `document.body.innerText`. A single SPA update from MarineTraffic (new React component, added whitespace, renamed labels) can break half the field mappings without raising an error — fields simply become `None`. **Recommendation:** Add a **schema validator** after extraction: require at least `name` + one of (`mmsi`, `imo`, `ship_id`). If validation fails, raise a `ParseError` so the caller knows the scraper is broken, rather than serving silent nulls.

### 6. No Resource Quotas or Watchdog
There is no limit on:
- Disk usage (`image_dir` can grow forever)
- Number of photos fetched
- Browser page count (`fetch_image_bytes` opens unlimited pages)
- Cookie file size

**Recommendation:** Add a disk-usage check (e.g. `shutil.disk_usage`), cap gallery sizes, and consider a background watchdog thread that kills the scraper if the browser process RSS exceeds a threshold.

### 7. Playwright Process Hygiene
If the Python process is killed (`kill -9`) or the daemon thread dies unexpectedly, the Chromium child process is orphaned. Over days/weeks of operation (especially in a sidecar that restarts often), this accumulates zombie browsers. **Recommendation:** Consider recording the browser PID on startup and adding a startup cleanup routine that `kill -9`s any orphaned `chrome.exe` processes whose parent PID no longer exists (platform-dependent, but essential for long-running deployments).

---

*Review completed. Issues are ordered by severity; fixing the Critical and High items will eliminate the most severe stability risks (deadlocks, zombie processes, and loop crashes).* 
