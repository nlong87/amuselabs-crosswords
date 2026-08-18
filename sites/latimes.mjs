import {
    getPuppeteerBrowser,
    startTracking,
    formatDate,
    waitForAmuselabsFrame,
    navigateToDatedPuzzle,
    finishRun, BLOCKED_AD_DOMAINS,
} from '../browser.mjs';

async function run( type = 'daily',  targetDate ) {

    let mini_url = 'https://www.latimes.com/games/mini-crossword';
    let daily_url = 'https://www.latimes.com/games/crossword';

    const target_url = type === 'daily' ? daily_url : mini_url;
    const date_search = type === 'daily' ?  formatDate(targetDate, 'yyMMdd') : formatDate(targetDate, 'yyyyMMdd');

    const [browser, page] = await getPuppeteerBrowser(target_url, { blockDomains: BLOCKED_AD_DOMAINS });

    const selector = 'pierce/a[data-tos-handler="accept-tos"]';

    try {
        const acceptButton = await page.waitForSelector(selector, { timeout: 5000 });
        await acceptButton.click();
        console.log('TOS button clicked');
    } catch (e) {
        console.log('TOS button not found');
    }

    // Find the element by its selector
    const mainElement = await page.$('main.page-main');

    if (mainElement) {
        await mainElement.scrollIntoView();
        await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
        await new Promise(r => setTimeout(r, 1000)); // give the observer a moment to react
        console.log('Scrolled to main.');
    }

    const puzzleFrame = await waitForAmuselabsFrame(page, { timeout: 35000 });

    startTracking( page );

    // Navigate to the target Puzzle
    await navigateToDatedPuzzle( puzzleFrame, date_search, { findTimeout: 55000 } );

    return finishRun( puzzleFrame, page, browser );
}

export async function runLaTimesMini( targetDate ) {
    return await run( 'mini', targetDate );
}

export async function runLaTimesDaily( targetDate ) {
    return await run( 'daily', targetDate );
}

//await run('daily', '2026-07-27').then( r => console.log(r) );