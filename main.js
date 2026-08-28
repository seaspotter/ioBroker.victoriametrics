'use strict';

const utils = require('@iobroker/adapter-core');
const CONFIG = require('./lib/config');
const metricName = require('./lib/metricName');
const { VmClient } = require('./lib/vmClient');
const { SeriesBuffer } = require('./lib/buffer');

class Victoriametrics extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    constructor(options) {
        super({
            ...options,
            name: 'victoriametrics',
        });

        /** Aktivierte Datenpunkte: ID -> Custom-Settings */
        this.enabledPoints = new Map();
        /** ID -> object.common (für type/unit) */
        this.objectCache = new Map();
        /** Fehlerzähler pro Punkt-ID */
        this.errorPoints = {};
        this.subscribedAll = false;
        this.lastPersistOnFailure = 0;
        this.flushTimer = null;
        this.vmClient = new VmClient(this.log);
        this.buffer = new SeriesBuffer();

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        if (!this.config.host) {
            this.log.error('Kein Host für VictoriaMetrics konfiguriert - Adapter wird beendet');
            return;
        }

        await this._loadCache();

        const health = await this.vmClient.testHealth(this.config);
        if (health.ok) {
            this.log.info(
                `VictoriaMetrics unter ${this.config.protocol}://${this.config.host}:${this.config.port} erreichbar`,
            );
        } else {
            this.log.warn(
                `VictoriaMetrics beim Start nicht erreichbar (${health.error}) - Werte werden bis zur Wiederverbindung gepuffert`,
            );
        }
        await this.setState('info.connection', health.ok, true);

        await this._loadEnabledPoints();
        await this._setupSubscriptions();
        this.subscribeForeignObjects('*');

