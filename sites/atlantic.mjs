import {
    getPuppeteerBrowser,
    setPuzzleFrame,
    startTracking,
    formatDate,
    randomDelay,
    navigateToDatedPuzzle,
    finishRun,
} from '../browser.mjs';

// The Atlantic's own games page (theatlantic.com/games/daily-crossword/) only
// ever wrapped this picker in two iframes. Since 2026-11-04 it sits behind a
// Cloudflare block ("Your access has been blocked – The Atlantic", a 403), so a
// run that went through it died waiting for `#Crossword` or the inner AmuseLabs
// iframe — intermittently at first, then on every attempt from 2026-11-07.
// AmuseLabs' CDN serves the same picker and puzzles with no Atlantic page in
// front, so load it directly as the top-level page.
const PICKER_URL = 'https://cdn3.amuselabs.com/atlantic/date-picker?embed=1&set=atlantic';

export async function runAtlantic( targetDate ) {

    // Tile ids are atlantic_yyyyMMdd. A substring match also covers the odd
    // misspelled id (atlantics_20260315).
    const date_search = formatDate(targetDate, 'yyyyMMdd');

    const [browser, page] = await getPuppeteerBrowser(PICKER_URL);

    // The picker is the main frame here, not an iframe. Tracking matches frames
    // by identity and the main frame survives the click-through navigation, so
    // the puzzle page's decoder script is captured just as it was inside the
    // Atlantic's iframe. Start before the click: the decoder is recovered from
    // scripts the puzzle page loads.
    const puzzleFrame = page.mainFrame();
    setPuzzleFrame(puzzleFrame);
    startTracking(page);

    await randomDelay();

    try {
        await navigateToDatedPuzzle(puzzleFrame, date_search);
    } catch (e) {
        // finishRun() owns the teardown on the normal path; a missing tile never
        // reaches it, and a leaked Chrome keeps the process alive.
        await browser.close().catch(() => {});
        throw e;
    }

    return finishRun(puzzleFrame, page, browser);
}
