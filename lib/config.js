'use strict';

/*
 * Zentrale, nicht vom Nutzer konfigurierbare Konstanten des Adapters.
 * Nutzer-konfigurierbare Werte (Host, Port, Schreibintervall, ...) liegen
 * in der Instanzkonfiguration (io-package.json "native" / this.config).
 */
module.exports = {
    // VictoriaMetrics HTTP API
    VM_IMPORT_PATH: '/api/v1/import',
    VM_EXPORT_PATH: '/api/v1/export',
    VM_QUERY_RANGE_PATH: '/api/v1/query_range',
    VM_HEALTH_PATH: '/health',
    VM_FLAGS_PATH: '/flags',
    VM_DELETE_SERIES_PATH: '/api/v1/admin/tsdb/delete_series',

    // Phase 2 (getHistory): Standard-Zeitraum, wenn weder start noch end übergeben wurden
    HISTORY_DEFAULT_RANGE_MS: 7 * 24 * 60 * 60 * 1000,
    // Default für options.count, falls weder step noch count übergeben wurden (@iobroker/aggregate
    // berechnet daraus den Bucket-step und crasht bei fehlendem count mit "Invalid array length: NaN")
    HISTORY_DEFAULT_COUNT: 500,
    // Default für options.limit, falls nicht übergeben (deckelt die interne Puffergröße von @iobroker/aggregate)
    HISTORY_DEFAULT_LIMIT: 2000,
    // aggregate-Methoden, die per PromQL/MetricsQL serverseitig in VictoriaMetrics berechnet
    // werden können (analog zu influxdb's InfluxQL-GROUP-BY-Pushdown) statt Rohdaten zu
    // exportieren und in @iobroker/aggregate JS-seitig zu aggregieren. onchange/none/minmax/
    // percentile/quantile/integral bleiben bewusst beim Rohdaten-Pfad.
    PROMQL_PUSHDOWN_FUNCS: {
        average: 'avg_over_time',
        min: 'min_over_time',
        max: 'max_over_time',
        total: 'sum_over_time',
        count: 'count_over_time',
    },

    // Puffer-/Retry-Verhalten (siehe README, Abschnitt "Verbindungsabbruch")
    MAX_ERROR_COUNT: 10,

    // Ab wie vielen aktivierten Datenpunkten auf alle States statt einzeln subscribed wird
    SUBSCRIBE_THRESHOLD: 20,

    // Persistenter Zwischenspeicher für ungeschriebene Punkte (ioBroker-Adapter-Dateispeicher)
    CACHE_FILE_NAME: 'buffer_cache.json',
    CACHE_FORMAT_VERSION: 1,
    PERSIST_ON_FAILURE_MIN_INTERVAL_MS: 60_000,

    // Prometheus-/VictoriaMetrics-konformer Metrikname: ^[a-zA-Z_:][a-zA-Z0-9_:]*$
    METRIC_NAME_REGEX: /^[a-zA-Z_:][a-zA-Z0-9_:]*$/,
    METRIC_NAME_FALLBACK: 'metric_unnamed',

    // Boolean-Werte werden als 0.0/1.0 geschrieben (Prometheus-Konvention)
    BOOL_TRUE: 1.0,
    BOOL_FALSE: 0.0,

    // Label-Werte werden auf diese Länge gekappt
    LABEL_VALUE_MAX_LEN: 128,
};
