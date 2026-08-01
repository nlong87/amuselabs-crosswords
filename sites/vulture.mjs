import { parse, format } from 'date-fns';
import {
    getPuppeteerBrowser,
    startTracking,
    randomDelay,
    waitForAmuselabsFrame,
    finishRun,
} from '../browser.mjs';

const LIST_URL = 'https://www.vulture.com/tags/crosswords/';

// None of this list's fields are reliably correct on their own: the newest
// one or two entries have no dated URL slug at all and show a relative
// label ("Yesterday at 5:00 a.m.") that isn't safely resolvable against our
// own clock or even the page's render time; the visible <time> text itself
// has been observed flat-out wrong (one entry read "July 24, 2026" while
// its own URL slug and thumbnail filename both agreed on July 23); and the
// thumbnail filename has its own occasional typos (one seen with the wrong
// year). So prefer the URL slug's date when present — most consistently
// correct — fall back to the thumbnail filename (the only date-like signal
// left for the undated "Today"/"Yesterday" entries), and only fall back to
// the visible text as a last resort.
function dateFromUrlSlug( href ) {
    const match = href && href.match( /-([a-z]+)-(\d{1,2})-(\d{4})\.html$/i );
    if ( !match ) return null;
    const parsed = parse( `${match[1]} ${match[2]} ${match[3]}`, 'MMMM d yyyy', new Date() );
    return isNaN( parsed.getTime() ) ? null : parsed;
}

function dateFromImageFilename( imgSrc ) {
    const match = imgSrc && imgSrc.match( /crossword-(\d{1,2})-(\d{1,2})-(\d{4})/i );
    if ( !match ) return null;
    const parsed = parse( `${match[1]}/${match[2]}/${match[3]}`, 'M/d/yyyy', new Date() );
    return isNaN( parsed.getTime() ) ? null : parsed;
}

function dateFromTimeText( timeText ) {
    const parsed = parse( timeText.trim(), 'MMMM d, yyyy', new Date() );
    return isNaN( parsed.getTime() ) ? null : parsed;
}

function resolveItemDate( item ) {
    const resolved = dateFromUrlSlug( item.href ) || dateFromImageFilename( item.imgSrc ) || dateFromTimeText( item.timeText );
    return resolved ? format( resolved, 'yyyy-MM-dd' ) : null;
}

export async function runVulture( targetDate ) {

    const [browser, page] = await getPuppeteerBrowser( LIST_URL );

    await randomDelay();

    // List items don't carry a date-friendly attribute — the date has to be
    // pieced together from the URL, the thumbnail, and the child
    // <time class="paginate-time"> text (see resolveItemDate above).
    const items = await page.evaluate(() => {
        return Array.from( document.querySelectorAll( 'li.article' ) ).map( li => ({
            href: li.querySelector( 'a[href]' )?.href || null,
            timeText: li.querySelector( 'time.paginate-time' )?.textContent || '',
            imgSrc: li.querySelector( 'img.article-img' )?.src || null,
        }) );
    });

    const match = items.find( item => resolveItemDate( item ) === targetDate );

    if ( !match || !match.href ) {
        throw new Error( `No Vulture crossword found for ${targetDate}` );
    }

    await page.goto( match.href, { waitUntil: 'domcontentloaded', timeout: 30000 } );

    await randomDelay();

    // Unlike this repo's other sites, the puzzle is embedded directly on
    // this page with no picker/date-click step afterwards — so its decoder
    // script has already loaded (and gone untracked) by the time we can
    // find the iframe and start tracking. Force the iframe to reload once
    // tracking is wired up so its scripts actually get captured.
    const puzzleFrame = await waitForAmuselabsFrame( page, { timeout: 20000 } );

    startTracking( page );

    await puzzleFrame.evaluate( () => location.reload() );
    await puzzleFrame.waitForNavigation( { waitUntil: 'networkidle2', timeout: 15000 } );

    return finishRun( puzzleFrame, page, browser );
}
