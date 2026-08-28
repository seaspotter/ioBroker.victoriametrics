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
}

module.exports = { VmClient };
