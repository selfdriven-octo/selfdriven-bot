'use strict';

// Dry run of the deploy factory against mocked AWS clients: once for a fresh account
// (everything missing), once for a re-deploy (everything present). Checks the step chain
// reaches "done" and that the CloudFront config routes /engage to the function URL.

const path = require('path');
const DEPLOY = path.join(__dirname, '..', 'deploy');
const req = function (m) { return require(require.resolve(m, { paths: [DEPLOY] })); };

const scenario = process.argv[2] || 'fresh';
const fresh = scenario === 'fresh';
const calls = [];
let captured = {};

function notFound(name) { const e = new Error(name); e.name = name; e.$metadata = { httpStatusCode: 404 }; return e; }

const state = { functionCreated: !fresh, tableCreated: !fresh, certIssued: !fresh, describeCount: 0 };

const handlers =
{
    // S3
    HeadBucketCommand: () => fresh ? Promise.reject(notFound('NotFound')) : Promise.resolve({}),
    CreateBucketCommand: () => Promise.resolve({ Location: 'http://selfdriven-bot-site.s3.amazonaws.com/' }),
    PutPublicAccessBlockCommand: () => Promise.resolve({}),
    PutBucketEncryptionCommand: () => Promise.resolve({}),
    PutBucketVersioningCommand: () => Promise.resolve({}),
    PutObjectCommand: (i) => { (captured.puts = captured.puts || []).push(i.Key + ' ' + i.ContentType); return Promise.resolve({}); },
    PutBucketPolicyCommand: (i) => { captured.bucketPolicy = JSON.parse(i.Policy); return Promise.resolve({}); },
    // DynamoDB
    DescribeTableCommand: () => state.tableCreated
        ? Promise.resolve({ Table: { TableStatus: 'ACTIVE', TableArn: 'arn:aws:dynamodb:ap-southeast-2:111122223333:table/selfdriven-bot' } })
        : Promise.reject(notFound('ResourceNotFoundException')),
    CreateTableCommand: () => { state.tableCreated = true; return Promise.resolve({ TableDescription: { TableArn: 'arn:aws:dynamodb:ap-southeast-2:111122223333:table/selfdriven-bot' } }); },
    DescribeTimeToLiveCommand: () => Promise.resolve({ TimeToLiveDescription: { TimeToLiveStatus: fresh ? 'DISABLED' : 'ENABLED' } }),
    UpdateTimeToLiveCommand: () => Promise.resolve({}),
    // IAM
    GetRoleCommand: () => fresh ? Promise.reject(notFound('NoSuchEntityException')) : Promise.resolve({ Role: { Arn: 'arn:aws:iam::111122223333:role/selfdriven-bot-engage-role' } }),
    CreateRoleCommand: () => Promise.resolve({ Role: { Arn: 'arn:aws:iam::111122223333:role/selfdriven-bot-engage-role' } }),
    AttachRolePolicyCommand: () => Promise.resolve({}),
    PutRolePolicyCommand: (i) => { captured.rolePolicy = JSON.parse(i.PolicyDocument); return Promise.resolve({}); },
    // Lambda
    GetFunctionCommand: () => state.functionCreated
        ? Promise.resolve({ Configuration: { FunctionArn: 'arn:aws:lambda:ap-southeast-2:111122223333:function:selfdriven-bot-engage', State: 'Active', LastUpdateStatus: 'Successful', Environment: { Variables: { ORIGIN_SECRET: 'existing-secret' } } } })
        : Promise.reject(notFound('ResourceNotFoundException')),
    CreateFunctionCommand: (i) => { state.functionCreated = true; captured.lambdaEnv = i.Environment.Variables; captured.zipBytes = i.Code.ZipFile.length; return Promise.resolve({ FunctionArn: 'arn:aws:lambda:ap-southeast-2:111122223333:function:selfdriven-bot-engage' }); },
    UpdateFunctionCodeCommand: (i) => { captured.zipBytes = i.ZipFile.length; return Promise.resolve({}); },
    UpdateFunctionConfigurationCommand: (i) => { captured.lambdaEnv = i.Environment.Variables; return Promise.resolve({}); },
    PutFunctionConcurrencyCommand: () => Promise.resolve({}),
    GetFunctionUrlConfigCommand: () => fresh ? Promise.reject(notFound('ResourceNotFoundException')) : Promise.resolve({ FunctionUrl: 'https://abc123.lambda-url.ap-southeast-2.on.aws.invalid/' }),
    CreateFunctionUrlConfigCommand: () => Promise.resolve({ FunctionUrl: 'https://abc123.lambda-url.ap-southeast-2.on.aws.invalid/' }),
    AddPermissionCommand: (i) => { (captured.permissions = captured.permissions || []).push(i.Action); if (!fresh) { const e = new Error('exists'); e.name = 'ResourceConflictException'; return Promise.reject(e); } return Promise.resolve({}); },
    // ACM
    ListCertificatesCommand: () => Promise.resolve({ CertificateSummaryList: fresh ? [] : [{ DomainName: 'selfdriven.bot', Status: 'ISSUED', CertificateArn: 'arn:aws:acm:us-east-1:111122223333:certificate/x' }] }),
    RequestCertificateCommand: () => Promise.resolve({ CertificateArn: 'arn:aws:acm:us-east-1:111122223333:certificate/x' }),
    DescribeCertificateCommand: () => { state.describeCount++; return Promise.resolve({ Certificate: { Status: state.describeCount > 2 ? 'ISSUED' : 'PENDING_VALIDATION', DomainValidationOptions: [{ ResourceRecord: { Name: '_x.selfdriven.bot.', Type: 'CNAME', Value: '_y.acm-validations.aws.' } }] } }); },
    // Route 53
    ListHostedZonesByNameCommand: () => Promise.resolve({ HostedZones: [{ Id: '/hostedzone/Z0123', Name: 'selfdriven.bot.', Config: { PrivateZone: false } }] }),
    ChangeResourceRecordSetsCommand: (i) => { (captured.dns = captured.dns || []).push(i.ChangeBatch.Changes.map(c => c.ResourceRecordSet.Type + ' ' + c.ResourceRecordSet.Name).join(', ')); return Promise.resolve({ ChangeInfo: { Id: 'c1' } }); },
    // CloudFront
    ListOriginAccessControlsCommand: () => Promise.resolve({ OriginAccessControlList: { Items: fresh ? [] : [{ Name: 'selfdriven-bot-site-oac', Id: 'OAC1' }] } }),
    CreateOriginAccessControlCommand: () => Promise.resolve({ OriginAccessControl: { Id: 'OAC1' } }),
    ListDistributionsCommand: () => Promise.resolve({ DistributionList: { IsTruncated: false, Items: fresh ? [] : [{ Id: 'E1', ARN: 'arn:aws:cloudfront::111122223333:distribution/E1', DomainName: 'd1.cloudfront.net', Aliases: { Items: ['selfdriven.bot'] } }] } }),
    CreateDistributionCommand: (i) => { captured.distribution = i.DistributionConfig; return Promise.resolve({ Distribution: { Id: 'E1', ARN: 'arn:aws:cloudfront::111122223333:distribution/E1', DomainName: 'd1.cloudfront.net' } }); },
    GetDistributionConfigCommand: () => Promise.resolve({ ETag: 'ETAG1', DistributionConfig: { CallerReference: 'original-ref', Logging: { Enabled: false, IncludeCookies: false, Bucket: '', Prefix: '' }, WebACLId: 'waf-kept' } }),
    UpdateDistributionCommand: (i) => { captured.distribution = i.DistributionConfig; captured.ifMatch = i.IfMatch; return Promise.resolve({ Distribution: { Id: 'E1', ARN: 'arn:aws:cloudfront::111122223333:distribution/E1', DomainName: 'd1.cloudfront.net' } }); }
};

