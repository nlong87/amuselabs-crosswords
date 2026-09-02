import { format, parse } from 'date-fns';
import 'dotenv/config';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import AdblockerPlugin from 'puppeteer-extra-plugin-adblocker';
import vm from 'vm';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import fs from 'fs';
import path from 'path';
puppeteer.use(StealthPlugin());

// Apply the adblocker plugin to remove ads and trackers
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));

let scriptSources = new Map();
let jsFiles = new Set();
let puzzleFrame;

export function setPuzzleFrame(frame) {
    puzzleFrame = frame;
    // Discard scripts tracked against whatever frame we were previously
    // pointed at (e.g. a picker iframe some sites click through before the
    // real puzzle frame appears). Otherwise a script from the wrong frame
    // can accidentally match the decoder-function heuristic below and
    // produce a corrupted decode instead of a clean failure.
    scriptSources = new Map();
    jsFiles = new Set();
}

// Ad/verification vendors that host pages routinely stall on. AmuseLabs'
// picker-min.js — when loaded directly on the host page rather than sandboxed
// in an iframe — blanks out document.body while it waits on these to finish
// initializing, and when they're slow or fail to load (which they routinely
// are/do) the picker never recovers and the page stays blank forever. None of
// them are needed to reach a puzzle, so they're blocked for every site by
// default (see `blockDomains` below); pass an explicit list to override.
export const BLOCKED_AD_DOMAINS = [
    'permutive.com',
    'doubleverify.com',
    'confiant-integrations.net',
    'connatix.com',
    'crwdcntrl.net',
    'liadm.com',
    'amazon-adsystem.com',
    'doubleclick.net',
    'rtb.openx.net'
];

export async function getPuppeteerBrowser( url, { blockDomains = BLOCKED_AD_DOMAINS, cookies = [] } = {} ) {

    scriptSources = new Map();
    jsFiles = new Set();
    let browser;

    if ( process.env.NODE_ENV === 'production' ) {
        browser = await puppeteer.launch({
            headless: 'new',
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
    } else {
        browser = await puppeteer.launch({
            // headless: false
            headless: 'new'
        });
    }

    const page = await browser.newPage();

    // Cached (disk/memory) responses often can't be read back as text via
    // CDP (see the try/catch in trackResponses below) — force fresh fetches
    // so script tracking never silently loses a decoder source to a cache hit.
    await page.setCacheEnabled(false);

    // Lets callers pre-seed a session (e.g. a cached login) before the first
    // navigation, rather than navigating anonymously and reloading — CDP
    // accepts cookies with domain+path set even on a page that hasn't
    // navigated yet, so this saves a full extra page load.
    if ( cookies.length ) {
        await page.setCookie(...cookies);
    }

    // Block at the network layer via CDP rather than page.setRequestInterception.
    // Interception routes every request through the Fetch domain, after which
    // Network.getResponseBody can no longer return bodies for continued
    // requests — so trackResponses' res.text() silently captures nothing,
    // scriptSources stays empty, and the run dies with the misleading
    // "Decoder function not found". setBlockedURLs drops the matching requests
    // without touching the bodies of the ones we let through.
    if ( blockDomains.length ) {
        const blockClient = await page.createCDPSession();
        await blockClient.send('Network.enable');
        await blockClient.send('Network.setBlockedURLs', {
            urls: blockDomains.map((d) => `*${d}*`),
        });
    }

    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 10000
    });

    return [browser, page];
}

const COOKIE_CACHE_DIR = path.join(process.cwd(), '.cache', 'cookies');

// Sites that require a real login (e.g. Newsday's subscriber-only crossword)
// are slow and more failure-prone than a plain page load. Cache the session
// cookies so the login flow can be skipped on repeat requests — callers should
// still fall back to a fresh login if the cached session turns out to be
// expired.
//
// In production this directory is a Cloud Storage bucket mounted over FUSE, so
// the cache outlives any single container and is shared by every instance —
// Cloud Run's own filesystem is per-instance and in-memory, which meant a cold
// start re-authenticated every time. Locally it's just a directory on disk.
export function readCachedCookies(name) {
    try {
        const raw = fs.readFileSync(path.join(COOKIE_CACHE_DIR, `${name}.json`), 'utf8');
        const cookies = JSON.parse(raw);
        return cookies.length ? cookies : null;
    } catch (e) {
        return null;
    }
}

