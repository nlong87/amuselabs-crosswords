import {
    getPuppeteerBrowser,
    startTracking,
    randomDelay,
    randomScroll,
    waitForAmuselabsFrame,
    findPuzzleByDate,
    navigateToDatedPuzzle,
    finishRun, clickIfPresent,
} from '../browser.mjs';

export async function runDailyBeast( targetDate ) {

    const url = 'https://www.thedailybeast.com/crossword-puzzles/';

    const [browser, page] = await getPuppeteerBrowser(url);

    try {
        await randomDelay();
        await randomScroll(page, 500, 1000);

        const puzzleFrame = await waitForAmuselabsFrame(page, { timeout: 20000 });

        // Click the play button to start any potential ads
        await clickIfPresent(puzzleFrame, 'img[aria-label="Play/Pause"]');

        // The tile labels are written by hand and the date is sometimes just
        // missing — Sept. 14, 2026 shipped as "Happy Belated" and nothing else.
        // The picker's own publication metadata has matched every hand-typed
        // label, so resolve the tile from that instead of from its text.
        const puzzle = await findPuzzleByDate(puzzleFrame, targetDate);
        if (!puzzle) throw new Error(`No Daily Beast crossword published on ${targetDate}`);

        startTracking( page );

        // Click the tile by id, allowing 30+ seconds for an ad to end
        await navigateToDatedPuzzle( puzzleFrame, puzzle.puzzleId, { findTimeout: 35000 } );

        // navigateToDatedPuzzle gives up quietly if the tile never navigated;
        // catch that here rather than as "Decoder function not found" later.
        if (!puzzleFrame.url().includes(`id=${puzzle.puzzleId}`)) {
            throw new Error(`Daily Beast tile for ${targetDate} ("${puzzle.title}") never opened`);
        }

        return await finishRun( puzzleFrame, page, browser );
    } catch ( e ) {
        await browser.close().catch( () => {} );
        throw e;
    }
}
