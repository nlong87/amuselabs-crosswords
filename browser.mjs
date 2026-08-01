import { format, parse } from 'date-fns';
import 'dotenv/config';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import vm from 'vm';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import fs from 'fs';
import path from 'path';
puppeteer.use(StealthPlugin());

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

export async function getPuppeteerBrowser( url, { blockDomains = [], cookies = [] } = {} ) {

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

    if ( blockDomains.length ) {
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const reqUrl = req.url();
            if ( blockDomains.some((d) => reqUrl.includes(d)) ) {
                req.abort();
            } else {
                req.continue();
            }
        });
    }

    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
    });

    return [browser, page];
}

const COOKIE_CACHE_DIR = path.join(process.cwd(), '.cache', 'cookies');

// Sites that require a real login (e.g. Newsday's subscriber-only crossword)
// are slow and more failure-prone than a plain page load. Cache the session
// cookies to disk so a warm server instance can skip the login flow on
// repeat requests — callers should still fall back to a fresh login if the
// cached session turns out to be expired.
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
    const cookies = await page.cookies();
    fs.mkdirSync(COOKIE_CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(COOKIE_CACHE_DIR, `${name}.json`), JSON.stringify(cookies));
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
    const puzzleFrame = await iframeElement.contentFrame();
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

export async function navigateToDatedPuzzle(puzzleFrame, dateSearch, {
    attr = 'data-id',
    findTimeout = 55000,
    navTimeout = 15000,
    soft = false,
} = {}) {
    const targetSelector = `[${attr}*="${dateSearch}"]`;

    if (soft) {
        let target;
        try {
            target = await puzzleFrame.waitForSelector(targetSelector, { timeout: findTimeout, visible: true });
        } catch (e) {
            console.log('Failed to find target element:', e.message);
            return;
        }
        try {
            await target.click();
            await puzzleFrame.waitForNavigation({ waitUntil: 'networkidle2', timeout: navTimeout });
        } catch (e) {
            console.log('Failed to navigate to target:', e.message);
        }
    } else {
        await puzzleFrame.waitForSelector(targetSelector, { visible: true, timeout: findTimeout });
        const target = await puzzleFrame.$(targetSelector);
        await target.click();
        await waitForNavOrDelay(puzzleFrame, { timeout: navTimeout });
    }
}

export async function finishRun(puzzleFrame, page, browser) {
    const decoded = await getDecodedJson( puzzleFrame );
    stopTracking( page );
    await browser.close();
    return decoded;
}