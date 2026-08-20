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
// page's own date (see assertPublishedOn), since it keeps serving the previous
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

// TODAY_URL is evergreen — it holds the previous day's puzzle until the new one
// is published, so decoding it blind can silently hand back the wrong day.
// Vulture's own metadata is the only date the page carries; it isn't a signal
// this file trusts elsewhere, so a mismatch fails loudly and names what it saw.
async function assertPublishedOn( page, targetDate ) {
    const publishedAt = await page.evaluate( () =>
        document.querySelector( 'meta[property="article:published_time"]' )?.content || null );
    const published = publishedAt ? pacificDate( new Date( publishedAt ) ) : null;

    if ( published !== targetDate ) {
        throw new Error( published
            ? `Vulture's daily page still holds the ${published} puzzle, not ${targetDate}`
            : `Vulture's daily page has no article:published_time to verify ${targetDate} against` );
    }
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

        if ( puzzleUrl === TODAY_URL ) await assertPublishedOn( page, targetDate );

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
