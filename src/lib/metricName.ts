const FALLBACK_NAME = 'metric_unnamed';
const LABEL_VALUE_MAX_LEN = 128;

/**
 * Normalizes a string to a valid Prometheus metric name (`^[a-zA-Z_:][a-zA-Z0-9_:]*$`).
 *
 * @param raw - Raw name, e.g. an object ID or alias
 * @param log - Optional logger for the fallback warning
 * @returns The normalized name
 */
export function normalizeMetricName(raw: string | null | undefined, log?: ioBroker.Log): string {
    let name = String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/\./g, '_')
        .replace(/[^a-zA-Z0-9_:]+/g, '_')
        .replace(/^_+|_+$/g, '');

    if (!name) {
        log?.warn(`Could not derive a valid metric name from "${raw}", using fallback`);
        name = FALLBACK_NAME;
    }

    return /^[0-9]/.test(name) ? `_${name}` : name;
}

/**
 * Derives the metric name of a datapoint: the configured alias, else the object ID
 * (stable, unlike `common.name`).
 *
 * @param objId - Object ID
 * @param customConfig - Custom settings of the object for this adapter
 * @param customConfig.aliasId - Configured metric name
 * @param log - Optional logger
 * @returns The normalized name
 */
export function deriveMetricName(objId: string, customConfig?: { aliasId?: string }, log?: ioBroker.Log): string {
    const alias = customConfig?.aliasId && String(customConfig.aliasId).trim();
    return normalizeMetricName(alias || objId, log);
}

/**
 * Trims a label value and caps its length.
 *
 * @param value - Raw label value
 * @returns The sanitized value
 */
export function sanitizeLabelValue(value: unknown): string {
    return String(value).trim().slice(0, LABEL_VALUE_MAX_LEN);
}

/**
 * Builds the labels written with a point (currently only the unit).
 *
 * @param unit - `common.unit` of the object
 * @returns The labels
 */
export function buildLabels(unit?: unknown): Record<string, string> {
    return unit ? { unit: sanitizeLabelValue(unit) } : {};
}
