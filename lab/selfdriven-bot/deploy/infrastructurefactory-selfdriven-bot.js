var entityos = require('entityos');
var _ = require('lodash');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

// selfdriven.bot deploy factory
//
//   app-process-aws-selfdriven-bot-deploy         site bucket → site upload → DynamoDB → IAM → Lambda + function URL
//                                                  → ACM (us-east-1) → CloudFront (OAC + /engage behaviours) → bucket policy → Route 53
//   app-process-aws-selfdriven-bot-oobi-publish   verify keri/selfdriven-bot.cesr → stamp the AID into the site
//                                                  → publish the KEL at /oobi → invalidate CloudFront
//
// CloudFront routes /engage and /engage/* to the Lambda function URL (with a secret origin header the
// Lambda checks) and everything else, including /oobi and /.well-known/*, to the private S3 bucket.

var TOTAL = 14;
var CLOUDFRONT_ZONE_ID = 'Z2FDTNDATAQYW2';          // fixed hosted zone for CloudFront alias targets
var POLICY_CACHING_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6';
var POLICY_CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
var POLICY_ALL_VIEWER_EXCEPT_HOST = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';
var POLICY_SECURITY_HEADERS = '67f7725c-6f97-4210-82d7-5512b31e9d03';
var AID_PLACEHOLDER = '<selfdriven-bot-autonomic-identifier>';

var CONTENT_TYPES =
{
    '.html': 'text/html; charset=utf-8',
    '.txt':  'text/plain; charset=utf-8',
    '.json': 'application/json',
    '.cesr': 'application/json+cesr',
    '.xml':  'application/xml',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.ico':  'image/x-icon',
    '.css':  'text/css; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8'
};

