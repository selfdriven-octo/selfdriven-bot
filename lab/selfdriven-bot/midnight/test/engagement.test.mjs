// Runs the compiled engagement contract in the Compact runtime (no chain, no proofs)
// and walks the lifecycle, the authorisation checks, and what reaches the public
// ledger and the public transcripts.
//
//   compactc --skip-zk contract/engagement.compact build && node test/engagement.test.mjs

import * as rt from '@midnight-ntwrk/compact-runtime';
import { randomBytes } from 'node:crypto';
import { Contract, ledger, pureCircuits, Phase, ClaimKind } from '../build/contract/index.js';

const witnesses = {
    secretKey: ({ privateState }) => [privateState, privateState.sk],
    offerTerms: ({ privateState }) => [privateState, privateState.terms],
    offerSalt: ({ privateState }) => [privateState, privateState.salt]
};

const contract = new Contract(witnesses);
const coinPk = '0'.repeat(64);
const address = rt.sampleContractAddress();
let state = contract.initialState(rt.createConstructorContext({}, coinPk)).currentContractState;

const NOW = 1_791_500_000;            // unix seconds, early October 2026
const DAY = 86_400;
const GRACE = 14 * DAY;
const transcripts = [];               // every public transcript, for the privacy checks

function call(name, party, time, ...args)
{
    const ctx = rt.createCircuitContext(address, coinPk, state, party, undefined, undefined, time);
    const res = contract.impureCircuits[name](ctx, ...args);
    state = res.context.currentQueryContext.state;
    transcripts.push({ name, transcript: res.proofData.publicTranscript });
    return res;
}

function attempt(name, party, time, ...args)
{
    try { call(name, party, time, ...args); return 'ok'; }
    catch (e) { return String(e.message || e).replace(/^.*failed assert: /, ''); }
}

const view = () => ledger(state);
const bytes = (n) => new Uint8Array(randomBytes(n));
const pad8 = (s) => { const b = new Uint8Array(8); b.set(new TextEncoder().encode(s)); return b; };

// The agent's secret is stable (derived from its wallet seed); its acceptance key
// is published with its listing. The conductor uses a secret per engagement.
const agentSecret = bytes(32);

function engagement(milestones = 2)
{
    const id = bytes(32);
    const conductor = { sk: bytes(32) };
    const agent = { sk: agentSecret };
    const terms = {
        offerSaid: bytes(32),
        conductorPk: pureCircuits.partyKey(id, conductor.sk),
        agentKey: pureCircuits.acceptanceKey(agentSecret),
        amount: 1_250_000n,                    // 12,500.00 AUD in cents
        currency: pad8('AUD'),
        milestones: BigInt(milestones),
        start: BigInt(NOW + DAY),
        end: BigInt(NOW + 31 * DAY),
        acceptBy: BigInt(NOW + 3 * DAY)
    };
    const salt = bytes(32);
    for (const p of [conductor, agent]) { p.terms = terms; p.salt = salt; }
    const insider = { sk: bytes(32), terms, salt };            // has terms and salt, not the agent's secret
    const outsider = { sk: bytes(32), terms, salt: bytes(32) }; // has the terms, not the salt
    return { id, conductor, agent, insider, outsider, terms, salt };
}

const results = [];
function check(name, ok, detail)
{
    results.push(ok);
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '  → ' + detail));
}

const soon = (t) => BigInt(t + 600);    // validUntil an agent would pick: ten minutes ahead

// ── Offer and accept ────────────────────────────────────────────────────────
const a = engagement(2);

call('offer', a.conductor, NOW, a.id);
let e = view().engagements.lookup(a.id);
check('offer opens the engagement', e.phase === Phase.offered);
check('commitment equals commitTerms(terms, salt)', rt.toHex(e.termsCommit) === rt.toHex(pureCircuits.commitTerms(a.terms, a.salt)));

let r = attempt('offer', a.conductor, NOW, a.id);
check('an engagement id cannot be reused', r.includes('engagement id already used'), r);

r = attempt('offer', { ...a.conductor, terms: { ...a.terms, conductorPk: pureCircuits.partyKey(a.id, bytes(32)) } }, NOW, bytes(32));
check('an offer must name the caller as conductor', r.includes('terms must name the caller'), r);

r = attempt('accept', a.conductor, NOW, a.id, soon(NOW));
check('the conductor cannot accept its own offer', r.includes('not the agent named in the offer'), r);

r = attempt('accept', a.insider, NOW, a.id, soon(NOW));
check('someone with the terms and salt, but not the agent secret, cannot accept', r.includes('not the agent named in the offer'), r);

r = attempt('accept', { ...a.agent, terms: { ...a.terms, amount: 1n } }, NOW, a.id, soon(NOW));
check('accept with altered terms fails', r.includes('terms do not match'), r);

