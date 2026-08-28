'use strict';

const { sendResponse } = require('@iobroker/aggregate');
const CONFIG = require('./config');
const metricName = require('./metricName');

/**
 * Behandelt eine getHistory-Nachricht:
 * - liest rohe oder (bei geeigneter aggregate-Methode) serverseitig per PromQL
 *   vorab aggregierte Datenpunkte für die Metrik des angefragten Objekts aus
 *   VictoriaMetrics
 * - übergibt sie an die geteilte `@iobroker/aggregate`-Bibliothek, die
 *   dieselbe Bucket-Aggregation/Lücken-Behandlung wie history/sql/influxdb
 *   übernimmt (oder bei preAggregated=true nur formatiert)
 * - antwortet über sendTo im von ioBroker erwarteten Format
 *
 * Bekannte Einschränkungen (siehe README): `id: '*'` liefert nur Rohwerte über
 * alle aktuell aktivierten Datenpunkte hinweg, keine Aggregation; kein
 * Vorab-Flush ungeschriebener gepufferter Werte; keine ack/q/from-Felder
 * (Phase 1 speichert diese nicht in VM).
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance & {vmClient: import('./vmClient').VmClient, enabledPoints: Map<string, object>}} adapter - Adapterinstanz
 * @param {ioBroker.Message} obj - Empfangene getHistory-Nachricht ({id, options})
 */
async function handleGetHistory(adapter, obj) {
    const startTime = Date.now();
    const id = obj.message && obj.message.id;
    /** @type {import('@iobroker/aggregate').GetHistoryOptions} */
    const options = (obj.message && obj.message.options) || {};

    options.end = options.end || Date.now();
    options.start = options.start || options.end - CONFIG.HISTORY_DEFAULT_RANGE_MS;
    // @iobroker/aggregate berechnet step aus (end-start)/count, wenn kein step gesetzt ist,
    // und crasht bei fehlendem count (NaN-Array-Länge) - siehe initAggregate(). limit ebenfalls
    // absichern, sonst kann ein sehr großer count die interne Zwischenspeicherung aufblähen.
    if (!options.step) {
        options.count = options.count || CONFIG.HISTORY_DEFAULT_COUNT;
    }
    options.limit = options.limit || CONFIG.HISTORY_DEFAULT_LIMIT;

    if (id === '*') {
        await handleMultiIdHistory(adapter, obj, options, startTime);
        return;
    }

    if (!id || typeof id !== 'string') {
        sendResponse(adapter, obj, id, options, 'getHistory: keine gültige id angegeben', startTime);
        return;
    }

    const foreignObj = await adapter.getForeignObjectAsync(id);
    const settings =
        foreignObj && foreignObj.common && foreignObj.common.custom && foreignObj.common.custom[adapter.namespace];
    const name = metricName.deriveMetricName(id, settings, adapter.log);

    const pushdownFunc = CONFIG.PROMQL_PUSHDOWN_FUNCS[options.aggregate];
    if (pushdownFunc) {
        const pushdownPoints = await tryPromqlPushdown(adapter, name, options, pushdownFunc);
        if (pushdownPoints) {
            sendResponse(adapter, obj, id, options, pushdownPoints, startTime);
            return;
        }
        // Pushdown nicht möglich/fehlgeschlagen - options.start/end wurden dabei nicht
        // verändert, weiter mit dem normalen Rohdaten-Pfad unten.
    }

    const result = await adapter.vmClient.exportRange(adapter.config, name, options.start, options.end);
    if (!result.ok) {
        sendResponse(adapter, obj, id, options, `Lesen von VictoriaMetrics fehlgeschlagen: ${result.error}`, startTime);
        return;
    }

    sendResponse(adapter, obj, id, options, result.points || [], startTime);
}

/**
 * Versucht, eine getHistory-Aggregation per PromQL/MetricsQL serverseitig in VictoriaMetrics
 * berechnen zu lassen (analog influxdb's InfluxQL-GROUP-BY-Pushdown), statt Rohdaten zu
 * exportieren und JS-seitig in der geteilten Aggregat-Bibliothek zu aggregieren. Bei Erfolg
 * werden options.start/options.end um einen Step nach außen erweitert (für saubere
 * Chart-Ränder, wie im Rohdaten-Pfad üblich) und options.preAggregated gesetzt - das lässt
 * sendResponse die eigene Aggregation überspringen und die übergebenen Punkte direkt
 * formatieren.
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance & {vmClient: import('./vmClient').VmClient}} adapter - Adapterinstanz
 * @param {string} name - Metrikname
 * @param {import('@iobroker/aggregate').GetHistoryOptions} options - wird bei Erfolg mutiert (start/end/preAggregated)
 * @param {string} pushdownFunc - PromQL-Funktion, z.B. "avg_over_time"
 * @returns {Promise<{ts: number, val: number}[] | null>} Punkte bei Erfolg, sonst null (Rückfall auf Rohdaten-Pfad)
 */
