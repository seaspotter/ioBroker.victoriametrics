import axios, { type AxiosError } from 'axios';
import { CONFIG, validTimerMs } from './config';

/** Connection settings: the adapter config, or unsaved form data of the connection test. */
export interface ConnectionConfig {
    protocol: string;
    host: string;
    port: number;
    useAuth?: boolean;
    username?: string;
    password?: string;
    requestTimeout?: number;
}

/** A point of a time series. */
export interface VmPoint {
    ts: number;
    val: number;
}

/** Result of a request: `ok` plus the data, or the sanitized error. */
export type VmResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Reduces an axios error to a short message; never includes the authorization header or password.
 *
 * @param err - Error of an axios request
 * @returns Safe error summary
 */
export function sanitizeError(err: AxiosError): string {
    if (err.response) {
        const body = typeof err.response.data === 'string' ? err.response.data.slice(0, 200) : '';
        return `HTTP ${err.response.status}${body ? `: ${body}` : ''}`;
    }
    return err.code ? `${err.code}: ${err.message}` : err.message || String(err);
}

/**
 * @param cfg - Connection settings
 * @returns The axios options
 */
function requestOptions(cfg: ConnectionConfig): {
    baseURL: string;
    timeout: number;
    auth?: { username: string; password: string };
} {
    return {
        baseURL: `${cfg.protocol}://${cfg.host}:${cfg.port}`,
        timeout: validTimerMs(cfg.requestTimeout) ?? CONFIG.DEFAULT_REQUEST_TIMEOUT_MS,
        ...(cfg.useAuth && { auth: { username: cfg.username || '', password: cfg.password || '' } }),
    };
}

/**
 * Runs a request and turns an error into a result.
 *
 * @param request - The request
 * @returns The data of the request, or the sanitized error
 */
async function run<T extends object>(request: () => Promise<T>): Promise<VmResult<T>> {
    try {
        return { ok: true, ...(await request()) };
    } catch (err) {
        return { ok: false, error: sanitizeError(err as AxiosError) };
    }
}

/**
 * Checks that VictoriaMetrics is reachable (`/health`).
 *
 * @param cfg - Connection settings
 * @returns Result of the check
 */
export function testHealth(cfg: ConnectionConfig): Promise<VmResult> {
    return run(async () => {
        await axios.get(CONFIG.VM_HEALTH_PATH, requestOptions(cfg));
        return {};
    });
}

/**
 * Writes points as newline-delimited JSON to `/api/v1/import`.
 *
 * @param cfg - Connection settings
 * @param ndjsonBody - Newline-delimited JSON payload
 * @returns Result of the write
 */
export function writeBatch(cfg: ConnectionConfig, ndjsonBody: string): Promise<VmResult> {
    return run(async () => {
        await axios.post(CONFIG.VM_IMPORT_PATH, ndjsonBody, {
            ...requestOptions(cfg),
            headers: { 'Content-Type': 'application/json' },
            // axios would JSON.parse a string body for this content type and, for multi-line NDJSON,
            // fail and re-encode it as one quoted string. Send the body unchanged.
            transformRequest: [(data: unknown) => data],
        });
        return {};
    });
}

/**
 * Reads the raw points of a metric (`/api/v1/export`). Series of the same metric with different
 * labels (e.g. a changed unit) are merged and sorted by time.
 *
 * @param cfg - Connection settings
 * @param metricName - Normalized metric name
 * @param startMs - Start of the range in ms
 * @param endMs - End of the range in ms
 * @returns The points
 */
export function exportRange(
    cfg: ConnectionConfig,
    metricName: string,
    startMs: number,
    endMs: number,
): Promise<VmResult<{ points: VmPoint[] }>> {
    return run(async () => {
        const response = await axios.get(CONFIG.VM_EXPORT_PATH, {
            ...requestOptions(cfg),
            params: { 'match[]': metricName, start: Math.floor(startMs / 1000), end: Math.ceil(endMs / 1000) },
            responseType: 'text',
        });

        const points: VmPoint[] = [];
        for (const line of String(response.data).split('\n')) {
            if (line.trim()) {
                const { values = [], timestamps = [] } = JSON.parse(line) as {
                    values?: number[];
                    timestamps?: number[];
                };
                values.forEach((val, i) => points.push({ ts: timestamps[i], val }));
            }
        }
        return { points: points.sort((a, b) => a.ts - b.ts) };
    });
}

/**
 * Runs a PromQL range query (`/api/v1/query_range`); returns the same point shape as `exportRange`.
 *
 * @param cfg - Connection settings
 * @param promqlQuery - Query, e.g. `avg_over_time(metric[60s])`
 * @param startMs - Start of the range in ms
 * @param endMs - End of the range in ms
 * @param stepMs - Step in ms
 * @returns The points
 */
export function queryRange(
    cfg: ConnectionConfig,
    promqlQuery: string,
    startMs: number,
    endMs: number,
    stepMs: number,
): Promise<VmResult<{ points: VmPoint[] }>> {
    return run(async () => {
        const response = await axios.get<{ data?: { result?: { values?: [number, string][] }[] } }>(
            CONFIG.VM_QUERY_RANGE_PATH,
            {
                ...requestOptions(cfg),
                params: {
                    query: promqlQuery,
                    start: Math.floor(startMs / 1000),
                    end: Math.ceil(endMs / 1000),
                    step: `${Math.max(1, Math.round(stepMs / 1000))}s`,
                },
            },
        );

        const points: VmPoint[] = [];
        for (const series of response.data?.data?.result ?? []) {
            for (const [seconds, value] of series.values ?? []) {
                points.push({ ts: seconds * 1000, val: parseFloat(value) });
            }
        }
        return { points: points.sort((a, b) => a.ts - b.ts) };
    });
}

/**
 * Reads the retention from `/flags` (plain text). Read-only: it is a server start flag.
 *
 * @param cfg - Connection settings
 * @returns The retention, e.g. `100y`; undefined if the flag is not listed
 */
export function getRetention(cfg: ConnectionConfig): Promise<VmResult<{ retention?: string }>> {
    return run(async () => {
        const response = await axios.get(CONFIG.VM_FLAGS_PATH, { ...requestOptions(cfg), responseType: 'text' });
        return { retention: String(response.data).match(/^-retentionPeriod="?([^"\n]*)"?$/m)?.[1] };
    });
}

/**
 * Deletes a whole time series (`/api/v1/admin/tsdb/delete_series`). VictoriaMetrics cannot delete single points.
 *
 * @param cfg - Connection settings
 * @param metricName - Normalized metric name
 * @returns Result of the deletion
 */
export function deleteSeries(cfg: ConnectionConfig, metricName: string): Promise<VmResult> {
    return run(async () => {
        await axios.post(CONFIG.VM_DELETE_SERIES_PATH, null, {
            ...requestOptions(cfg),
            params: { 'match[]': metricName },
        });
        return {};
    });
}
