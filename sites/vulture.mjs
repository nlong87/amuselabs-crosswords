import { parse, format } from 'date-fns';
import {
    getPuppeteerBrowser,
    startTracking,
    pacificDate,
    randomDelay,
    waitForAmuselabsFrame,
    finishRun,
} from '../browser.mjs';

const LIST_URL = 'https://www.vulture.com/tags/crosswords/';

// The newest one or two entries are sometimes published with no dated URL slug
// at all, in which case the puzzle is only reachable through this evergreen URL.
// It always serves whatever Vulture currently considers "today", so it's only
// safe to use for a target date that *is* today — and only after checking the
// page's own date (see assertDailyPageDate), since it keeps serving the previous
// day's puzzle until the new one goes live.
const TODAY_URL = 'https://www.vulture.com/article/daily-crossword-puzzle.html';

// The dated URL slug is the only signal on the list worth trusting. The other
// two that used to be consulted as fallbacks are both actively harmful:
//
//   - The thumbnail filename gets reused. On 2026-08-20 the undated entry for
//     that day carried yesterday's `Crossword-08-19-2026` image, so it resolved
//     to 08-19 and won the lookup for *yesterday* — silently returning the
//     wrong puzzle. It failed on exactly the undated entries it was added for.
//   - The visible <time class="paginate-time"> text never parsed anyway: the
//     list renders "Aug. 18, 2026" (abbreviated, with a period), which
//     date-fns rejects under 'MMMM d, yyyy'. It has also been observed
//     flat-out wrong — one entry read "July 24, 2026" while its own slug and
//     thumbnail both agreed on July 23.
//
// So match on the slug alone and let an unresolvable entry be a clean miss
// rather than a confident wrong answer. Undated entries are handled by
// TODAY_URL above.
function slugDate( href ) {
    const match = href && href.match( /-([a-z]+)-(\d{1,2})-(\d{4})\.html$/i );
    if ( !match ) return null;
    const parsed = parse( `${match[1]} ${match[2]} ${match[3]}`, 'MMMM d yyyy', new Date() );
    return isNaN( parsed.getTime() ) ? null : format( parsed, 'yyyy-MM-dd' );
}

// The date at the end of a daily-page headline, such as
// "Free Daily Crossword: The Kaiju Puzzle — November 10", as yyyy-MM-dd. The
// headline has no year, so it is read in the target date's year, moved a year
// either way when the two are more than six months apart: a "December 31"
// headline checked on January 1 belongs to the year before. Returns null when
// the headline carries no date it can read (an abbreviation like "Sept." included).
export function headlineDate( headline, targetDate ) {
    const matches = headline ? [ ...headline.matchAll( /[—–-]\s*([A-Za-z]{3,})\.?\s+(\d{1,2})\b/g ) ] : [];
    const match = matches[ matches.length - 1 ];
    if ( !match ) return null;

    const target = parse( targetDate, 'yyyy-MM-dd', new Date() );

    for ( const pattern of [ 'MMMM d yyyy', 'MMM d yyyy' ] ) {
        const parsed = parse( `${match[1]} ${match[2]} ${target.getFullYear()}`, pattern, new Date() );
        if ( isNaN( parsed.getTime() ) ) continue;

        const monthGap = parsed.getMonth() - target.getMonth();
        if ( monthGap > 6 ) parsed.setFullYear( parsed.getFullYear() - 1 );
        if ( monthGap < -6 ) parsed.setFullYear( parsed.getFullYear() + 1 );

        return format( parsed, 'yyyy-MM-dd' );
    }

    return null;
}