export async function cacheCookies(page, name) {
    // Over the bucket mount this write is a network call with its own failure
    // modes, and callers await it *after* the puzzle frame is already in hand.
    // The saved session is only ever an optimization, so a failure here must
    // not take down a run whose puzzle decoded fine — readCachedCookies
    // already degrades to null the same way.
    try {
        const cookies = await page.cookies();
        fs.mkdirSync(COOKIE_CACHE_DIR, { recursive: true });
        fs.writeFileSync(path.join(COOKIE_CACHE_DIR, `${name}.json`), JSON.stringify(cookies));
    } catch (e) {
        console.log(`Failed to cache ${name} session (continuing): ${e.message}`);
    }
}

export async function clickIfPresent(context, selector, timeoutMs = 5000) {
    try {
        const el = await context.waitForSelector(selector, { timeout: timeoutMs, visible: true });
        await el.click();
        return true;
    } catch (e) {
        return false;
    }
}

async function trackRequests( req ) {
    if (req.resourceType() !== 'script') return;
    const frame = req.frame();
    if (!frame) return;
    // Match by frame identity, not URL string, since the iframe url will change
    if (frame === puzzleFrame || isDescendantOf(frame, puzzleFrame)) {
        jsFiles.add(req.url());
    }
}

async function trackResponses( res ) {
    const req = res.request();
    if (req.resourceType() !== 'script') return;
    const frame = req.frame();
    if (!frame || !isDescendantOf(frame, puzzleFrame)) return;
    try {
        const text = await res.text();
        scriptSources.set(res.url(), text);
    } catch (e) {
        // some responses (redirects, cached 304s with no body) can't be read as text
    }
}

export function startTracking( page ) {
    page.on('request', trackRequests);
    page.on('response', trackResponses);
}

export function stopTracking( page ) {
    page.off('request', trackRequests);
}

export async function getDecodedJson( puzzleFrame ) {

    // #params can exist in the DOM before its textContent has been fully
    // written (e.g. Vox's puzzle iframe is detected via page.waitForFrame as
    // soon as it's created, well before its own content finishes loading) —
    // so poll until it actually parses instead of reading it once.
    const rawc = await puzzleFrame.evaluate(() => {
        return new Promise((resolve) => {
            const deadline = Date.now() + 10000;
            (function tryRead() {
                const el = document.querySelector('#params');
                if (el) {
                    try {
                        resolve(JSON.parse(el.textContent).rawc);
                        return;
                    } catch (e) {
                        // textContent not fully written yet — keep polling
                    }
                }
                if (Date.now() > deadline) {
                    resolve(null);
                    return;
                }
                setTimeout(tryRead, 150);
            })();
        });
    });
    
    return await decodeRawc(rawc, scriptSources);
}

function isDescendantOf(frame, ancestor) {
    let f = frame;
    while (f) {
        if (f === ancestor) return true;
        f = f.parentFrame();
    }
    return false;
}


