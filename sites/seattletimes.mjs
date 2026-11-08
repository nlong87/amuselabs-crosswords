import {
    getPuppeteerBrowser,
    startTracking,
    formatDate,
    randomDelay,
    waitForAmuselabsFrame,
    openPuzzleArchive,
    navigateToDatedPuzzle,
    finishRun,
} from '../browser.mjs';

// The puzzle has to be reached through seattletimes.com: its AmuseLabs picker
// redirects a top-level load to seattletimes.com/entertainment/games/, so the
// direct route the Atlantic uses (runFromPicker) doesn't work here.
async function run( type = 'large',  targetDate ) {

    let mini_url = 'https://www.seattletimes.com/games-crossword-mini/';
    let large_url = 'https://www.seattletimes.com/games-crossword-large/';

    const target_url = type === 'large' ? large_url : mini_url;
    const date_search = formatDate(targetDate, 'yyyyMMdd');

    const [browser, page] = await getPuppeteerBrowser(target_url);

    try {
        await randomDelay();

        const puzzleFrame = await waitForAmuselabsFrame(page, { timeout: 35000 });

        // Straight to the archive, past the player-info modal and the navbar
        // menu it covers. See openPuzzleArchive for why the modal used to fail
        // about one first attempt in seven.
        await openPuzzleArchive( puzzleFrame );

        startTracking( page );

        // Navigate to the target Puzzle
        await navigateToDatedPuzzle( puzzleFrame, date_search );

        return await finishRun( puzzleFrame, page, browser );
    } finally {
        // finishRun() closes it on the normal path; this covers every throw
        // before it, which used to leak the Chrome instance.
        await browser.close().catch(() => {});
    }
}

export async function runSeattleTimesMini( targetDate ) {
    return await run( 'mini', targetDate );
}

export async function runSeattleTimesLarge( targetDate ) {
    return await run( 'large', targetDate );
}
