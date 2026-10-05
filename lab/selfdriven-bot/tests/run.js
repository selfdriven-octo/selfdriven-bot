'use strict';

// End-to-end tests for the selfdriven.bot /engage Lambda.
// Real keripy KELs (a witnessed OOBI stream captured from keripy witnesses, plus generated fixtures)
// are served from a local OOBI server, requests are signed with signify-ts (or kli when USE_KLI=1),
// and DynamoDB is replaced with an in-memory table.
//
//   cd lambda && npm install && npm test

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const LAMBDA = path.join(__dirname, '..', 'lambda');
const FIX = path.join(__dirname, 'fixtures');
const KLI = process.env.KLI || 'kli';

const AGENT1 = 'EEJ_sQzPlO-STK3zKMtbbMjw-WGabXylof9lps8XzfrX';
const WEIGHTED = 'EBoLjazfr3hCez_-IT9mMVeOYY3mxEJZTMhYFewU3lw6';
const SECRET = 'test-origin-secret';
const PORT = 5700;

// ── In-memory DynamoDB ───────────────────────────────────────────────────────

const ddbPath = require.resolve('@aws-sdk/client-dynamodb', { paths: [LAMBDA] });
const ddb = require(ddbPath);
const table = new Map();

ddb.DynamoDBClient.prototype.send = function (command)
{
    const input = command.input;
    const key = function (item) { return item.pk.S + '|' + item.sk.S; };

    if (command instanceof ddb.TransactWriteItemsCommand)
    {
        const reasons = input.TransactItems.map(function (t)
        {
            const exists = table.has(key(t.Put.Item));
            return (t.Put.ConditionExpression && exists) ? { Code: 'ConditionalCheckFailed' } : { Code: 'None' };
        });

        if (reasons.some(function (r) { return r.Code !== 'None'; }))
        {
            const err = new Error('Transaction cancelled');
            err.name = 'TransactionCanceledException';
            err.CancellationReasons = reasons;
            return Promise.reject(err);
        }

        input.TransactItems.forEach(function (t) { table.set(key(t.Put.Item), t.Put.Item); });
        return Promise.resolve({});
    }

    if (command instanceof ddb.GetItemCommand)
    {
        return Promise.resolve({ Item: table.get(key(input.Key)) });
    }

    return Promise.reject(new Error('unexpected command'));
};

// ── OOBI fixtures ────────────────────────────────────────────────────────────

const agent1 = fs.readFileSync(path.join(FIX, 'agent1-oobi.cesr'), 'latin1');

function flipAt(s, i)
{
    return s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
}

const icpEnd = agent1.indexOf('-VBq');                    // first attachment group (icp)
const rotStart = agent1.indexOf('"t":"rot"');
const rotWitSigs = agent1.indexOf('-BAD', rotStart);      // rot witness signatures

const variants =
{
    good: agent1,
    'tampered-event': agent1.replace('"note":"hello"', '"note":"jello"'),
    'tampered-sig': flipAt(agent1, icpEnd + 8 + 20),      // inside the icp controller signature
    'weak-receipts': flipAt(flipAt(agent1, rotWitSigs + 4 + 30), rotWitSigs + 4 + 88 + 30)
};

const server = http.createServer(function (req, res)
{
    const parts = req.url.split('/');   // /oobi/<aid>/<variant>
    const aid = parts[2];
    const variant = parts[3];

    let body = null;
    if (aid === AGENT1 && variants[variant]) { body = Buffer.from(variants[variant], 'latin1'); }
    if (aid === WEIGHTED && variant === 'agent1') { body = Buffer.from(agent1, 'latin1'); }
    else if (aid === WEIGHTED && fs.existsSync(path.join(FIX, variant + '.cesr'))) { body = fs.readFileSync(path.join(FIX, variant + '.cesr')); }
    if (variant === 'redirect') { res.writeHead(302, { Location: '/elsewhere' }); res.end(); return; }

    if (body == null) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json+cesr' });
    res.end(body);
});

// ── Signing ─────────────────────────────────────────────────────────────────

let signify;
function signWith(keyFile, text, indices)
{
    const seeds = JSON.parse(fs.readFileSync(path.join(FIX, keyFile))).current;
    return indices.map(function (i)
    {
        return new signify.Signer({ qb64: seeds[i] }).sign(Buffer.from(text, 'utf8'), i).qb64;
    });
}

