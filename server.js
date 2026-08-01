import express from 'express';
import { runLaTimesMini, runLaTimesDaily } from './sites/latimes.mjs';
import { runVox } from './sites/vox.mjs';
import { runSeattleTimesMini, runSeattleTimesLarge} from "./sites/seattletimes.mjs";
import {runAtlantic} from "./sites/atlantic.mjs";
import {runDailyBeast} from "./sites/dailybeast.mjs";
import { runMissingLetter } from './sites/missingletter.mjs';
import { runNewsday } from './sites/newsday.mjs';
import { runVulture } from './sites/vulture.mjs';

const app = express();
app.use(express.json());

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

app.post('/decode/:type', async (req, res) => {
    const { type } = req.params;
    const { targetDate } = req.body;
    
    // Make sure the date passed is valid (YYYY-MM-DD)
    if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
        return res.status(400).json({ error: 'targetDate is required, format: YYYY-MM-DD' });
    }
    
    const runner = RUNNERS[type];
    if (!runner) {
        return res.status(400).json({
            error: `Unknown type "${type}". Valid options: ${Object.keys(RUNNERS).join(', ')}`,
        });
    }
    
    try {
        const result = await runner(targetDate);
        res.json(result);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
    
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Listening on ${port}`));