function findDecoderFunction(source) {
    let ast;
    try {
        ast = acorn.parse(source, { ecmaVersion: 'latest' });
    } catch (e) {
        return null; // not parseable as a standalone script — skip
    }
    
    const candidates = [];
    
    walk.simple(ast, {
        FunctionDeclaration: checkFn,
        FunctionExpression: checkFn,
    });
    
    function checkFn(node) {
        if (!node.params || node.params.length !== 1) return;
        if (!node.body || node.body.type !== 'BlockStatement') return;
        
        const body = source.slice(node.body.start, node.body.end);
        // Quote-agnostic split/join check
        const callsSplit = /\.split\(\s*(['"])\1\s*\)/.test(body);
        const callsJoin = /\.join\(\s*(['"])\1\s*\)/.test(body);
        if (!callsSplit || !callsJoin) return;
        
        const swapCount = countSwapTriplets(node.body);
        const loopCount = countForLoops(node.body);
        
        if (swapCount >= 1 && loopCount >= 2) {
            candidates.push({
                name: node.id?.name || '(anonymous)',
                start: node.start,
                end: node.end,
                source: source.slice(node.start, node.end),
                score: swapCount * 10 + loopCount,
            });
        }
    }
    
    if (candidates.length === 0) return null;
    // If multiple match, prefer the one with the most loop nesting —
    // decorator/helper functions with a stray split/join rarely have 3+ loops
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
}

async function decodeRawc(rawc, scriptSources) {
    // The script actually containing the decoder can still be in flight —
    // #params being readable doesn't guarantee every script response has
    // been tracked yet — so give it a little time before giving up.
    const deadline = Date.now() + 15000;
    let found = null;
    do {
        for (const [url, src] of scriptSources) {
            found = findDecoderFunction(src);
            if (found) break;
        }
        if (!found) await delay(300);
    } while (!found && Date.now() < deadline);

    if (!found) {
        throw new Error('Decoder function not found — obfuscation pattern may have changed. Manual check needed.');
    }
    
    const fn = vm.runInNewContext(`(${found.source})`);
    const decoded = fn(rawc);
    
    // Check the output before trusting it
    if (!looksValid(decoded)) {
        throw new Error(`Decoded output failed validation — likely a wrong function match. Got: ${decoded.slice(0, 80)}`);
    }
    
    return decoded;
}


// Flattens a statement list, unwrapping SequenceExpressions (comma-joined
// assignments) into individual assignment nodes so ";" vs "," doesn't matter.
function flattenAssignments(stmts) {
    const out = [];
    for (const stmt of stmts) {
        if (stmt.type === 'ExpressionStatement') {
            flattenExpr(stmt.expression, out);
        }
    }
    return out;
}

function flattenExpr(expr, out) {
    if (expr.type === 'SequenceExpression') {
        expr.expressions.forEach((e) => flattenExpr(e, out));
    } else if (expr.type === 'AssignmentExpression') {
        out.push(expr);
    }
}

// Walks every block in the function looking for 3 consecutive assignments
// matching the temp-swap shape: tmp = arr[x]; arr[x] = arr[y]; arr[y] = tmp
function countSwapTriplets(fnBody) {
    let count = 0;
    walk.simple(fnBody, {
        BlockStatement(block) {
            const flat = flattenAssignments(block.body);
            for (let i = 0; i + 2 < flat.length; i++) {
                if (isSwapTriplet(flat[i], flat[i + 1], flat[i + 2])) count++;
            }
        },
    });
    return count;
}

function isSwapTriplet(a1, a2, a3) {
    // a1: tmp = arr[x]
    if (a1.left.type !== 'Identifier') return false;
    if (a1.right.type !== 'MemberExpression' || !a1.right.computed) return false;
    const tmp = a1.left.name;
    const arrName = a1.right.object.name;
    
    // a2: arr[x] = arr[y]
    if (a2.left.type !== 'MemberExpression' || !a2.left.computed) return false;
    if (a2.right.type !== 'MemberExpression' || !a2.right.computed) return false;
    if (a2.left.object.name !== arrName || a2.right.object.name !== arrName) return false;
    if (!sameProp(a2.left.property, a1.right.property)) return false;
    
    // a3: arr[y] = tmp
    if (a3.left.type !== 'MemberExpression' || !a3.left.computed) return false;
    if (a3.left.object.name !== arrName) return false;
    if (!sameProp(a3.left.property, a2.right.property)) return false;
    if (a3.right.type !== 'Identifier' || a3.right.name !== tmp) return false;
    
    return true;
}

// Compares index expressions (usually just Identifiers like `a` / `r`)
function sameProp(p1, p2) {
    if (p1.type === 'Identifier' && p2.type === 'Identifier') return p1.name === p2.name;
    return source_equal(p1, p2); // fallback for literal indices, rare here
}
function source_equal(n1, n2) {
    return n1.type === n2.type && JSON.stringify(n1) === JSON.stringify(n2);
}

function countForLoops(fnBody) {
    let count = 0;
    walk.simple(fnBody, { ForStatement() { count++; } });
    return count;
}

function looksValid(decodedBase64) {
    try {
        const jsonStr = Buffer.from(decodedBase64, 'base64').toString('utf8');
        const parsed = JSON.parse(jsonStr);
        return parsed && typeof parsed === 'object';
    } catch {
        return false;
    }
}

export function formatDate( dateStr, pattern ) {
    /*
    const FORMATS = {
        'short-month':        'MMM d, yyyy',   // Jul 27, 2026
        'short-month-dot':    'MMM. d, yyyy',  // Jul. 27, 2026
        'long-month':         'MMMM d, yyyy',  // July 27, 2026
        'long-ordinal':       'MMMM do, yyyy', // July 27th, 2026
        'short-ordinal':      'MMM do, yyyy',  // Jul 27th, 2026
        'numeric-slash':      'M/d/yy',        // 7/27/26
        'numeric-slash-full': 'M/d/yyyy',      // 7/27/2026
        'numeric-dash':       'MM-dd-yyyy',    // 07-27-2026
        'iso-dash':           'yyyy-MM-dd',    // 2026-07-27
        'dot-dash':           'MM.dd.yyyy',    // 07.27.2026
    };*/
    return format(parseYmd(dateStr), pattern);
}

function parseYmd(dateStr) {
    return parse(dateStr, 'yyyy-MM-dd', new Date());
}

// Some sites label their tiles in AP style, which spells out March through
// July and abbreviates the rest — so date-fns' 'MMM. d, yyyy' produces
// "Sep. 1, 2026" and "Jul. 30, 2026" where the page actually reads
// "Sept. 1, 2026" and "July 30, 2026".
const AP_MONTHS = ['Jan.', 'Feb.', 'March', 'April', 'May', 'June',
    'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];

export function formatDateAP( dateStr ) {
    const d = parseYmd(dateStr);
    return `${AP_MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// These sites key their puzzle archives to the US Pacific calendar day, so
// "today" has to mean today in Pacific time regardless of what timezone this
// runs in — toISOString() is UTC and rolls over ~5-8h too early. en-CA is
// used purely because it formats as yyyy-MM-dd.
const PACIFIC_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' });

export function pacificDate( date = new Date() ) {
    return PACIFIC_DAY.format( date );
}

export function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function randomDelay(min = 1000, max = 3000) {
    await delay(getRandomInt(min, max));
}

export async function randomScroll(page, min = 400, max = 1000) {
    try {
        const scrollAmount = getRandomInt(min, max);
        await page.evaluate((amount) => {
            window.scrollBy(0, amount);
        }, scrollAmount);
    } catch (e) {
        console.log('scrollBy failed:', e.message);
    }
}

export async function waitForAmuselabsFrame(page, { selector = 'iframe[src*="amuselabs.com"]', timeout = 35000 } = {}) {
    const iframeElement = await page.waitForSelector(selector, { timeout });

    // The iframe element matches on its src attribute as soon as it's
    // inserted, which can be before the frame's document has been swapped in.
    // Wait for the document to finish loading before handing the frame back —
    // this is what makes the LA Times mini reliable (see the note on
    // pollForElement below for the failure it avoids).
    const deadline = Date.now() + timeout;
    let puzzleFrame = await iframeElement.contentFrame();
    while (Date.now() < deadline) {
        const frame = await iframeElement.contentFrame();
        const frameUrl = frame?.url() || '';
        if (frame && frameUrl && frameUrl !== 'about:blank') {
            try {
                if (await frame.evaluate(() => document.readyState) === 'complete') {
                    puzzleFrame = frame;
                    break;
                }
            } catch (e) {
                // context destroyed mid-navigation — keep polling
            }
        }
        await delay(250);
    }

    setPuzzleFrame(puzzleFrame);
    return puzzleFrame;
}

export async function waitForNavOrDelay(frame, { timeout = 15000, fallbackDelay = 3000 } = {}) {
    try {
        await frame.waitForNavigation({ waitUntil: 'networkidle2', timeout });
    } catch (e) {
        // Some SPA-style widgets don't fire a full navigation event —
        // fall back to a short settle delay if this times out
        await delay(fallbackDelay);
    }
}

// waitForSelector is not reliable on these picker frames. A wait started while
// the freshly-navigated cross-origin frame is still settling binds to an
// execution context that gets destroyed, and it never re-arms — it hangs for
// its full timeout with the element sitting right there. Measured on LA Times:
// evaluate()/$() returned the tile on every poll from 19s onward while a
// waitForSelector issued at 19s was still rejecting 45s later. $() re-resolves
// the context on each call, so polling it is immune to that race.
export async function pollForElement(context, selector, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        try {
            const handle = await context.$(selector);
            if (handle && await handle.isVisible()) return handle;
        } catch (e) {
            // context torn down mid-poll — retry until the deadline
        }
        await delay(250);
    }
    throw new Error(`Waiting for selector \`${selector}\` failed`);
}

// Puppeteer's click does real hit-testing, so a click aimed at a covered
// element silently lands on whatever is on top instead — no error thrown,
// nothing happens. AmuseLabs' player-info modal does exactly this: dismissing
// it via #footer-btn starts a fade-out, but it stays display:block/opacity:1
// over the navbar for ~1s afterwards and swallows any click aimed at the
// hamburger menu in that window. Wait until the element really is the topmost
// thing at its own centre point, then click it.
export async function clickWhenUnobstructed(context, selector, timeout = 15000) {
    const deadline = Date.now() + timeout;
    let lastBlocker = 'element never found';
    while (Date.now() < deadline) {
        try {
            const handle = await context.$(selector);
            if (handle && await handle.isVisible()) {
                const blocker = await handle.evaluate((el) => {
                    const r = el.getBoundingClientRect();
                    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                    if (!top) return 'no element at point';
                    if (top === el || el.contains(top)) return null;
                    return top.tagName + '.' + String(top.className).slice(0, 40);
                });
                if (blocker === null) {
                    await handle.click();
                    return handle;
                }
                lastBlocker = blocker;
            }
        } catch (e) {
            lastBlocker = e.message.split('\n')[0].slice(0, 60);
        }
        await delay(250);
    }
    throw new Error(`\`${selector}\` never became clickable (blocked by: ${lastBlocker})`);
}


// Same no-op-click race as navigateToDatedPuzzle, one layer up: a Bootstrap
// dropdown toggle can be present, visible and unobstructed before its handler
// is bound, so the click does nothing and the menu never opens. Click, verify
// the thing we expected actually appeared, and retry if it didn't. The wait
// between attempts is generous enough that a menu which did open is always
// seen — re-clicking a toggle would just close it again.
export async function clickUntilVisible(context, clickSelector, expectSelector, {
    attempts = 3,
    expectTimeout = 4000,
    clickTimeout = 15000,
} = {}) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        await clickWhenUnobstructed(context, clickSelector, clickTimeout);
        try {
            return await pollForElement(context, expectSelector, expectTimeout);
        } catch (e) {
            console.log(`Click ${attempt}/${attempts} on \`${clickSelector}\` produced no \`${expectSelector}\``);
            await delay(500);
        }
    }
    throw new Error(`\`${clickSelector}\` never produced \`${expectSelector}\``);
}
export async function navigateToDatedPuzzle(puzzleFrame, dateSearch, {
    attr = 'data-id',
    findTimeout = 15000,
    navTimeout = 15000,
    soft = false,
} = {}) {
    // Accept several spellings of the same date: tile labels on some sites are
    // written by hand, so the exact abbreviation can't be predicted from one
    // format string. Any of them matching is a hit.
    const searches = Array.isArray(dateSearch) ? dateSearch : [dateSearch];
    const targetSelector = searches.map((s) => `[${attr}*="${s}"]`).join(', ');

    // A tile can be present and visible before the picker has bound its click
    // handler, so an immediate click is silently a no-op — the frame never
    // navigates and we end up decoding the picker page instead of a puzzle,
    // which surfaces as the misleading "Decoder function not found" (the picker
    // has its own #params, just no crossword decoder). Give the handler a
    // moment to attach, then retry if nothing moved. Only retry when the url is
    // genuinely unchanged: a navigation that happened while networkidle2 merely
    // failed to settle must not be clicked a second time.
    const MAX_CLICK_ATTEMPTS = 3;
    const SETTLE_MS = 1000;
    const startUrl = puzzleFrame.url();

    await delay(SETTLE_MS);

    for (let attempt = 1; attempt <= MAX_CLICK_ATTEMPTS; attempt++) {
        let target;
        try {
            target = await pollForElement(puzzleFrame, targetSelector, findTimeout);
        } catch (e) {
            // soft callers treat a missing tile as "nothing to do"; everyone
            // else wants the failure surfaced rather than silently decoding
            // whatever page happens to be loaded.
            if (soft) {
                console.log('Failed to find target element:', e.message);
                return;
            }
            throw e;
        }

        // Don't burn the full navTimeout on a click that never registered; the
        // last attempt gets the real budget for a genuinely slow load.
        const attemptTimeout = attempt < MAX_CLICK_ATTEMPTS
            ? Math.min(navTimeout, 6000)
            : navTimeout;

        try {
            await target.click();
            await puzzleFrame.waitForNavigation({ waitUntil: 'networkidle2', timeout: attemptTimeout });
            return;
        } catch (e) {
            if (puzzleFrame.url() !== startUrl) return; // navigated; idle just never settled
            console.log(`Click ${attempt}/${MAX_CLICK_ATTEMPTS} did not navigate:`, e.message);
            // Let any in-flight mouse state clear before clicking again,
            // otherwise puppeteer throws "'left' is already pressed".
            await delay(SETTLE_MS);
        }
    }

    // Never navigated. Some widgets swap content in place without firing a
    // navigation event, so settle briefly and let the caller try to decode
    // rather than failing outright here.
    console.log('Target never navigated: still on', puzzleFrame.url());
    await delay(3000);
}

export async function finishRun(puzzleFrame, page, browser) {
    // Tear the browser down even when decoding throws. Closing only on the
    // success path leaks the whole Chrome instance on every failed run, and
    // because puppeteer's open connection keeps the event loop alive the node
    // process then never exits — a failing runner hangs the test script
    // indefinitely instead of just reporting FAIL.
    try {
        return await getDecodedJson( puzzleFrame );
    } finally {
        stopTracking( page );
        await browser.close().catch(() => {});
    }
}
