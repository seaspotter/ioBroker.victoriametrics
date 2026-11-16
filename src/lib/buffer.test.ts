import { expect } from 'chai';
import { SeriesBuffer, buildImportBody, type BufferedPoint } from './buffer';

const point = (pointId: string, value: number, ts: number, labels: Record<string, string> = {}): BufferedPoint => ({
    pointId,
    metricName: pointId,
    labels,
    value,
    ts,
});

describe('SeriesBuffer', () => {
    it('drains all points and requeues them', () => {
        const buffer = new SeriesBuffer();
        buffer.add(point('a', 1, 1));
        buffer.add(point('b', 2, 2));
        expect(buffer.size()).to.equal(2);

        const points = buffer.drainAll();
        expect(points).to.have.length(2);
        expect(buffer.size()).to.equal(0);

        buffer.requeue(points);
        expect(buffer.size()).to.equal(2);
    });

    it('restores a persisted buffer only for the expected format version', () => {
        const buffer = new SeriesBuffer();
        buffer.add(point('a', 1, 1));
        const data = buffer.toJSON(1);

        expect(SeriesBuffer.fromJSON(data, 1).size()).to.equal(1);
        expect(SeriesBuffer.fromJSON(data, 2).size()).to.equal(0);
        expect(SeriesBuffer.fromJSON(null, 1).size()).to.equal(0);
        expect(SeriesBuffer.fromJSON({ version: 1, points: 'x' as unknown as BufferedPoint[] }, 1).size()).to.equal(0);
    });
});

describe('buildImportBody', () => {
    it('groups points by metric and labels, one JSON line per group', () => {
        const body = buildImportBody([
            point('a', 1, 10, { unit: '°C' }),
            point('a', 2, 20, { unit: '°C' }),
            point('a', 3, 30),
            point('b', 4, 40),
        ]);
        const lines = body.split('\n').map(line => JSON.parse(line));

        expect(lines).to.have.length(3);
        expect(lines[0]).to.deep.equal({
            metric: { __name__: 'a', unit: '°C' },
            values: [1, 2],
            timestamps: [10, 20],
        });
        expect(lines[1].metric).to.deep.equal({ __name__: 'a' });
    });
});
