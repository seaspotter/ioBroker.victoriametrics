import { expect } from 'chai';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as vm from './vmClient';

describe('vmClient (against a mock VictoriaMetrics)', () => {
    let server: http.Server;
    let cfg: vm.ConnectionConfig;
    let lastImportBody = '';
    let lastAuth: string | undefined;

    before(done => {
        server = http.createServer((req, res) => {
            const url = new URL(req.url || '/', 'http://localhost');
            lastAuth = req.headers.authorization;
            switch (url.pathname) {
                case '/health':
                    res.end('OK');
                    break;
                case '/flags':
                    res.end('-retentionPeriod="100y"\n-other=1\n');
                    break;
                case '/api/v1/import': {
                    let body = '';
                    req.on('data', chunk => (body += chunk));
                    req.on('end', () => {
                        lastImportBody = body;
                        res.statusCode = 204;
                        res.end();
                    });
                    break;
                }
                case '/api/v1/export':
                    // two series of the same metric (e.g. changed unit), the second one is older
                    res.end(
                        `${JSON.stringify({ values: [3, 4], timestamps: [3000, 4000] })}\n${JSON.stringify({ values: [1], timestamps: [1000] })}\n`,
                    );
                    break;
                case '/api/v1/query_range':
                    res.setHeader('content-type', 'application/json');
                    res.end(
                        JSON.stringify({
                            data: {
                                result: [
                                    {
                                        values: [
                                            [2, '6'],
                                            [1, '5'],
                                        ],
                                    },
                                ],
                            },
                        }),
                    );
                    break;
                default:
                    res.statusCode = 400;
                    res.end('bad request');
            }
        });
        server.listen(0, '127.0.0.1', () => {
            cfg = { protocol: 'http', host: '127.0.0.1', port: (server.address() as AddressInfo).port };
            done();
        });
    });

    after(done => {
        server.close(done);
    });

    it('checks the health', async () => {
        expect(await vm.testHealth(cfg)).to.deep.equal({ ok: true });
    });

    it('reads the retention flag', async () => {
        expect(await vm.getRetention(cfg)).to.deep.equal({ ok: true, retention: '100y' });
    });

    it('sends a multi-line NDJSON body unchanged', async () => {
        const body =
            '{"metric":{"__name__":"a"},"values":[1],"timestamps":[1]}\n{"metric":{"__name__":"b"},"values":[2],"timestamps":[2]}';
        expect(await vm.writeBatch(cfg, body)).to.deep.equal({ ok: true });
        expect(lastImportBody).to.equal(body);
    });

    it('merges series of an export and sorts them by time', async () => {
        const result = await vm.exportRange(cfg, 'm', 0, 5000);
        expect(result).to.deep.equal({
            ok: true,
            points: [
                { ts: 1000, val: 1 },
                { ts: 3000, val: 3 },
                { ts: 4000, val: 4 },
            ],
        });
    });

    it('parses a range query', async () => {
        const result = await vm.queryRange(cfg, 'avg_over_time(m[1s])', 0, 5000, 1000);
        expect(result).to.deep.equal({
            ok: true,
            points: [
                { ts: 1000, val: 5 },
                { ts: 2000, val: 6 },
            ],
        });
    });

    it('sends basic auth only when enabled', async () => {
        await vm.testHealth({ ...cfg, useAuth: true, username: 'u', password: 'p' });
        expect(lastAuth).to.equal(`Basic ${Buffer.from('u:p').toString('base64')}`);
        await vm.testHealth(cfg);
        expect(lastAuth).to.equal(undefined);
    });

    it('reports HTTP errors and unreachable servers without leaking credentials', async () => {
        const http400 = await vm.deleteSeries({ ...cfg, useAuth: true, username: 'u', password: 'secret' }, 'm');
        expect(http400).to.deep.equal({ ok: false, error: 'HTTP 400: bad request' });

        const unreachable = await vm.testHealth({ ...cfg, port: 1, password: 'secret' });
        expect(unreachable.ok).to.equal(false);
        expect(JSON.stringify(unreachable)).to.not.contain('secret');
    });
});
