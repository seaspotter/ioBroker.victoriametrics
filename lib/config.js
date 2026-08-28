'use strict';

/*
 * Zentrale, nicht vom Nutzer konfigurierbare Konstanten des Adapters.
 * Nutzer-konfigurierbare Werte (Host, Port, Schreibintervall, ...) liegen
 * in der Instanzkonfiguration (io-package.json "native" / this.config).
 */
module.exports = {
    // VictoriaMetrics HTTP API
    VM_IMPORT_PATH: '/api/v1/import',
    VM_HEALTH_PATH: '/health',

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
