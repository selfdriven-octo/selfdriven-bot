'use strict';

// kel-verify.js
// CESR v1 stream parsing and KERI key event log (KEL) verification, built on signify-ts primitives.
//
// Verifies, per event: canonical JSON serialisation, SAID (self-addressing digest), prefix derivation,
// sequence and prior-digest chaining, controller signatures against the signing threshold, and on
// rotation that the newly exposed keys satisfy the prior next-key commitments (pre-rotation).
// Witness receipts are verified and counted against the witness threshold (toad) and reported;
// enforcement is a caller option. Delegated events (dip/drt) are accepted and flagged, but the
// delegator's anchoring seal is not checked here because that needs the delegator's own KEL.

var signify; // promise of the ready signify-ts module

function load()
{
    if (signify == undefined)
    {
        // signify-ts is ESM-only; dynamic import works from CommonJS on every Node version Lambda runs.
        signify = import('signify-ts').then(function (m)
        {
            return m.ready().then(function () { return m; });
        });
    }
    return signify;
}

var VERSION_RE = /^(KERI|ACDC)([0-9a-f])([0-9a-f])(JSON)([0-9a-f]{6})_$/;
var KEL_ILKS = ['icp', 'rot', 'ixn', 'dip', 'drt'];
var SAID_DUMMY = '#'.repeat(44);

function fail(code, message, extra)
{
    var err = new Error(message);
    err.code = code;
    if (extra) { err.detail = extra; }
    return err;
}

// ── CESR stream parsing ─────────────────────────────────────────────────────

function parseStream(m, input)
{
    var buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
    var s = buf.toString('latin1'); // 1 char per byte, so string indices are byte offsets
    var pos = 0;
    var messages = [];

    function primitive(Type)
    {
        var p = new Type({ qb64: s.slice(pos) });
        pos += p.qb64.length;
        return p;
    }

    function counter()
    {
        var c = new m.Counter({ qb64: s.slice(pos) });
        pos += c.qb64.length;
        return c;
    }

    function sigs(n)
    {
        var out = [];
        for (var i = 0; i < n; i++) { out.push(primitive(m.Siger)); }
        return out;
    }

    function group(msg, end)
    {
        var c = counter();
        var n = c.count;
        var att = msg.attachments;
        var i;

        switch (c.code)
        {
            case '-V':
            case '-0V':
                var stop = pos + n * 4;
                if (stop > end) { throw fail('cesr', 'attachment group overruns the stream'); }
                while (pos < stop) { group(msg, stop); }
                break;
            case '-A':
                att.controllerSigs = att.controllerSigs.concat(sigs(n));
                break;
            case '-B':
                att.witnessSigs = att.witnessSigs.concat(sigs(n));
                break;
            case '-C':
                for (i = 0; i < n; i++) { att.receiptCouples.push({ verfer: primitive(m.Verfer), cigar: primitive(m.Matter) }); }
                break;
            case '-D':
                for (i = 0; i < n; i++) { primitive(m.Matter); primitive(m.Matter); primitive(m.Matter); primitive(m.Siger); }
                break;
            case '-E':
                for (i = 0; i < n; i++) { primitive(m.Matter); primitive(m.Matter); }
                break;
            case '-F':
                for (i = 0; i < n; i++)
                {
                    primitive(m.Matter); primitive(m.Matter); primitive(m.Matter);
                    var inner = counter();
                    if (inner.code !== '-A') { throw fail('cesr', 'expected controller signatures in signature group'); }
                    sigs(inner.count);
                }
                break;
            case '-G':
                for (i = 0; i < n; i++) { att.sealSources.push({ seqner: primitive(m.Matter), saider: primitive(m.Matter) }); }
                break;
            case '-H':
                for (i = 0; i < n; i++)
                {
                    primitive(m.Matter);
                    var last = counter();
                    if (last.code !== '-A') { throw fail('cesr', 'expected controller signatures in signature group'); }
                    sigs(last.count);
                }
                break;
            case '-I':
                for (i = 0; i < n; i++) { primitive(m.Matter); primitive(m.Matter); primitive(m.Matter); }
                break;
            case '--AAA':
                break; // protocol stack version marker, no payload
            default:
                throw fail('cesr', 'unsupported attachment count code ' + c.code);
        }
    }

    while (pos < s.length)
    {
        var ch = s[pos];

        if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') { pos++; continue; }

        if (ch === '{')
        {
            var head = s.slice(pos, pos + 64).match(/"v":"([^"]{17})"/);
            if (head == null) { throw fail('cesr', 'message without a version string at byte ' + pos); }
            var vm = VERSION_RE.exec(head[1]);
            if (vm == null) { throw fail('cesr', 'unsupported version string ' + head[1]); }
            var size = parseInt(vm[5], 16);
            if (pos + size > buf.length) { throw fail('cesr', 'message size overruns the stream'); }

            var raw = buf.subarray(pos, pos + size);
            var ked;
            try { ked = JSON.parse(raw.toString('utf8')); }
            catch (e) { throw fail('cesr', 'message at byte ' + pos + ' is not valid JSON'); }

            messages.push(
            {
                proto: vm[1],
                raw: raw,
                ked: ked,
                attachments: { controllerSigs: [], witnessSigs: [], receiptCouples: [], sealSources: [] }
            });
            pos += size;
            continue;
        }

        if (ch === '-')
        {
            if (messages.length === 0) { throw fail('cesr', 'attachments before any message'); }
            group(messages[messages.length - 1], s.length);
            continue;
        }

        throw fail('cesr', 'unexpected byte at ' + pos + ': only JSON messages and text-domain CESR attachments are supported');
    }

    return messages;
}

