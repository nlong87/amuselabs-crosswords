import {
    getPuppeteerBrowser,
    startTracking,
    formatDate,
    clickIfPresent,
    randomDelay,
    waitForAmuselabsFrame,
    navigateToDatedPuzzle,
    finishRun,
    readCachedCookies,
    cacheCookies,
} from '../browser.mjs';

const EMAIL_SELECTOR = 'input[data-nxt-input="Email"]';
const PASSWORD_SELECTOR = '#input-pwd-naviga';
const LOGIN_SUBMIT_SELECTOR = 'button[data-nxt-button="LogIn"]';
const NOT_LOGGED_IN_SELECTOR = 'a.not-loggedin.logInbtn';
const COOKIE_CACHE_NAME = 'newsday';

export async function runNewsday( targetDate ) {

    const url = 'https://www.newsday.com/entertainment/crossword-puzzle';
    const date_search = formatDate(targetDate, 'yyyyMMdd');

    // Unlike this repo's other sites, Newsday marks the crossword page
    // "restricted" rather than its default metered paywall — anonymous
    // sessions never even request an amuselabs URL, #game-block just spins
    // forever. A subscriber login is required before the picker iframe
    // appears, and it's by far the slowest and most failure-prone part of
    // this runner — so seed the browser with a cached session's cookies
    // before the first navigation and skip login if it's still valid.
    const cachedCookies = readCachedCookies( COOKIE_CACHE_NAME );
    console.log( cachedCookies ? 'Newsday: using cached session' : 'Newsday: no cached session found' );

    const [browser, page] = await getPuppeteerBrowser( url, { cookies: cachedCookies || [] } );

    await randomDelay();

    await clickIfPresent( page, '.onetrust-close-btn-handler' );

    // page.$() doesn't wait for the header to hydrate, so it can race a
    // freshly-loaded page and wrongly read as "already logged in" — give it
    // a real wait before deciding.
    const stillLoggedOut = await page
        .waitForSelector( NOT_LOGGED_IN_SELECTOR, { timeout: 5000 } )
        .then( () => true )
        .catch( () => false );
    if ( stillLoggedOut ) {
        console.log( 'Newsday: cached session expired or absent, logging in' );
        await clickIfPresent( page, NOT_LOGGED_IN_SELECTOR );

        // The login trigger sometimes lands on a subscription offer modal
        // instead of the login form directly (server-side meter state, not
        // something we control) — click through its own "Log in" link if so.
        await clickIfPresent( page, 'a#MG2login.login-link' );

        await page.waitForSelector( EMAIL_SELECTOR, { visible: true, timeout: 15000 } );
        await page.type( EMAIL_SELECTOR, process.env.NEWSDAY_EMAIL, { delay: 30 } );
        await page.type( PASSWORD_SELECTOR, process.env.NEWSDAY_PASSWORD, { delay: 30 } );
        await page.click( LOGIN_SUBMIT_SELECTOR );
    }

    // Once authorized, the page swaps #game-block's spinner for the
    // amuselabs date-picker iframe in place — no reload needed.
    const puzzleFrame = await waitForAmuselabsFrame( page, { timeout: 20000 } );

    // Confirmed logged in at this point (cached session was still valid, or
    // the fresh login above just succeeded) — refresh the cache either way
    // so its expiry keeps sliding forward.
    await cacheCookies( page, COOKIE_CACHE_NAME );

    startTracking( page );

    // Clicking a tile navigates this same iframe in place from the picker
    // to the actual crossword.
    await navigateToDatedPuzzle( puzzleFrame, date_search );

    return finishRun( puzzleFrame, page, browser );
}
