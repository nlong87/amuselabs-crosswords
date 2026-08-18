import {
    getPuppeteerBrowser,
    setPuzzleFrame,
    startTracking,
    formatDate,
    clickIfPresent,
    randomDelay,
    randomScroll,
    waitForNavOrDelay,
    navigateToDatedPuzzle,
    finishRun,
    clickUntilVisible,
} from '../browser.mjs';

export async function runAtlantic( targetDate ) {

    const target_url = 'https://www.theatlantic.com/games/daily-crossword/';
    const date_search = formatDate(targetDate, 'yyyyMMdd');

    const [browser, page] = await getPuppeteerBrowser(target_url);

    await randomDelay();
    await randomScroll(page, 400, 1000);

    const iframeSelector = 'iframe[src*="amuselabs.com"]';
    let puzzleFrame;
    
    try {
        const outerElement = await page.waitForSelector('#Crossword');
        const outerFrame = await outerElement.contentFrame();
        
        const innerElement = await outerFrame.waitForSelector(iframeSelector, {timeout: 15000});
        puzzleFrame = await innerElement.contentFrame();
        setPuzzleFrame(puzzleFrame);
    } catch (e) {
        throw e;
    }
    
    // Dismiss the interstitial before going near the navbar — it and the
    // player-info modal sit over the hamburger toggle and silently swallow
    // clicks aimed at it. The toggle itself is the <a data-bs-toggle>, not the
    // <li>; clicking it twice would just close the menu again.
    await clickIfPresent( puzzleFrame, '.modal-content .close');

    // Open the menu and take the Puzzle Archive link once it has actually
    // appeared — the toggle can be clickable before its handler is bound, so
    // the first click is sometimes a silent no-op.
    const archiveLink = await clickUntilVisible(
        puzzleFrame,
        '#navbarContent .nav-item:first-child a.dropdown-toggle',
        '.dropdown-menu.show .puzzle-list a',
    );
    await archiveLink.click();

    await waitForNavOrDelay( puzzleFrame );

    startTracking( page );

    // Navigate to the target Puzzle
    await navigateToDatedPuzzle( puzzleFrame, date_search );

    return finishRun( puzzleFrame, page, browser );
}