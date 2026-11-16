/** Fixed constants of the adapter. User settings live in the instance config. */
export const CONFIG = {
    // VictoriaMetrics HTTP API
    VM_IMPORT_PATH: '/api/v1/import',
    VM_EXPORT_PATH: '/api/v1/export',
    VM_QUERY_RANGE_PATH: '/api/v1/query_range',
    VM_HEALTH_PATH: '/health',
    VM_FLAGS_PATH: '/flags',
    VM_DELETE_SERIES_PATH: '/api/v1/admin/tsdb/delete_series',

    // getHistory defaults. @iobroker/aggregate needs `count` (or `step`) and caps its buffer with `limit`.
    HISTORY_DEFAULT_RANGE_MS: 7 * 24 * 60 * 60 * 1000,
    HISTORY_DEFAULT_COUNT: 500,
    HISTORY_DEFAULT_LIMIT: 2000,
    // Aggregates that VictoriaMetrics computes itself (PromQL pushdown); all others use the raw-data path
    PROMQL_PUSHDOWN_FUNCS: {
        average: 'avg_over_time',
        min: 'min_over_time',
        max: 'max_over_time',
        total: 'sum_over_time',
        count: 'count_over_time',
    },

    // Points of a failed batch are re-buffered until a point failed this many times
    MAX_ERROR_COUNT: 10,

    DEFAULT_WRITE_INTERVAL_S: 10,
    DEFAULT_REQUEST_TIMEOUT_MS: 5000,

    // Above this number of enabled datapoints the adapter subscribes to all states instead of each one
    SUBSCRIBE_THRESHOLD: 20,

    // Buffer persisted in the adapter's file storage
    CACHE_FILE_NAME: 'buffer_cache.json',
    CACHE_FORMAT_VERSION: 1,
    PERSIST_ON_FAILURE_MIN_INTERVAL_MS: 60_000,
} as const;

/** Longest delay that setTimeout/setInterval accept (2^31 - 1 ms); larger values fire immediately. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Validates a configured duration.
 *
 * @param raw - Configured value in ms
 * @returns The value if it is a positive number a timer can handle, otherwise undefined
 */
export function validTimerMs(raw: unknown): number | undefined {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 && n <= MAX_TIMER_MS ? n : undefined;
}
