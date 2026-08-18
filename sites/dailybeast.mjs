import {
    getPuppeteerBrowser,
    startTracking,
    formatDate,
    randomDelay,
    randomScroll,
    waitForAmuselabsFrame,
    navigateToDatedPuzzle,
    finishRun, clickIfPresent,
} from '../browser.mjs';

export async function runDailyBeast( targetDate ) {

    const url = 'https://www.thedailybeast.com/crossword-puzzles/';
    const date_search = formatDate(targetDate, 'MMM. d, yyyy');

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