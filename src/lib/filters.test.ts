import { expect } from 'chai';
import { PointFilter, parseOptionalNumber, type FilterDefaults } from './filters';

const make = (defaults: FilterDefaults = {}): PointFilter => new PointFilter(() => defaults);

describe('parseOptionalNumber', () => {
    it('parses numbers and numeric strings, ignores everything else', () => {
        expect(parseOptionalNumber(5)).to.equal(5);
        expect(parseOptionalNumber(' 2.5 ')).to.equal(2.5);
        expect(parseOptionalNumber(0)).to.equal(0);
        for (const raw of ['', undefined, null, 'abc', NaN]) {
            expect(parseOptionalNumber(raw)).to.equal(undefined);
        }
    });
});

describe('PointFilter', () => {
    describe('validate', () => {
        it('passes values unchanged without settings', () => {
            expect(make().validate(21.456, {})).to.equal(21.456);
        });

        it('filters values outside the thresholds', () => {
            const filter = make();
            const settings = { ignoreBelowNumber: 0, ignoreAboveNumber: '100' };
            expect(filter.validate(-1, settings)).to.equal(null);
            expect(filter.validate(101, settings)).to.equal(null);
            expect(filter.validate(100, settings)).to.equal(100);
        });

        it('ignores zero only when enabled', () => {
            expect(make().validate(0, {})).to.equal(0);
            expect(make().validate(0, { ignoreZero: true })).to.equal(null);
            expect(make().validate(1, { ignoreZero: true })).to.equal(1);
        });

        it('rounds to the configured decimals', () => {
            expect(make().validate(21.456, { round: 1 })).to.equal(21.5);
            expect(make().validate(21.456, { round: '0' })).to.equal(21);
            expect(make().validate(21.456, { round: -1 })).to.equal(21.456);
        });

        it('uses the instance default unless the datapoint sets its own value', () => {
            const filter = make({ defaultRound: 1, defaultIgnoreZero: true });
            expect(filter.validate(1.26, {})).to.equal(1.3);
            expect(filter.validate(1.26, { round: 2 })).to.equal(1.26);
            expect(filter.validate(0, {})).to.equal(null);
            expect(filter.validate(0, { ignoreZero: false })).to.equal(0);
        });
    });

    describe('isRedundant', () => {
        it('never filters the first value', () => {
            const settings = { changesOnly: true, changesMinDelta: 5, blockTime: 1000 };
            expect(make().isRedundant('a', 1, settings, 0)).to.equal(false);
        });

        it('filters changes below the minimum change', () => {
            const filter = make();
            filter.record('a', 10, 0);
            expect(filter.isRedundant('a', 10.4, { changesMinDelta: 0.5 }, 1)).to.equal(true);
            expect(filter.isRedundant('a', 10.5, { changesMinDelta: 0.5 }, 1)).to.equal(false);
        });

        it('with changes only, skips unchanged values until the relog interval has passed', () => {
            const filter = make();
            filter.record('a', 10, 0);
            const settings = { changesOnly: true, changesRelogInterval: 1000 };
            expect(filter.isRedundant('a', 11, settings, 10)).to.equal(false);
            expect(filter.isRedundant('a', 10, settings, 999)).to.equal(true);
            expect(filter.isRedundant('a', 10, settings, 1000)).to.equal(false);
            expect(filter.isRedundant('a', 10, { changesOnly: true }, 999999)).to.equal(true);
        });

        it('blocks values within the block time after the last written value', () => {
            const filter = make();
            filter.record('a', 10, 0);
            expect(filter.isRedundant('a', 11, { blockTime: 1000 }, 999)).to.equal(true);
            expect(filter.isRedundant('a', 11, { blockTime: 1000 }, 1000)).to.equal(false);
        });

        it('forgets a datapoint', () => {
            const filter = make();
            filter.record('a', 10, 0);
            filter.forget('a');
            expect(filter.isRedundant('a', 10, { changesOnly: true }, 1)).to.equal(false);
        });
    });

    it('reads the debounce time', () => {
        expect(make().debounceMs({})).to.equal(0);
        expect(make({ defaultDebounceTime: '200' }).debounceMs({})).to.equal(200);
        expect(make({ defaultDebounceTime: '200' }).debounceMs({ debounceTime: 50 })).to.equal(50);
    });
});