['client-s3', 'client-dynamodb', 'client-iam', 'client-lambda', 'client-acm', 'client-route-53', 'client-cloudfront'].forEach(function (pkg)
{
    const mod = req('@aws-sdk/' + pkg);
    const Client = Object.values(mod).find(function (v) { return typeof v === 'function' && /Client$/.test(v.name) && v.prototype && v.prototype.send; });
    Client.prototype.send = function (command)
    {
        const name = command.constructor.name;
        calls.push(name);
        if (!handlers[name]) { return Promise.reject(new Error('unmocked ' + name)); }
        return handlers[name](command.input);
    };
});

const entityos = req('entityos');
const factory = require(path.join(DEPLOY, 'infrastructurefactory-selfdriven-bot.js'));
const settings = JSON.parse(JSON.stringify(require(path.join(DEPLOY, 'settings.json'))));
settings.infrastructure.aws.access = { id: 'AKIAEXAMPLE', secret: 'example' };
settings.deploy.acmPollIntervalMs = 10;

entityos.set({ scope: '_settings', value: settings });
factory.init({});

const started = Date.now();

entityos.add(
{
    name: 'util-end',
    code: function (param, status)
    {
        const d = captured.distribution || {};
        const engage = (d.Origins && d.Origins.Items.find(o => o.Id === 'engage')) || {};
        const secretHeader = engage.CustomHeaders && engage.CustomHeaders.Items[0].HeaderValue;

        const checks =
        [
            ['pipeline reached done', status === '200' && param.status === 'deployed'],
            ['site uploaded incl. .well-known/agent.json as JSON', (captured.puts || []).some(p => p === '.well-known/agent.json application/json')],
            ['llms.txt served as text/plain', (captured.puts || []).some(p => p.startsWith('llms.txt text/plain'))],
            ['dotfiles like .nojekyll skipped', !(captured.puts || []).some(p => p.startsWith('.nojekyll'))],
            ['/engage and /engage/* go to the function URL', d.CacheBehaviors && d.CacheBehaviors.Items.map(b => b.PathPattern + '>' + b.TargetOriginId).join(',') === '/engage>engage,/engage/*>engage'],
            ['function URL host as custom origin', engage.DomainName === 'abc123.lambda-url.ap-southeast-2.on.aws.invalid'],
            ['origin secret matches Lambda env', !!secretHeader && secretHeader === (captured.lambdaEnv || {}).ORIGIN_SECRET],
            ['re-deploy keeps the existing secret', fresh || secretHeader === 'existing-secret'],
            ['audience env is the public URL', (captured.lambdaEnv || {}).ENGAGE_AUDIENCE === 'https://selfdriven.bot/engage'],
            ['both function URL permissions', fresh ? (captured.permissions || []).sort().join() === 'lambda:InvokeFunction,lambda:InvokeFunctionUrl' : true],
            ['bucket policy scoped to distribution', captured.bucketPolicy && captured.bucketPolicy.Statement[0].Condition.StringEquals['AWS:SourceArn'] === 'arn:aws:cloudfront::111122223333:distribution/E1'],
            ['role policy scoped to table', captured.rolePolicy && captured.rolePolicy.Statement[0].Resource.endsWith(':table/selfdriven-bot')],
            ['A + AAAA alias written', (captured.dns || []).some(c => c === 'A selfdriven.bot, AAAA selfdriven.bot')],
            ['update keeps hand-set WAF and CallerReference', fresh || (d.WebACLId === 'waf-kept' && d.CallerReference === 'original-ref' && captured.ifMatch === 'ETAG1')],
            ['zip excludes the AWS SDK and stays small', captured.zipBytes > 0 && captured.zipBytes < 20 * 1024 * 1024]
        ];

        console.log('\n── ' + scenario + ' deploy (' + Math.round((Date.now() - started) / 1000) + 's, ' + calls.length + ' AWS calls, zip ' + Math.round(captured.zipBytes / 1024) + ' KB) ──');
        let failed = 0;
        checks.forEach(function (c) { if (!c[1]) { failed++; } console.log((c[1] ? 'PASS  ' : 'FAIL  ') + c[0]); });
        if (status !== '200') { console.log('util-end:', status, param); }
        process.exit(failed ? 1 : 0);
    }
});

entityos.invoke('app-process-aws-selfdriven-bot-deploy');
