import {
    getPuppeteerBrowser,
    startTracking,
    formatDate,
    clickIfPresent,
    randomDelay,
    waitForAmuselabsFrame,
    waitForNavOrDelay,
    navigateToDatedPuzzle,
    finishRun,
    clickUntilVisible,
} from '../browser.mjs';

async function run( type = 'large',  targetDate ) {

    let mini_url = 'https://www.seattletimes.com/games-crossword-mini/';
    let large_url = 'https://www.seattletimes.com/games-crossword-large/';

    const target_url = type === 'large' ? large_url : mini_url;
    const date_search = formatDate(targetDate, 'yyyyMMdd');

    const [browser, page] = await getPuppeteerBrowser(target_url);

    await randomDelay();

    const puzzleFrame = await waitForAmuselabsFrame(page, { timeout: 35000 });

    await randomDelay();

    // Close the modal box
    await clickIfPresent( puzzleFrame, '#footer-btn' );

    // The hamburger toggle is the <a data-bs-toggle="dropdown">, not the <li>
    // wrapper, and the player-info modal dismissed above keeps covering it for
    // ~1s while it fades out, silently swallowing clicks aimed at it. It can
    // also be clickable before its handler is bound, making the first click a
    // no-op. clickUntilVisible waits out the overlay and verifies the menu
    // actually opened, retrying if it did not.
    const archiveLink = await clickUntilVisible(
        puzzleFrame,
        '#navbarContent .nav-item:first-child a.dropdown-toggle',
        '.dropdown-menu.show .puzzle-list',
    );
    await archiveLink.click();

    await waitForNavOrDelay( puzzleFrame );

    startTracking( page );

    // Navigate to the target Puzzle
    await navigateToDatedPuzzle( puzzleFrame, date_search );

    return finishRun( puzzleFrame, page, browser );
}

export async function runSeattleTimesMini( targetDate ) {
    return await run( 'mini', targetDate );
}

export async function runSeattleTimesLarge( targetDate ) {
    return await run( 'large', targetDate );
}