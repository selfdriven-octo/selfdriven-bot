'use strict';

// Dry run of publish-oobi against mocked S3/CloudFront: verifies the KEL, stamps the AID into a
// copy of the site, uploads the KEL under every OOBI path, and invalidates the cache.
//   node tests/publish-dryrun.js <keriFolder> <siteFolderCopy>

const path = require('path');
const fs = require('fs');
const DEPLOY = path.join(__dirname, '..', 'deploy');
const req = function (m) { return require(require.resolve(m, { paths: [DEPLOY] })); };

const keriFolder = path.resolve(process.argv[2]);
const siteFolder = path.resolve(process.argv[3]);
const puts = [];
let invalidation = null;

const handlers =
{
    PutObjectCommand: (i) => { puts.push({ key: i.Key, type: i.ContentType, size: i.Body.length }); return Promise.resolve({}); },
    ListDistributionsCommand: () => Promise.resolve({ DistributionList: { IsTruncated: false, Items: [{ Id: 'E1', ARN: 'arn:aws:cloudfront::1:distribution/E1', DomainName: 'd1.cloudfront.net', Aliases: { Items: ['selfdriven.bot'] } }] } }),
    CreateInvalidationCommand: (i) => { invalidation = i.InvalidationBatch.Paths.Items; return Promise.resolve({ Invalidation: { Id: 'I1' } }); }
};

['client-s3', 'client-cloudfront'].forEach(function (pkg)
{
    const mod = req('@aws-sdk/' + pkg);
    const Client = Object.values(mod).find(function (v) { return typeof v === 'function' && /Client$/.test(v.name) && v.prototype && v.prototype.send; });
    Client.prototype.send = function (command)
    {
        const h = handlers[command.constructor.name];
        return h ? h(command.input) : Promise.reject(new Error('unmocked ' + command.constructor.name));
    };
});

const entityos = req('entityos');
const factory = require(path.join(DEPLOY, 'infrastructurefactory-selfdriven-bot.js'));
const settings = JSON.parse(JSON.stringify(require(path.join(DEPLOY, 'settings.json'))));
settings.infrastructure.aws.access = { id: 'AKIAEXAMPLE', secret: 'example' };
settings.deploy.keriFolder = keriFolder;
settings.deploy.siteFolder = siteFolder;

entityos.set({ scope: '_settings', value: settings });
factory.init({});

entityos.add(
{
    name: 'util-end',
    code: function (param, status)
    {
        const aid = fs.readFileSync(path.join(keriFolder, 'selfdriven-bot.aid'), 'utf8').trim();
        const agentJson = JSON.parse(fs.readFileSync(path.join(siteFolder, '.well-known', 'agent.json'), 'utf8'));
        const html = fs.readFileSync(path.join(siteFolder, 'index.html'), 'utf8');
        const keys = puts.map(p => p.key);

        const checks =
        [
            ['published', status === '200' && param.aid === aid],
            ['agent.json identity.aid stamped', agentJson.identity.aid === aid],
            ['page manifest stamped, placeholder gone', html.indexOf(aid) !== -1 && html.indexOf('autonomic-identifier') === -1],
            ['KEL at /oobi, /oobi/{aid}, /oobi/{aid}/controller, /.well-known/keri/oobi/{aid}',
                ['oobi', 'oobi/' + aid, 'oobi/' + aid + '/controller', '.well-known/keri/oobi/' + aid].every(k => keys.includes(k))],
            ['KEL served as application/json+cesr', puts.filter(p => p.key.indexOf('oobi') !== -1).every(p => p.type === 'application/json+cesr')],
            ['stamped files re-uploaded', keys.includes('index.html') && keys.includes('.well-known/agent.json')],
            ['cache invalidated', Array.isArray(invalidation) && invalidation.includes('/oobi*')]
        ];

        let failed = 0;
        console.log('\n── publish-oobi dry run ──');
        checks.forEach(function (c) { if (!c[1]) { failed++; } console.log((c[1] ? 'PASS  ' : 'FAIL  ') + c[0]); });
        if (status !== '200') { console.log('util-end:', status, param); }
        process.exit(failed ? 1 : 0);
    }
});

entityos.invoke('app-process-aws-selfdriven-bot-oobi-publish');