// ── Event checks ────────────────────────────────────────────────────────────

function digestOf(m, bytes)
{
    return new m.Diger({ code: m.MtrDex.Blake3_256 }, bytes).qb64;
}

function checkSerialisation(msg)
{
    // The signed bytes must be exactly the compact serialisation of the parsed event,
    // so the fields we check are the fields that were signed.
    if (JSON.stringify(msg.ked) !== msg.raw.toString('utf8'))
    {
        throw fail('serialisation', 'event ' + msg.ked.t + ' sn ' + msg.ked.s + ' is not canonically serialised');
    }
}

function checkSaid(m, ked)
{
    if (typeof ked.d !== 'string' || ked.d.length !== 44 || ked.d[0] !== 'E')
    {
        throw fail('said', 'event SAID must be a Blake3-256 digest (E prefix)');
    }

    var dummied = Object.assign({}, ked, { d: SAID_DUMMY });
    if ((ked.t === 'icp' || ked.t === 'dip') && ked.i === ked.d) { dummied.i = SAID_DUMMY; }

    var computed = digestOf(m, Buffer.from(JSON.stringify(dummied), 'utf8'));
    if (computed !== ked.d)
    {
        throw fail('said', 'SAID mismatch on ' + ked.t + ' sn ' + ked.s);
    }
}

function tholder(m, sith)
{
    return new m.Tholder({ sith: sith });
}

function verifyIndexedSigs(m, sigers, keys, bytes)
{
    // Returns the verified sigers, each checked against keys[index].
    var verified = [];
    var seen = {};

    sigers.forEach(function (siger)
    {
        if (siger.index >= keys.length || seen[siger.index]) { return; }
        var verfer = new m.Verfer({ qb64: keys[siger.index] });
        if (verfer.verify(siger.raw, bytes))
        {
            seen[siger.index] = true;
            verified.push(siger);
        }
    });

    return verified;
}

function checkControllerSigs(m, msg, keys, kt)
{
    var verified = verifyIndexedSigs(m, msg.attachments.controllerSigs, keys, msg.raw);
    var indices = verified.map(function (sg) { return sg.index; });

    if (!tholder(m, kt).satisfy(indices))
    {
        throw fail('signatures', msg.ked.t + ' sn ' + msg.ked.s + ': ' + indices.length + ' valid signature(s), signing threshold ' + JSON.stringify(kt) + ' not met');
    }

    return verified;
}

