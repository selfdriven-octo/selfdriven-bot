'use strict';
// Serves the /engage Lambda on http://127.0.0.1:5720 the way CloudFront fronts it
// (adds the origin header), with an in-memory DynamoDB. For trying the documented curl recipe locally.
const path = require('path');
const http = require('http');
const LAMBDA = path.join(__dirname, '..', 'lambda');
const ddb = require(require.resolve('@aws-sdk/client-dynamodb', { paths: [LAMBDA] }));
const table = new Map();
const key = (i) => i.pk.S + '|' + i.sk.S;
ddb.DynamoDBClient.prototype.send = function (c)
{
    if (c instanceof ddb.TransactWriteItemsCommand)
    {
        const clash = c.input.TransactItems.some((t) => t.Put.ConditionExpression && table.has(key(t.Put.Item)));
        if (clash) { const e = new Error('cancelled'); e.name = 'TransactionCanceledException'; e.CancellationReasons = [{ Code: 'ConditionalCheckFailed' }]; return Promise.reject(e); }
        c.input.TransactItems.forEach((t) => table.set(key(t.Put.Item), t.Put.Item));
        return Promise.resolve({});
    }
    return Promise.resolve({ Item: table.get(key(c.input.Key)) });
};
process.env.ORIGIN_SECRET = 'local';
process.env.TABLE_NAME = 'local';
process.env.ALLOW_PRIVATE_OOBI_HOSTS = 'true';
const handler = require(path.join(LAMBDA, 'index.js')).handler;
http.createServer((req, res) =>
{
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () =>
    {
        const u = new URL(req.url, 'http://local');
        handler({ rawPath: u.pathname, headers: Object.assign({}, req.headers, { 'x-origin-verify': 'local' }),
                  requestContext: { http: { method: req.method, path: u.pathname, sourceIp: '127.0.0.1' } }, body: body, isBase64Encoded: false })
        .then((r) => { res.writeHead(r.statusCode, r.headers); res.end(r.body); });
    });
}).listen(5720, '127.0.0.1', () => console.log('engage on http://127.0.0.1:5720/engage'));