function signSeeds(text, indices) { return signWith('weighted-keys.json', text, indices); }

// agent1: signify-ts by default; with USE_KLI=1, kli signs from the agent1 keystore (KLI_HOME, KLI_CWD)
function signKli(text)
{
    if (process.env.USE_KLI !== '1') { return signWith('agent1-keys.json', text, [0]); }

    const file = path.join(__dirname, '.req.txt');
    fs.writeFileSync(file, text);
    const out = execFileSync(KLI, ['sign', '--name', 'agent1', '--alias', 'agent1', '--text', '@' + file],
        { env: Object.assign({}, process.env, process.env.KLI_HOME ? { HOME: process.env.KLI_HOME } : {}), cwd: process.env.KLI_CWD || __dirname }).toString();
    fs.unlinkSync(file);
    return out.trim().split('\n').map(function (l) { return l.replace(/^\d+\.\s*/, '').trim(); });
}

function requestFor(aid, variant, overrides)
{
    return JSON.stringify(Object.assign(
    {
        aud: 'https://selfdriven.bot/engage',
        aid: aid,
        oobi: 'http://127.0.0.1:' + PORT + '/oobi/' + aid + '/' + variant,
        ts: new Date().toISOString(),
        nonce: crypto.randomBytes(18).toString('base64url'),
        capabilities: ['research', 'drafting'],
        note: 'test agent'
    }, overrides || {}));
}

// ── Lambda invocation ───────────────────────────────────────────────────────

process.env.TABLE_NAME = 'selfdriven-bot-test';
process.env.ORIGIN_SECRET = SECRET;
process.env.ALLOW_PRIVATE_OOBI_HOSTS = 'true';

const handler = require(path.join(LAMBDA, 'index.js')).handler;

function call(method, rawPath, body, headers)
{
    return handler(
    {
        version: '2.0',
        rawPath: rawPath,
        headers: Object.assign({ 'x-origin-verify': SECRET, 'x-forwarded-for': '203.0.113.9' }, headers || {}),
        requestContext: { http: { method: method, path: rawPath, sourceIp: '130.176.0.1' } },
        body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
        isBase64Encoded: false
    })
    .then(function (res)
    {
        return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
    });
}

// ── Tests ───────────────────────────────────────────────────────────────────

const results = [];

function expect(name, res, status, error)
{
    const ok = res.status === status && (error === undefined || (res.body && res.body.error === error));
    results.push({ name: name, ok: ok });
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  → ' + res.status + (res.body && res.body.error ? ' ' + res.body.error : '') +
        (ok ? '' : '  ' + JSON.stringify(res.body)));
    return res;
}

