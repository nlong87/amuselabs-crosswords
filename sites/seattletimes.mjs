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

    // Click the hamburger menu link
    const hamburgerMenu = await puzzleFrame.$('#navbarContent .nav-item:first-child');
    await hamburgerMenu.click();

    // Wait for the dropdown menu to appear
    const dropdownMenu = await hamburgerMenu.waitForSelector('.dropdown-menu', {
        visible: true
    });

    // Click the Puzzle Archive link
    const archiveLink = await dropdownMenu.$('.puzzle-list');
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