// TODAY_URL is evergreen — it holds the previous day's puzzle until the new one
// is published, so decoding it blind can silently hand back the wrong day.
//
// The headline's date decides. Each puzzle's headline names its own day, while
// article:published_time can't be trusted on its own: on 2026-11-10 the Kaiju
// puzzle ("— November 10", thumbnail Crossword-11-10-2026) went up carrying the
// Nov 9 puzzle's exact published_time (2026-11-09 05:00 ET), so the list called
// it "Yesterday" and a published_time-only check rejected the right puzzle.
// published_time is only the fallback for a headline with no readable date.
// Either way a mismatch fails loudly and names what it saw: a stale page names
// yesterday's date, so this can't hand back the wrong day.
async function assertDailyPageDate( page, targetDate ) {
    const { title, headline, publishedAt } = await page.evaluate( () => {
        let headline = null;
        for ( const script of document.querySelectorAll( 'script[type="application/ld+json"]' ) ) {
            try {
                const data = JSON.parse( script.textContent );
                const items = [ data, ...( Array.isArray( data ) ? data : [] ), ...( data?.['@graph'] || [] ) ];
                headline = items.find( item => item && typeof item.headline === 'string' )?.headline || null;
            } catch ( e ) {}
            if ( headline ) break;
        }
        return {
            title: document.title,
            headline,
            publishedAt: document.querySelector( 'meta[property="article:published_time"]' )?.content || null,
        };
    } );

    const published = publishedAt ? pacificDate( new Date( publishedAt ) ) : null;
    const named = headlineDate( title, targetDate ) || headlineDate( headline, targetDate );

    if ( named ) {
        if ( named !== targetDate ) {
            throw new Error( `Vulture's daily page holds the ${named} puzzle (headline), not ${targetDate}` );
        }
        if ( published !== targetDate ) {
            console.warn( `Vulture's daily page headline names ${targetDate}, but its published_time says ${published || 'nothing'}` );
        }
        return;
    }

    if ( published !== targetDate ) {
        throw new Error( published
            ? `Vulture's daily page still holds the ${published} puzzle, not ${targetDate}`
            : `Vulture's daily page has no headline date or article:published_time to verify ${targetDate} against` );
    }
}

// The puzzle iframe is served with an empty src and the real URL parked in
// data-crossword-url; a script on the page is what copies one into the other.
// That script doesn't always run — the adblocker plugin drops it, and ad/consent
// failures can stall it too — leaving an iframe that never matches
// `iframe[src*="amuselabs.com"]`, so the run dies waiting for a selector while
// the URL it needs is sitting right there in the DOM. The attribute is the only
// part we actually depend on, so set the src ourselves when the page hasn't.
async function hydratePuzzleFrameSrc( page ) {
    const IFRAME_SELECTOR = 'iframe[data-crossword-url]';
    await page.waitForSelector( IFRAME_SELECTOR, { timeout: 20000 } );
    const src = await page.evaluate( ( selector ) => {
        const frame = document.querySelector( selector );
        if ( !frame ) return null;
        // Leave an already-hydrated frame alone: rewriting the src would reload
        // it, and the page's own URL carries embed params ours doesn't.
        if ( frame.src ) return frame.src;
        frame.src = frame.dataset.crosswordUrl;
        return frame.src;
    }, IFRAME_SELECTOR );

    if ( !src ) throw new Error( 'Vulture puzzle iframe has no crossword URL to load' );
}

export async function runVulture( targetDate ) {

    const [browser, page] = await getPuppeteerBrowser( LIST_URL );

    try {
        await randomDelay();

        // List items carry no date-friendly attribute — the date has to come
        // out of the URL itself (see slugDate above).
        const hrefs = await page.evaluate( () =>
            Array.from( document.querySelectorAll( 'li.article' ) )
                .map( li => li.querySelector( 'a[href]' )?.href || null ) );

        // Prefer the dated slug. If Vulture goes back to publishing today's
        // puzzle under a dated slug, this matches and TODAY_URL is never reached.
        let puzzleUrl = hrefs.find( href => slugDate( href ) === targetDate ) || null;

        // Only fall back to the evergreen URL for today, and only when the list
        // offered nothing dated — that's the case it exists to cover.
        if ( !puzzleUrl && targetDate === pacificDate() ) puzzleUrl = TODAY_URL;

        if ( !puzzleUrl ) {
            throw new Error( `No Vulture crossword found for ${targetDate}` );
        }

        await page.goto( puzzleUrl, { waitUntil: 'domcontentloaded', timeout: 30000 } );

        if ( puzzleUrl === TODAY_URL ) await assertDailyPageDate( page, targetDate );

        await randomDelay();

        await hydratePuzzleFrameSrc( page );

        // Unlike this repo's other sites, the puzzle is embedded directly on
        // this page with no picker/date-click step afterwards — so its decoder
        // script has already loaded (and gone untracked) by the time we can
        // find the iframe and start tracking. Force the iframe to reload once
        // tracking is wired up so its scripts actually get captured.
        const puzzleFrame = await waitForAmuselabsFrame( page, { timeout: 20000 } );

        startTracking( page );

        await puzzleFrame.evaluate( () => location.reload() );
        await puzzleFrame.waitForNavigation( { waitUntil: 'networkidle2', timeout: 15000 } );

        return await finishRun( puzzleFrame, page, browser );
    } catch ( e ) {
        // Bailing out before finishRun would otherwise leak the whole Chrome
        // instance, and puppeteer's open connection keeps the event loop alive
        // — so a failed lookup hangs the caller instead of just reporting the
        // error. finishRun closes the browser itself, so this only has to cover
        // the paths that never reach it.
        await browser.close().catch( () => {} );
        throw e;
    }
}
