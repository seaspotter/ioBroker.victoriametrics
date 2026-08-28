'use strict';

const { expect } = require('chai');
const { normalizeMetricName, deriveMetricName, sanitizeLabelValue } = require('./metricName');

describe('metricName', () => {
    describe('normalizeMetricName', () => {
        it('lowercases and replaces dots with underscores', () => {
            expect(normalizeMetricName('javascript.0.Aussentemperatur')).to.equal('javascript_0_aussentemperatur');
        });

        it('collapses invalid character runs into a single underscore', () => {
            expect(normalizeMetricName('PV Batterieleistung (kW)')).to.equal('pv_batterieleistung_kw');
        });

        it('strips leading and trailing underscores', () => {
            expect(normalizeMetricName('  .foo.  ')).to.equal('foo');
        });

        it('prepends an underscore if the result starts with a digit', () => {
            expect(normalizeMetricName('0_test.0.value')).to.equal('_0_test_0_value');
        });

        it('falls back to a default name for empty/invalid input', () => {
            expect(normalizeMetricName('!!!')).to.equal('metric_unnamed');
            expect(normalizeMetricName('')).to.equal('metric_unnamed');
        });

        it('keeps already-valid names untouched apart from lowercasing', () => {
            expect(normalizeMetricName('idm_aussentemperatur')).to.equal('idm_aussentemperatur');
        });
    });

    describe('deriveMetricName', () => {
        it('uses aliasId when set', () => {
            expect(deriveMetricName('javascript.0.foo', { aliasId: 'idm_aussentemperatur' })).to.equal(
                'idm_aussentemperatur',
            );
        });

        it('falls back to the object ID when aliasId is empty or missing', () => {
            expect(deriveMetricName('javascript.0.foo', { aliasId: '' })).to.equal('javascript_0_foo');
            expect(deriveMetricName('javascript.0.foo', undefined)).to.equal('javascript_0_foo');
        });
    });

    describe('sanitizeLabelValue', () => {
        it('trims whitespace', () => {
            expect(sanitizeLabelValue('  °C  ')).to.equal('°C');
        });

        it('caps overly long values', () => {
            const long = 'x'.repeat(200);
            expect(sanitizeLabelValue(long)).to.have.length(128);
        });
    });
});
