var entityos = require('entityos');
var _ = require('lodash');
var crypto = require('crypto');
var dns = require('dns');
var net = require('net');
var http = require('http');
var https = require('https');
var kelVerify = require('./kel-verify');

// selfdriven.bot /engage
//
//   GET  /engage          usage document (how to call POST /engage)
//   POST /engage          signed engagement request: resolve the agent's OOBI, verify its KEL,
//                         verify the request signatures against current keys, record the listing
//   GET  /engage/{id}     engagement status
//
// Sits behind CloudFront. CloudFront adds a secret origin header; direct calls to the function URL
// without it are refused.

module.exports =
{
    VERSION: '1.0.0',

    init: function (param)
    {
        // ── Config ──────────────────────────────────────────────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-engage-get-config',
            code: function ()
            {
                const settings = entityos.get({ scope: '_settings' });

                const config = {
                    region: _.get(settings, 'infrastructure.aws.region',
                            process.env.AWS_REGION || 'ap-southeast-2')
                };

                const accessId = _.get(settings, 'infrastructure.aws.access.id');
                if (accessId && accessId !== 'iam-role')
                {
                    config.credentials = {
                        accessKeyId:     accessId,
                        secretAccessKey: _.get(settings, 'infrastructure.aws.access.secret')
                    };
                }

                return config;
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-engage-get-settings',
            code: function ()
            {
                const settings = entityos.get({ scope: '_settings' });

                return {
                    table:                   _.get(settings, 'engage.table'),
                    originSecret:            _.get(settings, 'engage.originSecret', ''),
                    audience:                _.get(settings, 'engage.audience', 'https://selfdriven.bot/engage'),
                    allowPrivateHosts:       _.get(settings, 'engage.allowPrivateHosts', false),
                    requireWitnessThreshold: _.get(settings, 'engage.requireWitnessThreshold', true),
                    maxSkewSeconds:          _.get(settings, 'engage.maxSkewSeconds', 300),
                    maxBodyBytes:            _.get(settings, 'engage.maxBodyBytes', 16384),
                    oobiTimeoutMs:           _.get(settings, 'engage.oobiTimeoutMs', 5000),
                    oobiMaxBytes:            _.get(settings, 'engage.oobiMaxBytes', 524288)
                };
            }
        });

        // ── Router ──────────────────────────────────────────────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-engage-route',
            code: function ()
            {
                const event   = entityos.get({ scope: '_event' });
                const engage  = entityos.invoke('util-aws-selfdriven-bot-engage-get-settings');
                const headers = _.mapKeys(_.get(event, 'headers', {}), function (v, k) { return k.toLowerCase(); });

                const method  = (_.get(event, 'requestContext.http.method')
                    || _.get(event, 'httpMethod')
                    || 'GET').toUpperCase();

                const rawPath = (_.get(event, 'rawPath')
                    || _.get(event, 'requestContext.http.path')
                    || _.get(event, 'path')
                    || '/').replace(/\/+$/, '') || '/';

                console.log('[selfdriven-bot-engage] ' + method + ' ' + rawPath);

                if (engage.originSecret)
                {
                    const presented = Buffer.from(String(headers['x-origin-verify'] || ''));
                    const expected  = Buffer.from(engage.originSecret);

                    if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected))
                    {
                        entityos.invoke('util-aws-selfdriven-bot-engage-respond-error',
                            { status: 403, error: 'forbidden', message: 'Call https://selfdriven.bot/engage, not the origin.' });
                        return;
                    }
                }

                const statusMatch = rawPath.match(/^\/engage\/([0-9a-f-]{36})$/);

                if (method === 'OPTIONS')
                {
                    entityos.invoke('util-end', entityos.invoke('util-response-json', { status: 204, body: null }));
                }
                else if (rawPath === '/engage' && method === 'POST')
                {
                    entityos.invoke('util-aws-selfdriven-bot-engage-request-parse');
                }
                else if (rawPath === '/engage' && (method === 'GET' || method === 'HEAD'))
                {
                    entityos.invoke('util-aws-selfdriven-bot-engage-usage');
                }
                else if (statusMatch && (method === 'GET' || method === 'HEAD'))
                {
                    entityos.invoke('util-aws-selfdriven-bot-engage-status-get', { id: statusMatch[1] });
                }
                else
                {
                    entityos.invoke('util-aws-selfdriven-bot-engage-respond-error',
                        { status: 404, error: 'not_found', message: 'Routes: GET /engage, POST /engage, GET /engage/{id}.' });
                }
            }
        });

        // ── GET /engage ─────────────────────────────────────────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-engage-usage',
            code: function ()
            {
                const engage = entityos.invoke('util-aws-selfdriven-bot-engage-get-settings');

                entityos.invoke('util-end', entityos.invoke('util-response-json',
                {
                    status: 200,
                    body:
                    {
                        endpoint: 'POST /engage',
                        contentType: 'application/json',
                        body:
                        {
                            request: 'JSON string, signed exactly as sent',
                            sigs: ['CESR qb64 indexed signatures over the UTF-8 bytes of request, by the current signing keys, meeting kt']
                        },
                        request:
                        {
                            aud: engage.audience + ' (required, exact)',
                            aid: 'your AID (required, transferable: E or D prefix)',
                            oobi: 'URL that resolves your KEL; must contain your AID (required)',
                            ts: 'ISO 8601 UTC time, within ' + engage.maxSkewSeconds + 's of now (required)',
                            nonce: '16-64 chars of [A-Za-z0-9_-], never reused (required)',
                            capabilities: 'up to 16 lowercase slugs, e.g. ["research","drafting"] (optional)',
                            note: 'up to 280 chars (optional)'
                        },
                        witnessThreshold: engage.requireWitnessThreshold ? 'enforced' : 'reported only',
                        status: 'GET /engage/{id}',
                        docs: 'https://selfdriven.bot/llms.txt'
                    }
                }));
            }
        });

        // ── POST /engage: parse + validate ──────────────────────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-engage-request-parse',
            code: function ()
            {
                const event  = entityos.get({ scope: '_event' });
                const engage = entityos.invoke('util-aws-selfdriven-bot-engage-get-settings');

                let raw = _.get(event, 'body') || '';
                if (_.get(event, 'isBase64Encoded')) { raw = Buffer.from(raw, 'base64').toString('utf8'); }

                if (Buffer.byteLength(raw, 'utf8') > engage.maxBodyBytes)
                {
                    entityos.invoke('util-aws-selfdriven-bot-engage-respond-error',
                        { status: 413, error: 'too_large', message: 'Body over ' + engage.maxBodyBytes + ' bytes.' });
                    return;
                }

                let body;
                try { body = JSON.parse(raw); }
                catch (e) { body = null; }

                if (body == null || typeof body.request !== 'string' || !Array.isArray(body.sigs) || body.sigs.length === 0 || body.sigs.length > 32)
                {
                    entityos.invoke('util-aws-selfdriven-bot-engage-respond-error',
                        { status: 400, error: 'bad_request', message: 'Body must be {"request": "<JSON string>", "sigs": ["<qb64>", ...]}. See GET /engage.' });
                    return;
                }

                let request;
                try { request = JSON.parse(body.request); }
                catch (e) { request = null; }

                const problems = entityos.invoke('util-aws-selfdriven-bot-engage-request-validate', { request: request });

                if (problems.length > 0)
                {
                    entityos.invoke('util-aws-selfdriven-bot-engage-respond-error',
                        { status: 400, error: 'bad_request', message: problems.join(' ') });
                    return;
                }

                const skew = Math.abs(Date.now() - Date.parse(request.ts)) / 1000;
                if (skew > engage.maxSkewSeconds)
                {
                    entityos.invoke('util-aws-selfdriven-bot-engage-respond-error',
                        { status: 400, error: 'stale_request', message: 'ts is ' + Math.round(skew) + 's from server time; limit ' + engage.maxSkewSeconds + 's.' });
                    return;
                }

                entityos.set({ scope: 'selfdriven-bot-engage', context: 'request', value: request });
                entityos.set({ scope: 'selfdriven-bot-engage', context: 'requestBytes', value: Buffer.from(body.request, 'utf8') });
                entityos.set({ scope: 'selfdriven-bot-engage', context: 'sigs', value: body.sigs });

                entityos.invoke('util-aws-selfdriven-bot-engage-oobi-fetch');
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-engage-request-validate',
            code: function (param)
            {
                const engage  = entityos.invoke('util-aws-selfdriven-bot-engage-get-settings');
                const request = _.get(param, 'request');
                const problems = [];

                if (!_.isPlainObject(request)) { return ['request must be a JSON object.']; }

                if (request.aud !== engage.audience) { problems.push('aud must be "' + engage.audience + '".'); }

                if (typeof request.aid !== 'string' || !/^[ED][A-Za-z0-9_-]{43}$/.test(request.aid))
                {
                    problems.push('aid must be a transferable KERI AID (44 chars, E or D prefix).');
                }

                let oobi = null;
                try { oobi = new URL(request.oobi); }
                catch (e) { oobi = null; }

                if (oobi == null || (oobi.protocol !== 'https:' && oobi.protocol !== 'http:') || oobi.username || oobi.password)
                {
                    problems.push('oobi must be an http(s) URL without credentials.');
                }
                else if (typeof request.aid === 'string' && oobi.pathname.split('/').indexOf(request.aid) === -1)
                {
                    problems.push('oobi path must contain your aid.');
                }

                if (typeof request.ts !== 'string' || isNaN(Date.parse(request.ts)) || !/(Z|[+-]00:00)$/.test(request.ts))
                {
                    problems.push('ts must be an ISO 8601 UTC time.');
                }

                if (typeof request.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(request.nonce))
                {
                    problems.push('nonce must be 16-64 chars of [A-Za-z0-9_-].');
                }

                if (request.capabilities !== undefined)
                {
                    const ok = Array.isArray(request.capabilities)
                        && request.capabilities.length <= 16
                        && _.every(request.capabilities, function (c) { return typeof c === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(c); });
                    if (!ok) { problems.push('capabilities must be up to 16 lowercase slugs.'); }
                }

                if (request.note !== undefined && (typeof request.note !== 'string' || request.note.length > 280))
                {
                    problems.push('note must be a string of up to 280 chars.');
                }

                return problems;
            }
        });

        // ── Resolve the agent's OOBI (SSRF-guarded) ────────────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-engage-ip-blocked',
            code: function (param)
            {
                let address = _.get(param, 'address', '');
                let family  = net.isIP(address);

                const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
                if (mapped) { address = mapped[1]; family = 4; }

                let blockList = entityos.get({ scope: 'selfdriven-bot-engage', context: 'blockList' });

                if (blockList == undefined)
                {
                    blockList = new net.BlockList();

                    [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
                     ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
                     ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]
                    .forEach(function (s) { blockList.addSubnet(s[0], s[1], 'ipv4'); });

                    [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
                     ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]
                    .forEach(function (s) { blockList.addSubnet(s[0], s[1], 'ipv6'); });

                    entityos.set({ scope: 'selfdriven-bot-engage', context: 'blockList', value: blockList });
                }

                if (family === 0) { return true; }
                return blockList.check(address, family === 6 ? 'ipv6' : 'ipv4');
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-engage-oobi-fetch',
            code: function ()
            {
                const engage  = entityos.invoke('util-aws-selfdriven-bot-engage-get-settings');
                const request = entityos.get({ scope: 'selfdriven-bot-engage', context: 'request' });
                const url     = new URL(request.oobi);
                const host    = url.hostname.replace(/^\[|\]$/g, '');

                dns.promises.lookup(host, { all: true, verbatim: true })
                .then(function (addresses)
                {
                    const blocked = _.find(addresses, function (a)
                    {
                        return entityos.invoke('util-aws-selfdriven-bot-engage-ip-blocked', { address: a.address });
                    });

                    if (blocked && !engage.allowPrivateHosts)
                    {
                        const err = new Error('OOBI host resolves to a private or reserved address.');
                        err.code = 'oobi_host_not_allowed';
                        throw err;
                    }

                    // Connect to the address we vetted, so a second DNS answer can't redirect us.
                    const pinned = addresses[0];

                    return new Promise(function (resolve, reject)
                    {
                        const lib = url.protocol === 'https:' ? https : http;
                        let settled = false;

                        function finish(err, value)
                        {
                            if (settled) { return; }
                            settled = true;
                            clearTimeout(timer);
                            if (err) { reject(err); } else { resolve(value); }
                        }

                        const req = lib.request(
                        {
                            protocol: url.protocol,
                            hostname: host,
                            port: url.port || undefined,
                            path: url.pathname + url.search,
                            method: 'GET',
                            headers: { 'Accept': 'application/json+cesr, application/cesr, */*', 'User-Agent': 'selfdriven.bot-engage/1.0' },
                            lookup: function (hostname, options, cb)
                            {
                                if (options && options.all) { cb(null, [{ address: pinned.address, family: pinned.family }]); }
                                else { cb(null, pinned.address, pinned.family); }
                            }
                        },
                        function (res)
                        {
                            if (res.statusCode >= 300 && res.statusCode < 400)
                            {
                                res.resume();
                                const err = new Error('OOBI redirected (' + res.statusCode + '); redirects are not followed. Submit the final URL.');
                                err.code = 'oobi_unreachable';
                                finish(err);
                                return;
                            }

                            if (res.statusCode !== 200)
                            {
                                res.resume();
                                const err = new Error('OOBI returned HTTP ' + res.statusCode + '.');
                                err.code = 'oobi_unreachable';
                                finish(err);
                                return;
                            }

                            const chunks = [];
                            let size = 0;

                            res.on('data', function (chunk)
                            {
                                size += chunk.length;
                                if (size > engage.oobiMaxBytes)
                                {
                                    const err = new Error('OOBI response over ' + engage.oobiMaxBytes + ' bytes.');
                                    err.code = 'oobi_unreachable';
                                    req.destroy();
                                    finish(err);
                                    return;
                                }
                                chunks.push(chunk);
                            });

                            res.on('end', function () { finish(null, Buffer.concat(chunks)); });
                            res.on('error', function (e) { finish(Object.assign(new Error('OOBI read failed: ' + e.message), { code: 'oobi_unreachable' })); });
                        });

                        const timer = setTimeout(function ()
                        {
                            req.destroy();
                            finish(Object.assign(new Error('OOBI did not respond within ' + engage.oobiTimeoutMs + 'ms.'), { code: 'oobi_unreachable' }));
                        }, engage.oobiTimeoutMs);

                        req.on('error', function (e)
                        {
                            finish(Object.assign(new Error('OOBI request failed: ' + e.message), { code: 'oobi_unreachable' }));
                        });

                        req.end();
                    });
                })
                .then(function (stream)
                {
                    console.log('[selfdriven-bot-engage] OOBI fetched: ' + stream.length + ' bytes from ' + url.host);
                    entityos.set({ scope: 'selfdriven-bot-engage', context: 'oobiStream', value: stream });
                    entityos.invoke('util-aws-selfdriven-bot-engage-kel-verify');
                })
                .catch(function (err)
                {
                    const code = err.code === 'oobi_host_not_allowed' ? 'oobi_host_not_allowed'
                        : (err.code === 'ENOTFOUND' ? 'oobi_unreachable' : (err.code || 'oobi_unreachable'));

                    entityos.invoke('util-aws-selfdriven-bot-engage-respond-error',
                        { status: 422, error: code, message: err.code === 'ENOTFOUND' ? 'OOBI host not found.' : err.message });
                });
            }
        });

        // ── Verify KEL + request signatures ─────────────────────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-engage-kel-verify',
            code: function ()
            {
                const engage  = entityos.invoke('util-aws-selfdriven-bot-engage-get-settings');
                const request = entityos.get({ scope: 'selfdriven-bot-engage', context: 'request' });
                const stream  = entityos.get({ scope: 'selfdriven-bot-engage', context: 'oobiStream' });
                const bytes   = entityos.get({ scope: 'selfdriven-bot-engage', context: 'requestBytes' });
                const sigs    = entityos.get({ scope: 'selfdriven-bot-engage', context: 'sigs' });

                kelVerify.load()
                .then(function (m)
                {
                    let keyState;

                    try
                    {
                        const messages = kelVerify.parseStream(m, stream);
                        keyState = kelVerify.verifyKel(m, messages,
                        {
                            prefix: request.aid,
                            requireWitnessThreshold: engage.requireWitnessThreshold
                        });
                    }
                    catch (err)
                    {
                        entityos.invoke('util-aws-selfdriven-bot-engage-respond-error',
                            { status: 422, error: 'kel_invalid', message: err.message, detail: err.code });
                        return;
                    }

                    const check = kelVerify.verifySignatures(m, keyState, sigs, bytes);

                    if (!check.valid)
                    {
                        entityos.invoke('util-aws-selfdriven-bot-engage-respond-error',
                        {
                            status: 422,
                            error: 'signature_invalid',
                            message: check.verified + ' valid signature(s) over request by the keys at sn ' + keyState.sn + '; threshold ' + JSON.stringify(keyState.kt) + ' not met.'
                        });
                        return;
                    }

                    console.log('[selfdriven-bot-engage] Verified: aid=' + keyState.prefix + ' sn=' + keyState.sn + ' sigs=' + check.verified);
                    entityos.set({ scope: 'selfdriven-bot-engage', context: 'keyState', value: keyState });
                    entityos.invoke('util-aws-selfdriven-bot-engage-save');
                })
                .catch(function (err)
                {
                    console.error('[selfdriven-bot-engage] Verifier error:', err);
                    entityos.invoke('util-aws-selfdriven-bot-engage-respond-error',
                        { status: 500, error: 'server_error', message: 'Verifier failed to load.' });
                });
            }
        });

        // ── Record: nonce claim + engagement + agent, atomically ───────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-engage-save',
            code: function ()
            {
                const engage   = entityos.invoke('util-aws-selfdriven-bot-engage-get-settings');
                const request  = entityos.get({ scope: 'selfdriven-bot-engage', context: 'request' });
                const keyState = entityos.get({ scope: 'selfdriven-bot-engage', context: 'keyState' });
                const ip       = entityos.invoke('util-aws-selfdriven-bot-engage-ip-get');

                const id  = crypto.randomUUID();
                const now = new Date().toISOString();

                const summary =
                {
                    sn: keyState.sn,
                    digest: keyState.digest,
                    keys: keyState.keys,
                    kt: keyState.kt,
                    witnesses: keyState.witnesses.length,
                    toad: keyState.toad,
                    receiptsMet: keyState.receiptsMet,
                    delegated: keyState.delegated,
                    delegator: keyState.delegator
                };

                const engagement =
                {
                    id: id,
                    status: 'listed',
                    aid: request.aid,
                    oobi: request.oobi,
                    capabilities: request.capabilities || [],
                    note: request.note || null,
                    keyState: summary,
                    createdAt: now
                };

                const { DynamoDBClient, TransactWriteItemsCommand } = require('@aws-sdk/client-dynamodb');
                const ddb = new DynamoDBClient(entityos.invoke('util-aws-selfdriven-bot-engage-get-config'));

                ddb.send(new TransactWriteItemsCommand(
                {
                    TransactItems:
                    [
                        {
                            Put:
                            {
                                TableName: engage.table,
                                Item:
                                {
                                    pk:  { S: 'nonce#' + request.aid + '#' + request.nonce },
                                    sk:  { S: 'nonce' },
                                    ttl: { N: String(Math.floor(Date.now() / 1000) + engage.maxSkewSeconds * 4) }
                                },
                                ConditionExpression: 'attribute_not_exists(pk)'
                            }
                        },
                        {
                            Put:
                            {
                                TableName: engage.table,
                                Item:
                                {
                                    pk:         { S: 'eng#' + id },
                                    sk:         { S: 'eng' },
                                    aid:        { S: request.aid },
                                    status:     { S: 'listed' },
                                    engagement: { S: JSON.stringify(engagement) },
                                    sourceIp:   { S: ip },
                                    createdAt:  { S: now }
                                }
                            }
                        },
                        {
                            Put:
                            {
                                TableName: engage.table,
                                Item:
                                {
                                    pk:             { S: 'agent#' + request.aid },
                                    sk:             { S: 'agent' },
                                    keyState:       { S: JSON.stringify(summary) },
                                    oobi:           { S: request.oobi },
                                    lastEngagement: { S: id },
                                    updatedAt:      { S: now }
                                }
                            }
                        }
                    ]
                }))
                .then(function ()
                {
                    console.log('[selfdriven-bot-engage] Listed: aid=' + request.aid + ' id=' + id + ' ip=' + ip);

                    entityos.invoke('util-end', entityos.invoke('util-response-json',
                    {
                        status: 201,
                        headers: { Location: '/engage/' + id },
                        body:
                        {
                            status: 'listed',
                            engagement: id,
                            aid: request.aid,
                            keyState: summary,
                            next: 'Your capabilities are listed for conductors. Check GET /engage/' + id + ' for status. A conductor offer leads to delegation (dip) and an ACDC role credential.'
                        }
                    }));
                })
                .catch(function (err)
                {
                    const reasons = _.get(err, 'CancellationReasons', []);

                    if (err.name === 'TransactionCanceledException' && _.get(reasons, '[0].Code') === 'ConditionalCheckFailed')
                    {
                        entityos.invoke('util-aws-selfdriven-bot-engage-respond-error',
                            { status: 409, error: 'replay', message: 'This nonce has already been used. Sign a new request with a fresh nonce.' });
                        return;
                    }

                    console.error('[selfdriven-bot-engage] TransactWriteItems error:', err);
                    entityos.invoke('util-aws-selfdriven-bot-engage-respond-error',
                        { status: 500, error: 'server_error', message: 'Could not record the engagement.' });
                });
            }
        });

        // ── GET /engage/{id} ────────────────────────────────────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-engage-status-get',
            code: function (param)
            {
                const engage = entityos.invoke('util-aws-selfdriven-bot-engage-get-settings');
                const id     = _.get(param, 'id');

                const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
                const ddb = new DynamoDBClient(entityos.invoke('util-aws-selfdriven-bot-engage-get-config'));

                ddb.send(new GetItemCommand(
                {
                    TableName: engage.table,
                    Key: { pk: { S: 'eng#' + id }, sk: { S: 'eng' } }
                }))
                .then(function (response)
                {
                    const item = _.get(response, 'Item');

                    if (item == undefined)
                    {
                        entityos.invoke('util-aws-selfdriven-bot-engage-respond-error',
                            { status: 404, error: 'not_found', message: 'No engagement ' + id + '.' });
                        return;
                    }

                    const engagement = JSON.parse(_.get(item, 'engagement.S', '{}'));
                    engagement.status = _.get(item, 'status.S', engagement.status);

                    entityos.invoke('util-end', entityos.invoke('util-response-json', { status: 200, body: engagement }));
                })
                .catch(function (err)
                {
                    console.error('[selfdriven-bot-engage] GetItem error:', err);
                    entityos.invoke('util-aws-selfdriven-bot-engage-respond-error',
                        { status: 500, error: 'server_error', message: 'Could not read the engagement.' });
                });
            }
        });

        // ── Utilities ───────────────────────────────────────────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-engage-ip-get',
            code: function ()
            {
                const event = entityos.get({ scope: '_event' });
                const headers = _.mapKeys(_.get(event, 'headers', {}), function (v, k) { return k.toLowerCase(); });

                // Behind CloudFront the socket peer is the edge; the viewer is first in X-Forwarded-For.
                return (headers['x-forwarded-for'] || '').split(',')[0].trim()
                    || _.get(event, 'requestContext.http.sourceIp')
                    || _.get(event, 'requestContext.identity.sourceIp')
                    || 'unknown';
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-engage-respond-error',
            code: function (param)
            {
                const status = _.get(param, 'status', 500);
                const body = { error: _.get(param, 'error', 'server_error'), message: _.get(param, 'message', '') };
                if (_.get(param, 'detail')) { body.detail = _.get(param, 'detail'); }

                console.log('[selfdriven-bot-engage] ' + status + ' ' + body.error + ': ' + body.message);
                entityos.invoke('util-end', entityos.invoke('util-response-json', { status: status, body: body }));
            }
        });

        entityos.add(
        {
            name: 'util-response-json',
            code: function (param)
            {
                const body = _.get(param, 'body');

                return {
                    statusCode: _.get(param, 'status', 200),
                    headers: _.assign(
                    {
                        'Content-Type':                 'application/json',
                        'Cache-Control':                'no-store',
                        'X-Content-Type-Options':       'nosniff',
                        'Access-Control-Allow-Origin':  '*',
                        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type'
                    }, _.get(param, 'headers', {})),
                    body: body == null ? '' : JSON.stringify(body, null, 2)
                };
            }
        });
    }
};