        this.flushTimer = this.setInterval(() => this.flush(), this.config.writeInterval * 1000);
    }

    /**
     * Liest alle Objekte mit aktivierten Custom-Settings für diesen Adapter
     * (system/custom-View) und füllt enabledPoints/objectCache.
     */
    async _loadEnabledPoints() {
        const result = await this.getObjectViewAsync('system', 'custom', {});
        for (const row of result.rows) {
            const settings = row.value && row.value[this.namespace];
            if (settings && settings.enabled) {
                await this._registerEnabledPoint(row.id, settings);
            }
        }
        this.log.info(`${this.enabledPoints.size} Datenpunkt(e) für Historisierung in VictoriaMetrics aktiviert`);
    }

    /**
     * @param {string} id - ioBroker-Objekt-ID
     * @param {{enabled: boolean, aliasId?: string}} settings - Custom-Settings dieses Adapters für das Objekt
     */
    async _registerEnabledPoint(id, settings) {
        this.enabledPoints.set(id, settings);
        const obj = await this.getForeignObjectAsync(id);
        this.objectCache.set(id, (obj && obj.common) || {});
    }

    /**
     * Wählt die Subscription-Strategie einmalig anhand der Anzahl aktivierter
     * Datenpunkte beim Start (siehe README, Abschnitt Architektur).
     */
    async _setupSubscriptions() {
        if (this.enabledPoints.size <= CONFIG.SUBSCRIBE_THRESHOLD) {
            for (const id of this.enabledPoints.keys()) {
                this.subscribeForeignStates(id);
            }
        } else {
            this.subscribedAll = true;
            this.subscribeForeignStates('*');
        }
    }

    /**
     * Is called if a subscribed object changes (immer auf '*' subscribed,
     * um Änderungen an den Custom-Settings live zu erkennen).
     *
     * @param {string} id - Objekt-ID
     * @param {ioBroker.Object | null | undefined} obj - Neuer Objektstand oder null bei Löschung
     */
    onObjectChange(id, obj) {
        const settings = obj && obj.common && obj.common.custom && obj.common.custom[this.namespace];
        const wasEnabled = this.enabledPoints.has(id);
        const isEnabled = !!(settings && settings.enabled);

        if (isEnabled) {
            this.enabledPoints.set(id, settings);
            this.objectCache.set(id, obj.common);
            if (!wasEnabled && !this.subscribedAll) {
                this.subscribeForeignStates(id);
            }
        } else if (wasEnabled) {
            this.enabledPoints.delete(id);
            this.objectCache.delete(id);
            if (!this.subscribedAll) {
                this.unsubscribeForeignStates(id);
            }
        }
    }

    /**
     * Is called if a subscribed state changes.
     *
     * @param {string} id - State-ID
     * @param {ioBroker.State | null | undefined} state - Neuer Zustand oder null bei Löschung/Ablauf
     */
    onStateChange(id, state) {
        if (!state || state.val === null || state.val === undefined) {
            return;
        }
        const settings = this.enabledPoints.get(id);
        if (!settings) {
            return;
        }

        const common = this.objectCache.get(id) || {};
        const value = this._convertValue(state.val, id);
        if (value === null) {
            return;
        }

        /** @type {Record<string, string>} */
        const labels = {};
        if (common.unit) {
            labels.unit = metricName.sanitizeLabelValue(common.unit);
        }

        this.buffer.add({
            pointId: id,
            metricName: metricName.deriveMetricName(id, settings, this.log),
            labels,
            value,
            ts: state.ts,
        });

        if (this.buffer.size() >= this.config.bufferMaxSize) {
            this.flush();
        }
    }

    /**
     * Konvertiert einen ioBroker-Zustandswert in eine für VictoriaMetrics
     * schreibbare Zahl. Booleans werden zu 0.0/1.0, Strings werden als Zahl
     * geparst, nicht parsbare/andere Typen werden übersprungen.
     *
     * @param {ioBroker.StateValue} val - Roher Zustandswert
     * @param {string} id - Objekt-ID (nur für die Log-Meldung)
     * @returns {number | null} Numerischer Wert oder null, wenn der Punkt übersprungen werden soll
     */
    _convertValue(val, id) {
        if (typeof val === 'number') {
            if (Number.isFinite(val)) {
                return val;
            }
            this.log.warn(`Wert von ${id} ist keine endliche Zahl (${val}) und wird übersprungen`);
            return null;
        }
        if (typeof val === 'boolean') {
            return val ? CONFIG.BOOL_TRUE : CONFIG.BOOL_FALSE;
        }
        if (typeof val === 'string') {
            const num = Number(val.trim());
            if (val.trim() !== '' && Number.isFinite(num)) {
                return num;
            }
            this.log.warn(`Wert von ${id} ("${val}") ist keine Zahl und wird übersprungen`);
            return null;
        }
        this.log.warn(`Wert von ${id} hat einen nicht unterstützten Typ (${typeof val}) und wird übersprungen`);
        return null;
    }

    /**
     * Sammelt gepufferte Punkte, gruppiert sie nach Metrik+Labels und
     * schreibt sie als newline-delimited JSON an VictoriaMetrics. Bei
     * Fehlschlag greift die Fehlerzähler-Retry-Policy.
     */
    async flush() {
        if (!this.buffer || this.buffer.size() === 0) {
            return;
        }

        const points = this.buffer.drainAll();
        const body = this._buildImportBody(points);
        const result = await this.vmClient.writeBatch(this.config, body);

        if (result.ok) {
            for (const point of points) {
                this.errorPoints[point.pointId] = 0;
            }
            await this.setState('info.connection', true, true);
        } else {
            this.log.warn(
                `Schreiben von ${points.length} Punkt(en) nach VictoriaMetrics fehlgeschlagen: ${result.error}`,
            );
            await this.setState('info.connection', false, true);
            this._applyRetryPolicy(points);
            await this._persistOnFailure();
        }
    }

    /**
     * Gruppiert Punkte nach (Metrikname + Labels) und baut daraus den
     * newline-delimited-JSON-Body für /api/v1/import.
     *
     * @param {import('./lib/buffer').BufferedPoint[]} points - Zu schreibende Punkte
     * @returns {string} NDJSON-Body
     */
    _buildImportBody(points) {
        const groups = new Map();
        for (const point of points) {
            const key = `${point.metricName}|${JSON.stringify(point.labels)}`;
            let group = groups.get(key);
            if (!group) {
                group = { metric: { __name__: point.metricName, ...point.labels }, values: [], timestamps: [] };
                groups.set(key, group);
            }
            group.values.push(point.value);
            group.timestamps.push(point.ts);
        }
        return Array.from(groups.values())
            .map(line => JSON.stringify(line))
            .join('\n');
    }

    /**
     * Erhöht den Fehlerzähler jedes Punkts aus einem fehlgeschlagenen Batch.
     * Punkte unter dem Limit werden erneut gepuffert (ohne Größenbegrenzung),
     * Punkte am Limit werden verworfen und ihr Zähler zurückgesetzt.
     *
     * @param {import('./lib/buffer').BufferedPoint[]} points - Punkte des fehlgeschlagenen Batches
     */
    _applyRetryPolicy(points) {
        for (const point of points) {
            this.errorPoints[point.pointId] = (this.errorPoints[point.pointId] || 0) + 1;
            if (this.errorPoints[point.pointId] < CONFIG.MAX_ERROR_COUNT) {
                this.buffer.add(point);
            } else {
                this.log.warn(`Verwerfe Punkt für ${point.pointId} nach ${CONFIG.MAX_ERROR_COUNT} Fehlversuchen`);
                this.errorPoints[point.pointId] = 0;
            }
        }
    }

    /**
     * Persistiert den Puffer als Absicherung gegen einen harten Absturz
     * (kein sauberer onUnload), gedrosselt auf höchstens einmal pro Minute.
     */
    async _persistOnFailure() {
        const now = Date.now();
        if (now - this.lastPersistOnFailure < CONFIG.PERSIST_ON_FAILURE_MIN_INTERVAL_MS) {
            return;
        }
        this.lastPersistOnFailure = now;
        await this._persistCache();
    }

    /**
     * Schreibt den aktuellen Pufferinhalt in den ioBroker-Adapter-Dateispeicher.
     */
    async _persistCache() {
        try {
            const data = this.buffer.toJSON(CONFIG.CACHE_FORMAT_VERSION);
            await this.writeFileAsync(this.namespace, CONFIG.CACHE_FILE_NAME, JSON.stringify(data));
        } catch (err) {
            this.log.debug(`Konnte Puffer-Cache nicht schreiben: ${err.message}`);
        }
    }

    /**
     * Lädt beim Start einen zuvor persistierten Puffer (falls vorhanden) und
     * leert die Cache-Datei danach wieder. Fehlerzähler starten bei 0.
     */
    async _loadCache() {
        try {
            const result = await this.readFileAsync(this.namespace, CONFIG.CACHE_FILE_NAME);
            const raw = result && result.file;
            const data = JSON.parse(raw ? raw.toString() : '{}');
            const loaded = SeriesBuffer.fromJSON(data, CONFIG.CACHE_FORMAT_VERSION);
            const points = loaded.drainAll();
            if (points.length) {
                this.buffer.requeue(points);
                this.log.info(`${points.length} gepufferte Punkte aus vorherigem Lauf geladen`);
            }
            await this._persistCache();
        } catch {
            this.log.debug('Kein Puffer-Cache aus vorherigem Lauf gefunden');
        }
    }

    /**
     * Some message was sent to this instance over message box (Verwendet für den
     * Verbindungstest-Button im Admin-UI).
     *
     * @param {ioBroker.Message} obj - Empfangene Nachricht
     */
    async onMessage(obj) {
        if (obj.command !== 'testConnection') {
            return;
        }

        const cfg = obj.message && obj.message.config;
        if (!cfg || !cfg.host) {
            this.sendTo(obj.from, obj.command, { error: 'Ungültige Verbindungsdaten' }, obj.callback);
            return;
        }

        const testCfg = { ...cfg, password: decodeURIComponent(cfg.password || '') };
        const result = await this.vmClient.testHealth(testCfg);
        this.sendTo(obj.from, obj.command, { error: result.ok ? null : result.error }, obj.callback);
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback - Callback function
     */
    onUnload(callback) {
        try {
            if (this.flushTimer) {
                this.clearInterval(this.flushTimer);
                this.flushTimer = null;
            }
            if (this.buffer && this.buffer.size() > 0) {
                // Best-effort, synchron auf den Abschluss warten ist beim Unload nicht garantiert möglich -
                // wir stoßen das Schreiben an, ohne den Callback zu verzögern.
                this._persistCache().finally(() => callback());
            } else {
                callback();
            }
        } catch (error) {
            this.log.error(`Fehler beim Beenden des Adapters: ${error.message}`);
            callback();
        }
    }
}

if (require.main !== module) {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    module.exports = options => new Victoriametrics(options);
} else {
    new Victoriametrics();
}