function checkPreRotation(m, msg, verified, prior)
{
    // Each verified signature with a prior-next index must expose a key whose digest
    // matches the prior next-key commitment at that index; together they must meet prior nt.
    var keys = msg.ked.k;
    var ondices = [];

    verified.forEach(function (siger)
    {
        var ondex = (siger.ondex === undefined || siger.ondex === null) ? undefined : siger.ondex;
        if (ondex === undefined) { return; } // current-only signature, not counted toward prior next
        if (ondex >= prior.n.length) { return; }

        var keyDigest = digestOf(m, Buffer.from(keys[siger.index], 'utf8'));
        if (keyDigest === prior.n[ondex]) { ondices.push(ondex); }
    });

    if (!tholder(m, prior.nt).satisfy(ondices))
    {
        throw fail('prerotation', 'rot sn ' + msg.ked.s + ': exposed keys do not satisfy the prior next-key commitment');
    }
}

function countReceipts(m, msg, witnesses)
{
    var good = {};

    verifyIndexedSigs(m, msg.attachments.witnessSigs, witnesses, msg.raw).forEach(function (siger)
    {
        good[witnesses[siger.index]] = true;
    });

    msg.attachments.receiptCouples.forEach(function (couple)
    {
        var wit = couple.verfer.qb64;
        if (witnesses.indexOf(wit) === -1) { return; }
        if (couple.verfer.verify(couple.cigar.raw, msg.raw)) { good[wit] = true; }
    });

    return Object.keys(good).length;
}

function hexInt(value, field)
{
    if (typeof value !== 'string' || !/^[0-9a-f]+$/.test(value)) { throw fail('event', 'field ' + field + ' must be lowercase hex'); }
    return parseInt(value, 16);
}

// ── KEL verification ────────────────────────────────────────────────────────

