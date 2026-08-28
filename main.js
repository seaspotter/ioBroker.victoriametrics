'use strict';

const utils = require('@iobroker/adapter-core');
const CONFIG = require('./lib/config');
const metricName = require('./lib/metricName');
const { VmClient } = require('./lib/vmClient');
const { SeriesBuffer } = require('./lib/buffer');

/**
 * Parst ein optionales, aus dem Admin-UI kommendes Zahlenfeld (kann Zahl,
 * numerischer String, leerer String oder undefined sein).
 *
 * @param {string | number | undefined | null} raw - Roher Feldwert
 * @returns {number | undefined} Zahl oder undefined, wenn nicht gesetzt/ungültig
 */
function parseOptionalNumber(raw) {
    if (raw === undefined || raw === '' || raw === null) {
        return undefined;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}

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
        /** ID -> zuletzt geschriebener Wert (für changesMinDelta) */
        this.lastValues = new Map();
        /** ID -> Zeitpunkt (Date.now()) des zuletzt geschriebenen Werts (für blockTime) */
        this.lastLogTimes = new Map();
        /** ID -> aktiver Entprellungs-Timer (für debounceTime) */
        this.debounceTimers = new Map();
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
            this.lastValues.delete(id);
            this.lastLogTimes.delete(id);
            const pendingDebounce = this.debounceTimers.get(id);
            if (pendingDebounce) {
                this.clearTimeout(pendingDebounce);
                this.debounceTimers.delete(id);
            }
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

        const debounceMs = parseOptionalNumber(settings.debounceTime);
        if (debounceMs !== undefined && debounceMs > 0) {
            const pending = this.debounceTimers.get(id);
            if (pending) {
                this.clearTimeout(pending);
            }
            const timer = this.setTimeout(() => {
                this.debounceTimers.delete(id);
                this._processPoint(id, state, settings);
            }, debounceMs);
            this.debounceTimers.set(id, timer);
            return;
        }

        this._processPoint(id, state, settings);
    }

    /**
     * Wendet Schwellenwert-/Nullwert-/Rundungs-/Änderungs-/Rate-Limit-Filter an und
     * puffert den Punkt, falls er nicht herausgefiltert wird. Wird entweder direkt
     * aus onStateChange oder verzögert nach Ablauf der Entprellzeit aufgerufen.
     *
     * @param {string} id - State-ID
     * @param {ioBroker.State} state - Zustand zum Zeitpunkt der (ggf. entprellten) Änderung
     * @param {object} settings - Custom-Settings des Datenpunkts
     */
    _processPoint(id, state, settings) {
        const common = this.objectCache.get(id) || {};
        const converted = this._convertValue(state.val, id);
        if (converted === null) {
            return;
        }

        if (this._isOutsideThreshold(converted, settings)) {
            return;
        }
        if (this._isIgnoredZero(converted, settings)) {
            return;
        }

        const value = this._applyRounding(converted, settings);

        if (this._isBelowMinDelta(id, value, settings)) {
            return;
        }
        if (this._isBlockedByBlockTime(id, settings)) {
            return;
        }

        this.lastValues.set(id, value);
        this.lastLogTimes.set(id, Date.now());

        /** @type {Record<string, string>} */
        const labels = {};
        if (common.unit) {
            labels.unit = metricName.sanitizeLabelValue(common.unit);
        }

        const name = metricName.deriveMetricName(id, settings, this.log);
        this.buffer.add({ pointId: id, metricName: name, labels, value, ts: state.ts });
        this.log.debug(`Gepuffert: ${id} -> ${name}=${value} (${JSON.stringify(labels)})`);

        if (this.buffer.size() >= this.config.bufferMaxSize) {
            this.flush();
        }
    }

    /**
     * Prüft die Schwellenwerte ignoreBelowNumber/ignoreAboveNumber.
     *
     * @param {number} value - Umgewandelter Zahlenwert
     * @param {{ignoreBelowNumber?: string | number, ignoreAboveNumber?: string | number}} settings - Custom-Settings des Datenpunkts
     * @returns {boolean} true, wenn der Wert außerhalb des erlaubten Bereichs liegt
     */
    _isOutsideThreshold(value, settings) {
        const below = parseOptionalNumber(settings.ignoreBelowNumber);
        if (below !== undefined && value < below) {
            return true;
        }
        const above = parseOptionalNumber(settings.ignoreAboveNumber);
        return above !== undefined && value > above;
    }

    /**
     * Prüft, ob Nullwerte für diesen Datenpunkt ignoriert werden sollen (ignoreZero).
     *
     * @param {number} value - Umgewandelter Zahlenwert
     * @param {{ignoreZero?: boolean}} settings - Custom-Settings des Datenpunkts
     * @returns {boolean} true, wenn der Wert übersprungen werden soll
     */
    _isIgnoredZero(value, settings) {
        return !!settings.ignoreZero && value === 0;
    }

    /**
     * Rundet den Wert auf die im Historie-Tab konfigurierte Anzahl Nachkommastellen,
     * sofern gesetzt.
     *
     * @param {number} value - Umgewandelter Zahlenwert
     * @param {{round?: string | number}} settings - Custom-Settings des Datenpunkts
     * @returns {number} Ggf. gerundeter Wert
     */
    _applyRounding(value, settings) {
        const decimals = parseOptionalNumber(settings.round);
        if (decimals === undefined || decimals < 0) {
            return value;
        }
        const factor = 10 ** decimals;
        return Math.round(value * factor) / factor;
    }

    /**
     * Prüft, ob der neue Wert sich vom zuletzt geschriebenen Wert um weniger als die
     * konfigurierte Mindestdifferenz (changesMinDelta) unterscheidet und deshalb
     * übersprungen werden soll. Der allererste Wert eines Datenpunkts wird nie
     * übersprungen.
     *
     * @param {string} id - Objekt-ID
     * @param {number} value - Neuer (bereits gerundeter) Wert
     * @param {{changesMinDelta?: string | number}} settings - Custom-Settings des Datenpunkts
     * @returns {boolean} true, wenn der Wert übersprungen werden soll
     */
    _isBelowMinDelta(id, value, settings) {
        const minDelta = parseOptionalNumber(settings.changesMinDelta);
        if (minDelta === undefined || minDelta <= 0) {
            return false;
        }
        const last = this.lastValues.get(id);
        return last !== undefined && Math.abs(value - last) < minDelta;
    }

    /**
     * Prüft die Blockzeit (blockTime): ignoriert neue Werte für die konfigurierte
     * Zeitspanne nach dem zuletzt geschriebenen Wert dieses Datenpunkts.
     *
     * @param {string} id - Objekt-ID
     * @param {{blockTime?: string | number}} settings - Custom-Settings des Datenpunkts
     * @returns {boolean} true, wenn der Wert übersprungen werden soll
     */
    _isBlockedByBlockTime(id, settings) {
        const blockMs = parseOptionalNumber(settings.blockTime);
        if (blockMs === undefined || blockMs <= 0) {
            return false;
        }
        const last = this.lastLogTimes.get(id);
        return last !== undefined && Date.now() - last < blockMs;
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
            this.log.debug(`${points.length} Punkt(e) erfolgreich nach VictoriaMetrics geschrieben`);
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
            await this.writeFileAsync(`${this.namespace}.cache`, CONFIG.CACHE_FILE_NAME, JSON.stringify(data));
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
            const result = await this.readFileAsync(`${this.namespace}.cache`, CONFIG.CACHE_FILE_NAME);
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
