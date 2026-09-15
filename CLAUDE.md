# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node/Express service that scrapes AmuseLabs-powered crossword puzzles from a fixed set of news sites and returns the puzzle as a base64-encoded JSON payload. `POST /decode/:type` with `{"targetDate":"YYYY-MM-DD"}` dispatches to a per-site runner registered in the `RUNNERS` map in `server.js`. Deployed to Cloud Run.

## Commands

```bash
npm test                          # run every runner against today's Pacific date
npm test -- vox latimes           # run specific runners
node tests/run-runners.mjs vox 2026-07-27   # a single runner for a specific date
npm run test:vox                  # per-runner shortcut (one script per runner)
npm run build                     # gcloud run deploy (see notes below)
node server.js                    # local server on :8080
```

There is no lint step and no unit-test framework. `tests/run-runners.mjs` is an integration harness: it invokes runners against live sites, base64-decodes the result, and fails if it doesn't parse as puzzle JSON. Runs take tens of seconds each and can fail for reasons outside the code (site redesign, ad-vendor timeouts, paywall state) — a failure is a signal to look, not automatically a regression.

`npm run build` is the full deploy command line; the Cloud Run config lives there, not in a YAML file. It carries: `--concurrency 1` (one Chrome per instance), 2Gi/2CPU, Newsday credentials from Secret Manager, and a Cloud Storage volume (`tryhard-word-games-sessions`) mounted at `/app/.cache` so the cookie cache survives cold starts and is shared across instances.

## Architecture

`browser.mjs` is the shared engine; `sites/*.mjs` are thin, per-site navigation scripts. Every runner follows the same shape:

1. `getPuppeteerBrowser(url, opts)` — launches stealth Puppeteer, disables the HTTP cache, optionally pre-seeds cookies, and CDP-blocks ad/verification domains.
2. Reach the AmuseLabs iframe (`waitForAmuselabsFrame`, or site-specific frame hunting) and register it with `setPuzzleFrame`.
3. `startTracking(page)` — **must** happen before the puzzle's scripts load, since the decoder is recovered from the script bodies themselves.
4. Navigate the picker to the target date (`navigateToDatedPuzzle`, matching a `data-id`/`aria-label` containing a site-specific date format).
5. `finishRun(puzzleFrame, page, browser)` — decodes and closes the browser in a `finally`.

### How decoding works

AmuseLabs ships the puzzle as an obfuscated `rawc` string in `#params` inside the iframe, unscrambled by a per-deployment obfuscated JS function. Rather than reimplementing it, `browser.mjs` captures every script response served into the puzzle frame (`trackResponses` → `scriptSources`), parses each with acorn, and finds the decoder heuristically (`findDecoderFunction`): a one-parameter function whose body does `.split('')`/`.join('')` and contains ≥1 temp-variable swap triplet and ≥2 `for` loops, scored to prefer the deepest match. That function is then executed in a `vm` sandbox on the `rawc` value and its output is validated as base64→JSON before being returned.

Consequences worth knowing before changing anything:

- **"Decoder function not found" is usually a navigation bug, not an obfuscation change.** It means the puzzle page was never reached (the picker page has its own `#params` but no decoder), or tracking started too late, or requests were intercepted so bodies couldn't be read.
- Never switch to `page.setRequestInterception` — routing requests through the Fetch domain makes `Network.getResponseBody` return nothing, so `scriptSources` silently ends up empty. Blocking is done with `Network.setBlockedURLs` for exactly this reason.
- `setPuzzleFrame` resets the tracking maps, so scripts from a previously-tracked frame can't produce a corrupted decode.

### Timing primitives (read the comments before "simplifying" them)

The helpers at the bottom of `browser.mjs` exist because of specific, reproduced Puppeteer/AmuseLabs races, and each carries a comment explaining the failure it prevents:

- `pollForElement` instead of `waitForSelector` on picker frames — a wait armed during a cross-origin navigation binds to a doomed execution context and never re-arms.
- `clickWhenUnobstructed` — Puppeteer clicks hit-test, so a click under a fading modal silently lands on the modal; this waits until the element is topmost at its own centre.
- `clickUntilVisible` — an element can be visible and unobstructed before its handler is bound, making the click a no-op; click, verify the expected result appeared, retry.
- `navigateToDatedPuzzle` — same no-op-click race for date tiles, with retries guarded on the frame URL actually changing.

Silent failures are the norm in this codebase: a click that does nothing produces a misleading error several steps later. Prefer verifying the *effect* of an action over adding a delay.

### Site-specific quirks

Each runner in `sites/` deviates from the standard flow in a documented way — Vox's picker postMessages a *new* iframe rather than navigating in place; Atlantic nests an iframe inside an iframe; Vulture embeds the puzzle directly (so it reloads the frame after tracking starts) and resolves dates from URL slugs only, with an evergreen-URL fallback guarded by the page's own published-time metadata; Newsday requires a subscriber login and caches its session cookies. Date formats per site are not interchangeable (`yyyyMMdd`, `yyMMdd` for the LA Times daily; `navigateToDatedPuzzle` accepts an array of candidate date strings for sites that spell a month more than one way). Daily Beast is the exception that matches no text at all: its labels are typed by hand and the date is sometimes simply absent (Sept. 14, 2026 shipped as “Happy Belated”), so it resolves the tile through `findPuzzleByDate`, which reads the `publicationTime` that the picker’s own `#params.streakInfo` carries for every tile and returns the `puzzleId` to click as a `data-id`.

### Dates and credentials

- `pacificDate()` is the definition of "today" — these archives key to the US Pacific calendar day, and UTC rolls over hours early.
- `formatDate(dateStr, pattern)` converts a `YYYY-MM-DD` input into a site's tile format; the commented block in `browser.mjs` lists the known patterns.
- `NEWSDAY_EMAIL` / `NEWSDAY_PASSWORD` come from `.env` locally (gitignored, and named explicitly in `.gcloudignore`, which *replaces* gcloud's default ignore list rather than extending it — add new secrets to both files).
