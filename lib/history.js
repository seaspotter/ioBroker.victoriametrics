'use strict';

const { sendResponse } = require('@iobroker/aggregate');
const CONFIG = require('./config');
const metricName = require('./metricName');

/**
 * Behandelt eine getHistory-Nachricht (Phase 2, Proof-of-Concept):
 * - liest rohe Datenpunkte für die Metrik des angefragten Objekts aus
 *   VictoriaMetrics
 * - übergibt sie an die geteilte `@iobroker/aggregate`-Bibliothek, die
 *   dieselbe Bucket-Aggregation/Lücken-Behandlung wie history/sql/influxdb
 *   übernimmt
 * - antwortet über sendTo im von ioBroker erwarteten Format
 *
 * Bekannte Einschränkungen (siehe README): nur einzelne id (kein '*'),
 * kein Vorab-Flush ungeschriebener gepufferter Werte, keine ack/q/from-
 * Felder (Phase 1 speichert diese nicht in VM).
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance & {vmClient: import('./vmClient').VmClient}} adapter - Adapterinstanz
 * @param {ioBroker.Message} obj - Empfangene getHistory-Nachricht ({id, options})
 */
async function handleGetHistory(adapter, obj) {
    const startTime = Date.now();
    const id = obj.message && obj.message.id;
    /** @type {import('@iobroker/aggregate').GetHistoryOptions} */
    const options = (obj.message && obj.message.options) || {};

    if (!id || typeof id !== 'string') {
        sendResponse(adapter, obj, id, options, 'getHistory: keine gültige id angegeben', startTime);
        return;
    }

    options.end = options.end || Date.now();
    options.start = options.start || options.end - CONFIG.HISTORY_DEFAULT_RANGE_MS;
    // @iobroker/aggregate berechnet step aus (end-start)/count, wenn kein step gesetzt ist,
    // und crasht bei fehlendem count (NaN-Array-Länge) - siehe initAggregate(). limit ebenfalls
    // absichern, sonst kann ein sehr großer count die interne Zwischenspeicherung aufblähen.
    if (!options.step) {
        options.count = options.count || CONFIG.HISTORY_DEFAULT_COUNT;
    }
    options.limit = options.limit || CONFIG.HISTORY_DEFAULT_LIMIT;

    const foreignObj = await adapter.getForeignObjectAsync(id);
    const settings =
        foreignObj && foreignObj.common && foreignObj.common.custom && foreignObj.common.custom[adapter.namespace];
    const name = metricName.deriveMetricName(id, settings, adapter.log);

    const result = await adapter.vmClient.exportRange(adapter.config, name, options.start, options.end);
    if (!result.ok) {
        sendResponse(adapter, obj, id, options, `Lesen von VictoriaMetrics fehlgeschlagen: ${result.error}`, startTime);
        return;
    }

    sendResponse(adapter, obj, id, options, result.points || [], startTime);
}

module.exports = { handleGetHistory };
