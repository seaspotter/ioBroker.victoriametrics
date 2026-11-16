import { expect } from 'chai';
import { validTimerMs } from './config';

describe('validTimerMs', () => {
    it('accepts positive numbers and numeric strings', () => {
        expect(validTimerMs(5000)).to.equal(5000);
        expect(validTimerMs('250')).to.equal(250);
    });

    it('rejects zero, negative, non-numeric and empty values', () => {
        for (const raw of [0, -1, 'abc', '', undefined, null, NaN, Infinity]) {
            expect(validTimerMs(raw), String(raw)).to.equal(undefined);
        }
    });

    it('rejects values above the timer maximum', () => {
        expect(validTimerMs(2_147_483_647)).to.equal(2_147_483_647);
        expect(validTimerMs(2_147_483_648)).to.equal(undefined);
    });
});
