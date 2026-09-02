import {
    getPuppeteerBrowser,
    startTracking,
    formatDate,
    formatDateAP,
    randomDelay,
    randomScroll,
    waitForAmuselabsFrame,
    navigateToDatedPuzzle,
    finishRun, clickIfPresent,
} from '../browser.mjs';

export async function runDailyBeast( targetDate ) {

    const url = 'https://www.thedailybeast.com/crossword-puzzles/';
    // The tile labels are written by hand, in AP style — "Sept. 1, 2026",
    // "July 30, 2026" — so date-fns' 'MMM. d, yyyy' misses on every month AP
    // abbreviates differently (Sept.) or spells out (March-July). Offer both
    // spellings rather than betting on one; whichever the editor typed matches.
    const date_search = [...new Set([
        formatDateAP(targetDate),
        formatDate(targetDate, 'MMM. d, yyyy'),
    ])];

    const [browser, page] = await getPuppeteerBrowser(url);

    await randomDelay();
    await randomScroll(page, 500, 1000);

    const puzzleFrame = await waitForAmuselabsFrame(page, { timeout: 5000 });

    // Click the play button to start any potential ads
    await clickIfPresent(puzzleFrame, 'img[aria-label="Play/Pause"]');

    startTracking( page );

    // Find the element that contains the target date and wait 30+ seconds for an ad to end
    await navigateToDatedPuzzle( puzzleFrame, date_search, { attr: 'aria-label', findTimeout: 35000, soft: true } );

    return finishRun( puzzleFrame, page, browser );
}