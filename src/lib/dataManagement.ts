import * as metricName from './metricName';
import type { Victoriametrics } from '../main';

/**
 * Löst für eine ioBroker-Objekt-ID den zugehörigen Metriknamen auf (frischer
 * Objekt-Lookup + dieselbe Ableitung wie beim Schreiben), damit deleteAll
 * konsistent mit der tatsächlich geschriebenen Metrik arbeitet.
 *
 * @param adapter - Adapterinstanz
 * @param id - ioBroker-Objekt-ID
 * @returns Normalisierter Metrikname
 */
async function resolveMetricName(adapter: Victoriametrics, id: string): Promise<string> {
    const foreignObj = await adapter.getForeignObjectAsync(id);
    const settings =
        foreignObj && foreignObj.common && foreignObj.common.custom && foreignObj.common.custom[adapter.namespace];
    return metricName.deriveMetricName(id, settings, adapter.log);
}

/**
 * Normalisiert obj.message der storeState-Nachricht zu einer flachen Liste von
 * {id, state, rules}-Einträgen. Akzeptierte Formen (aus iobroker.influxdb
 * übernommen): {id, state, rules?}, {id, state:[...], rules?}, oder ein Array davon.
 *
 * @param message - obj.message
 * @returns Flache Liste
 */
function flattenStoreStateMessage(message: unknown): { id: string; state: ioBroker.State; rules?: boolean }[] {
    const entries = Array.isArray(message) ? message : [message];
    const flat: { id: string; state: ioBroker.State; rules?: boolean }[] = [];
    for (const entry of entries) {
        if (!entry || !entry.id || !entry.state) {
            continue;
        }
        const states = Array.isArray(entry.state) ? entry.state : [entry.state];
        for (const state of states) {
            if (state) {
                flat.push({ id: entry.id, state, rules: entry.rules });
            }
        }
    }
    return flat;
}

/**
 * Behandelt eine storeState-Nachricht: schreibt einen oder mehrere historische
 * Punkte in den Puffer, z.B. für ein Migrationsskript, das alte Historie aus
 * einer anderen Quelle (z.B. InfluxDB) nachträglich importiert. Erfordert
 * bewusst NICHT, dass der Datenpunkt aktuell für Live-Historisierung aktiviert
 * ist - ein expliziter storeState-Aufruf ist unabhängig davon zulässig.
 *
 * `rules:true` wendet Rundung + Schwellenwert-/Nullwert-Filter an (Werte-
 * Validität, sinnvoll auch für Importe). debounceTime/blockTime/changesMinDelta
 * werden bewusst NIE angewendet, unabhängig von rules - diese sind auf Live-
 * Zustandsänderungen ausgelegt (zeitbasierte Rate-Limits, Vergleich mit dem
 * zuletzt geschriebenen Wert) und ergeben für rückdatierte Bulk-Importe keinen
 * Sinn.
 *
 * @param adapter - Adapterinstanz
 * @param obj - Empfangene storeState-Nachricht
 */
export async function handleStoreState(adapter: Victoriametrics, obj: ioBroker.Message): Promise<void> {
    const entries = flattenStoreStateMessage(obj.message);
    if (!entries.length) {
        adapter.sendTo(obj.from, obj.command, { error: `Invalid call: ${JSON.stringify(obj.message)}` }, obj.callback);
        return;
    }

    const errors: string[] = [];
    let successCount = 0;

    for (const { id, state, rules } of entries) {
        try {
            const converted = adapter._convertValue(state.val, id);
            if (converted === null) {
                errors.push(`${id}: Value "${state.val}" is not a number`);
                continue;
            }

            const foreignObj = await adapter.getForeignObjectAsync(id);
            const settings =
                (foreignObj &&
                    foreignObj.common &&
                    foreignObj.common.custom &&
                    foreignObj.common.custom[adapter.namespace]) ||
                {};
            const common = ((foreignObj && foreignObj.common) || {}) as Partial<ioBroker.StateCommon>;

            let value = converted;
            if (rules) {
                if (adapter._isOutsideThreshold(value, settings) || adapter._isIgnoredZero(value, settings)) {
                    continue;
                }
                value = adapter._applyRounding(value, settings);
            }

            const name = metricName.deriveMetricName(id, settings, adapter.log);
            const labels: Record<string, string> = {};
            if (common.unit) {
                labels.unit = metricName.sanitizeLabelValue(common.unit);
            }

            adapter.buffer.add({ pointId: id, metricName: name, labels, value, ts: state.ts || Date.now() });
            successCount++;
        } catch (err) {
            errors.push(`${id}: ${(err as Error).message}`);
        }
    }

    if (errors.length) {
        adapter.sendTo(
            obj.from,
            obj.command,
            { error: `${errors.length} errors happened while storing data`, errors, successCount },
            obj.callback,
        );
    } else {
        adapter.sendTo(obj.from, obj.command, { success: true, successCount, connected: true }, obj.callback);
    }
}

/**
 * Behandelt eine deleteAll-Nachricht: löscht die komplette in VictoriaMetrics
 * gespeicherte Historie eines oder mehrerer Datenpunkte (ganze Zeitreihe per
 * Label-Match - VictoriaMetrics kennt keine Einzelpunkt-Löschung, siehe README).
 *
 * @param adapter - Adapterinstanz
 * @param obj - Empfangene deleteAll-Nachricht ({id} oder [{id}, ...])
 */
export async function handleDeleteAll(adapter: Victoriametrics, obj: ioBroker.Message): Promise<void> {
    const entries = Array.isArray(obj.message) ? obj.message : [obj.message];
    const ids = entries.filter(entry => entry && entry.id).map(entry => entry.id);

    if (!ids.length) {
        adapter.sendTo(obj.from, obj.command, { error: `Invalid call: ${JSON.stringify(obj.message)}` }, obj.callback);
        return;
    }

    for (const id of ids) {
        const name = await resolveMetricName(adapter, id);
        const result = await adapter.vmClient.deleteSeries(adapter.connection, name);
        if (!result.ok) {
            adapter.sendTo(
                obj.from,
                obj.command,
                { success: false, error: result.error, connected: false },
                obj.callback,
            );
            return;
        }
    }

    adapter.sendTo(obj.from, obj.command, { success: true, connected: true }, obj.callback);
}

/**
 * Behandelt eine features-Nachricht (Capability-Discovery). Bewirbt nur, was
 * tatsächlich implementiert ist - insbesondere KEIN delete/deleteRange/update,
 * da VictoriaMetrics keine Einzelpunkt-Löschung/-Bearbeitung unterstützt und
 * Admin sonst einen Lösch-Button anzeigen würde, der nicht das tut, was er
 * verspricht.
 *
 * @param adapter - Adapterinstanz
 * @param obj - Empfangene features-Nachricht
 */
export function handleFeatures(adapter: Victoriametrics, obj: ioBroker.Message): void {
    adapter.sendTo(obj.from, obj.command, { supportedFeatures: ['storeState', 'deleteAll'] }, obj.callback);
}
