const http = require('node:http');
const path = require('node:path');
const { expect } = require('chai');
const { tests } = require('@iobroker/testing');

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Writing history to a mock VictoriaMetrics', getHarness => {
            it('writes a changed state with the configured filters and the unit label', async function () {
                this.timeout(60000);
                const harness = getHarness();

                const imports = [];
                const server = http.createServer((req, res) => {
                    let body = '';
                    req.on('data', chunk => (body += chunk));
                    req.on('end', () => {
                        if (req.url.startsWith('/api/v1/import')) {
                            imports.push(body);
                        }
                        res.statusCode = req.url.startsWith('/api/v1/import') ? 204 : 200;
                        res.end(req.url.startsWith('/flags') ? '-retentionPeriod="100y"\n' : 'OK');
                    });
                });
                await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

                try {
                    await harness.changeAdapterConfig('victoriametrics', {
                        native: { protocol: 'http', host: '127.0.0.1', port: server.address().port, writeInterval: 1 },
                    });
                    await harness.objects.setObjectAsync('test.0.temperature', {
                        type: 'state',
                        common: {
                            name: 'Temperature',
                            type: 'number',
                            role: 'value.temperature',
                            unit: '°C',
                            read: true,
                            write: false,
                            custom: { 'victoriametrics.0': { enabled: true, round: 1 } },
                        },
                        native: {},
                    });
                    await harness.startAdapterAndWait();

                    // The harness reports the adapter as started once it is connected, before it has
                    // subscribed to its datapoints, so set the state until the write arrives.
                    const deadline = Date.now() + 30000;
                    while (!imports.length && Date.now() < deadline) {
                        await harness.states.setStateAsync('test.0.temperature', { val: 21.456, ack: true });
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }

                    expect(imports, 'no write reached VictoriaMetrics').to.have.length.greaterThan(0);
                    const series = JSON.parse(imports[0].split('\n')[0]);
                    expect(series.metric).to.deep.equal({ __name__: 'test_0_temperature', unit: '°C' });
                    expect(series.values).to.have.length.greaterThan(0);
                    expect(new Set(series.values)).to.deep.equal(new Set([21.5])); // rounded to 1 decimal
                } finally {
                    server.close();
                }
            });
        });
    },
});
