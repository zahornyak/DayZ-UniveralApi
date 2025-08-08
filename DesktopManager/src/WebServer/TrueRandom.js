const {Router} = require('express');
const crypto = require('crypto');
const log = require("./log");
const {isArray,GenerateLimiter} = require('./utils');

const { CheckAuth, CheckServerAuth} = require('./AuthChecker')

const router = Router();

router.use(GenerateLimiter(global.config.RequestLimitToxicity || 200, 10));

// QRNG request helpers to ensure we never try to JSON-parse HTML error pages
const DEFAULT_QRNG_TIMEOUT_MS = 10000;
const QRNG_CALL_INTERVAL_MS = 60000; // ANU free API is 1 request/min
let lastQrngCallMs = 0;

function sleep(ms){
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchQrngJson(url, { timeoutMs = DEFAULT_QRNG_TIMEOUT_MS } = {}){
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'accept': 'application/json' },
        });
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok){
            const body = await response.text().catch(() => '');
            throw new Error(`QRNG HTTP ${response.status} ${response.statusText}${body ? `: ${body.substring(0,120)}` : ''}`);
        }
        if (!contentType.toLowerCase().includes('application/json')){
            const body = await response.text().catch(() => '');
            throw new Error(`QRNG non-JSON response (${contentType})${body ? `: ${body.substring(0,120)}` : ''}`);
        }
        return await response.json();
    } catch (err){
        if (err && err.name === 'AbortError'){
            throw new Error('QRNG request timed out');
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchQrngJsonWithRetries(url, retries = 2){
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++){
        try {
            const now = Date.now();
            if (now - lastQrngCallMs < QRNG_CALL_INTERVAL_MS){
                throw new Error('QRNG local throttle: only 1 request per minute allowed');
            }
            lastQrngCallMs = now;
            return await fetchQrngJson(url);
        } catch (e){
            lastError = e;
            if (attempt < retries){
                await sleep(500 * (attempt + 1));
                continue;
            }
        }
    }
    throw lastError;
}

function generatePseudoUint16(count){
    const buffer = crypto.randomBytes(count * 2);
    const result = new Array(count);
    for (let i = 0; i < count; i++){
        result[i] = buffer.readUInt16LE(i * 2);
    }
    return result;
}

function generatePseudoInt32(count){
    const buffer = crypto.randomBytes(count * 4);
    const result = new Array(count);
    for (let i = 0; i < count; i++){
        result[i] = buffer.readInt32LE(i * 4);
    }
    return result;
}

/**
 *  Quantum Random Number Generator 0 to 65535
 *  Post: /Random
 *  
 *  Description: This endpoint generates the specified amount of random numbers from 
 *    ANU's Quantum Random number API within the range of 0 to 65535
 * 
 *  Accepts: `{ "Count": |NumberToGenerate| }`
 *
 *  Returns: `{ "Status": "|STATUSOFREQUEST|", "Error": "|ANYERRORMESSAGE|", "Numbers": [|ARRAYOFINTEGERS|] }`
 * 
 */
router.post('', (req, res)=>{
    GetRandom(req, res, req.headers['auth-key']);
});

/**
 *  Quantum Random Number Generator -2147483647 to 2147483647
 *  Post: /Random/Full
 *  
 *  Description: This endpoint generates the specified amount of random numbers from 
 *    ANU's Quantum Random number API within the range of -2147483647 to 2147483647
 * 
 *  Accepts: `{ "Count": |NumberToGenerate| }`
 *
 *  Returns: `{ 
 *                 "Status": "|STATUSOFREQUEST|", 
 *                 "Error": "|ANYERRORMESSAGE|",
 *                  "Numbers": [|ARRAYOFINTEGERS|] 
 *            }`
 * 
 */
router.post('/Full', (req, res)=>{
    GetFullRandom(req, res, req.headers['auth-key']);
});

async function GetRandom(req, res, auth){
    if ( CheckServerAuth( auth ) || (await CheckAuth( auth )) ){
        let RawCount = req.body.Count || 2048;
        let count = RawCount;
        if (count > 2048 || count < 1){
            log("Failed to generate random numbers due to request size being too large", "warn");
            res.status(203);
            return res.json({Status: "Error", Error: `Invalid Array Request Size` });
        }
        try {
            let ints = []; //I know I could Impove this but meh it works and yeah
            if (count > 1024){
                count = count - 1024
                try {
                    let data2 = await fetchQrngJsonWithRetries(`https://qrng.anu.edu.au/API/jsonI.php?length=1024&type=uint16`);
                    if (data2.success){
                        ints = ints.concat(data2.data);
                    } else {
                        ints = ints.concat(generatePseudoUint16(1024));
                    }
                } catch (err){
                    log(`QRNG fetch (uint16 x1024) failed, using pseudo fallback: ${err}`, 'warn');
                    ints = ints.concat(generatePseudoUint16(1024));
                }
            }
            try {
                let data = await fetchQrngJsonWithRetries(`https://qrng.anu.edu.au/API/jsonI.php?length=${count}&type=uint16`);
                if (data.success){
                    ints = ints.concat(data.data);
                } else {
                    ints = ints.concat(generatePseudoUint16(count));
                }
            } catch (err){
                log(`QRNG fetch (uint16 x${count}) failed, using pseudo fallback: ${err}`, 'warn');
                ints = ints.concat(generatePseudoUint16(count));
            }
            if (ints && ints.length === RawCount){
                log("Random numbers requested");
                res.status(200);
                res.json({Status: "Success", Error: ``, Numbers: ints });
            } else {
                res.status(203)
                log("Failed to generate random numbers due to error from qrng servers", "warn");
                res.json({Status: "Error", Error: `Error in request`,  });
            }
        } catch (e){
            console.log(e)
            log(e, "warn")
            res.status(203);
            res.json({Status: "Error", Error: `${e}` });
        }
    } else {
        res.status(401);
        res.json({Status: "Error", Error: "Invalid Auth" });
    }

}

async function GetFullRandom(req, res, auth){
    if ( CheckServerAuth( auth ) || (await CheckAuth( auth )) ){
        let RawCount = req.body.Count || 4096;
        let count = RawCount;
        if (count > 4096 || count < 1){
            log("Failed to generate random numbers due to request size being too large", "warn");
            res.status(203);
            return res.json({Status: "Error", Error: `Invalid Array Request Size` });
        }
        try {
            let hexs = []; //I know I could Impove this but meh it works and yeah
            let ints = []; 

            if (count > 2048){
                count = count - 2048
                try {
                    let data2 = await fetchQrngJsonWithRetries(`https://qrng.anu.edu.au/API/jsonI.php?length=1024&type=hex16&size=8`);
                    if (data2.success){
                        hexs = hexs.concat(data2.data);
                    } else {
                        ints = ints.concat(generatePseudoInt32(2048));
                    }
                } catch (err){
                    log(`QRNG fetch (hex16 x1024) failed, using pseudo fallback: ${err}`, 'warn');
                    ints = ints.concat(generatePseudoInt32(2048));
                }
            }
            try {
                let data = await fetchQrngJsonWithRetries(`https://qrng.anu.edu.au/API/jsonI.php?length=${Math.ceil(count/2)}&type=hex16&size=8`);
                if (data.success){
                    hexs = hexs.concat(data.data);
                } else {
                    ints = ints.concat(generatePseudoInt32(count));
                }
            } catch (err){
                log(`QRNG fetch (hex16 x${Math.ceil(count/2)}) failed, using pseudo fallback: ${err}`, 'warn');
                ints = ints.concat(generatePseudoInt32(count));
            }
            // Convert fetched hexs to ints
            hexs.forEach(e => { ints = ints.concat(ConvertToInts(e)); });

            // Ensure we return exactly the requested amount
            if (ints.length > RawCount){
                ints = ints.slice(0, RawCount);
            } else if (ints.length < RawCount){
                ints = ints.concat(generatePseudoInt32(RawCount - ints.length));
            }

            log("Random numbers requested");
            res.status(200);
            res.json({Status: "Success", Error: ``, Numbers: ints });
        } catch (e){
            console.log(e)
            log(e, "warn")
            res.status(203);
            res.json({Status: "Error", Error: `${e}` });
        }
    } else {
        res.status(401);
        res.json({Status: "Error", Error: "Invalid Auth" });
    }

}
function ConvertToInts(hex){
    let buf = Buffer.from(hex, "hex");
    let buf1 = buf.slice(0,4)
    let buf2 = buf.slice(4,8)
    let ints = [];
    ints.push(buf1.readInt32LE(0))
    ints.push(buf2.readInt32LE(0))
    return ints
}

module.exports = router;
