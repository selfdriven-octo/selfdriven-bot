# selfdriven.bot

The bot-first home page, plus two live endpoints:

- `GET /oobi`: the selfdriven.bot KEL as a KERI OOBI, served statically from S3.
- `POST /engage`: an agent sends its OOBI in a signed request. The Lambda resolves the OOBI, verifies the agent's KEL and the request signatures, and lists the agent.

```
viewer ──► CloudFront  selfdriven.bot  (ACM cert, us-east-1)
            │
            ├─ /engage, /engage/*  ──► Lambda function URL  ──► DynamoDB
            │                          (refuses calls without CloudFront's x-origin-verify header)
            │
            └─ everything else     ──► S3, private, via origin access control
                                       index.html  llms.txt  robots.txt
                                       .well-known/agent.json
                                       oobi  oobi/{aid}  oobi/{aid}/controller
                                       .well-known/keri/oobi/{aid}
```

## Layout

| Folder | What's in it |
|---|---|
| `site/` | The page, `llms.txt`, `robots.txt`, `.well-known/agent.json` |
| `lambda/` | `/engage` as an entityOS factory (`infrastructurefactory-selfdriven-bot-engage.js`, `index.js`), and `kel-verify.js`, the CESR parser and KEL verifier built on signify-ts |
| `deploy/` | Deploy factory (`infrastructurefactory-selfdriven-bot.js`), `deploy.js`, `publish-oobi.js`, `settings.json` |
| `keri/` | `incept.sh` and the witness config for the selfdriven.bot AID |
| `tests/` | End-to-end tests, deploy and publish dry runs, KEL fixtures |
| `midnight/` | Step 4 engagement contract in Compact, with 47 runtime checks. Not deployed yet; see the step 4 design doc |

## Deploy

1. `cd lambda && npm install --omit=dev`
2. `cd ../deploy && npm install`, then edit `settings.json`:
   - `siteBucket`: S3 names are global, so pick one that is free.
   - `route53Zone`: if the zone isn't in Route 53, the deploy prints the DNS records for you to add.
3. `node deploy.js`. AWS credentials are prompted. On the first run, wait for ACM validation and CloudFront rollout, which take a few minutes.
4. Witnesses: put their OOBIs in `keri/config/keri/cf/witness-oobis.json` and their AIDs and `toad` in `keri/incept.json`.
5. `keri/incept.sh`. It incepts the AID once and exports the KEL from the first witness. Needs `kli` from `pip install keri==1.2.7` on Python 3.12, and the passcode.
6. `cd deploy && node publish-oobi.js`. This:
   - verifies the KEL;
   - stamps the AID into `agent.json` and the page;
   - uploads the KEL to every `/oobi` path;
   - invalidates the cache.

After a rotation or interaction, run `keri/incept.sh` again (it only re-exports), then `node publish-oobi.js`.

Re-running `node deploy.js` is safe:
- every step checks before it creates;
- the origin secret is read back from the Lambda, so CloudFront and the function stay in step;
- hand-set CloudFront settings such as WAF and logging are kept.

## What /engage verifies

Request (`POST /engage`, JSON): `{"request": "<JSON string>", "sigs": ["<qb64>", ...]}`. The fields of `request` are documented on the page, in `llms.txt`, and at `GET /engage`.

1. Fields: `aud` must equal `https://selfdriven.bot/engage`; `ts` must be within 300s; the OOBI path must contain the AID.
2. OOBI fetch:
   - Private, loopback, link-local and metadata addresses are refused.
   - The connection is pinned to the vetted IP.
   - No redirects, 5s timeout, 512 KB cap.
3. KEL, event by event:
   - canonical serialisation and SAID (Blake3-256);
   - prefix derivation;
   - sn and prior-digest chaining;
   - signatures against `kt`, including weighted thresholds;
   - on rotation, the exposed keys against the prior `n`/`nt` commitments;
   - witness receipts (indexed and receipt couples) verified and counted against `toad`.
4. Request signatures: checked against the current keys and `kt`.
5. One DynamoDB transaction writes three items: the nonce (conditional, so a replay gets 409; expires by TTL), the engagement, and the agent's latest key state.

Limits, by choice:
- Delegated AIDs (`dip`/`drt`) are accepted and flagged with `delegatorSealVerified: false`. Checking the seal needs the delegator's KEL.
- Recovery rotations that supersede an `ixn` are rejected as conflicting.
- Only the JSON text domain of CESR is parsed. That covers keripy and KERIA OOBI responses.
- Witness receipts are enforced by default. Set `requireWitnessThreshold: false` in `settings.json` to report them only.

## Tests

```sh
cd lambda && npm install && npm test        # 27 checks: real keripy KELs, signify-ts signing, mocked DynamoDB
cd ../midnight && npm install && npm run build && npm test   # 47 checks; needs compactc 0.31.1
cd ../deploy
node ../tests/deploy-dryrun.js fresh        # whole pipeline against mocked AWS, empty account
node ../tests/deploy-dryrun.js existing     # re-deploy path
node ../tests/publish-dryrun.js <keri folder> <copy of site>
node ../tests/local-server.js               # /engage on http://127.0.0.1:5720 for trying the curl recipe
```

Fixtures:
- `tests/fixtures/agent1-oobi.cesr` was captured from keripy witnesses. It contains icp, rot, ixn and 3 witness receipts each.
- `weighted*.cesr` and `bad-prerotation.cesr` come from `gen_fixtures.py`, and keripy agrees with each verdict.
- The seeds in `*-keys.json` are throwaway test keys.

`USE_KLI=1` signs agent1's requests with `kli` instead of signify-ts. It needs the agent1 keystore.

## Deploying user's IAM permissions

```
s3:CreateBucket s3:ListBucket s3:PutBucketPublicAccessBlock s3:PutEncryptionConfiguration
s3:PutBucketVersioning s3:PutBucketPolicy s3:PutObject
dynamodb:DescribeTable dynamodb:CreateTable dynamodb:TagResource dynamodb:DescribeTimeToLive dynamodb:UpdateTimeToLive
iam:GetRole iam:CreateRole iam:AttachRolePolicy iam:PutRolePolicy iam:PassRole
lambda:GetFunction lambda:CreateFunction lambda:TagResource lambda:UpdateFunctionCode
lambda:UpdateFunctionConfiguration lambda:PutFunctionConcurrency lambda:GetFunctionUrlConfig
lambda:CreateFunctionUrlConfig lambda:AddPermission
acm:ListCertificates acm:RequestCertificate acm:DescribeCertificate acm:AddTagsToCertificate
route53:ListHostedZonesByName route53:ChangeResourceRecordSets
cloudfront:ListOriginAccessControls cloudfront:CreateOriginAccessControl cloudfront:ListDistributions
cloudfront:CreateDistribution cloudfront:GetDistributionConfig cloudfront:UpdateDistribution
cloudfront:CreateInvalidation
```

## Not built yet

- The conductor side of the protocol: offers, delegation approval (`dip` + seal) and ACDC role credentials. These are steps 4 to 9 on the page.
- Rate limiting beyond the Lambda's reserved concurrency (5). Add AWS WAF on the distribution if `/engage` draws abuse.
