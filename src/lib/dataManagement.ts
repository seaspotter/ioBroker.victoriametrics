import { buildLabels, deriveMetricName } from './metricName';
import * as vm from './vmClient';
import type { Victoriametrics } from '../main';

/**
 * @param adapter - Adapter instance
 * @param obj - The received message
 * @param payload - Response to send back
 */
function reply(adapter: Victoriametrics, obj: ioBroker.Message, payload: object): void {
    adapter.sendTo(obj.from, obj.command, payload, obj.callback);
}

/**
 * @param adapter - Adapter instance
 * @param obj - The received message
 */
function replyInvalid(adapter: Victoriametrics, obj: ioBroker.Message): void {
    reply(adapter, obj, { error: `Invalid call: ${JSON.stringify(obj.message)}` });
}

/**
 * Answers `storeState`: writes historical points, e.g. to import old history from another source.
 * Accepts `{id, state, rules?}`, `{id, state: [...]}` or an array of these. The datapoint does not
 * have to be enabled for live history.
 *
 * `rules: true` applies the value filters and rounding. Debounce, block time and minimum change
 * are never applied: they are meant for live changes, not for backdated imports.
 *
 * @param adapter - Adapter instance
 * @param obj - The message
 */
export async function handleStoreState(adapter: Victoriametrics, obj: ioBroker.Message): Promise<void> {
    const entries = (Array.isArray(obj.message) ? obj.message : [obj.message]).flatMap(
        (entry: { id?: string; state?: ioBroker.State | ioBroker.State[]; rules?: boolean } | null) =>
            entry?.id && entry.state
                ? [entry.state]
                      .flat()
                      .filter(Boolean)
                      .map(state => ({ id: entry.id as string, state, rules: entry.rules }))
                : [],
    );
    if (!entries.length) {
        replyInvalid(adapter, obj);
        return;
    }

    const errors: string[] = [];
    let successCount = 0;

    for (const { id, state, rules } of entries) {
        try {
            const converted = adapter.convertValue(state.val, id);
            if (converted === null) {
                errors.push(`${id}: Value "${state.val}" is not a number`);
                continue;
            }

            const { settings, unit } = await adapter.getPointInfo(id);
            const value = rules ? adapter.filter.validate(converted, settings) : converted;
            if (value === null) {
                continue;
            }

            adapter.buffer.add({
                pointId: id,
                metricName: deriveMetricName(id, settings, adapter.log),
                labels: buildLabels(unit),
                value,
                ts: state.ts || Date.now(),
            });
            successCount++;
        } catch (err) {
            errors.push(`${id}: ${(err as Error).message}`);
        }
    }

    if (errors.length) {
        reply(adapter, obj, { error: `${errors.length} errors happened while storing data`, errors, successCount });
    } else {
        reply(adapter, obj, { success: true, successCount, connected: true });
    }
}

/**
 * Answers `deleteAll`: deletes the whole stored history of one or more datapoints. VictoriaMetrics
 * deletes whole time series only, so `delete`, `deleteRange` and `update` are not offered.
 *
 * @param adapter - Adapter instance
 * @param obj - The message ({id} or [{id}, ...])
 */
export async function handleDeleteAll(adapter: Victoriametrics, obj: ioBroker.Message): Promise<void> {
    const ids: string[] = (Array.isArray(obj.message) ? obj.message : [obj.message])
        .filter((entry: { id?: string } | null) => entry?.id)
        .map((entry: { id: string }) => entry.id);
    if (!ids.length) {
        replyInvalid(adapter, obj);
        return;
    }

    for (const id of ids) {
        const result = await vm.deleteSeries(adapter.connection, await adapter.metricNameOf(id));
        if (!result.ok) {
            reply(adapter, obj, { success: false, error: result.error, connected: false });
            return;
        }
    }
    reply(adapter, obj, { success: true, connected: true });
}

/**
 * Answers `features`: the supported commands.
 *
 * @param adapter - Adapter instance
 * @param obj - The message
 */
export function handleFeatures(adapter: Victoriametrics, obj: ioBroker.Message): void {
    reply(adapter, obj, { supportedFeatures: ['storeState', 'deleteAll'] });
}
