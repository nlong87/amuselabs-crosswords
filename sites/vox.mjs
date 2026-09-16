import {
    getPuppeteerBrowser,
    setPuzzleFrame,
    startTracking,
    randomDelay,
    randomScroll,
    waitForAmuselabsFrame,
    findPuzzleByDate,
    pollForElement,
    clickIfPresent,
    finishRun,
    BLOCKED_AD_DOMAINS,
} from '../browser.mjs';

// An interstitial modal on the main page can appear on top of the picker
// iframe. It no longer swallows the tile click — that is dispatched on the
// element itself now, not aimed at coordinates — but it is still dismissed so
// it can't cover the picker while the frame loads.
const MODAL_CLOSE_SELECTOR = 'xpath//html/body/div[5]/div[3]/div/div/div/button';

export async function runVox( targetDate ) {

    const url = 'https://www.vox.com/21523212/crossword-puzzles-free-daily-printable';

    const [browser, page] = await getPuppeteerBrowser(url, { blockDomains: BLOCKED_AD_DOMAINS });

    // Every exit before finishRun has to close the browser itself —
    // finishRun is the only other place that does, so a bare throw (a day
    // Vox skipped, a tile that never opened) leaks Chrome and hangs any
    // caller that catches instead of exiting, the test harness included.
    try {
        const client = await page.createCDPSession();
        await client.send('Page.enable');

        await randomDelay();
        await randomScroll(page, 2000, 4000);

        const pickerFrame = await waitForAmuselabsFrame(page, { selector: '#voxpuzzle' });

        // Most Vox ids spell the date out (`AJRvox_20260912_1000`), but not all —
        // Sept. 16, 2026 shipped as the opaque `ac870842`. The picker's own
        // #params.streakInfo carries a publicationTime for every tile, including
        // those, and it agrees with the tile's rendered date, so resolve the id
        // from there rather than matching a date inside it.
        const puzzle = await findPuzzleByDate(pickerFrame, targetDate);
        if (!puzzle) throw new Error(`No Vox crossword published on ${targetDate}`);

        startTracking( page );

        // Dispatch the tile's own click rather than aiming the mouse at it. The
        // #voxpuzzle iframe renders all 30 tiles at full height (~2600px) and never
        // scrolls internally, so after randomScroll the tile usually sits hundreds
        // of pixels *above* the parent viewport — measured at parent-y -1270 for a
        // tile four rows from the top. Puppeteer's click hit-tests at that
        // off-screen point and lands on whatever tile the coordinates clamp to:
        // asking for Sept. 12 opened Aug. 18 and Aug. 22 on consecutive runs. That
        // fails silently, because a wrong puzzle still decodes perfectly.
        const targetSelector = `[data-id="${puzzle.puzzleId}"]`;
        const clickTile = () => pickerFrame.evaluate(
            (sel) => document.querySelector(sel)?.click(),
            targetSelector,
        );

        // The tile can be present before the picker has bound its click handler,
        // making the first click a silent no-op, so click, check, and retry.
        // Re-resolve the tile each time: the picker navigates in place, and a
        // handle held across that throws "Argument should belong to the same
        // JavaScript world" instead of clicking.
        //
        // The frame we want is the #voxpuzzle iframe itself — it navigates from
        // /vox/date-picker to /vox/crossword rather than the parent injecting a
        // second iframe. Match its live URL (page.waitForFrame), including the
        // requested id: the article lazy-loads its own puzzle embeds while we
        // scroll, so a bare /vox/crossword predicate can resolve against one of
        // those instead.
        const MAX_ATTEMPTS = 3;
        let puzzleFrame = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !puzzleFrame; attempt++) {
            await clickIfPresent(page, MODAL_CLOSE_SELECTOR, 2000);
            try {
                await pollForElement(pickerFrame, targetSelector, 15000);
                await clickTile();
                puzzleFrame = await page.waitForFrame(
                    frame => frame.url().includes('amuselabs.com/vox/crossword')
                          && frame.url().includes(`id=${puzzle.puzzleId}`),
                    { timeout: 12000 }
                );
            } catch (e) {
                console.log(`Attempt ${attempt}/${MAX_ATTEMPTS} failed to reach crossword frame:`, e.message);
            }
        }

        if (!puzzleFrame) {
            throw new Error('Failed to reach crossword puzzle after multiple click attempts');
        }
        setPuzzleFrame(puzzleFrame);

        return await finishRun( puzzleFrame, page, browser );
    } catch ( e ) {
        await browser.close().catch( () => {} );
        throw e;
    }
}
