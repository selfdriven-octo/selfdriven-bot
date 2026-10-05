'use strict';

var entityos = require('entityos');
var factory  = require('./infrastructurefactory-selfdriven-bot-engage');

factory.init({});

entityos.add(
{
    name: 'util-end',
    code: function (response)
    {
        const resolve = entityos.get({ scope: 'selfdriven-bot-engage', context: '_resolve' });
        if (resolve) { resolve(response); }
    }
});

exports.handler = async function (event)
{
    return new Promise(function (resolve)
    {
        entityos.set({ scope: 'selfdriven-bot-engage', context: '_resolve', value: resolve });
        entityos.set({ scope: '_event', value: event });

        entityos.set(
        {
            scope: '_settings',
            value:
            {
                infrastructure:
                {
                    aws:
                    {
                        region: process.env.AWS_REGION || 'ap-southeast-2'
                    }
                },
                engage:
                {
                    table:                   process.env.TABLE_NAME || 'selfdriven-bot',
                    originSecret:            process.env.ORIGIN_SECRET || '',
                    audience:                process.env.ENGAGE_AUDIENCE || 'https://selfdriven.bot/engage',
                    allowPrivateHosts:       process.env.ALLOW_PRIVATE_OOBI_HOSTS === 'true',
                    requireWitnessThreshold: process.env.REQUIRE_WITNESS_THRESHOLD !== 'false',
                    maxSkewSeconds:          parseInt(process.env.MAX_SKEW_SECONDS || '300', 10)
                }
            }
        });

        entityos.invoke('util-aws-selfdriven-bot-engage-route');
    });
};