function verifyKel(m, messages, options)
{
    options = options || {};
    var prefix = options.prefix;
    var state = null;
    var receipts = [];

    var events = messages.filter(function (msg)
    {
        if (msg.proto !== 'KERI' || KEL_ILKS.indexOf(msg.ked.t) === -1) { return false; }
        if (prefix == undefined && (msg.ked.t === 'icp' || msg.ked.t === 'dip')) { prefix = msg.ked.i; }
        return msg.ked.i === prefix;
    });

    if (events.length === 0) { throw fail('kel', 'no key events found' + (prefix ? ' for ' + prefix : '')); }

    events.forEach(function (msg)
    {
        var ked = msg.ked;
        var sn = hexInt(ked.s, 's');

        if (state && sn <= state.sn)
        {
            if (sn < state.events.length && state.events[sn] === ked.d) { return; } // duplicate copy
            throw fail('fork', 'conflicting event at sn ' + sn + ' (recovery rotations are not accepted here)');
        }

        checkSerialisation(msg);
        checkSaid(m, ked);

        var verified;
        var witnesses;
        var toad;

        if (ked.t === 'icp' || ked.t === 'dip')
        {
            if (state != null || sn !== 0) { throw fail('kel', 'inception must be the first event at sn 0'); }
            if (!Array.isArray(ked.k) || ked.k.length === 0) { throw fail('event', 'inception has no signing keys'); }
            if (!Array.isArray(ked.n) || ked.n.length === 0) { throw fail('event', 'agent AIDs must be transferable (non-empty next keys)'); }

            var code = ked.i[0];
            if (code === 'E')
            {
                if (ked.i !== ked.d) { throw fail('prefix', 'self-addressing prefix does not equal the inception SAID'); }
            }
            else if (code === 'D')
            {
                if (ked.k.length !== 1 || ked.k[0] !== ked.i) { throw fail('prefix', 'basic prefix does not match the single signing key'); }
            }
            else
            {
                throw fail('prefix', 'unsupported prefix derivation code ' + code);
            }

            if (ked.t === 'dip' && typeof ked.di !== 'string') { throw fail('event', 'dip without delegator'); }

            verified = checkControllerSigs(m, msg, ked.k, ked.kt);
            witnesses = ked.b || [];
            toad = hexInt(ked.bt, 'bt');

            state =
            {
                prefix: ked.i,
                sn: 0,
                d: ked.d,
                k: ked.k, kt: ked.kt,
                n: ked.n, nt: ked.nt,
                b: witnesses, bt: toad,
                delegated: ked.t === 'dip',
                delegator: ked.di,
                lastEst: { sn: 0, d: ked.d, t: ked.t },
                events: [ked.d]
            };
        }
        else
        {
            if (state == null) { throw fail('kel', 'event before inception'); }
            if (sn !== state.sn + 1) { throw fail('kel', 'sequence gap: expected sn ' + (state.sn + 1) + ', got ' + sn); }
            if (ked.p !== state.d) { throw fail('kel', 'prior digest mismatch at sn ' + sn); }

            if (ked.t === 'ixn')
            {
                checkControllerSigs(m, msg, state.k, state.kt);
                witnesses = state.b;
                toad = state.bt;
            }
            else // rot, drt
            {
                if (ked.t === 'drt' && !state.delegated) { throw fail('event', 'drt on a non-delegated AID'); }
                if (ked.t === 'rot' && state.delegated) { throw fail('event', 'delegated AIDs rotate with drt'); }
                if (state.n.length === 0) { throw fail('event', 'AID is abandoned (empty next keys)'); }

                verified = checkControllerSigs(m, msg, ked.k, ked.kt);
                checkPreRotation(m, msg, verified, state);

                var cut = ked.br || [];
                var add = ked.ba || [];
                witnesses = state.b.filter(function (w) { return cut.indexOf(w) === -1; }).concat(add);
                toad = hexInt(ked.bt, 'bt');

                state.k = ked.k; state.kt = ked.kt;
                state.n = ked.n; state.nt = ked.nt;
                state.b = witnesses; state.bt = toad;
                state.lastEst = { sn: sn, d: ked.d, t: ked.t };
            }

            state.sn = sn;
            state.d = ked.d;
            state.events.push(ked.d);
        }

        var count = countReceipts(m, msg, witnesses);
        receipts.push({ sn: sn, t: ked.t, d: ked.d, witnessReceipts: count, toad: toad, met: count >= toad });

        if (options.requireWitnessThreshold && count < toad)
        {
            throw fail('receipts', ked.t + ' sn ' + sn + ': ' + count + ' witness receipt(s), threshold ' + toad);
        }
    });

    return {
        prefix: state.prefix,
        sn: state.sn,
        digest: state.d,
        keys: state.k,
        kt: state.kt,
        next: state.n,
        nt: state.nt,
        witnesses: state.b,
        toad: state.bt,
        delegated: state.delegated,
        delegator: state.delegator || null,
        delegatorSealVerified: state.delegated ? false : null,
        lastEstablishment: state.lastEst,
        receipts: receipts,
        receiptsMet: receipts.every(function (r) { return r.met; })
    };
}

// Verifies indexed signatures (qb64 strings) over bytes against a verified key state.
function verifySignatures(m, keyState, sigs, bytes)
{
    var sigers = [];
    (sigs || []).forEach(function (qb64)
    {
        try
        {
            var siger = new m.Siger({ qb64: String(qb64) });
            if (siger.qb64 === String(qb64)) { sigers.push(siger); }
        }
        catch (e) { /* malformed signature, ignored */ }
    });

    var verified = verifyIndexedSigs(m, sigers, keyState.keys, bytes);
    var indices = verified.map(function (sg) { return sg.index; });

    return { valid: tholder(m, keyState.kt).satisfy(indices), verified: indices.length };
}

module.exports =
{
    load: load,
    parseStream: parseStream,
    verifyKel: verifyKel,
    verifySignatures: verifySignatures
};
