import { parseIntervalBorders, sendResponse, type GetHistoryOptions } from '@iobroker/aggregate';
import { CONFIG } from './config';
import { deriveMetricName } from './metricName';
import * as vm from './vmClient';
import type { Victoriametrics } from '../main';

/**
 * Answers a `getHistory` message. Reads raw points from VictoriaMetrics, or has it aggregate with
 * PromQL where possible, and passes them to `@iobroker/aggregate` for aggregation, gap handling and
 * the response format (the same library the history, sql and influxdb adapters use).
 *
 * @param adapter - Adapter instance
 * @param obj - The message ({id, options})
 */
export async function handleGetHistory(adapter: Victoriametrics, obj: ioBroker.Message): Promise<void> {
    const startTime = Date.now();
    const id = obj.message?.id;
    const options: GetHistoryOptions = obj.message?.options || {};

    options.end ||= Date.now();
    options.start ||= options.end - CONFIG.HISTORY_DEFAULT_RANGE_MS;
    if (!options.step) {
        options.count ||= CONFIG.HISTORY_DEFAULT_COUNT;
    }
    options.limit ||= CONFIG.HISTORY_DEFAULT_LIMIT;

    // Interval borders define the range that has to be read
    const borders = parseIntervalBorders(options.intervalBorders, options.limit);
    if (borders) {
        options.start = borders[0];
        options.end = borders[borders.length - 1];
    }

    if (id === '*') {
        await handleAllIdsHistory(adapter, obj, options, startTime);
        return;
    }
    if (!id || typeof id !== 'string') {
        sendResponse(adapter, obj, id, options, 'getHistory: no valid id given', startTime);
        return;
    }

    const name = await adapter.metricNameOf(id);

    const funcs: Record<string, string> = CONFIG.PROMQL_PUSHDOWN_FUNCS;
    const pushdownFunc =
        options.aggregate && Object.hasOwn(funcs, options.aggregate) ? funcs[options.aggregate] : undefined;
    if (pushdownFunc && !borders) {
        const points = await tryPromqlPushdown(adapter, name, options, pushdownFunc);
        if (points) {
            sendResponse(adapter, obj, id, options, points, startTime);
            return;
        }
    }

    const result = await vm.exportRange(adapter.connection, name, options.start, options.end);
    sendResponse(
        adapter,
        obj,
        id,
        options,
        result.ok ? result.points : `Reading from VictoriaMetrics failed: ${result.error}`,
        startTime,
    );
}

/**
 * Lets VictoriaMetrics aggregate with PromQL. On success `options` is changed: start/end are widened
 * by one step (clean chart borders, as on the raw-data path) and `preAggregated` makes
 * `sendResponse` only format the points.
 *
 * @param adapter - Adapter instance
 * @param name - Metric name
 * @param options - Request options, changed on success
 * @param pushdownFunc - PromQL function, e.g. `avg_over_time`
 * @returns The aggregated points, or null to fall back to the raw-data path
 */
async function tryPromqlPushdown(
    adapter: Victoriametrics,
    name: string,
    options: GetHistoryOptions,
    pushdownFunc: string,
): Promise<vm.VmPoint[] | null> {
    // Defaults are set in handleGetHistory
    const start = options.start as number;
    const end = options.end as number;
    const stepMs = options.step || (end - start) / (options.count as number);
    if (!stepMs || stepMs < 1000) {
        return null; // VictoriaMetrics has no sub-second step
    }

    const stepSeconds = Math.round(stepMs / 1000);
    const paddedStart = start - stepSeconds * 1000;
    const paddedEnd = end + stepSeconds * 1000;
    const result = await vm.queryRange(
        adapter.connection,
        `${pushdownFunc}(${name}[${stepSeconds}s])`,
        paddedStart,
        paddedEnd,
        stepSeconds * 1000,
    );
    if (!result.ok) {
        adapter.log.debug(`PromQL pushdown failed, falling back to the raw-data path: ${result.error}`);
        return null;
    }

    options.start = paddedStart;
    options.end = paddedEnd;
    options.preAggregated = true;
    return result.points;
}

/**
 * Answers `getHistory` with `id: '*'`: the latest raw values of all datapoints currently enabled in
 * Admin, each with its `id`. There is no aggregation across different metrics.
 *
 * @param adapter - Adapter instance
 * @param obj - The message
 * @param options - Request options with defaults applied
 * @param startTime - Time the message was received
 */
async function handleAllIdsHistory(
    adapter: Victoriametrics,
    obj: ioBroker.Message,
    options: GetHistoryOptions,
    startTime: number,
): Promise<void> {
    if (options.aggregate && options.aggregate !== 'onchange' && options.aggregate !== 'none') {
        adapter.log.debug(`getHistory id:'*' does not support aggregation (requested: ${options.aggregate})`);
    }

    const perId = await Promise.all(
        Array.from(adapter.enabledPoints, async ([id, settings]) => {
            const name = deriveMetricName(id, settings, adapter.log);
            const result = await vm.exportRange(
                adapter.connection,
                name,
                options.start as number,
                options.end as number,
            );
            return result.ok ? result.points.map(p => ({ ...p, id })) : [];
        }),
    );

    const limit = options.count || options.limit || CONFIG.HISTORY_DEFAULT_COUNT;
    const latest = perId
        .flat()
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit)
        .sort((a, b) => a.ts - b.ts);

    options.preAggregated = true;
    // No global id: it would overwrite the id of every point
    sendResponse(adapter, obj, undefined, options, latest, startTime);
}