r = attempt('accept', { ...a.agent, salt: bytes(32) }, NOW, a.id, soon(NOW));
check('accept without the right salt fails', r.includes('terms do not match'), r);

r = attempt('accept', a.agent, NOW, a.id, a.terms.acceptBy + 1n);
check('validUntil past acceptBy fails', r.includes('offer has lapsed'), r);

r = attempt('accept', a.agent, NOW + 4 * DAY, a.id, soon(NOW + 4 * DAY));
check('accept after acceptBy fails', r.includes('offer has lapsed'), r);

r = attempt('accept', a.agent, NOW + DAY, a.id, BigInt(NOW + DAY - 60));
check('a validUntil already past fails', r.includes('offer has lapsed'), r);

const acceptRes = call('accept', a.agent, NOW + DAY, a.id, soon(NOW + DAY));
e = view().engagements.lookup(a.id);
check('the named agent accepts', e.phase === Phase.accepted);
check('agent key recorded', rt.toHex(e.agentPk) === rt.toHex(pureCircuits.partyKey(a.id, agentSecret)));

r = attempt('accept', a.agent, NOW + DAY, a.id, soon(NOW + DAY));
check('a second accept fails', r.includes('offer is not open'), r);

r = attempt('withdraw', a.conductor, NOW + DAY, a.id);
check('an accepted offer cannot be withdrawn', r.includes('only an open offer'), r);

// ── Attested payments ───────────────────────────────────────────────────────
r = attempt('markPaid', a.agent, NOW + 2 * DAY, a.id);
check('the agent cannot mark a payment', r.includes('only the conductor'), r);

r = attempt('confirmReceived', a.agent, NOW + 2 * DAY, a.id);
check('nothing to confirm before a payment', r.includes('no unconfirmed payment'), r);

call('markPaid', a.conductor, NOW + 10 * DAY, a.id);
r = attempt('confirmReceived', a.conductor, NOW + 10 * DAY, a.id);
check('the conductor cannot confirm receipt', r.includes('only the agent'), r);

call('confirmReceived', a.agent, NOW + 11 * DAY, a.id);
e = view().engagements.lookup(a.id);
check('first milestone: paid 1, received 1, still active', e.paid === 1n && e.received === 1n && e.phase === Phase.accepted);

call('markPaid', a.conductor, NOW + 30 * DAY, a.id);
r = attempt('markPaid', a.conductor, NOW + 30 * DAY, a.id);
check('no more payments than milestones', r.includes('every milestone is already paid'), r);

call('confirmReceived', a.agent, NOW + 31 * DAY, a.id);
check('the last confirmation completes the engagement', view().engagements.lookup(a.id).phase === Phase.completed);

// ── Closing when the agent goes silent ──────────────────────────────────────
const s = engagement(1);
call('offer', s.conductor, NOW, s.id);
call('accept', s.agent, NOW, s.id, soon(NOW));
const closeAt = s.terms.end + BigInt(GRACE);

r = attempt('close', s.conductor, Number(closeAt) + 60, s.id, closeAt);
check('close needs every milestone paid', r.includes('not every milestone is paid'), r);

call('markPaid', s.conductor, NOW + 30 * DAY, s.id);
r = attempt('close', s.conductor, Number(closeAt) + 60, s.id, closeAt - 1n);
check('close before end plus 14 days fails', r.includes('grace period has not ended'), r);

r = attempt('close', s.conductor, Number(closeAt) - 60, s.id, closeAt);
check('close with a time not yet reached fails', r.includes('grace period has not ended'), r);

r = attempt('close', s.agent, Number(closeAt) + 60, s.id, closeAt);
check('only the conductor can close', r.includes('only the conductor'), r);

call('close', s.conductor, Number(closeAt) + 60, s.id, closeAt);
e = view().engagements.lookup(s.id);
check('a paid, unconfirmed engagement closes after the grace period', e.phase === Phase.closed && e.paid === 1n && e.received === 0n);

// ── Claims ──────────────────────────────────────────────────────────────────
const conductorKey = pureCircuits.partyKey(a.id, a.conductor.sk);
call('attestAmountAtMost', a.conductor, NOW + 31 * DAY, a.id, 1_500_000n);
check('claim "total ≤ 15,000.00" recorded with the conductor as attester',
    view().claims.member({ engagement: a.id, attester: conductorKey, kind: ClaimKind.amountAtMost, bound: 1_500_000n }));

r = attempt('attestAmountAtMost', a.agent, NOW + 31 * DAY, a.id, 1_000_000n);
check('a false claim "total ≤ 10,000.00" cannot be proven', r.includes('amount exceeds the bound'), r);

