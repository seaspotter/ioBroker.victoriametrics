import { expect } from 'chai';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleGetHistory } from './history';
import { deriveMetricName } from './metricName';
import type { CustomSettings } from './types';
import type { ConnectionConfig } from './vmClient';
import type { Victoriametrics } from '../main';

/** The response of the handler. */
interface Response {
    result?: { ts: number; val: number | null; id?: string }[];
    error?: string;
}

describe('getHistory', () => {
    let server: http.Server;
    let requests: string[];
    let failQuery = false;
    let cfg: ConnectionConfig;

    before(done => {
        server = http.createServer((req, res) => {
            const url = new URL(req.url || '/', 'http://localhost');
            requests.push(url.pathname);
            const now = Date.now();
            if (url.pathname === '/api/v1/export') {
                // metric b is newer than metric a
                const offset = url.searchParams.get('match[]') === 'b' ? 250 : 3000;
                res.end(
                    `${JSON.stringify({ values: [1, 2, 3], timestamps: [now - offset, now - offset + 100, now - offset + 200] })}\n`,
                );
            } else if (url.pathname === '/api/v1/query_range' && !failQuery) {
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ data: { result: [{ values: [[Math.floor(now / 1000), '7']] }] } }));
            } else {
                res.statusCode = 500;
                res.end('boom');
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

    beforeEach(() => {
        requests = [];
        failQuery = false;
    });

    /**
     * Sends a getHistory message to the handler and returns the response.
     *
     * @param message - Message body
     * @param enabled - Datapoints enabled in the adapter
     * @param connection - Connection to use
     */
    async function ask(
        message: object,
        enabled: Record<string, CustomSettings> = {},
        connection: ConnectionConfig = cfg,
    ): Promise<Response> {
        let response: Response | undefined;
        const log = { debug: () => {}, warn: () => {}, info: () => {}, error: () => {} };
        const adapter = {
            connection,
            log,
            enabledPoints: new Map(Object.entries(enabled)),
            metricNameOf: (id: string) => Promise.resolve(deriveMetricName(id)),
            sendTo: (_from: string, _command: string, payload: Response) => {
                response = payload;
            },
        } as unknown as Victoriametrics;
        await handleGetHistory(adapter, {
            command: 'getHistory',
            from: 'test',
            message,
            callback: {},
        } as ioBroker.Message);
        return response as Response;
    }

    it('rejects a missing id', async () => {
        expect((await ask({ options: {} })).error).to.contain('no valid id');
    });

    it('returns raw points without any options', async () => {
        const response = await ask({ id: 'a' });
        expect(response.error).to.equal(undefined);
        expect(response.result?.map(p => p.val)).to.include.members([1, 2, 3]);
        expect(requests).to.deep.equal(['/api/v1/export']);
    });

    it('lets VictoriaMetrics aggregate average with a step', async () => {
        const end = Date.now();
        const response = await ask({
            id: 'a',
            options: { aggregate: 'average', step: 60_000, start: end - 3_600_000, end },
        });
        expect(requests).to.deep.equal(['/api/v1/query_range']);
        expect(response.result?.some(p => p.val === 7)).to.equal(true);
    });

    it('falls back to the raw-data path if the pushdown fails', async () => {
        failQuery = true;
        const end = Date.now();
        const response = await ask({
            id: 'a',
            options: { aggregate: 'average', step: 60_000, start: end - 3_600_000, end },
        });
        expect(requests).to.deep.equal(['/api/v1/query_range', '/api/v1/export']);
        expect(response.error).to.equal(undefined);
    });

    it('uses the raw-data path for aggregates without PromQL equivalent and for unknown names', async () => {
        await ask({ id: 'a', options: { aggregate: 'onchange' } });
        await ask({ id: 'a', options: { aggregate: 'constructor' } });
        expect(requests).to.deep.equal(['/api/v1/export', '/api/v1/export']);
    });

    it('reports an unreachable VictoriaMetrics', async () => {
        const response = await ask({ id: 'a', options: {} }, {}, { ...cfg, port: 1 });
        expect(response.error).to.contain('Reading from VictoriaMetrics failed');
    });

    it("returns the latest points of all enabled datapoints for id '*'", async () => {
        const response = await ask({ id: '*', options: { count: 4, addId: true } }, { a: {}, b: {} });
        expect(response.error).to.equal(undefined);
        // the newest 4 of 6 points, oldest first: only the newest point of a and all 3 of b
        // the aggregation library adds a border point without id in front
        expect(response.result?.filter(p => p.id).map(p => p.id)).to.deep.equal(['a', 'b', 'b', 'b']);
    });
});