module.exports =
{
    VERSION: '1.0.0',

    init: function (param)
    {
        // ── Config + settings ───────────────────────────────────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-get-config',
            code: function (param)
            {
                const settings = entityos.get({ scope: '_settings' });

                let accessID = _.get(settings, 'infrastructure.aws.access.id');
                let accessSecretKey = _.get(settings, 'infrastructure.aws.access.secret');

                if (accessID == 'prompt' || accessSecretKey == 'prompt')
                {
                    const prompt = require('prompt-sync')();
                    if (accessID == 'prompt')
                    {
                        const _accessID = prompt('AWS Access ID: ');
                        _.set(settings, 'infrastructure.aws.access.id', _accessID);
                    }
                    if (accessSecretKey == 'prompt')
                    {
                        const _accessSecretKey = prompt('AWS Access Secret Key: ', { echo: '*' });
                        _.set(settings, 'infrastructure.aws.access.secret', _accessSecretKey);
                    }
                }

                process.env.AWS_ACCESS_KEY_ID = _.get(settings, 'infrastructure.aws.access.id');
                process.env.AWS_SECRET_ACCESS_KEY = _.get(settings, 'infrastructure.aws.access.secret');

                return {
                    credentials: {
                        accessKeyId: _.get(settings, 'infrastructure.aws.access.id'),
                        secretAccessKey: _.get(settings, 'infrastructure.aws.access.secret')
                    },
                    // CloudFront, ACM-for-CloudFront and Route 53 are global and live in us-east-1
                    region: _.get(param, 'region', _.get(settings, 'deploy.region', 'ap-southeast-2'))
                };
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-get-deploy-settings',
            code: function ()
            {
                const settings = entityos.get({ scope: '_settings' });
                const domain = _.get(settings, 'deploy.domain', 'selfdriven.bot');

                return {
                    region:                  _.get(settings, 'deploy.region', 'ap-southeast-2'),
                    domain:                  domain,
                    route53Zone:             _.get(settings, 'deploy.route53Zone', domain),
                    siteBucket:              _.get(settings, 'deploy.siteBucket', 'selfdriven-bot-site'),
                    siteFolder:              path.resolve(__dirname, _.get(settings, 'deploy.siteFolder', '../site')),
                    tableName:               _.get(settings, 'deploy.tableName', 'selfdriven-bot'),
                    lambdaFolder:            path.resolve(__dirname, _.get(settings, 'deploy.lambdaFolder', '../lambda')),
                    lambdaZipName:           _.get(settings, 'deploy.lambdaZipName', 'selfdriven-bot-engage.zip'),
                    functionName:            _.get(settings, 'deploy.functionName', 'selfdriven-bot-engage'),
                    roleName:                _.get(settings, 'deploy.roleName', 'selfdriven-bot-engage-role'),
                    memorySize:              _.get(settings, 'deploy.memorySize', 512),
                    timeout:                 _.get(settings, 'deploy.timeout', 15),
                    reservedConcurrency:     _.get(settings, 'deploy.reservedConcurrency', 5),
                    requireWitnessThreshold: _.get(settings, 'deploy.requireWitnessThreshold', true),
                    originSecret:            _.get(settings, 'deploy.originSecret', 'generate'),
                    oacName:                 _.get(settings, 'deploy.oacName', 'selfdriven-bot-site-oac'),
                    priceClass:              _.get(settings, 'deploy.priceClass', 'PriceClass_All'),
                    keriFolder:              path.resolve(__dirname, _.get(settings, 'deploy.keriFolder', '../keri')),
                    acmPollMaxAttempts:      _.get(settings, 'deploy.acmPollMaxAttempts', 40),
                    acmPollIntervalMs:       _.get(settings, 'deploy.acmPollIntervalMs', 15000)
                };
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-get-origin-secret',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                let secret = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'originSecret' });

                if (secret == undefined)
                {
                    if (deploy.originSecret && deploy.originSecret !== 'generate') { secret = deploy.originSecret; }
                    else { secret = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'existingOriginSecret' }); }
                    if (!secret) { secret = crypto.randomBytes(32).toString('base64url'); }

                    entityos.set({ scope: 'selfdriven-bot-deploy', context: 'originSecret', value: secret });
                }

                return secret;
            }
        });

        // ── Entry ───────────────────────────────────────────────────────────

        entityos.add(
        {
            name: 'app-process-aws-selfdriven-bot-deploy',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');

                console.log('\n── selfdriven.bot deploy ───────────────────');
                console.log('Region:   ', deploy.region);
                console.log('Domain:   ', deploy.domain);
                console.log('Bucket:   ', deploy.siteBucket);
                console.log('Table:    ', deploy.tableName);
                console.log('Function: ', deploy.functionName);
                console.log('────────────────────────────────────────────\n');

                entityos.invoke('util-aws-selfdriven-bot-deploy-s3-bucket-check');
            }
        });

        // ── [1] Site bucket ─────────────────────────────────────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-s3-bucket-check',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');
                const s3 = new S3Client(entityos.invoke('util-aws-selfdriven-bot-get-config'));

                console.log('[1/' + TOTAL + '] Checking site bucket:', deploy.siteBucket);

                s3.send(new HeadBucketCommand({ Bucket: deploy.siteBucket }))
                .then(function ()
                {
                    console.log('  ✓ Bucket exists — skipping create');
                    entityos.invoke('util-aws-selfdriven-bot-deploy-s3-bucket-configure');
                })
                .catch(function (err)
                {
                    if (_.get(err, '$metadata.httpStatusCode') === 404 || err.name === 'NotFound' || err.name === 'NoSuchBucket')
                    {
                        console.log('  → Bucket not found — will create');
                        entityos.invoke('util-aws-selfdriven-bot-deploy-s3-bucket-create');
                    }
                    else if (_.get(err, '$metadata.httpStatusCode') === 403)
                    {
                        entityos.invoke('util-end', 'Bucket name ' + deploy.siteBucket + ' is owned by another account. Change deploy.siteBucket.', '500');
                    }
                    else
                    {
                        entityos.invoke('util-end', 'HeadBucket error: ' + err.message, '500');
                    }
                });
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-s3-bucket-create',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const { S3Client, CreateBucketCommand } = require('@aws-sdk/client-s3');
                const s3 = new S3Client(entityos.invoke('util-aws-selfdriven-bot-get-config'));

                let commandParams = { Bucket: deploy.siteBucket };
                if (deploy.region !== 'us-east-1')
                {
                    commandParams.CreateBucketConfiguration = { LocationConstraint: deploy.region };
                }

                s3.send(new CreateBucketCommand(commandParams))
                .then(function (response)
                {
                    console.log('  ✓ Bucket created:', response.Location);
                    entityos.invoke('util-aws-selfdriven-bot-deploy-s3-bucket-configure');
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'CreateBucket error: ' + err.message, '500');
                });
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-s3-bucket-configure',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const {
                    S3Client,
                    PutPublicAccessBlockCommand,
                    PutBucketEncryptionCommand,
                    PutBucketVersioningCommand
                } = require('@aws-sdk/client-s3');
                const s3 = new S3Client(entityos.invoke('util-aws-selfdriven-bot-get-config'));

                Promise.all([
                    s3.send(new PutPublicAccessBlockCommand({
                        Bucket: deploy.siteBucket,
                        PublicAccessBlockConfiguration: {
                            BlockPublicAcls: true, BlockPublicPolicy: true,
                            IgnorePublicAcls: true, RestrictPublicBuckets: true
                        }
                    })),
                    s3.send(new PutBucketEncryptionCommand({
                        Bucket: deploy.siteBucket,
                        ServerSideEncryptionConfiguration: {
                            Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }]
                        }
                    })),
                    s3.send(new PutBucketVersioningCommand({
                        Bucket: deploy.siteBucket,
                        VersioningConfiguration: { Status: 'Enabled' }
                    }))
                ])
                .then(function ()
                {
                    console.log('  ✓ Bucket: private (CloudFront OAC only), AES-256, versioning');
                    entityos.invoke('util-aws-selfdriven-bot-deploy-site-upload');
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'Bucket configure error: ' + err.message, '500');
                });
            }
        });

        // ── [2] Site upload ─────────────────────────────────────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-site-files',
            code: function (param)
            {
                const root = _.get(param, 'root');
                const files = [];

                (function walk(dir)
                {
                    _.each(fs.readdirSync(dir, { withFileTypes: true }), function (entry)
                    {
                        const full = path.join(dir, entry.name);
                        if (entry.isDirectory())
                        {
                            if (entry.name === '.well-known' || entry.name[0] !== '.') { walk(full); }
                        }
                        else if (entry.name[0] !== '.')
                        {
                            files.push({ full: full, key: path.relative(root, full).split(path.sep).join('/') });
                        }
                    });
                })(root);

                return files;
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-site-upload',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
                const s3 = new S3Client(entityos.invoke('util-aws-selfdriven-bot-get-config'));

                const files = entityos.invoke('util-aws-selfdriven-bot-site-files', { root: deploy.siteFolder });

                console.log('[2/' + TOTAL + '] Uploading site:', files.length, 'files from', deploy.siteFolder);

                Promise.all(_.map(files, function (file)
                {
                    return s3.send(new PutObjectCommand({
                        Bucket:               deploy.siteBucket,
                        Key:                  file.key,
                        Body:                 fs.readFileSync(file.full),
                        ContentType:          CONTENT_TYPES[path.extname(file.key)] || 'application/octet-stream',
                        CacheControl:         'public, max-age=300',
                        ServerSideEncryption: 'AES256'
                    }))
                    .then(function () { console.log('  ✓', file.key); });
                }))
                .then(function ()
                {
                    entityos.invoke('util-aws-selfdriven-bot-deploy-dynamodb-check');
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'Site upload error: ' + err.message, '500');
                });
            }
        });

        // ── [3] DynamoDB ────────────────────────────────────────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-dynamodb-check',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const { DynamoDBClient, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
                const ddb = new DynamoDBClient(entityos.invoke('util-aws-selfdriven-bot-get-config'));

                console.log('[3/' + TOTAL + '] Checking DynamoDB table:', deploy.tableName);

                ddb.send(new DescribeTableCommand({ TableName: deploy.tableName }))
                .then(function (response)
                {
                    console.log('  ✓ Table exists:', response.Table.TableStatus);
                    entityos.set({ scope: 'selfdriven-bot-deploy', context: 'tableARN', value: response.Table.TableArn });
                    entityos.invoke('util-aws-selfdriven-bot-deploy-dynamodb-ttl');
                })
                .catch(function (err)
                {
                    if (err.name === 'ResourceNotFoundException')
                    {
                        console.log('  → Table not found — will create');
                        entityos.invoke('util-aws-selfdriven-bot-deploy-dynamodb-create');
                    }
                    else
                    {
                        entityos.invoke('util-end', 'DescribeTable error: ' + err.message, '500');
                    }
                });
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-dynamodb-create',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const { DynamoDBClient, CreateTableCommand, waitUntilTableExists } = require('@aws-sdk/client-dynamodb');
                const ddb = new DynamoDBClient(entityos.invoke('util-aws-selfdriven-bot-get-config'));

                ddb.send(new CreateTableCommand(
                {
                    TableName: deploy.tableName,
                    BillingMode: 'PAY_PER_REQUEST',
                    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
                    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
                    SSESpecification: { Enabled: true },
                    Tags: [{ Key: 'Project', Value: 'selfdriven.bot' }]
                }))
                .then(function (response)
                {
                    entityos.set({ scope: 'selfdriven-bot-deploy', context: 'tableARN', value: response.TableDescription.TableArn });
                    console.log('  → Table creating — waiting for ACTIVE');
                    return waitUntilTableExists({ client: ddb, maxWaitTime: 300 }, { TableName: deploy.tableName });
                })
                .then(function ()
                {
                    console.log('  ✓ Table active');
                    entityos.invoke('util-aws-selfdriven-bot-deploy-dynamodb-ttl');
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'CreateTable error: ' + err.message, '500');
                });
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-dynamodb-ttl',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const { DynamoDBClient, DescribeTimeToLiveCommand, UpdateTimeToLiveCommand } = require('@aws-sdk/client-dynamodb');
                const ddb = new DynamoDBClient(entityos.invoke('util-aws-selfdriven-bot-get-config'));

                ddb.send(new DescribeTimeToLiveCommand({ TableName: deploy.tableName }))
                .then(function (response)
                {
                    const status = _.get(response, 'TimeToLiveDescription.TimeToLiveStatus');
                    if (status === 'ENABLED' || status === 'ENABLING')
                    {
                        console.log('  ✓ TTL on "ttl" (expires used nonces):', status);
                        return null;
                    }

                    return ddb.send(new UpdateTimeToLiveCommand(
                    {
                        TableName: deploy.tableName,
                        TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true }
                    }))
                    .then(function () { console.log('  ✓ TTL enabled on "ttl" (expires used nonces)'); });
                })
                .then(function ()
                {
                    entityos.invoke('util-aws-selfdriven-bot-deploy-iam-role-check');
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'TTL error: ' + err.message, '500');
                });
            }
        });

        // ── [4] IAM role ────────────────────────────────────────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-iam-policy',
            code: function ()
            {
                const tableARN = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'tableARN' });

                return JSON.stringify(
                {
                    Version: '2012-10-17',
                    Statement:
                    [{
                        Sid: 'EngagementTable',
                        Effect: 'Allow',
                        Action: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:ConditionCheckItem'],
                        Resource: tableARN
                    }]
                });
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-iam-role-check',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const { IAMClient, GetRoleCommand, PutRolePolicyCommand } = require('@aws-sdk/client-iam');
                const iam = new IAMClient(entityos.invoke('util-aws-selfdriven-bot-get-config'));

                console.log('[4/' + TOTAL + '] Checking IAM role:', deploy.roleName);

                iam.send(new GetRoleCommand({ RoleName: deploy.roleName }))
                .then(function (response)
                {
                    console.log('  ✓ Role exists:', response.Role.Arn);
                    entityos.set({ scope: 'selfdriven-bot-deploy', context: 'roleARN', value: response.Role.Arn });

                    return iam.send(new PutRolePolicyCommand({
                        RoleName: deploy.roleName,
                        PolicyName: 'selfdriven-bot-engage-table',
                        PolicyDocument: entityos.invoke('util-aws-selfdriven-bot-deploy-iam-policy')
                    }))
                    .then(function ()
                    {
                        console.log('  ✓ Table policy refreshed');
                        entityos.invoke('util-aws-selfdriven-bot-deploy-zip');
                    });
                })
                .catch(function (err)
                {
                    if (err.name === 'NoSuchEntityException')
                    {
                        console.log('  → Role not found — will create');
                        entityos.invoke('util-aws-selfdriven-bot-deploy-iam-role-create');
                    }
                    else
                    {
                        entityos.invoke('util-end', 'GetRole error: ' + err.message, '500');
                    }
                });
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-iam-role-create',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const { IAMClient, CreateRoleCommand, AttachRolePolicyCommand, PutRolePolicyCommand } = require('@aws-sdk/client-iam');
                const iam = new IAMClient(entityos.invoke('util-aws-selfdriven-bot-get-config'));

                const assumeRolePolicy = {
                    Version: '2012-10-17',
                    Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }]
                };

                iam.send(new CreateRoleCommand({
                    RoleName: deploy.roleName,
                    AssumeRolePolicyDocument: JSON.stringify(assumeRolePolicy),
                    Description: deploy.functionName + ' Lambda execution role'
                }))
                .then(function (response)
                {
                    entityos.set({ scope: 'selfdriven-bot-deploy', context: 'roleARN', value: response.Role.Arn });

                    return Promise.all([
                        iam.send(new AttachRolePolicyCommand({
                            RoleName: deploy.roleName,
                            PolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
                        })),
                        iam.send(new PutRolePolicyCommand({
                            RoleName: deploy.roleName,
                            PolicyName: 'selfdriven-bot-engage-table',
                            PolicyDocument: entityos.invoke('util-aws-selfdriven-bot-deploy-iam-policy')
                        }))
                    ]);
                })
                .then(function ()
                {
                    console.log('  ✓ Role created (logs + table access) — waiting 10s for IAM propagation');
                    setTimeout(function () { entityos.invoke('util-aws-selfdriven-bot-deploy-zip'); }, 10000);
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'IAM role create error: ' + err.message, '500');
                });
            }
        });

        // ── [5] Lambda package ──────────────────────────────────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-zip',
            code: function ()
            {
                const deploy  = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const zipPath = path.join(__dirname, deploy.lambdaZipName);

                console.log('[5/' + TOTAL + '] Zipping', deploy.lambdaFolder, '→', zipPath);

                if (!fs.existsSync(path.join(deploy.lambdaFolder, 'node_modules', 'signify-ts')))
                {
                    entityos.invoke('util-end', 'Run "npm install --omit=dev" in ' + deploy.lambdaFolder + ' first.', '500');
                    return;
                }

                const archiver = require('archiver');
                const output   = fs.createWriteStream(zipPath);
                const archive  = archiver('zip', { zlib: { level: 9 } });

                output.on('close', function ()
                {
                    console.log('  ✓ Zip created:', archive.pointer(), 'bytes');
                    entityos.set({ scope: 'selfdriven-bot-deploy', context: 'zipPath', value: zipPath });
                    entityos.invoke('util-aws-selfdriven-bot-deploy-lambda-check');
                });

                archive.on('error', function (err)
                {
                    entityos.invoke('util-end', 'Zip error: ' + err.message, '500');
                });

                archive.pipe(output);
                archive.glob('**/*', {
                    cwd: deploy.lambdaFolder,
                    // The Node.js Lambda runtime provides AWS SDK v3; don't ship the dev copy used by tests.
                    ignore: ['node_modules/@aws-sdk/**', 'node_modules/@smithy/**', 'node_modules/@aws-crypto/**',
                             'node_modules/@aws/**', 'events/**', '*.zip']
                });
                archive.finalize();
            }
        });

        // ── [6] Lambda function ─────────────────────────────────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-lambda-environment',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');

                return {
                    Variables:
                    {
                        TABLE_NAME:                deploy.tableName,
                        ORIGIN_SECRET:             entityos.invoke('util-aws-selfdriven-bot-get-origin-secret'),
                        ENGAGE_AUDIENCE:           'https://' + deploy.domain + '/engage',
                        REQUIRE_WITNESS_THRESHOLD: deploy.requireWitnessThreshold ? 'true' : 'false',
                        MAX_SKEW_SECONDS:          '300'
                    }
                };
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-lambda-check',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const { LambdaClient, GetFunctionCommand } = require('@aws-sdk/client-lambda');
                const lambda = new LambdaClient(entityos.invoke('util-aws-selfdriven-bot-get-config'));

                console.log('[6/' + TOTAL + '] Checking Lambda function:', deploy.functionName);

                lambda.send(new GetFunctionCommand({ FunctionName: deploy.functionName }))
                .then(function (response)
                {
                    console.log('  ✓ Function exists:', response.Configuration.FunctionArn);
                    entityos.set({ scope: 'selfdriven-bot-deploy', context: 'functionARN', value: response.Configuration.FunctionArn });
                    entityos.set({ scope: 'selfdriven-bot-deploy', context: 'existingOriginSecret',
                        value: _.get(response, 'Configuration.Environment.Variables.ORIGIN_SECRET') });
                    entityos.invoke('util-aws-selfdriven-bot-deploy-lambda-update');
                })
                .catch(function (err)
                {
                    if (err.name === 'ResourceNotFoundException')
                    {
                        console.log('  → Function not found — will create');
                        entityos.invoke('util-aws-selfdriven-bot-deploy-lambda-create', { attempt: 1 });
                    }
                    else
                    {
                        entityos.invoke('util-end', 'GetFunction error: ' + err.message, '500');
                    }
                });
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-lambda-create',
            code: function (param)
            {
                const deploy  = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const roleARN = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'roleARN' });
                const zipPath = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'zipPath' });
                const attempt = _.get(param, 'attempt', 1);

                const { LambdaClient, CreateFunctionCommand, waitUntilFunctionActiveV2 } = require('@aws-sdk/client-lambda');
                const lambda = new LambdaClient(entityos.invoke('util-aws-selfdriven-bot-get-config'));

                lambda.send(new CreateFunctionCommand({
                    FunctionName:  deploy.functionName,
                    Runtime:       'nodejs22.x',
                    Architectures: ['arm64'],
                    Handler:       'index.handler',
                    Role:          roleARN,
                    Code:          { ZipFile: fs.readFileSync(zipPath) },
                    MemorySize:    deploy.memorySize,
                    Timeout:       deploy.timeout,
                    Description:   'selfdriven.bot /engage: OOBI resolution, KEL verification, signed engagement requests',
                    Environment:   entityos.invoke('util-aws-selfdriven-bot-deploy-lambda-environment'),
                    Tags:          { Project: 'selfdriven.bot' }
                }))
                .then(function (response)
                {
                    entityos.set({ scope: 'selfdriven-bot-deploy', context: 'functionARN', value: response.FunctionArn });
                    console.log('  → Function created — waiting for Active');
                    return waitUntilFunctionActiveV2({ client: lambda, maxWaitTime: 180 }, { FunctionName: deploy.functionName });
                })
                .then(function ()
                {
                    console.log('  ✓ Function active');
                    entityos.invoke('util-aws-selfdriven-bot-deploy-lambda-concurrency');
                })
                .catch(function (err)
                {
                    // A new role can take a few seconds more before Lambda may assume it.
                    if (err.name === 'InvalidParameterValueException' && /role/i.test(err.message) && attempt < 6)
                    {
                        console.log('  → Role not assumable yet — retrying in 5s (' + attempt + '/5)');
                        setTimeout(function () { entityos.invoke('util-aws-selfdriven-bot-deploy-lambda-create', { attempt: attempt + 1 }); }, 5000);
                        return;
                    }
                    entityos.invoke('util-end', 'CreateFunction error: ' + err.message, '500');
                });
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-lambda-update',
            code: function ()
            {
                const deploy  = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const zipPath = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'zipPath' });
                const roleARN = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'roleARN' });

                const {
                    LambdaClient,
                    UpdateFunctionCodeCommand,
                    UpdateFunctionConfigurationCommand,
                    waitUntilFunctionUpdatedV2
                } = require('@aws-sdk/client-lambda');
                const lambda = new LambdaClient(entityos.invoke('util-aws-selfdriven-bot-get-config'));
                const waiter = { client: lambda, maxWaitTime: 180 };

                lambda.send(new UpdateFunctionCodeCommand({
                    FunctionName: deploy.functionName,
                    ZipFile:      fs.readFileSync(zipPath),
                    Architectures: ['arm64']
                }))
                .then(function ()
                {
                    console.log('  ✓ Code updated — waiting for update to finish');
                    return waitUntilFunctionUpdatedV2(waiter, { FunctionName: deploy.functionName });
                })
                .then(function ()
                {
                    return lambda.send(new UpdateFunctionConfigurationCommand({
                        FunctionName: deploy.functionName,
                        Runtime:      'nodejs22.x',
                        Handler:      'index.handler',
                        Role:         roleARN,
                        MemorySize:   deploy.memorySize,
                        Timeout:      deploy.timeout,
                        Environment:  entityos.invoke('util-aws-selfdriven-bot-deploy-lambda-environment')
                    }));
                })
                .then(function ()
                {
                    return waitUntilFunctionUpdatedV2(waiter, { FunctionName: deploy.functionName });
                })
                .then(function ()
                {
                    console.log('  ✓ Configuration updated');
                    entityos.invoke('util-aws-selfdriven-bot-deploy-lambda-concurrency');
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'Lambda update error: ' + err.message, '500');
                });
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-lambda-concurrency',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');

                if (!deploy.reservedConcurrency)
                {
                    entityos.invoke('util-aws-selfdriven-bot-deploy-lambda-url-check');
                    return;
                }

                const { LambdaClient, PutFunctionConcurrencyCommand } = require('@aws-sdk/client-lambda');
                const lambda = new LambdaClient(entityos.invoke('util-aws-selfdriven-bot-get-config'));

                lambda.send(new PutFunctionConcurrencyCommand({
                    FunctionName: deploy.functionName,
                    ReservedConcurrentExecutions: deploy.reservedConcurrency
                }))
                .then(function ()
                {
                    console.log('  ✓ Reserved concurrency:', deploy.reservedConcurrency, '(caps cost under load)');
                })
                .catch(function (err)
                {
                    // Accounts with a low concurrency quota can't reserve; the deploy still works without it.
                    console.log('  ! Reserved concurrency not set:', err.message);
                })
                .then(function ()
                {
                    entityos.invoke('util-aws-selfdriven-bot-deploy-lambda-url-check');
                });
            }
        });

        // ── [7] Function URL ────────────────────────────────────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-lambda-url-check',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const { LambdaClient, GetFunctionUrlConfigCommand, CreateFunctionUrlConfigCommand } = require('@aws-sdk/client-lambda');
                const lambda = new LambdaClient(entityos.invoke('util-aws-selfdriven-bot-get-config'));

                console.log('[7/' + TOTAL + '] Checking function URL');

                lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: deploy.functionName }))
                .then(function (response)
                {
                    console.log('  ✓ Function URL exists:', response.FunctionUrl);
                    return response.FunctionUrl;
                })
                .catch(function (err)
                {
                    if (err.name !== 'ResourceNotFoundException') { throw err; }

                    console.log('  → Function URL not found — will create');
                    return lambda.send(new CreateFunctionUrlConfigCommand({
                        FunctionName: deploy.functionName,
                        AuthType:     'NONE',
                        InvokeMode:   'BUFFERED'
                    }))
                    .then(function (response)
                    {
                        console.log('  ✓ Function URL created:', response.FunctionUrl);
                        return response.FunctionUrl;
                    });
                })
                .then(function (functionUrl)
                {
                    entityos.set({ scope: 'selfdriven-bot-deploy', context: 'functionUrlHost', value: new URL(functionUrl).host });
                    entityos.invoke('util-aws-selfdriven-bot-deploy-lambda-url-permissions');
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'Function URL error: ' + err.message, '500');
                });
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-lambda-url-permissions',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const { LambdaClient, AddPermissionCommand } = require('@aws-sdk/client-lambda');
                const lambda = new LambdaClient(entityos.invoke('util-aws-selfdriven-bot-get-config'));

                function add(input)
                {
                    return lambda.send(new AddPermissionCommand(input))
                    .catch(function (err)
                    {
                        if (err.name === 'ResourceConflictException') { return null; } // statement already present
                        throw err;
                    });
                }

                // Since October 2025 a public function URL needs both statements.
                Promise.all([
                    add({
                        FunctionName:        deploy.functionName,
                        StatementId:         'FunctionURLAllowPublicAccess',
                        Action:              'lambda:InvokeFunctionUrl',
                        Principal:           '*',
                        FunctionUrlAuthType: 'NONE'
                    }),
                    add({
                        FunctionName:          deploy.functionName,
                        StatementId:           'FunctionURLInvokeAllowPublicAccess',
                        Action:                'lambda:InvokeFunction',
                        Principal:             '*',
                        InvokedViaFunctionUrl: true
                    })
                ])
                .then(function ()
                {
                    console.log('  ✓ Public invoke permissions (requests without the CloudFront origin header get 403)');
                    entityos.invoke('util-aws-selfdriven-bot-deploy-acm-check');
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'AddPermission error: ' + err.message, '500');
                });
            }
        });

        // ── [8] ACM certificate (us-east-1, for CloudFront) ─────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-acm-check',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const { ACMClient, ListCertificatesCommand } = require('@aws-sdk/client-acm');
                const acm = new ACMClient(entityos.invoke('util-aws-selfdriven-bot-get-config', { region: 'us-east-1' }));

                console.log('[8/' + TOTAL + '] Checking ACM certificate (us-east-1):', deploy.domain);

                acm.send(new ListCertificatesCommand({ CertificateStatuses: ['ISSUED', 'PENDING_VALIDATION'] }))
                .then(function (response)
                {
                    const existing = _.find(response.CertificateSummaryList, function (cert)
                    {
                        return cert.DomainName === deploy.domain;
                    });

                    if (existing)
                    {
                        console.log('  ✓ Certificate exists:', existing.Status);
                        entityos.set({ scope: 'selfdriven-bot-deploy', context: 'certARN', value: existing.CertificateArn });

                        if (existing.Status === 'ISSUED') { entityos.invoke('util-aws-selfdriven-bot-deploy-cloudfront-oac-check'); }
                        else { entityos.invoke('util-aws-selfdriven-bot-deploy-acm-describe'); }
                    }
                    else
                    {
                        console.log('  → No certificate — will request');
                        entityos.invoke('util-aws-selfdriven-bot-deploy-acm-request');
                    }
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'ListCertificates error: ' + err.message, '500');
                });
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-acm-request',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const { ACMClient, RequestCertificateCommand } = require('@aws-sdk/client-acm');
                const acm = new ACMClient(entityos.invoke('util-aws-selfdriven-bot-get-config', { region: 'us-east-1' }));

                acm.send(new RequestCertificateCommand({
                    DomainName:       deploy.domain,
                    ValidationMethod: 'DNS',
                    Tags:             [{ Key: 'Project', Value: 'selfdriven.bot' }]
                }))
                .then(function (response)
                {
                    console.log('  ✓ Certificate requested');
                    entityos.set({ scope: 'selfdriven-bot-deploy', context: 'certARN', value: response.CertificateArn });
                    setTimeout(function () { entityos.invoke('util-aws-selfdriven-bot-deploy-acm-describe'); }, 5000);
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'RequestCertificate error: ' + err.message, '500');
                });
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-acm-describe',
            code: function ()
            {
                const certARN = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'certARN' });
                const { ACMClient, DescribeCertificateCommand } = require('@aws-sdk/client-acm');
                const acm = new ACMClient(entityos.invoke('util-aws-selfdriven-bot-get-config', { region: 'us-east-1' }));

                acm.send(new DescribeCertificateCommand({ CertificateArn: certARN }))
                .then(function (response)
                {
                    const cert = response.Certificate;
                    const validationRecords = [];

                    _.each(_.get(cert, 'DomainValidationOptions', []), function (dv)
                    {
                        const record = _.get(dv, 'ResourceRecord');
                        if (record) { validationRecords.push({ name: record.Name, value: record.Value, type: record.Type }); }
                    });

                    if (cert.Status === 'ISSUED')
                    {
                        entityos.invoke('util-aws-selfdriven-bot-deploy-cloudfront-oac-check');
                        return;
                    }

                    if (validationRecords.length === 0)
                    {
                        setTimeout(function () { entityos.invoke('util-aws-selfdriven-bot-deploy-acm-describe'); }, 5000);
                        return;
                    }

                    entityos.set({ scope: 'selfdriven-bot-deploy', context: 'validationRecords', value: validationRecords });
                    entityos.invoke('util-aws-selfdriven-bot-deploy-route53-zone', { next: 'util-aws-selfdriven-bot-deploy-acm-dns-validate' });
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'DescribeCertificate error: ' + err.message, '500');
                });
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-route53-zone',
            code: function (param)
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const next   = _.get(param, 'next');
                const cached = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'zoneId' });

                if (cached !== undefined) { entityos.invoke(next); return; }

                const { Route53Client, ListHostedZonesByNameCommand } = require('@aws-sdk/client-route-53');
                const route53 = new Route53Client(entityos.invoke('util-aws-selfdriven-bot-get-config', { region: 'us-east-1' }));
                const zoneName = deploy.route53Zone.endsWith('.') ? deploy.route53Zone : deploy.route53Zone + '.';

                route53.send(new ListHostedZonesByNameCommand({ DNSName: zoneName, MaxItems: 1 }))
                .then(function (response)
                {
                    const zone = _.find(response.HostedZones, function (hz) { return hz.Name === zoneName && !_.get(hz, 'Config.PrivateZone'); });
                    entityos.set({ scope: 'selfdriven-bot-deploy', context: 'zoneId', value: zone ? zone.Id.replace('/hostedzone/', '') : null });
                    if (zone) { console.log('  ✓ Route 53 zone:', zone.Id.replace('/hostedzone/', '')); }
                    else { console.log('  ✗ No public Route 53 zone for', deploy.route53Zone, '— DNS records will be printed for manual entry'); }
                    entityos.invoke(next);
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'ListHostedZonesByName error: ' + err.message, '500');
                });
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-acm-dns-validate',
            code: function ()
            {
                const deploy            = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const zoneId            = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'zoneId' });
                const validationRecords = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'validationRecords' });

                if (!zoneId)
                {
                    console.log('\n  Add this DNS record at your DNS provider, then run the deploy again:');
                    _.each(validationRecords, function (r) { console.log('   ', r.name, r.type, r.value); });
                    entityos.invoke('util-end', 'Waiting on ACM DNS validation for ' + deploy.domain + '. Re-run once the record is in place.', '408');
                    return;
                }

                const { Route53Client, ChangeResourceRecordSetsCommand } = require('@aws-sdk/client-route-53');
                const route53 = new Route53Client(entityos.invoke('util-aws-selfdriven-bot-get-config', { region: 'us-east-1' }));

                route53.send(new ChangeResourceRecordSetsCommand({
                    HostedZoneId: zoneId,
                    ChangeBatch:
                    {
                        Comment: 'ACM validation for ' + deploy.domain,
                        Changes: _.map(validationRecords, function (r)
                        {
                            return {
                                Action: 'UPSERT',
                                ResourceRecordSet: { Name: r.name, Type: r.type, TTL: 300, ResourceRecords: [{ Value: r.value }] }
                            };
                        })
                    }
                }))
                .then(function ()
                {
                    console.log('  ✓ Validation record written');
                    entityos.set({ scope: 'selfdriven-bot-deploy', context: 'pollAttempt', value: 0 });
                    entityos.invoke('util-aws-selfdriven-bot-deploy-acm-poll');
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'Validation record error: ' + err.message, '500');
                });
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-acm-poll',
            code: function ()
            {
                const deploy  = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const certARN = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'certARN' });
                const attempt = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'pollAttempt' }) || 0;

                const { ACMClient, DescribeCertificateCommand } = require('@aws-sdk/client-acm');
                const acm = new ACMClient(entityos.invoke('util-aws-selfdriven-bot-get-config', { region: 'us-east-1' }));

                console.log('  Polling ACM — attempt', (attempt + 1) + '/' + deploy.acmPollMaxAttempts);

                acm.send(new DescribeCertificateCommand({ CertificateArn: certARN }))
                .then(function (response)
                {
                    const status = response.Certificate.Status;

                    if (status === 'ISSUED')
                    {
                        console.log('  ✓ Certificate issued');
                        entityos.invoke('util-aws-selfdriven-bot-deploy-cloudfront-oac-check');
                    }
                    else if (status === 'FAILED')
                    {
                        entityos.invoke('util-end', 'Certificate FAILED: ' + _.get(response, 'Certificate.FailureReason', 'unknown'), '500');
                    }
                    else if (attempt + 1 >= deploy.acmPollMaxAttempts)
                    {
                        entityos.invoke('util-end', 'Certificate still ' + status + ' after ' + deploy.acmPollMaxAttempts + ' attempts. Re-run once ISSUED.', '408');
                    }
                    else
                    {
                        entityos.set({ scope: 'selfdriven-bot-deploy', context: 'pollAttempt', value: attempt + 1 });
                        setTimeout(function () { entityos.invoke('util-aws-selfdriven-bot-deploy-acm-poll'); }, deploy.acmPollIntervalMs);
                    }
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'ACM poll error: ' + err.message, '500');
                });
            }
        });

        // ── [9] CloudFront origin access control ────────────────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-cloudfront-oac-check',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const { CloudFrontClient, ListOriginAccessControlsCommand, CreateOriginAccessControlCommand } = require('@aws-sdk/client-cloudfront');
                const cloudfront = new CloudFrontClient(entityos.invoke('util-aws-selfdriven-bot-get-config', { region: 'us-east-1' }));

                console.log('[9/' + TOTAL + '] Checking CloudFront origin access control:', deploy.oacName);

                cloudfront.send(new ListOriginAccessControlsCommand({ MaxItems: 100 }))
                .then(function (response)
                {
                    const existing = _.find(_.get(response, 'OriginAccessControlList.Items', []), function (oac) { return oac.Name === deploy.oacName; });

                    if (existing)
                    {
                        console.log('  ✓ OAC exists:', existing.Id);
                        return existing.Id;
                    }

                    return cloudfront.send(new CreateOriginAccessControlCommand({
                        OriginAccessControlConfig:
                        {
                            Name:                          deploy.oacName,
                            Description:                   'selfdriven.bot site bucket',
                            SigningProtocol:               'sigv4',
                            SigningBehavior:               'always',
                            OriginAccessControlOriginType: 's3'
                        }
                    }))
                    .then(function (created)
                    {
                        console.log('  ✓ OAC created:', created.OriginAccessControl.Id);
                        return created.OriginAccessControl.Id;
                    });
                })
                .then(function (oacId)
                {
                    entityos.set({ scope: 'selfdriven-bot-deploy', context: 'oacId', value: oacId });
                    entityos.invoke('util-aws-selfdriven-bot-deploy-cloudfront-find', { next: 'util-aws-selfdriven-bot-deploy-cloudfront-upsert' });
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'Origin access control error: ' + err.message, '500');
                });
            }
        });

        // ── [10] CloudFront distribution ────────────────────────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-cloudfront-find',
            code: function (param)
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const next   = _.get(param, 'next');
                const marker = _.get(param, 'marker');

                const { CloudFrontClient, ListDistributionsCommand } = require('@aws-sdk/client-cloudfront');
                const cloudfront = new CloudFrontClient(entityos.invoke('util-aws-selfdriven-bot-get-config', { region: 'us-east-1' }));

                cloudfront.send(new ListDistributionsCommand(marker ? { Marker: marker } : {}))
                .then(function (response)
                {
                    const list = _.get(response, 'DistributionList', {});
                    const found = _.find(list.Items || [], function (d) { return _.includes(_.get(d, 'Aliases.Items', []), deploy.domain); });

                    if (found)
                    {
                        entityos.set({ scope: 'selfdriven-bot-deploy', context: 'distribution', value: { id: found.Id, arn: found.ARN, domain: found.DomainName } });
                        entityos.invoke(next);
                    }
                    else if (list.IsTruncated)
                    {
                        entityos.invoke('util-aws-selfdriven-bot-deploy-cloudfront-find', { next: next, marker: list.NextMarker });
                    }
                    else
                    {
                        entityos.set({ scope: 'selfdriven-bot-deploy', context: 'distribution', value: null });
                        entityos.invoke(next);
                    }
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'ListDistributions error: ' + err.message, '500');
                });
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-cloudfront-config',
            code: function (param)
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const oacId  = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'oacId' });
                const certARN = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'certARN' });
                const functionUrlHost = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'functionUrlHost' });

                const engageBehaviour = function (pattern)
                {
                    return {
                        PathPattern:           pattern,
                        TargetOriginId:        'engage',
                        ViewerProtocolPolicy:  'https-only',
                        AllowedMethods:
                        {
                            Quantity: 7, Items: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
                            CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] }
                        },
                        Compress:              true,
                        CachePolicyId:         POLICY_CACHING_DISABLED,
                        OriginRequestPolicyId: POLICY_ALL_VIEWER_EXCEPT_HOST
                    };
                };

                return {
                    CallerReference:   _.get(param, 'callerReference', 'selfdriven-bot-' + Date.now()),
                    Comment:           deploy.domain,
                    Enabled:           true,
                    Aliases:           { Quantity: 1, Items: [deploy.domain] },
                    DefaultRootObject: 'index.html',
                    HttpVersion:       'http2and3',
                    IsIPV6Enabled:     true,
                    PriceClass:        deploy.priceClass,
                    ViewerCertificate:
                    {
                        ACMCertificateArn:      certARN,
                        SSLSupportMethod:       'sni-only',
                        MinimumProtocolVersion: 'TLSv1.2_2021'
                    },
                    Origins:
                    {
                        Quantity: 2,
                        Items:
                        [
                            {
                                Id:                    'site',
                                DomainName:            deploy.siteBucket + '.s3.' + deploy.region + '.amazonaws.com',
                                OriginAccessControlId: oacId,
                                S3OriginConfig:        { OriginAccessIdentity: '' }
                            },
                            {
                                Id:         'engage',
                                DomainName: functionUrlHost,
                                CustomOriginConfig:
                                {
                                    HTTPPort:               80,
                                    HTTPSPort:              443,
                                    OriginProtocolPolicy:   'https-only',
                                    OriginSslProtocols:     { Quantity: 1, Items: ['TLSv1.2'] },
                                    OriginReadTimeout:      30,
                                    OriginKeepaliveTimeout: 5
                                },
                                CustomHeaders:
                                {
                                    Quantity: 1,
                                    Items: [{ HeaderName: 'x-origin-verify', HeaderValue: entityos.invoke('util-aws-selfdriven-bot-get-origin-secret') }]
                                }
                            }
                        ]
                    },
                    DefaultCacheBehavior:
                    {
                        TargetOriginId:          'site',
                        ViewerProtocolPolicy:    'redirect-to-https',
                        AllowedMethods:
                        {
                            Quantity: 2, Items: ['GET', 'HEAD'],
                            CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] }
                        },
                        Compress:                true,
                        CachePolicyId:           POLICY_CACHING_OPTIMIZED,
                        ResponseHeadersPolicyId: POLICY_SECURITY_HEADERS
                    },
                    CacheBehaviors:
                    {
                        Quantity: 2,
                        Items: [engageBehaviour('/engage'), engageBehaviour('/engage/*')]
                    }
                };
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-cloudfront-upsert',
            code: function ()
            {
                const distribution = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'distribution' });
                const {
                    CloudFrontClient,
                    CreateDistributionCommand,
                    GetDistributionConfigCommand,
                    UpdateDistributionCommand
                } = require('@aws-sdk/client-cloudfront');
                const cloudfront = new CloudFrontClient(entityos.invoke('util-aws-selfdriven-bot-get-config', { region: 'us-east-1' }));

                console.log('[10/' + TOTAL + '] CloudFront distribution:', distribution ? 'updating ' + distribution.id : 'creating');

                let work;

                if (distribution == null)
                {
                    work = cloudfront.send(new CreateDistributionCommand({
                        DistributionConfig: entityos.invoke('util-aws-selfdriven-bot-deploy-cloudfront-config')
                    }))
                    .then(function (response)
                    {
                        return { id: response.Distribution.Id, arn: response.Distribution.ARN, domain: response.Distribution.DomainName };
                    });
                }
                else
                {
                    work = cloudfront.send(new GetDistributionConfigCommand({ Id: distribution.id }))
                    .then(function (current)
                    {
                        const config = entityos.invoke('util-aws-selfdriven-bot-deploy-cloudfront-config',
                            { callerReference: current.DistributionConfig.CallerReference });

                        // Keep anything set by hand that this factory doesn't manage (logging, WAF, errors, etc.)
                        const merged = _.assign({}, current.DistributionConfig, config);

                        return cloudfront.send(new UpdateDistributionCommand({
                            Id:                 distribution.id,
                            IfMatch:            current.ETag,
                            DistributionConfig: merged
                        }));
                    })
                    .then(function (response)
                    {
                        return { id: response.Distribution.Id, arn: response.Distribution.ARN, domain: response.Distribution.DomainName };
                    });
                }

                work
                .then(function (result)
                {
                    console.log('  ✓ Distribution', result.id, '→', result.domain, '(edge rollout takes a few minutes)');
                    entityos.set({ scope: 'selfdriven-bot-deploy', context: 'distribution', value: result });
                    entityos.invoke('util-aws-selfdriven-bot-deploy-s3-bucket-policy');
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'CloudFront distribution error: ' + err.message, '500');
                });
            }
        });

        // ── [11] Bucket policy (CloudFront only) ───────────────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-s3-bucket-policy',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const distribution = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'distribution' });

                const { S3Client, PutBucketPolicyCommand } = require('@aws-sdk/client-s3');
                const s3 = new S3Client(entityos.invoke('util-aws-selfdriven-bot-get-config'));

                console.log('[11/' + TOTAL + '] Bucket policy: read access for this distribution only');

                const condition = { StringEquals: { 'AWS:SourceArn': distribution.arn } };

                s3.send(new PutBucketPolicyCommand({
                    Bucket: deploy.siteBucket,
                    Policy: JSON.stringify(
                    {
                        Version: '2012-10-17',
                        Statement:
                        [
                            {
                                Sid: 'CloudFrontReadObjects', Effect: 'Allow',
                                Principal: { Service: 'cloudfront.amazonaws.com' },
                                Action: 's3:GetObject',
                                Resource: 'arn:aws:s3:::' + deploy.siteBucket + '/*',
                                Condition: condition
                            },
                            {
                                // Lets missing paths return 404 rather than 403
                                Sid: 'CloudFrontListBucket', Effect: 'Allow',
                                Principal: { Service: 'cloudfront.amazonaws.com' },
                                Action: 's3:ListBucket',
                                Resource: 'arn:aws:s3:::' + deploy.siteBucket,
                                Condition: condition
                            }
                        ]
                    })
                }))
                .then(function ()
                {
                    console.log('  ✓ Bucket policy set');
                    entityos.invoke('util-aws-selfdriven-bot-deploy-route53-zone', { next: 'util-aws-selfdriven-bot-deploy-route53-alias' });
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'PutBucketPolicy error: ' + err.message, '500');
                });
            }
        });

        // ── [12] Route 53 alias ─────────────────────────────────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-route53-alias',
            code: function ()
            {
                const deploy       = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const zoneId       = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'zoneId' });
                const distribution = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'distribution' });

                console.log('[12/' + TOTAL + '] DNS:', deploy.domain, '→', distribution.domain);

                if (!zoneId)
                {
                    entityos.set({ scope: 'selfdriven-bot-deploy', context: 'dnsManual', value: true });
                    entityos.invoke('util-aws-selfdriven-bot-deploy-lambda-smoke');
                    return;
                }

                const { Route53Client, ChangeResourceRecordSetsCommand } = require('@aws-sdk/client-route-53');
                const route53 = new Route53Client(entityos.invoke('util-aws-selfdriven-bot-get-config', { region: 'us-east-1' }));

                const alias = function (type)
                {
                    return {
                        Action: 'UPSERT',
                        ResourceRecordSet:
                        {
                            Name: deploy.domain,
                            Type: type,
                            AliasTarget: { HostedZoneId: CLOUDFRONT_ZONE_ID, DNSName: distribution.domain, EvaluateTargetHealth: false }
                        }
                    };
                };

                route53.send(new ChangeResourceRecordSetsCommand({
                    HostedZoneId: zoneId,
                    ChangeBatch: { Comment: 'selfdriven.bot → CloudFront', Changes: [alias('A'), alias('AAAA')] }
                }))
                .then(function ()
                {
                    console.log('  ✓ A + AAAA alias records');
                    entityos.invoke('util-aws-selfdriven-bot-deploy-lambda-smoke');
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'Alias record error: ' + err.message, '500');
                });
            }
        });

        // ── [13] Smoke test: origin refuses direct calls ───────────────────

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-deploy-lambda-smoke',
            code: function ()
            {
                const host = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'functionUrlHost' });

                console.log('[13/' + TOTAL + '] Smoke test: direct call to the function URL should be refused');

                fetch('https://' + host + '/engage')
                .then(function (res)
                {
                    if (res.status === 403) { console.log('  ✓ 403 without the origin header'); }
                    else { console.log('  ! Expected 403, got', res.status, '— check ORIGIN_SECRET on the function'); }
                })
                .catch(function (err)
                {
                    console.log('  ! Smoke test skipped:', err.message);
                })
                .then(function ()
                {
                    entityos.invoke('app-process-aws-selfdriven-bot-deploy-done');
                });
            }
        });

        // ── [14] Done ───────────────────────────────────────────────────────

        entityos.add(
        {
            name: 'app-process-aws-selfdriven-bot-deploy-done',
            code: function ()
            {
                const deploy       = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const distribution = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'distribution' });
                const dnsManual    = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'dnsManual' });

                console.log('\n[14/' + TOTAL + '] ── selfdriven.bot deployed ─────────────────');
                console.log('Site:          https://' + deploy.domain + '/');
                console.log('Engage:        https://' + deploy.domain + '/engage');
                console.log('Distribution:  ' + distribution.id + ' (' + distribution.domain + ')');

                if (dnsManual)
                {
                    console.log('\nDNS is not in Route 53. At your DNS provider, point the apex at CloudFront:');
                    console.log('   ' + deploy.domain + '  ALIAS/ANAME  ' + distribution.domain);
                }

                console.log('\nNext: incept the selfdriven.bot AID (keri/incept.sh), then: node publish-oobi.js');
                console.log('────────────────────────────────────────────\n');

                entityos.invoke('util-end',
                {
                    status: 'deployed',
                    site: 'https://' + deploy.domain + '/',
                    engage: 'https://' + deploy.domain + '/engage',
                    distributionId: distribution.id,
                    distributionDomain: distribution.domain,
                    dnsManual: !!dnsManual
                }, '200');
            }
        });

        // ── OOBI publish ────────────────────────────────────────────────────

        entityos.add(
        {
            name: 'app-process-aws-selfdriven-bot-oobi-publish',
            code: function ()
            {
                const deploy  = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const kelPath = path.join(deploy.keriFolder, 'selfdriven-bot.cesr');
                const aidPath = path.join(deploy.keriFolder, 'selfdriven-bot.aid');

                console.log('\n── selfdriven.bot OOBI publish ─────────────');

                if (!fs.existsSync(kelPath) || !fs.existsSync(aidPath))
                {
                    entityos.invoke('util-end', 'Missing ' + kelPath + ' or ' + aidPath + '. Run keri/incept.sh first.', '400');
                    return;
                }

                const aid = fs.readFileSync(aidPath, 'utf8').trim();
                const kel = fs.readFileSync(kelPath);
                const kelVerify = require(path.join(deploy.lambdaFolder, 'kel-verify.js'));

                console.log('[1/4] Verifying KEL for', aid);

                kelVerify.load()
                .then(function (m)
                {
                    const state = kelVerify.verifyKel(m, kelVerify.parseStream(m, kel), { prefix: aid, requireWitnessThreshold: true });
                    console.log('  ✓ KEL verifies: sn ' + state.sn + ', ' + state.keys.length + ' signing key(s), ' +
                        state.witnesses.length + ' witness(es), toad ' + state.toad);

                    entityos.set({ scope: 'selfdriven-bot-deploy', context: 'oobi', value: { aid: aid, kel: kel } });
                    entityos.invoke('util-aws-selfdriven-bot-oobi-publish-stamp');
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'KEL does not verify, not publishing: ' + err.message, '400');
                });
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-oobi-publish-stamp',
            code: function ()
            {
                const deploy = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const oobi   = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'oobi' });

                console.log('[2/4] Stamping the AID into the site');

                const stamped = [];

                _.each(['.well-known/agent.json', 'index.html'], function (rel)
                {
                    const file = path.join(deploy.siteFolder, rel);
                    if (!fs.existsSync(file)) { return; }

                    const text = fs.readFileSync(file, 'utf8');
                    const escaped = AID_PLACEHOLDER.replace('<', '&lt;').replace('>', '&gt;');   // as it appears in index.html

                    if (text.indexOf(AID_PLACEHOLDER) !== -1 || text.indexOf(escaped) !== -1)
                    {
                        fs.writeFileSync(file, text.split(AID_PLACEHOLDER).join(oobi.aid).split(escaped).join(oobi.aid));
                        console.log('  ✓', rel, '(placeholder → AID)');
                    }
                    else if (text.indexOf(oobi.aid) !== -1)
                    {
                        console.log('  ✓', rel, '(already has this AID)');
                    }
                    else
                    {
                        console.log('  ! ' + rel + ' has neither the placeholder nor this AID — update identity.aid by hand');
                    }
                    stamped.push(rel);
                });

                entityos.set({ scope: 'selfdriven-bot-deploy', context: 'stampedFiles', value: stamped });
                entityos.invoke('util-aws-selfdriven-bot-oobi-publish-upload');
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-oobi-publish-upload',
            code: function ()
            {
                const deploy  = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const oobi    = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'oobi' });
                const stamped = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'stampedFiles' }) || [];

                const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
                const s3 = new S3Client(entityos.invoke('util-aws-selfdriven-bot-get-config'));

                // Served as-is by CloudFront from the bucket; KERI resolvers accept any of these forms.
                const kelKeys = ['oobi', 'oobi/' + oobi.aid, 'oobi/' + oobi.aid + '/controller', '.well-known/keri/oobi/' + oobi.aid];

                console.log('[3/4] Uploading KEL and stamped site files');

                const puts = _.map(kelKeys, function (key)
                {
                    return s3.send(new PutObjectCommand({
                        Bucket: deploy.siteBucket, Key: key, Body: oobi.kel,
                        ContentType: 'application/json+cesr', CacheControl: 'public, max-age=300',
                        Metadata: { 'keri-aid': oobi.aid }, ServerSideEncryption: 'AES256'
                    }))
                    .then(function () { console.log('  ✓ /' + key); });
                })
                .concat(_.map(stamped, function (rel)
                {
                    return s3.send(new PutObjectCommand({
                        Bucket: deploy.siteBucket, Key: rel, Body: fs.readFileSync(path.join(deploy.siteFolder, rel)),
                        ContentType: CONTENT_TYPES[path.extname(rel)] || 'application/octet-stream',
                        CacheControl: 'public, max-age=300', ServerSideEncryption: 'AES256'
                    }))
                    .then(function () { console.log('  ✓ /' + rel); });
                }));

                Promise.all(puts)
                .then(function ()
                {
                    entityos.invoke('util-aws-selfdriven-bot-deploy-cloudfront-find', { next: 'util-aws-selfdriven-bot-oobi-publish-invalidate' });
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'OOBI upload error: ' + err.message, '500');
                });
            }
        });

        entityos.add(
        {
            name: 'util-aws-selfdriven-bot-oobi-publish-invalidate',
            code: function ()
            {
                const deploy       = entityos.invoke('util-aws-selfdriven-bot-get-deploy-settings');
                const oobi         = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'oobi' });
                const distribution = entityos.get({ scope: 'selfdriven-bot-deploy', context: 'distribution' });

                const done = function ()
                {
                    console.log('\nOOBI:  https://' + deploy.domain + '/oobi');
                    console.log('       https://' + deploy.domain + '/oobi/' + oobi.aid + '/controller');
                    console.log('       https://' + deploy.domain + '/.well-known/keri/oobi/' + oobi.aid);
                    console.log('────────────────────────────────────────────\n');
                    entityos.invoke('util-end', { status: 'published', aid: oobi.aid, oobi: 'https://' + deploy.domain + '/oobi' }, '200');
                };

                console.log('[4/4] Invalidating CloudFront cache');

                if (distribution == null)
                {
                    console.log('  ! No distribution for ' + deploy.domain + ' yet — run node deploy.js');
                    done();
                    return;
                }

                const { CloudFrontClient, CreateInvalidationCommand } = require('@aws-sdk/client-cloudfront');
                const cloudfront = new CloudFrontClient(entityos.invoke('util-aws-selfdriven-bot-get-config', { region: 'us-east-1' }));

                cloudfront.send(new CreateInvalidationCommand({
                    DistributionId: distribution.id,
                    InvalidationBatch:
                    {
                        CallerReference: 'oobi-' + Date.now(),
                        Paths: { Quantity: 4, Items: ['/', '/index.html', '/oobi*', '/.well-known/*'] }
                    }
                }))
                .then(function (response)
                {
                    console.log('  ✓ Invalidation', response.Invalidation.Id);
                    done();
                })
                .catch(function (err)
                {
                    entityos.invoke('util-end', 'CreateInvalidation error: ' + err.message, '500');
                });
            }
        });
    }
};
