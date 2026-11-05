import * as os from 'node:os';
import * as utils from '@iobroker/adapter-core';
import { CONFIG } from './lib/config';
import * as metricName from './lib/metricName';
import { VmClient, type ConnectionConfig } from './lib/vmClient';
import { SeriesBuffer, type BufferedPoint } from './lib/buffer';
import { handleGetHistory } from './lib/history';
import { handleStoreState, handleDeleteAll, handleFeatures } from './lib/dataManagement';
import type { CustomSettings } from './lib/types';

/**
 * Parst ein optionales, aus dem Admin-UI kommendes Zahlenfeld (kann Zahl,
 * numerischer String, leerer String oder undefined sein).
 *
 * @param raw - Roher Feldwert
 * @returns Zahl oder undefined, wenn nicht gesetzt/ungültig
 */
function parseOptionalNumber(raw: string | number | undefined | null): number | undefined {
    if (raw === undefined || raw === '' || raw === null) {
        return undefined;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}

export class Victoriametrics extends utils.Adapter {
    /** Aktivierte Datenpunkte: ID -> Custom-Settings */
    enabledPoints = new Map<string, CustomSettings>();
    /** ID -> object.common (für type/unit) */
    objectCache = new Map<string, Partial<ioBroker.StateCommon>>();
    /** ID -> zuletzt geschriebener Wert (für changesMinDelta) */
    lastValues = new Map<string, number>();
    /** ID -> Zeitpunkt (Date.now()) des zuletzt geschriebenen Werts (für blockTime) */
    lastLogTimes = new Map<string, number>();
    /** ID -> aktiver Entprellungs-Timer (für debounceTime) */
    debounceTimers = new Map<string, ioBroker.Timeout>();
    /** Fehlerzähler pro Punkt-ID */
    errorPoints: Record<string, number> = {};
    subscribedAll = false;
    lastPersistOnFailure = 0;
    flushTimer: ioBroker.Interval | undefined | null = null;
    vmClient: VmClient;
    buffer: SeriesBuffer;

    /**
     * @param [options] - Adapter options
     */
    constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'victoriametrics',
        });

        this.vmClient = new VmClient(this.log);
        this.buffer = new SeriesBuffer();

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Effektive Verbindungskonfiguration: bei aktiviertem Docker-Betrieb der lokal gestartete
     * Container (Host/Port/Protokoll aus den Docker-Einstellungen, ohne Auth), sonst die
     * Verbindungseinstellungen aus dem Admin-UI.
     *
     * @returns Verbindungskonfiguration für den VmClient
     */
    get connection(): ConnectionConfig {
        const docker = this.config.dockerVictoria;
        if (docker?.enabled) {
            // 0.0.0.0 / :: / leer = "auf allen Interfaces gebunden" - der Adapter selbst erreicht den Container lokal
            const bind = !docker.bind || docker.bind === '0.0.0.0' || docker.bind === '::' ? '127.0.0.1' : docker.bind;
            return {
                protocol: 'http',
                host: bind,
                port: Number(docker.port) || 8428,
                useAuth: false,
                requestTimeout: this.config.requestTimeout,
            };
        }
        return this.config;
    }

    /**
     * Der VMUI-Link in der Admin-Seitenleiste (`common.adminTab.link`) wird von Admin aus
     * protocol/host/port der Instanz-Konfiguration aufgebaut. Bei aktiviertem Docker-Betrieb sind
     * diese Felder im UI ausgeblendet und leer - deshalb werden sie hier auf den Container
     * abgeglichen. Bei Bind-Adresse 0.0.0.0 (alle Interfaces) wird der Hostname dieses Rechners
     * verwendet, so wie es auch Admin für seine eigenen Links tut. Eine Änderung startet die
     * Instanz einmalig neu.
     *
     * @returns true, wenn die Konfiguration geändert wurde (die Instanz wird dann neu gestartet)
     */
    async _syncVmuiLinkSettings(): Promise<boolean> {
        const docker = this.config.dockerVictoria;
        if (!docker?.enabled) {
            return false;
        }
        const allInterfaces = !docker.bind || docker.bind === '0.0.0.0' || docker.bind === '::';
        const desired = {
            protocol: 'http',
            host: allInterfaces ? os.hostname() : docker.bind,
            port: Number(docker.port) || 8428,
        };
        if (
            this.config.protocol === desired.protocol &&
            this.config.host === desired.host &&
            Number(this.config.port) === desired.port
        ) {
            return false;
        }
        this.log.info(
            `Updating the connection settings for the VMUI link to the Docker container (${desired.protocol}://${desired.host}:${desired.port})`,
        );
        await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, { native: desired });
        return true;
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady(): Promise<void> {
        if (await this._syncVmuiLinkSettings()) {
            // js-controller restarts the instance because its configuration changed
            return;
        }

        const connection = this.connection;
        if (!connection.host) {
            this.log.error('No host configured for VictoriaMetrics - adapter is stopping');
            return;
        }

        await this._loadCache();

        const health = await this.vmClient.testHealth(connection);
        if (health.ok) {
            const retention = await this.vmClient.getRetention(connection);
            const retentionValue = (retention.ok && retention.retention) || '';
            const retentionInfo = retentionValue ? ` (Retention: ${retentionValue})` : '';
            this.log.info(
                `VictoriaMetrics reachable at ${connection.protocol}://${connection.host}:${connection.port}${retentionInfo}${this.config.dockerVictoria?.enabled ? ' [Docker]' : ''}`,
            );
            await this.setState('info.retention', retentionValue, true);
        } else {
            this.log.warn(
                `VictoriaMetrics not reachable at startup (${health.error}) - values will be buffered until reconnection`,
            );
        }
        await this.setState('info.connection', health.ok, true);

        await this._loadEnabledPoints();
        this._setupSubscriptions();
        this.subscribeForeignObjects('*');

        this.flushTimer = this.setInterval(() => void this.flush(), this._resolveWriteIntervalMs());
    }

    /**
     * Validiert writeInterval gegen Node.js' setTimeout/setInterval-Maximaldelay
     * (2^31 - 1 ms) und stellt sicher, dass es positiv ist - ein zu großer oder
     * ungültiger Wert würde sonst zu unvorhersehbarem Timer-Verhalten führen statt zum
     * erwarteten Schreibintervall. Die Admin-UI setzt zwar bereits min: 1, das greift
     * aber nur auf UI-Ebene.
     *
     * @returns Gültiges Schreibintervall in ms
     */
    _resolveWriteIntervalMs(): number {
        const configuredMs = Number(this.config.writeInterval) * 1000;
        if (!Number.isFinite(configuredMs) || configuredMs <= 0 || configuredMs > CONFIG.MAX_TIMER_MS) {
            this.log.warn(
                `Invalid write interval (${this.config.writeInterval}s), falling back to ${CONFIG.DEFAULT_WRITE_INTERVAL_S}s`,
            );
            return CONFIG.DEFAULT_WRITE_INTERVAL_S * 1000;
        }
        return configuredMs;
    }

    /**
     * Liest alle Objekte mit aktivierten Custom-Settings für diesen Adapter
     * (system/custom-View) und füllt enabledPoints/objectCache.
     */
    async _loadEnabledPoints(): Promise<void> {
        const result = await this.getObjectViewAsync('system', 'custom', {});
        for (const row of result.rows) {
            const settings = row.value && row.value[this.namespace];
            if (settings && settings.enabled) {
                await this._registerEnabledPoint(row.id, settings);
            }
        }
        this.log.info(`${this.enabledPoints.size} datapoint(s) enabled for history in VictoriaMetrics`);
    }

    /**
     * @param id - ioBroker-Objekt-ID
     * @param settings - Custom-Settings dieses Adapters für das Objekt
     */
    async _registerEnabledPoint(id: string, settings: CustomSettings): Promise<void> {
        this.enabledPoints.set(id, settings);
        const obj = await this.getForeignObjectAsync(id);
        this.objectCache.set(id, (obj && obj.common) || {});
    }

    /**
     * Wählt die Subscription-Strategie einmalig anhand der Anzahl aktivierter
     * Datenpunkte beim Start (siehe README, Abschnitt Architektur).
     */
    _setupSubscriptions(): void {
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
     * @param id - Objekt-ID
     * @param obj - Neuer Objektstand oder null bei Löschung
     */
    onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
        const settings = obj && obj.common && obj.common.custom && obj.common.custom[this.namespace];
        const wasEnabled = this.enabledPoints.has(id);
        const isEnabled = !!(settings && settings.enabled);

        if (isEnabled) {
            this.enabledPoints.set(id, settings);
            this.objectCache.set(id, obj.common as Partial<ioBroker.StateCommon>);
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
     * @param id - State-ID
     * @param state - Neuer Zustand oder null bei Löschung/Ablauf
     */
    onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state || state.val === null || state.val === undefined) {
            return;
        }
        const settings = this.enabledPoints.get(id);
        if (!settings) {
            return;
        }

        const debounceMs = this._resolveNumberSetting(settings, 'debounceTime', 'defaultDebounceTime');
        if (debounceMs !== undefined && debounceMs > 0) {
            const pending = this.debounceTimers.get(id);
            if (pending) {
                this.clearTimeout(pending);
            }
            const timer = this.setTimeout(() => {
                this.debounceTimers.delete(id);
                this._processPoint(id, state, settings);
            }, debounceMs);
            if (timer) {
                this.debounceTimers.set(id, timer);
            }
            return;
        }

        this._processPoint(id, state, settings);
    }

    /**
     * Wendet Schwellenwert-/Nullwert-/Rundungs-/Änderungs-/Rate-Limit-Filter an und
     * puffert den Punkt, falls er nicht herausgefiltert wird. Wird entweder direkt
     * aus onStateChange oder verzögert nach Ablauf der Entprellzeit aufgerufen.
     *
     * @param id - State-ID
     * @param state - Zustand zum Zeitpunkt der (ggf. entprellten) Änderung
     * @param settings - Custom-Settings des Datenpunkts
     */
    _processPoint(id: string, state: ioBroker.State, settings: CustomSettings): void {
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
        if (this._isSkippedByChangesOnly(id, value, settings)) {
            return;
        }
        if (this._isBlockedByBlockTime(id, settings)) {
            return;
        }

        this.lastValues.set(id, value);
        this.lastLogTimes.set(id, Date.now());

        const labels: Record<string, string> = {};
        if (common.unit) {
            labels.unit = metricName.sanitizeLabelValue(common.unit);
        }

        const name = metricName.deriveMetricName(id, settings, this.log);
        this.buffer.add({ pointId: id, metricName: name, labels, value, ts: state.ts });
        this.log.debug(`Buffered: ${id} -> ${name}=${value} (${JSON.stringify(labels)})`);

        if (this.buffer.size() >= this.config.bufferMaxSize) {
            void this.flush();
        }
    }

    /**
     * Liest eine optionale Zahl-Einstellung: Pro-Datenpunkt-Wert, falls gesetzt, sonst
     * der instanzweite Standardwert aus this.config, sonst undefined. So müssen Nutzer
     * mit vielen Datenpunkten nicht jeden einzeln konfigurieren.
     *
     * @param settings - Custom-Settings des Datenpunkts
     * @param key - Feldname in settings (z.B. "round")
     * @param defaultsKey - Feldname in this.config für den instanzweiten Standard (z.B. "defaultRound")
     * @returns Zahl oder undefined, wenn weder Datenpunkt noch Standard gesetzt sind
     */
    _resolveNumberSetting(
        settings: CustomSettings,
        key:
            | 'debounceTime'
            | 'blockTime'
            | 'round'
            | 'changesMinDelta'
            | 'changesRelogInterval'
            | 'ignoreBelowNumber'
            | 'ignoreAboveNumber',
        defaultsKey:
            | 'defaultDebounceTime'
            | 'defaultBlockTime'
            | 'defaultRound'
            | 'defaultChangesMinDelta'
            | 'defaultChangesRelogInterval'
            | 'defaultIgnoreBelowNumber'
            | 'defaultIgnoreAboveNumber',
    ): number | undefined {
        const perPoint = parseOptionalNumber(settings[key]);
        if (perPoint !== undefined) {
            return perPoint;
        }
        return parseOptionalNumber(this.config[defaultsKey]);
    }

    /**
     * Prüft die Schwellenwerte ignoreBelowNumber/ignoreAboveNumber (Datenpunkt- oder
     * instanzweiter Standardwert).
     *
     * @param value - Umgewandelter Zahlenwert
     * @param settings - Custom-Settings des Datenpunkts
     * @returns true, wenn der Wert außerhalb des erlaubten Bereichs liegt
     */
    _isOutsideThreshold(value: number, settings: CustomSettings): boolean {
        const below = this._resolveNumberSetting(settings, 'ignoreBelowNumber', 'defaultIgnoreBelowNumber');
        if (below !== undefined && value < below) {
            return true;
        }
        const above = this._resolveNumberSetting(settings, 'ignoreAboveNumber', 'defaultIgnoreAboveNumber');
        return above !== undefined && value > above;
    }

    /**
     * Prüft, ob Nullwerte für diesen Datenpunkt ignoriert werden sollen (ignoreZero,
     * Datenpunkt- oder instanzweiter Standardwert).
     *
     * @param value - Umgewandelter Zahlenwert
     * @param settings - Custom-Settings des Datenpunkts
     * @returns true, wenn der Wert übersprungen werden soll
     */
    _isIgnoredZero(value: number, settings: CustomSettings): boolean {
        const ignoreZero = settings.ignoreZero !== undefined ? settings.ignoreZero : this.config.defaultIgnoreZero;
        return !!ignoreZero && value === 0;
    }

    /**
     * Rundet den Wert auf die konfigurierte Anzahl Nachkommastellen (Datenpunkt- oder
     * instanzweiter Standardwert), sofern gesetzt.
     *
     * @param value - Umgewandelter Zahlenwert
     * @param settings - Custom-Settings des Datenpunkts
     * @returns Ggf. gerundeter Wert
     */
    _applyRounding(value: number, settings: CustomSettings): number {
        const decimals = this._resolveNumberSetting(settings, 'round', 'defaultRound');
        if (decimals === undefined || decimals < 0) {
            return value;
        }
        const factor = 10 ** decimals;
        return Math.round(value * factor) / factor;
    }

    /**
     * Prüft, ob der neue Wert sich vom zuletzt geschriebenen Wert um weniger als die
     * konfigurierte Mindestdifferenz (changesMinDelta, Datenpunkt- oder instanzweiter
     * Standardwert) unterscheidet und deshalb übersprungen werden soll. Der allererste
     * Wert eines Datenpunkts wird nie übersprungen.
     *
     * @param id - Objekt-ID
     * @param value - Neuer (bereits gerundeter) Wert
     * @param settings - Custom-Settings des Datenpunkts
     * @returns true, wenn der Wert übersprungen werden soll
     */
    _isBelowMinDelta(id: string, value: number, settings: CustomSettings): boolean {
        const minDelta = this._resolveNumberSetting(settings, 'changesMinDelta', 'defaultChangesMinDelta');
        if (minDelta === undefined || minDelta <= 0) {
            return false;
        }
        const last = this.lastValues.get(id);
        return last !== undefined && Math.abs(value - last) < minDelta;
    }

    /**
     * Prüft changesOnly (Datenpunkt- oder instanzweiter Standardwert): schreibt einen Wert
     * nur, wenn er sich vom zuletzt geschriebenen Wert unterscheidet. Ein unveränderter Wert
     * wird trotzdem erneut geschrieben (relogged), sobald changesRelogInterval seit dem
     * letzten Schreiben abgelaufen ist - so entstehen keine Lücken im Chart. Der allererste
     * Wert eines Datenpunkts wird nie übersprungen.
     *
     * @param id - Objekt-ID
     * @param value - Neuer (bereits gerundeter) Wert
     * @param settings - Custom-Settings des Datenpunkts
     * @returns true, wenn der Wert übersprungen werden soll
     */
    _isSkippedByChangesOnly(id: string, value: number, settings: CustomSettings): boolean {
        const changesOnly = settings.changesOnly !== undefined ? settings.changesOnly : this.config.defaultChangesOnly;
        if (!changesOnly) {
            return false;
        }
        const last = this.lastValues.get(id);
        if (last === undefined || last !== value) {
            return false;
        }
        const relogMs = this._resolveNumberSetting(settings, 'changesRelogInterval', 'defaultChangesRelogInterval');
        if (relogMs === undefined || relogMs <= 0) {
            return true;
        }
        const lastLogTime = this.lastLogTimes.get(id);
        return lastLogTime !== undefined && Date.now() - lastLogTime < relogMs;
    }

    /**
     * Prüft die Blockzeit (blockTime, Datenpunkt- oder instanzweiter Standardwert):
     * ignoriert neue Werte für die konfigurierte Zeitspanne nach dem zuletzt
     * geschriebenen Wert dieses Datenpunkts.
     *
     * @param id - Objekt-ID
     * @param settings - Custom-Settings des Datenpunkts
     * @returns true, wenn der Wert übersprungen werden soll
     */
    _isBlockedByBlockTime(id: string, settings: CustomSettings): boolean {
        const blockMs = this._resolveNumberSetting(settings, 'blockTime', 'defaultBlockTime');
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
     * @param val - Roher Zustandswert
     * @param id - Objekt-ID (nur für die Log-Meldung)
     * @returns Numerischer Wert oder null, wenn der Punkt übersprungen werden soll
     */
    _convertValue(val: ioBroker.StateValue, id: string): number | null {
        if (typeof val === 'number') {
            if (Number.isFinite(val)) {
                return val;
            }
            this.log.warn(`Value of ${id} is not a finite number (${val}) and will be skipped`);
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
            this.log.warn(`Value of ${id} ("${val}") is not a number and will be skipped`);
            return null;
        }
        this.log.warn(`Value of ${id} has an unsupported type (${typeof val}) and will be skipped`);
        return null;
    }

    /**
     * Sammelt gepufferte Punkte, gruppiert sie nach Metrik+Labels und
     * schreibt sie als newline-delimited JSON an VictoriaMetrics. Bei
     * Fehlschlag greift die Fehlerzähler-Retry-Policy.
     */
    async flush(): Promise<void> {
        if (!this.buffer || this.buffer.size() === 0) {
            return;
        }

        const points = this.buffer.drainAll();
        const body = this._buildImportBody(points);
        const result = await this.vmClient.writeBatch(this.connection, body);

        if (result.ok) {
            for (const point of points) {
                this.errorPoints[point.pointId] = 0;
            }
            this.log.debug(`${points.length} point(s) successfully written to VictoriaMetrics`);
            await this.setState('info.connection', true, true);
        } else {
            this.log.warn(`Writing ${points.length} point(s) to VictoriaMetrics failed: ${result.error}`);
            await this.setState('info.connection', false, true);
            this._applyRetryPolicy(points);
            await this._persistOnFailure();
        }
    }

    /**
     * Gruppiert Punkte nach (Metrikname + Labels) und baut daraus den
     * newline-delimited-JSON-Body für /api/v1/import.
     *
     * @param points - Zu schreibende Punkte
     * @returns NDJSON-Body
     */
    _buildImportBody(points: BufferedPoint[]): string {
        const groups = new Map<
            string,
            {
                metric: Record<string, string>;
                values: number[];
                timestamps: number[];
            }
        >();
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
     * @param points - Punkte des fehlgeschlagenen Batches
     */
    _applyRetryPolicy(points: BufferedPoint[]): void {
        for (const point of points) {
            this.errorPoints[point.pointId] = (this.errorPoints[point.pointId] || 0) + 1;
            if (this.errorPoints[point.pointId] < CONFIG.MAX_ERROR_COUNT) {
                this.buffer.add(point);
            } else {
                this.log.warn(`Discarding point for ${point.pointId} after ${CONFIG.MAX_ERROR_COUNT} failed attempts`);
                this.errorPoints[point.pointId] = 0;
            }
        }
    }

    /**
     * Persistiert den Puffer als Absicherung gegen einen harten Absturz
     * (kein sauberer onUnload), gedrosselt auf höchstens einmal pro Minute.
     */
    async _persistOnFailure(): Promise<void> {
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
    async _persistCache(): Promise<void> {
        try {
            const data = this.buffer.toJSON(CONFIG.CACHE_FORMAT_VERSION);
            await this.writeFileAsync(`${this.namespace}.cache`, CONFIG.CACHE_FILE_NAME, JSON.stringify(data));
        } catch (err) {
            this.log.debug(`Could not write buffer cache: ${(err as Error).message}`);
        }
    }

    /**
     * Lädt beim Start einen zuvor persistierten Puffer (falls vorhanden) und
     * leert die Cache-Datei danach wieder. Fehlerzähler starten bei 0.
     */
    async _loadCache(): Promise<void> {
        try {
            const result = await this.readFileAsync(`${this.namespace}.cache`, CONFIG.CACHE_FILE_NAME);
            const raw = result && result.file;
            const data = JSON.parse(raw ? raw.toString() : '{}');
            const loaded = SeriesBuffer.fromJSON(data, CONFIG.CACHE_FORMAT_VERSION);
            const points = loaded.drainAll();
            if (points.length) {
                this.buffer.requeue(points);
                this.log.info(`${points.length} buffered points loaded from previous run`);
            }
            await this._persistCache();
        } catch {
            this.log.debug('No buffer cache found from previous run');
        }
    }

    /**
     * Some message was sent to this instance over message box (Verbindungstest-Button
     * im Admin-UI, getHistory-Anfragen von vis-Chart-Widgets, sowie storeState/
     * deleteAll/features für Skripte und Admin-Capability-Discovery).
     *
     * @param obj - Empfangene Nachricht
     */
    async onMessage(obj: ioBroker.Message): Promise<void> {
        if (obj.command === 'getHistory') {
            await handleGetHistory(this, obj);
            return;
        }
        if (obj.command === 'storeState') {
            await handleStoreState(this, obj);
            return;
        }
        if (obj.command === 'deleteAll') {
            await handleDeleteAll(this, obj);
            return;
        }
        if (obj.command === 'features') {
            handleFeatures(this, obj);
            return;
        }
        if (obj.command !== 'testConnection') {
            return;
        }

        const cfg = obj.message && obj.message.config;
        if (!cfg || !cfg.host) {
            this.sendTo(obj.from, obj.command, { error: 'Invalid connection data' }, obj.callback);
            return;
        }

        const testCfg = { ...cfg, password: decodeURIComponent(cfg.password || '') };
        const result = await this.vmClient.testHealth(testCfg);
        if (!result.ok) {
            this.sendTo(obj.from, obj.command, { error: result.error }, obj.callback);
            return;
        }
        const retention = await this.vmClient.getRetention(testCfg);
        this.sendTo(
            obj.from,
            obj.command,
            { result: 'ok', args: [(retention.ok && retention.retention) || '–'] },
            obj.callback,
        );
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback - Callback function
     */
    onUnload(callback: () => void): void {
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
            this.log.error(`Error while shutting down the adapter: ${(error as Error).message}`);
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Victoriametrics(options);
} else {
    // otherwise start the instance directly
    (() => new Victoriametrics())();
}
