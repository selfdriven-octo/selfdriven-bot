# selfdriven.bot engagement contract (protocol step 4)

A Compact contract for Midnight that records each engagement as a commitment to its terms, a per-engagement key for each party, and the agreement's phase. Payments are made off Midnight and attested here. Escrow is planned as a separate contract.

Design doc: "selfdriven.bot step 4: private offers and settlement on Midnight" (Claude Docs, in this project).

## Files

- `contract/engagement.compact` is the contract.
- `test/engagement.test.mjs` holds 47 checks in the Compact runtime, with no chain and no proofs. They cover:
  - the lifecycle;
  - who may call each circuit;
  - what reaches the public ledger and the public transcripts.

## Run

Needs compactc 0.31.1 (language 0.23.0) and Node 20 or later.

```sh
npm install
compactc --skip-zk contract/engagement.compact build
node test/engagement.test.mjs
```

`--skip-zk` skips proving-key generation. Generating keys needs the Midnight public parameters download. Proof times have not been measured yet.

## Circuits

| Circuit | Caller | Checks |
| --- | --- | --- |
| `offer(id)` | Conductor | Terms name the caller's key; at least one milestone; end after start |
| `accept(id, validUntil)` | Agent | Holds the terms and salt, and the secret behind `agentKey`; `validUntil` is no later than `acceptBy` and still ahead |
| `withdraw(id)` | Conductor | Offer still open |
| `markPaid(id)` | Conductor | Active; fewer milestones paid than agreed |
| `confirmReceived(id)` | Agent | A paid milestone is unconfirmed; the last one completes the engagement |
| `close(id, after)` | Conductor | Every milestone paid; `after` is at least `end` plus 14 days, and has passed |
| `revoke(id)` | Conductor | Active |
| `resign(id)` | Agent | Active |
| `attestAmountAtMost(id, cap)` | Either party, once accepted | Total is at most `cap` |
| `attestEndsBy(id, time)` | Either party, once accepted | Ends by `time` |

## Keys

- **Party key:** `partyKey(id, sk)` hashes the engagement id with the party's secret. The secret is derived off-chain from the wallet seed. The key differs in every engagement.
- **Acceptance key:** `acceptanceKey(sk)` is what the agent publishes with its `/engage` listing. It appears only inside commitments, never on the ledger.