call('attestEndsBy', a.agent, NOW + 31 * DAY, a.id, BigInt(NOW + 60 * DAY));
check('the agent can attest an end-date bound',
    view().claims.member({ engagement: a.id, attester: pureCircuits.partyKey(a.id, agentSecret), kind: ClaimKind.endsBy, bound: BigInt(NOW + 60 * DAY) }));

r = attempt('attestEndsBy', a.outsider, NOW + 31 * DAY, a.id, BigInt(NOW + 60 * DAY));
check('an outsider cannot attest', r.includes('not a party'), r);

const o = engagement();
call('offer', o.conductor, NOW, o.id);
r = attempt('attestAmountAtMost', o.conductor, NOW, o.id, 2_000_000n);
check('no claims on an offer not yet accepted', r.includes('claims need an accepted engagement'), r);

// ── Other endings ───────────────────────────────────────────────────────────
r = attempt('withdraw', o.agent, NOW, o.id);
check('only the conductor can withdraw', r.includes('only the conductor'), r);
call('withdraw', o.conductor, NOW, o.id);
check('a withdrawn offer', view().engagements.lookup(o.id).phase === Phase.withdrawn);
r = attempt('accept', o.agent, NOW, o.id, soon(NOW));
check('a withdrawn offer cannot be accepted', r.includes('offer is not open'), r);

const c = engagement();
call('offer', c.conductor, NOW, c.id);
call('accept', c.agent, NOW, c.id, soon(NOW));
r = attempt('revoke', c.agent, NOW, c.id);
check('only the conductor can revoke', r.includes('only the conductor'), r);
call('revoke', c.conductor, NOW, c.id);
check('a revoked engagement', view().engagements.lookup(c.id).phase === Phase.revoked);
r = attempt('markPaid', c.conductor, NOW, c.id);
check('no payments after revocation', r.includes('engagement is not active'), r);

const d = engagement();
call('offer', d.conductor, NOW, d.id);
call('accept', d.agent, NOW, d.id, soon(NOW));
call('resign', d.agent, NOW, d.id);
check('the agent can resign', view().engagements.lookup(d.id).phase === Phase.resigned);

// ── What is public ──────────────────────────────────────────────────────────
// Ledger: every entry and claim the ledger exposes.
const enc = (v) => JSON.stringify(v, (k, x) => (x instanceof Uint8Array ? rt.toHex(x) : typeof x === 'bigint' ? x.toString(16) : x));
const ledgerDump = enc([...view().engagements]) + enc([...view().claims]);
check('ledger dump is real: it shows the commitment', ledgerDump.includes(rt.toHex(pureCircuits.commitTerms(a.terms, a.salt))));
const secrets = [a.terms.offerSaid, a.salt, a.conductor.sk, agentSecret, a.terms.agentKey].map(rt.toHex);
check('ledger has no offer SAID, salt, secrets or acceptance key', secrets.every((x) => !ledgerDump.includes(x)));
check('ledger has no amount or dates', ![a.terms.amount, a.terms.start, a.terms.end, a.terms.acceptBy].some((n) => ledgerDump.includes('"' + n.toString(16) + '"')));

// Transcripts: the public part of every call. Values appear as little-endian bytes.
const le = (n) => { const h = []; let v = BigInt(n); while (v > 0n) { h.push(Number(v & 0xffn).toString(16).padStart(2, '0')); v >>= 8n; } return h.join(''); };
const transcriptDump = enc(transcripts.map((x) => x.transcript));
const acceptDump = enc(transcripts.find((x) => x.name === 'accept' && x.transcript && enc(x.transcript).includes(rt.toHex(a.id)))?.transcript || []);
check('accept transcript is real: it shows the engagement id', acceptDump.includes(rt.toHex(a.id)));
check('accept transcript shows validUntil, not acceptBy', acceptDump.includes(le(soon(NOW + DAY))) && !acceptDump.includes(le(a.terms.acceptBy)));
check('no transcript holds the offer SAID, salt, secrets or acceptance key', secrets.every((x) => !transcriptDump.includes(x)));
check('no transcript holds the amount or start date', ![a.terms.amount, a.terms.start].some((n) => transcriptDump.includes(le(n))));

const entry = view().engagements.lookup(a.id);
check('an entry holds only the commitment, two keys, phase and counters',
    JSON.stringify(Object.keys(entry).sort()) === JSON.stringify(['agentPk', 'conductorPk', 'paid', 'phase', 'received', 'termsCommit']));
check("the same agent's keys differ across engagements",
    rt.toHex(pureCircuits.partyKey(a.id, agentSecret)) !== rt.toHex(pureCircuits.partyKey(c.id, agentSecret)));

const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exit(passed === results.length ? 0 : 1);
