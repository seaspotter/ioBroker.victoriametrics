'use strict';

const CONFIG = require('./config');

/**
 * Normalisiert einen beliebigen String zu einem gültigen Prometheus-/
 * VictoriaMetrics-Metriknamen (`^[a-zA-Z_:][a-zA-Z0-9_:]*$`).
 *
 * @param {string} raw - Roher Name (z.B. ioBroker-Objekt-ID oder aliasId)
 * @param {ioBroker.Log} [log] - Optionaler Logger für Warnungen
 * @returns {string} Normalisierter Metrikname
 */
function normalizeMetricName(raw, log) {
    let name = String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/\./g, '_')
        .replace(/[^a-zA-Z0-9_:]+/g, '_')
        .replace(/^_+|_+$/g, '');

    if (!name) {
        log && log.warn(`Konnte aus "${raw}" keinen gültigen Metriknamen ableiten, verwende Fallback`);
        name = CONFIG.METRIC_NAME_FALLBACK;
    }

    if (/^[0-9]/.test(name)) {
        name = `_${name}`;
    }

    return name;
}

/**
 * Leitet den Metriknamen für einen Datenpunkt ab: bevorzugt die konfigurierte
 * aliasId, sonst die ioBroker-Objekt-ID selbst (stabil & eindeutig, im
 * Gegensatz zu common.name).
 *
 * @param {string} objId - ioBroker-Objekt-ID
 * @param {{aliasId?: string}} [customConfig] - Custom-Settings des Objekts für diesen Adapter
 * @param {ioBroker.Log} [log] - Optionaler Logger für Warnungen
 * @returns {string} Normalisierter Metrikname
 */
function deriveMetricName(objId, customConfig, log) {
    const alias = customConfig && customConfig.aliasId && String(customConfig.aliasId).trim();
    return normalizeMetricName(alias || objId, log);
}

/**
 * Bereinigt einen Label-Wert (kein Zeichensatz-Limit bei VM-Labelwerten,
 * aber Länge begrenzen und trimmen).
 *
 * @param {unknown} value - Roher Label-Wert
 * @returns {string} Bereinigter Label-Wert
 */
function sanitizeLabelValue(value) {
    return String(value).trim().slice(0, CONFIG.LABEL_VALUE_MAX_LEN);
}

module.exports = {
    normalizeMetricName,
    deriveMetricName,
    sanitizeLabelValue,
};
