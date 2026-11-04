import { CONFIG } from './config';

/**
 * Normalisiert einen beliebigen String zu einem gültigen Prometheus-/
 * VictoriaMetrics-Metriknamen (`^[a-zA-Z_:][a-zA-Z0-9_:]*$`).
 *
 * @param raw - Roher Name (z.B. ioBroker-Objekt-ID oder aliasId)
 * @param [log] - Optionaler Logger für Warnungen
 * @returns Normalisierter Metrikname
 */
export function normalizeMetricName(raw: string | null | undefined, log?: ioBroker.Log): string {
    let name = String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/\./g, '_')
        .replace(/[^a-zA-Z0-9_:]+/g, '_')
        .replace(/^_+|_+$/g, '');

    if (!name) {
        log && log.warn(`Could not derive a valid metric name from "${raw}", using fallback`);
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
 * @param objId - ioBroker-Objekt-ID
 * @param [customConfig] - Custom-Settings des Objekts für diesen Adapter
 * @param customConfig.aliasId
 * @param [log] - Optionaler Logger für Warnungen
 * @returns Normalisierter Metrikname
 */
export function deriveMetricName(objId: string, customConfig?: { aliasId?: string }, log?: ioBroker.Log): string {
    const alias = customConfig && customConfig.aliasId && String(customConfig.aliasId).trim();
    return normalizeMetricName(alias || objId, log);
}

/**
 * Bereinigt einen Label-Wert (kein Zeichensatz-Limit bei VM-Labelwerten,
 * aber Länge begrenzen und trimmen).
 *
 * @param value - Roher Label-Wert
 * @returns Bereinigter Label-Wert
 */
export function sanitizeLabelValue(value: unknown): string {
    return String(value).trim().slice(0, CONFIG.LABEL_VALUE_MAX_LEN);
}