async function main()
{
    signify = await import(path.join(LAMBDA, 'node_modules', 'signify-ts', 'dist', 'index.js'));
    await signify.ready();
    await new Promise(function (r) { server.listen(PORT, '127.0.0.1', r); });

    // 1. kli-signed request, witnessed KEL with rot + ixn
    const req1 = requestFor(AGENT1, 'good');
    const body1 = { request: req1, sigs: signKli(req1) };
    const r1 = expect((process.env.USE_KLI === '1' ? 'kli' : 'signify-ts') + '-signed request, witnessed KEL', await call('POST', '/engage', body1), 201);

    // 2. same request again
    expect('replayed nonce', await call('POST', '/engage', body1), 409, 'replay');

    // 3. status
    const st = expect('engagement status', await call('GET', '/engage/' + r1.body.engagement), 200);
    results.push({ name: 'status shows listed', ok: st.body.status === 'listed' && st.body.aid === AGENT1 });

    // 4. weighted threshold, 2 of 3 signers (signify-ts)
    const req4 = requestFor(WEIGHTED, 'weighted');
    expect('weighted kt, 2 of 3 signatures', await call('POST', '/engage', { request: req4, sigs: signSeeds(req4, [0, 2]) }), 201);

    // 5. weighted threshold, 1 of 3
    const req5 = requestFor(WEIGHTED, 'weighted');
    expect('weighted kt, 1 of 3 signatures', await call('POST', '/engage', { request: req5, sigs: signSeeds(req5, [1]) }), 422, 'signature_invalid');

    // 6. signature over different bytes
    const req6 = requestFor(AGENT1, 'good');
    expect('signature over other text', await call('POST', '/engage', { request: req6, sigs: signKli(req6 + ' ') }), 422, 'signature_invalid');

    // 7-11. KEL faults
    const req7 = requestFor(AGENT1, 'tampered-event');
    expect('tampered event data', await call('POST', '/engage', { request: req7, sigs: signKli(req7) }), 422, 'kel_invalid');

    const req8 = requestFor(AGENT1, 'tampered-sig');
    expect('tampered controller signature', await call('POST', '/engage', { request: req8, sigs: signKli(req8) }), 422, 'kel_invalid');

    const req9 = requestFor(WEIGHTED, 'bad-prerotation');
    expect('rotation to uncommitted keys', await call('POST', '/engage', { request: req9, sigs: signSeeds(req9, [0, 1]) }), 422, 'kel_invalid');

    const req10 = requestFor(WEIGHTED, 'weighted-underthreshold');
    expect('ixn under signing threshold', await call('POST', '/engage', { request: req10, sigs: signSeeds(req10, [0, 1]) }), 422, 'kel_invalid');

    const req11 = requestFor(WEIGHTED, 'agent1');
    expect('OOBI serves a different AID', await call('POST', '/engage', { request: req11, sigs: signSeeds(req11, [0, 1]) }), 422, 'kel_invalid');

    // 12-13. witness threshold enforced vs reported
    const req12 = requestFor(AGENT1, 'weak-receipts');
    expect('rot with 1 of 3 witness receipts (enforced)', await call('POST', '/engage', { request: req12, sigs: signKli(req12) }), 422, 'kel_invalid');

    process.env.REQUIRE_WITNESS_THRESHOLD = 'false';
    const req13 = requestFor(AGENT1, 'weak-receipts');
    const r13 = expect('rot with 1 of 3 witness receipts (reported)', await call('POST', '/engage', { request: req13, sigs: signKli(req13) }), 201);
    results.push({ name: 'receiptsMet reported false', ok: r13.body.keyState.receiptsMet === false });
    delete process.env.REQUIRE_WITNESS_THRESHOLD;

    // 14-19. request validation
    const req14 = requestFor(AGENT1, 'good', { ts: new Date(Date.now() - 600000).toISOString() });
    expect('stale timestamp', await call('POST', '/engage', { request: req14, sigs: signKli(req14) }), 400, 'stale_request');

    const req15 = requestFor(AGENT1, 'good', { aud: 'https://example.com/engage' });
    expect('wrong audience', await call('POST', '/engage', { request: req15, sigs: signKli(req15) }), 400, 'bad_request');

    const req16 = requestFor(AGENT1, 'good', { oobi: 'http://127.0.0.1:' + PORT + '/oobi/other/good' });
    expect('OOBI path without the AID', await call('POST', '/engage', { request: req16, sigs: ['x'] }), 400, 'bad_request');

    expect('malformed body', await call('POST', '/engage', 'not json'), 400, 'bad_request');

    expect('no origin secret', await call('POST', '/engage', body1, { 'x-origin-verify': 'wrong' }), 403, 'forbidden');

    const req17 = requestFor(AGENT1, 'redirect');
    expect('OOBI redirect not followed', await call('POST', '/engage', { request: req17, sigs: signKli(req17) }), 422, 'oobi_unreachable');

    // 20-21. SSRF guard with private hosts disallowed
    process.env.ALLOW_PRIVATE_OOBI_HOSTS = 'false';
    const req18 = requestFor(AGENT1, 'good');
    expect('loopback OOBI host blocked', await call('POST', '/engage', { request: req18, sigs: signKli(req18) }), 422, 'oobi_host_not_allowed');

    const req19 = requestFor(AGENT1, 'good', { oobi: 'http://169.254.169.254/oobi/' + AGENT1 + '/controller' });
    expect('metadata endpoint blocked', await call('POST', '/engage', { request: req19, sigs: signKli(req19) }), 422, 'oobi_host_not_allowed');
    process.env.ALLOW_PRIVATE_OOBI_HOSTS = 'true';

    // 22-24. routes
    const usage = expect('GET /engage usage', await call('GET', '/engage'), 200);
    results.push({ name: 'usage names the audience', ok: usage.body.request.aud.indexOf('https://selfdriven.bot/engage') === 0 });
    expect('unknown engagement', await call('GET', '/engage/' + crypto.randomUUID()), 404, 'not_found');
    expect('unknown route', await call('GET', '/nope'), 404, 'not_found');

    server.close();

    const failed = results.filter(function (r) { return !r.ok; });
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
    process.exit(failed.length ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
