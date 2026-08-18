import {
    getPuppeteerBrowser,
    setPuzzleFrame,
    startTracking,
    formatDate,
    randomDelay,
    randomScroll,
    waitForAmuselabsFrame,
    clickIfPresent,
    finishRun,
    BLOCKED_AD_DOMAINS,
} from '../browser.mjs';

// An interstitial modal on the main page can appear on top of the picker
// iframe. Puppeteer's visibility check for the tile only looks within the
// iframe itself, so the tile reads as clickable even while this modal is
// covering it and silently swallowing the click.
const MODAL_CLOSE_SELECTOR = 'xpath//html/body/div[5]/div[3]/div/div/div/button';

export async function runVox( targetDate ) {

    const url = 'https://www.vox.com/21523212/crossword-puzzles-free-daily-printable';
    const date_search = formatDate(targetDate, 'yyyyMMdd');

    const [browser, page] = await getPuppeteerBrowser(url, { blockDomains: BLOCKED_AD_DOMAINS });

    const client = await page.createCDPSession();
    await client.send('Page.enable');

    await randomDelay();
    await randomScroll(page, 2000, 4000);

    const pickerFrame = await waitForAmuselabsFrame(page, { selector: '#voxpuzzle' });

    startTracking( page );

    // Vox's #voxpuzzle iframe is a *picker* — clicking a date tile never
    // navigates it. Instead it postMessages the parent page, which injects a
    // brand-new, separate iframe pointing at the actual crossword. So we find
    // the tile in the picker, click it, then wait for that new iframe to
    // appear and switch our frame reference to it. Match by the frame's live
    // URL (page.waitForFrame) rather than a DOM attribute selector — the new
    // iframe's src *attribute* doesn't necessarily match its navigated URL.
    const targetSelector = `[data-id*="${date_search}"]`;
    const target = await pickerFrame.waitForSelector(targetSelector, { timeout: 15000, visible: true });

    // The interstitial modal's timing is unpredictable — it can load before
    // or after our first dismiss attempt, occasionally swallowing the click.
    // Retry the whole dismiss-and-click a few times rather than one long wait.
    const MAX_ATTEMPTS = 3;
    let puzzleFrame = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !puzzleFrame; attempt++) {
        await clickIfPresent(page, MODAL_CLOSE_SELECTOR, 2000);
        await target.click();
        try {
            puzzleFrame = await page.waitForFrame(
                frame => frame.url().includes('amuselabs.com/vox/crossword'),
                { timeout: 12000 }
            );
        } catch (e) {
            console.log(`Attempt ${attempt}/${MAX_ATTEMPTS} failed to reach crossword frame:`, e.message);
        }
    }

    if (!puzzleFrame) {
        throw new Error('Failed to reach crossword puzzle after multiple click attempts');
    }
    setPuzzleFrame(puzzleFrame);

    return finishRun( puzzleFrame, page, browser );
}