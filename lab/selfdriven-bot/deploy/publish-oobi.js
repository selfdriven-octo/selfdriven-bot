var entityos = require('entityos');
var factory  = require('./infrastructurefactory-selfdriven-bot');

entityos.set({ scope: '_settings', value: require('./settings.json') });

factory.init({});

entityos.add(
{
    name: 'util-end',
    code: function (param, status)
    {
        console.log('\n[util-end] status:', status);
        console.log(JSON.stringify(param, null, 2));
        process.exit(status === '200' ? 0 : 1);
    }
});

entityos.invoke('app-process-aws-selfdriven-bot-oobi-publish');
