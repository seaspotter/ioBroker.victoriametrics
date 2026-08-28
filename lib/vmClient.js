'use strict';

const axios = require('axios');
const CONFIG = require('./config');

/**
 * Dünner HTTP-Client für die native VictoriaMetrics-Schreib-API.
 * Kennt weder Puffer noch Retry-Policy - das lebt in main.js.
 */
class VmClient {
    /**
     * @param {ioBroker.Log} log - Adapter-Logger
     */
    constructor(log) {
        this.log = log;
    }

    /**
     * Baut die Basis-URL und ggf. Basic-Auth-Optionen aus einer Konfiguration
     * (entweder this.config des Adapters oder ungespeicherte Formulardaten
     * aus dem Verbindungstest-Button).
     *
     * @param {{protocol: string, host: string, port: number, useAuth?: boolean, username?: string, password?: string, requestTimeout?: number}} cfg - Verbindungskonfiguration
     * @returns {{baseURL: string, timeout: number, auth?: {username: string, password: string}}} axios-Request-Optionen
     */
    _buildRequestOptions(cfg) {
        const options = {
            baseURL: `${cfg.protocol}://${cfg.host}:${cfg.port}`,
            timeout: cfg.requestTimeout || 5000,
        };
        if (cfg.useAuth) {
            options.auth = { username: cfg.username || '', password: cfg.password || '' };
        }
        return options;
    }

    /**
     * Entfernt sensible/redundante Details aus einem axios-Fehler, bevor er
     * geloggt wird (niemals Authorization-Header oder Passwort loggen).
     *
     * @param {import('axios').AxiosError} err - Fehler aus einem axios-Request
     * @returns {string} Kurze, sichere Fehlerzusammenfassung
     */
    sanitizeError(err) {
        if (err.response) {
            const body = typeof err.response.data === 'string' ? err.response.data.slice(0, 200) : '';
            return `HTTP ${err.response.status}${body ? `: ${body}` : ''}`;
        }
        if (err.code) {
            return `${err.code}: ${err.message}`;
        }
        return err.message || String(err);
    }

    /**
     * Prüft die Erreichbarkeit von VictoriaMetrics über den /health-Endpunkt.
     *
     * @param {{protocol: string, host: string, port: number, useAuth?: boolean, username?: string, password?: string, requestTimeout?: number}} cfg - Verbindungskonfiguration
     * @returns {Promise<{ok: boolean, error?: string}>} Ergebnis des Health-Checks
     */
    async testHealth(cfg) {
        try {
            const response = await axios.get(CONFIG.VM_HEALTH_PATH, this._buildRequestOptions(cfg));
            return { ok: response.status === 200 };
        } catch (err) {
            return { ok: false, error: this.sanitizeError(err) };
        }
    }

    /**
     * Schreibt einen Batch von Punkten als newline-delimited JSON an
     * VictoriaMetrics' /api/v1/import.
     *
     * @param {{protocol: string, host: string, port: number, useAuth?: boolean, username?: string, password?: string, requestTimeout?: number}} cfg - Verbindungskonfiguration
     * @param {string} ndjsonBody - Newline-delimited JSON-Payload
     * @returns {Promise<{ok: boolean, error?: string}>} Ergebnis des Schreibversuchs
     */
    async writeBatch(cfg, ndjsonBody) {
        try {
            await axios.post(CONFIG.VM_IMPORT_PATH, ndjsonBody, {
                ...this._buildRequestOptions(cfg),
                headers: { 'Content-Type': 'application/json' },
                // Der Body ist bereits fertig formatiertes newline-delimited JSON (ein oder
                // mehrere Zeilen). axios' Standard-Transform versucht bei
                // Content-Type: application/json, String-Payloads per JSON.parse zu
                // validieren und im Fehlerfall per JSON.stringify neu zu kodieren - das
                // zerstört mehrzeilige NDJSON-Bodies (JSON.parse schlägt fehl, danach wird
                // der gesamte String nochmal in Anführungszeichen gepackt). Transform
                // deaktivieren, damit der Body unverändert gesendet wird.
                transformRequest: [data => data],
            });
            return { ok: true };
        } catch (err) {
            return { ok: false, error: this.sanitizeError(err) };
        }
    }

