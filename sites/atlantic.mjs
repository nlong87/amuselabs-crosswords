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
    
    // Click the hamburger menu link
    const hamburgerMenu = await puzzleFrame.$('#navbarContent .nav-item:first-child');
    const hamburgerMenuLink = await hamburgerMenu.$('a');
    await hamburgerMenuLink.click();
    
    await clickIfPresent( puzzleFrame, '.modal-content .close');
    
    await hamburgerMenuLink.click();
    
    // Wait for the dropdown menu to appear
    const dropdownMenu = await hamburgerMenu.waitForSelector('.dropdown-menu', {
        visible: true
    });
    
    // Click the Puzzle Archive link
    const archiveLink = await dropdownMenu.$('.puzzle-list a');
    await archiveLink.click();

    await waitForNavOrDelay( puzzleFrame );

    startTracking( page );

    // Navigate to the target Puzzle
    await navigateToDatedPuzzle( puzzleFrame, date_search );

    return finishRun( puzzleFrame, page, browser );
}