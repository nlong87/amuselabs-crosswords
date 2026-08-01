import {
    setPuzzleFrame,
    getPuppeteerBrowser,
    startTracking,
    formatDate,
    randomDelay,
    randomScroll,
    navigateToDatedPuzzle,
    finishRun,
} from '../browser.mjs';

export async function runMissingLetter( targetDate ) {

    const url = 'https://www.merriam-webster.com/games/missing-letter';
    const date_search = formatDate(targetDate, 'yyyyMMdd');

    const [browser, page] = await getPuppeteerBrowser(url);

    await randomDelay();
    await randomScroll(page, 100, 600);

    const iframeContext  = await page.waitForFrame(frame => frame.url().includes('amuselabs.com'));
    const iframeElement = await iframeContext.frameElement();
    let puzzleFrame = await iframeElement.contentFrame();
    setPuzzleFrame(puzzleFrame);

    startTracking( page );

    // Find the element that contains the target date and wait 30+ seconds for an ad to end
    await navigateToDatedPuzzle( puzzleFrame, date_search, { findTimeout: 8000, soft: true } );

    return finishRun( puzzleFrame, page, browser );
}