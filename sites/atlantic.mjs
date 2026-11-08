import { formatDate, runFromPicker } from '../browser.mjs';

// theatlantic.com/games/daily-crossword/ only ever embedded this picker in two
// iframes, and since 2026-11-04 it answers automation with a Cloudflare block
// ("Your access has been blocked – The Atlantic", a 403). Runs through it died
// waiting for `#Crossword` or the inner AmuseLabs iframe, and the 11-07 and
// 11-08 puzzles were missed. AmuseLabs' CDN serves the picker unblocked.
const PICKER_URL = 'https://cdn3.amuselabs.com/atlantic/date-picker?embed=1&set=atlantic';

export async function runAtlantic( targetDate ) {
    // Tile ids are atlantic_yyyyMMdd. A substring match also covers the odd
    // misspelled id (atlantics_20260315).
    return runFromPicker(PICKER_URL, formatDate(targetDate, 'yyyyMMdd'));
}
