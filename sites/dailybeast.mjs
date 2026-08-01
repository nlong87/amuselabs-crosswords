import {
    getPuppeteerBrowser,
    startTracking,
    formatDate,
    randomDelay,
    randomScroll,
    waitForAmuselabsFrame,
    navigateToDatedPuzzle,
    finishRun,
} from '../browser.mjs';

export async function runDailyBeast( targetDate ) {

    const url = 'https://www.thedailybeast.com/crossword-puzzles/';
    const date_search = formatDate(targetDate, 'MMMM d, yyyy');

    const [browser, page] = await getPuppeteerBrowser(url);

    await randomDelay();
    await randomScroll(page, 500, 1000);

    const puzzleFrame = await waitForAmuselabsFrame(page, { timeout: 5000 });

    // Click the play button to start any potential ads
    const adPlayButton = await puzzleFrame.$('img[aria-label="Play/Pause"]');
    await adPlayButton.click();

    startTracking( page );

    // Find the element that contains the target date and wait 30+ seconds for an ad to end
    await navigateToDatedPuzzle( puzzleFrame, date_search, { attr: 'aria-label', findTimeout: 35000, soft: true } );

    return finishRun( puzzleFrame, page, browser );
}