async function tryPromqlPushdown(adapter, name, options, pushdownFunc) {
    // handleGetHistory hat start/end/count bereits mit Defaults befüllt, bevor diese
    // Funktion aufgerufen wird - hier lokal binden, damit TS die Werte als number sieht.
    const start = /** @type {number} */ (options.start);
    const end = /** @type {number} */ (options.end);
    const count = /** @type {number} */ (options.count);

    let stepMs = options.step;
    if (!stepMs) {
        stepMs = (end - start) / count;
    }
    if (!stepMs || stepMs < 1000) {
        // VM erlaubt kein sinnvolles Sub-Sekunden-step - Rohdaten-Pfad übernimmt.
        return null;
    }
    const stepSeconds = Math.round(stepMs / 1000);
    const paddedStart = start - stepSeconds * 1000;
    const paddedEnd = end + stepSeconds * 1000;
    const query = `${pushdownFunc}(${name}[${stepSeconds}s])`;

    const result = await adapter.vmClient.queryRange(adapter.config, query, paddedStart, paddedEnd, stepSeconds * 1000);
    if (!result.ok) {
        adapter.log.debug(`PromQL-Pushdown fehlgeschlagen, falle auf Rohdaten-Pfad zurück: ${result.error}`);
        return null;
    }

    options.start = paddedStart;
    options.end = paddedEnd;
    options.preAggregated = true;
    return result.points || [];
}

/**
 * Behandelt getHistory mit id: '*' - liefert die letzten Rohwerte über alle aktuell in
 * Admin aktivierten Datenpunkte hinweg (nicht verwaiste Metriken zwischenzeitlich
 * deaktivierter Datenpunkte, siehe README). Aggregation wird hierfür nicht unterstützt, da
 * sie über verschiedene Metriken hinweg keinen Sinn ergibt - es werden immer Rohwerte
 * zurückgegeben, unabhängig vom angefragten aggregate.
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance & {vmClient: import('./vmClient').VmClient, enabledPoints: Map<string, object>}} adapter - Adapterinstanz
 * @param {ioBroker.Message} obj - Empfangene getHistory-Nachricht
 * @param {import('@iobroker/aggregate').GetHistoryOptions} options - bereits mit Defaults befüllte Optionen
 * @param {number} startTime - Zeitpunkt des Nachrichteneingangs (für Logging in sendResponse)
 */
async function handleMultiIdHistory(adapter, obj, options, startTime) {
    if (options.aggregate && options.aggregate !== 'onchange' && options.aggregate !== 'none') {
        adapter.log.debug(
            `getHistory id:'*' unterstützt keine Aggregation (angefragt: ${options.aggregate}) - liefere Rohwerte`,
        );
    }

    const start = /** @type {number} */ (options.start);
    const end = /** @type {number} */ (options.end);
    const ids = Array.from(adapter.enabledPoints.keys());
    const perIdResults = await Promise.all(
        ids.map(async id => {
            const settings = adapter.enabledPoints.get(id);
            const name = metricName.deriveMetricName(id, settings, adapter.log);
            const result = await adapter.vmClient.exportRange(adapter.config, name, start, end);
            if (!result.ok) {
                return [];
            }
            return (result.points || []).map(p => ({ ts: p.ts, val: p.val, id }));
        }),
    );

    const merged = perIdResults.flat();
    merged.sort((a, b) => b.ts - a.ts);
    const limit = options.count || options.limit || CONFIG.HISTORY_DEFAULT_COUNT;
    const trimmed = merged.slice(0, limit).sort((a, b) => a.ts - b.ts);

    options.preAggregated = true;
    // id bewusst undefined lassen: @iobroker/aggregate's beautify() würde bei gesetztem
    // options.id sonst jedem Ergebnispunkt dieselbe globale id zuweisen und damit die pro
    // Punkt bereits gesetzten individuellen ids überschreiben (siehe addId-Handling).
    sendResponse(adapter, obj, undefined, options, trimmed, startTime);
}

module.exports = { handleGetHistory };