    /**
     * Liest rohe (unaggregierte) Datenpunkte einer Metrik über VictoriaMetrics'
     * /api/v1/export. Führt Punkte aus mehreren zurückgegebenen Zeitreihen
     * (z.B. wenn sich das unit-Label über die Zeit geändert hat) zu einer nach
     * Zeitstempel aufsteigend sortierten Liste zusammen.
     *
     * @param {{protocol: string, host: string, port: number, useAuth?: boolean, username?: string, password?: string, requestTimeout?: number}} cfg - Verbindungskonfiguration
     * @param {string} metricName - Normalisierter Metrikname (__name__)
     * @param {number} startMs - Beginn des Zeitraums in Millisekunden
     * @param {number} endMs - Ende des Zeitraums in Millisekunden
     * @returns {Promise<{ok: boolean, points?: {ts: number, val: number}[], error?: string}>} Ergebnis
     */
    async exportRange(cfg, metricName, startMs, endMs) {
        try {
            const response = await axios.get(CONFIG.VM_EXPORT_PATH, {
                ...this._buildRequestOptions(cfg),
                params: {
                    'match[]': metricName,
                    start: Math.floor(startMs / 1000),
                    end: Math.ceil(endMs / 1000),
                },
                responseType: 'text',
            });

            /** @type {{ts: number, val: number}[]} */
            const points = [];
            for (const line of String(response.data).split('\n')) {
                if (!line.trim()) {
                    continue;
                }
                const series = JSON.parse(line);
                const values = series.values || [];
                const timestamps = series.timestamps || [];
                for (let i = 0; i < values.length; i++) {
                    points.push({ ts: timestamps[i], val: values[i] });
                }
            }
            points.sort((a, b) => a.ts - b.ts);

            return { ok: true, points };
        } catch (err) {
            return { ok: false, error: this.sanitizeError(err) };
        }
    }

    /**
     * Führt eine PromQL/MetricsQL-Range-Query gegen VictoriaMetrics' /api/v1/query_range aus
     * (JSON-Antwort im Prometheus-API-Format). Wird für serverseitig vorab aggregierte
     * getHistory-Anfragen genutzt (siehe lib/history.js, PROMQL_PUSHDOWN_FUNCS) - liefert
     * dieselbe Punktform wie exportRange, damit beide Pfade gleich weiterverarbeitet werden
     * können.
     *
     * @param {{protocol: string, host: string, port: number, useAuth?: boolean, username?: string, password?: string, requestTimeout?: number}} cfg - Verbindungskonfiguration
     * @param {string} promqlQuery - Fertige PromQL/MetricsQL-Query, z.B. "avg_over_time(metric[60s])"
     * @param {number} startMs - Beginn des Zeitraums in Millisekunden
     * @param {number} endMs - Ende des Zeitraums in Millisekunden
     * @param {number} stepMs - Schrittweite in Millisekunden
     * @returns {Promise<{ok: boolean, points?: {ts: number, val: number}[], error?: string}>} Ergebnis
     */
    async queryRange(cfg, promqlQuery, startMs, endMs, stepMs) {
        try {
            const response = await axios.get(CONFIG.VM_QUERY_RANGE_PATH, {
                ...this._buildRequestOptions(cfg),
                params: {
                    query: promqlQuery,
                    start: Math.floor(startMs / 1000),
                    end: Math.ceil(endMs / 1000),
                    step: `${Math.max(1, Math.round(stepMs / 1000))}s`,
                },
            });

            /** @type {{ts: number, val: number}[]} */
            const points = [];
            const series = (response.data && response.data.data && response.data.data.result) || [];
            for (const s of series) {
                for (const [tsSeconds, valStr] of s.values || []) {
                    points.push({ ts: tsSeconds * 1000, val: parseFloat(valStr) });
                }
            }
            points.sort((a, b) => a.ts - b.ts);

            return { ok: true, points };
        } catch (err) {
            return { ok: false, error: this.sanitizeError(err) };
        }
    }

    /**
     * Liest die aktuell konfigurierte Retention über VictoriaMetrics' /flags-Endpunkt
     * (Klartext, kein JSON) aus. Read-only: VM's Retention ist ein Server-Start-Flag,
     * lässt sich nicht per API setzen/ändern.
     *
     * @param {{protocol: string, host: string, port: number, useAuth?: boolean, username?: string, password?: string, requestTimeout?: number}} cfg - Verbindungskonfiguration
     * @returns {Promise<{ok: boolean, retention?: string, error?: string}>} Ergebnis
     */
    async getRetention(cfg) {
        try {
            const response = await axios.get(CONFIG.VM_FLAGS_PATH, {
                ...this._buildRequestOptions(cfg),
                responseType: 'text',
            });
            const match = String(response.data).match(/^-retentionPeriod="?([^"\n]*)"?$/m);
            return { ok: true, retention: match ? match[1] : undefined };
        } catch (err) {
            return { ok: false, error: this.sanitizeError(err) };
        }
    }

    /**
     * Löscht eine komplette Zeitreihe (alle Werte) für eine Metrik über
     * VictoriaMetrics' /api/v1/admin/tsdb/delete_series. VM kennt keine
     * Einzelpunkt-Löschung, nur ganze Zeitreihen per Label-Match.
     *
     * @param {{protocol: string, host: string, port: number, useAuth?: boolean, username?: string, password?: string, requestTimeout?: number}} cfg - Verbindungskonfiguration
     * @param {string} metricName - Normalisierter Metrikname (__name__)
     * @returns {Promise<{ok: boolean, error?: string}>} Ergebnis
     */
    async deleteSeries(cfg, metricName) {
        try {
            await axios.post(CONFIG.VM_DELETE_SERIES_PATH, null, {
                ...this._buildRequestOptions(cfg),
                params: { 'match[]': metricName },
            });
            return { ok: true };
        } catch (err) {
            return { ok: false, error: this.sanitizeError(err) };
        }
    }
}

module.exports = { VmClient };
