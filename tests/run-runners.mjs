import { runAtlantic } from '../sites/atlantic.mjs';
import { runDailyBeast } from '../sites/dailybeast.mjs';
import { runLaTimesDaily, runLaTimesMini } from '../sites/latimes.mjs';
import { runMissingLetter } from '../sites/missingletter.mjs';
import { runNewsday } from '../sites/newsday.mjs';
import { runSeattleTimesLarge, runSeattleTimesMini } from '../sites/seattletimes.mjs';
import { runVox } from '../sites/vox.mjs';
import { runVulture } from '../sites/vulture.mjs';
import { pacificDate } from '../browser.mjs';

const RUNNERS = {
    atlantic: runAtlantic,
    dailybeast: runDailyBeast,
    latimes: runLaTimesDaily,
    latimesmini: runLaTimesMini,
    missingletter: runMissingLetter,
    newsday: runNewsday,
    seattletimes: runSeattleTimesLarge,
    seattletimesmini: runSeattleTimesMini,
    vox: runVox,
    vulture: runVulture
};

// Runners return a base64-encoded JSON payload — decode it to confirm
// it's actually a usable puzzle, not just a truthy string.
function decodePayload(base64) {
    const json = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(json);
}

async function testRunner(name, fn, targetDate) {
    const start = Date.now();
    try {
        const result = await fn(targetDate);
        const puzzle = decodePayload(result);
        return { name, ok: true, ms: Date.now() - start, title: puzzle.title };
    } catch (e) {
        return { name, ok: false, ms: Date.now() - start, error: e.message };
    }
}

async function main() {
    const args = process.argv.slice(2);
    const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
    const targetDate = dateArg || pacificDate();
    const requested = args.filter(a => a !== dateArg);

    const unknown = requested.filter(name => !RUNNERS[name]);
    if (unknown.length) {
        console.error(`Unknown runner(s): ${unknown.join(', ')}`);
        console.error(`Valid options: ${Object.keys(RUNNERS).join(', ')}`);
        process.exit(1);
    }

    const toRun = requested.length ? requested : Object.keys(RUNNERS);
    console.log(`Testing runner(s) [${toRun.join(', ')}] for date ${targetDate}\n`);

    const results = [];
    for (const name of toRun) {
        console.log(`--- ${name} ---`);
        const result = await testRunner(name, RUNNERS[name], targetDate);
        results.push(result);
        console.log(result.ok
            ? `OK (${result.ms}ms) - "${result.title}"`
            : `FAILED (${result.ms}ms) - ${result.error}`);
        console.log();
    }

    console.log('=== Summary ===');
    for (const r of results) {
        console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(18)} ${r.ms}ms${r.ok ? '' : '  ' + r.error}`);
    }

    process.exitCode = results.some(r => !r.ok) ? 1 : 0;
}

main();
