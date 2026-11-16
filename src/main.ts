import * as os from 'node:os';
import * as utils from '@iobroker/adapter-core';
import { CONFIG, validTimerMs } from './lib/config';
import { buildImportBody, SeriesBuffer, type BufferedPoint } from './lib/buffer';
import { handleDeleteAll, handleFeatures, handleStoreState } from './lib/dataManagement';
import { PointFilter } from './lib/filters';
import { handleGetHistory } from './lib/history';
import { buildLabels, deriveMetricName } from './lib/metricName';
import type { CustomSettings } from './lib/types';
import * as vm from './lib/vmClient';

/**
 * @param common - `common` of an object
 * @returns The unit, if the object is a state
 */
const unitOf = (common?: object): string | undefined => (common as { unit?: string } | undefined)?.unit;

/**
 * @param bind - Bind address
 * @returns true for 0.0.0.0, :: or empty (all interfaces)
 */
const isAllInterfaces = (bind?: string): boolean => !bind || bind === '0.0.0.0' || bind === '::';

export class Victoriametrics extends utils.Adapter {
    /** Enabled datapoints: object ID -> custom settings */
    enabledPoints = new Map<string, CustomSettings>();
    buffer = new SeriesBuffer();
    filter = new PointFilter(() => this.config);

    private readonly units = new Map<string, string | undefined>();
    private readonly debounceTimers = new Map<string, ioBroker.Timeout>();
    private readonly errorPoints: Record<string, number> = {};
    private subscribedAll = false;
    private lastPersistOnFailure = 0;
    private flushTimer: ioBroker.Interval | undefined | null = null;

    /**
     * @param options - Adapter options
     */
    constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'victoriametrics' });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * The connection to use: the local container if Docker is enabled, otherwise the admin settings.
     *
     * @returns Connection settings
     */
    get connection(): vm.ConnectionConfig {
        const docker = this.config.dockerVictoria;
        if (docker?.enabled) {
            return {
                protocol: 'http',
                host: isAllInterfaces(docker.bind) ? '127.0.0.1' : docker.bind,
                port: Number(docker.port) || 8428,
                requestTimeout: this.config.requestTimeout,
            };
        }
        return this.config;
    }

    /**
     * Admin builds the sidebar link (`common.adminTab.link`) from protocol/host/port of the instance
     * config. With Docker these fields are hidden and empty, so they are synced with the container
     * (host name of this machine for all interfaces). A change restarts the instance once.
     *
     * @returns true if the config was changed
     */
    private async syncVmuiLinkSettings(): Promise<boolean> {
        const docker = this.config.dockerVictoria;
        if (!docker?.enabled) {
            return false;
        }
        const desired = {
            protocol: 'http',
            host: isAllInterfaces(docker.bind) ? os.hostname() : docker.bind,
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
            `Setting the connection for the VMUI link to the Docker container (${desired.host}:${desired.port})`,
        );
        await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, { native: desired });
        return true;
    }

    private async onReady(): Promise<void> {
        if (await this.syncVmuiLinkSettings()) {
            return; // the instance restarts because its config changed
        }

        const connection = this.connection;
        if (!connection.host) {
            this.log.error('No host configured for VictoriaMetrics - adapter is stopping');
            return;
        }

        await this.loadCache();

        const health = await vm.testHealth(connection);
        if (health.ok) {
            const retention = await vm.getRetention(connection);
            const retentionValue = (retention.ok && retention.retention) || '';
            this.log.info(
                `VictoriaMetrics reachable at ${connection.protocol}://${connection.host}:${connection.port}` +
                    `${retentionValue ? ` (Retention: ${retentionValue})` : ''}`,
            );
            await this.setState('info.retention', retentionValue, true);
        } else {
            this.log.warn(
                `VictoriaMetrics not reachable at startup (${health.error}) - values will be buffered until reconnection`,
            );
        }
        await this.setState('info.connection', health.ok, true);

        await this.loadEnabledPoints();
        this.subscribeToPoints();
        this.subscribeForeignObjects('*');

        this.flushTimer = this.setInterval(() => void this.flush(), this.writeIntervalMs());
    }

    private writeIntervalMs(): number {
        const ms = validTimerMs(Number(this.config.writeInterval) * 1000);
        if (ms === undefined) {
            this.log.warn(
                `Invalid write interval (${this.config.writeInterval}s), using ${CONFIG.DEFAULT_WRITE_INTERVAL_S}s`,
            );
        }
        return ms ?? CONFIG.DEFAULT_WRITE_INTERVAL_S * 1000;
    }

    /**
     * Reads the objects that have the adapter enabled in their custom settings.
     */
    private async loadEnabledPoints(): Promise<void> {
        const result = await this.getObjectViewAsync('system', 'custom', {});
        for (const row of result.rows) {
            const settings = row.value?.[this.namespace];
            if (settings?.enabled) {
                const obj = await this.getForeignObjectAsync(row.id);
                this.trackPoint(row.id, settings, unitOf(obj?.common));
            }
        }
        this.log.info(`${this.enabledPoints.size} datapoint(s) enabled for history in VictoriaMetrics`);
    }

    /**
     * Subscribes to each enabled datapoint, or to all states if there are many.
     */
    private subscribeToPoints(): void {
        if (this.enabledPoints.size <= CONFIG.SUBSCRIBE_THRESHOLD) {
            for (const id of this.enabledPoints.keys()) {
                this.subscribeForeignStates(id);
            }
        } else {
            this.subscribedAll = true;
            this.subscribeForeignStates('*');
        }
    }

    private trackPoint(id: string, settings: CustomSettings, unit: string | undefined): void {
        this.enabledPoints.set(id, settings);
        this.units.set(id, unit);
    }

    private untrackPoint(id: string): void {
        this.enabledPoints.delete(id);
        this.units.delete(id);
        this.filter.forget(id);
        const pending = this.debounceTimers.get(id);
        if (pending) {
            this.clearTimeout(pending);
            this.debounceTimers.delete(id);
        }
    }

    /**
     * Reads the custom settings and unit of a datapoint from its object.
     *
     * @param id - Object ID
     * @returns The settings (empty if none) and the unit
     */
    async getPointInfo(id: string): Promise<{ settings: CustomSettings; unit: string | undefined }> {
        const common = (await this.getForeignObjectAsync(id))?.common;
        return { settings: common?.custom?.[this.namespace] ?? {}, unit: unitOf(common) };
    }

    /**
     * @param id - Object ID
     * @returns The metric name of the datapoint
     */
    async metricNameOf(id: string): Promise<string> {
        return deriveMetricName(id, (await this.getPointInfo(id)).settings, this.log);
    }

    /**
     * Follows changes of the custom settings (subscribed to all objects).
     *
     * @param id - Object ID
     * @param obj - New object, or null if deleted
     */
    private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
        const settings = obj?.common?.custom?.[this.namespace];
        if (obj && settings?.enabled) {
            const wasEnabled = this.enabledPoints.has(id);
            this.trackPoint(id, settings, unitOf(obj.common));
            if (!wasEnabled && !this.subscribedAll) {
                this.subscribeForeignStates(id);
            }
        } else if (this.enabledPoints.has(id)) {
            this.untrackPoint(id);
            if (!this.subscribedAll) {
                this.unsubscribeForeignStates(id);
            }
        }
    }

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        const settings = this.enabledPoints.get(id);
        if (!settings || state?.val === null || state?.val === undefined) {
            return;
        }

        const debounceMs = this.filter.debounceMs(settings);
        if (debounceMs > 0) {
            const pending = this.debounceTimers.get(id);
            if (pending) {
                this.clearTimeout(pending);
            }
            const timer = this.setTimeout(() => {
                this.debounceTimers.delete(id);
                this.processPoint(id, state, settings);
            }, debounceMs);
            if (timer) {
                this.debounceTimers.set(id, timer);
            }
            return;
        }

        this.processPoint(id, state, settings);
    }

    /**
     * Applies the filters and buffers the point.
     *
     * @param id - Object ID
     * @param state - The state, after the debounce time if one is set
     * @param settings - Custom settings of the datapoint
     */
    private processPoint(id: string, state: ioBroker.State, settings: CustomSettings): void {
        const converted = this.convertValue(state.val, id);
        const value = converted === null ? null : this.filter.validate(converted, settings);
        if (value === null || this.filter.isRedundant(id, value, settings)) {
            return;
        }
        this.filter.record(id, value);

        const metricName = deriveMetricName(id, settings, this.log);
        const labels = buildLabels(this.units.get(id));
        this.buffer.add({ pointId: id, metricName, labels, value, ts: state.ts });
        this.log.debug(`Buffered: ${id} -> ${metricName}=${value} (${JSON.stringify(labels)})`);

        if (this.buffer.size() >= this.config.bufferMaxSize) {
            void this.flush();
        }
    }

    /**
     * Converts a state value to a number: booleans become 0/1, numeric strings are parsed.
     *
     * @param val - State value
     * @param id - Object ID, for the log message
     * @returns The number, or null if the point is skipped
     */
    convertValue(val: ioBroker.StateValue, id: string): number | null {
        if (typeof val === 'boolean') {
            return val ? 1 : 0;
        }
        const num = typeof val === 'string' && val.trim() !== '' ? Number(val) : val;
        if (typeof num === 'number' && Number.isFinite(num)) {
            return num;
        }
        this.log.warn(
            `Value of ${id} (${typeof val === 'object' ? typeof val : `"${val}"`}) is not a number and will be skipped`,
        );
        return null;
    }

    /**
     * Writes the buffered points to VictoriaMetrics. If that fails, the points are retried.
     */
    private async flush(): Promise<void> {
        if (this.buffer.size() === 0) {
            return;
        }

        const points = this.buffer.drainAll();
        const result = await vm.writeBatch(this.connection, buildImportBody(points));

        if (result.ok) {
            for (const point of points) {
                this.errorPoints[point.pointId] = 0;
            }
            this.log.debug(`${points.length} point(s) successfully written to VictoriaMetrics`);
        } else {
            this.log.warn(`Writing ${points.length} point(s) to VictoriaMetrics failed: ${result.error}`);
            this.retry(points);
            await this.persistOnFailure();
        }
        await this.setState('info.connection', result.ok, true);
    }

    /**
     * Re-buffers the points of a failed batch. A point that failed MAX_ERROR_COUNT times is dropped,
     * so the buffer cannot grow without limit while VictoriaMetrics stays unreachable.
     *
     * @param points - Points of the failed batch
     */
    private retry(points: BufferedPoint[]): void {
        for (const point of points) {
            const failures = (this.errorPoints[point.pointId] || 0) + 1;
            if (failures < CONFIG.MAX_ERROR_COUNT) {
                this.errorPoints[point.pointId] = failures;
                this.buffer.add(point);
            } else {
                this.log.warn(`Discarding point for ${point.pointId} after ${CONFIG.MAX_ERROR_COUNT} failed attempts`);
                this.errorPoints[point.pointId] = 0;
            }
        }
    }

    /**
     * Persists the buffer after a failed write as protection against a hard crash, at most once a minute.
     */
    private async persistOnFailure(): Promise<void> {
        const now = Date.now();
        if (now - this.lastPersistOnFailure >= CONFIG.PERSIST_ON_FAILURE_MIN_INTERVAL_MS) {
            this.lastPersistOnFailure = now;
            await this.persistCache();
        }
    }

    private async persistCache(): Promise<void> {
        try {
            const data = this.buffer.toJSON(CONFIG.CACHE_FORMAT_VERSION);
            await this.writeFileAsync(`${this.namespace}.cache`, CONFIG.CACHE_FILE_NAME, JSON.stringify(data));
        } catch (err) {
            this.log.debug(`Could not write buffer cache: ${(err as Error).message}`);
        }
    }

    /**
     * Restores the buffer persisted by a previous run and empties the cache file.
     */
    private async loadCache(): Promise<void> {
        try {
            const file = (await this.readFileAsync(`${this.namespace}.cache`, CONFIG.CACHE_FILE_NAME))?.file;
            const points = SeriesBuffer.fromJSON(
                JSON.parse(file ? file.toString() : '{}'),
                CONFIG.CACHE_FORMAT_VERSION,
            ).drainAll();
            if (points.length) {
                this.buffer.requeue(points);
                this.log.info(`${points.length} buffered points loaded from previous run`);
            }
            await this.persistCache();
        } catch {
            this.log.debug('No buffer cache found from previous run');
        }
    }

    private async onMessage(obj: ioBroker.Message): Promise<void> {
        switch (obj.command) {
            case 'getHistory':
                return handleGetHistory(this, obj);
            case 'storeState':
                return handleStoreState(this, obj);
            case 'deleteAll':
                return handleDeleteAll(this, obj);
            case 'features':
                return handleFeatures(this, obj);
            case 'testConnection':
                return this.testConnection(obj);
        }
    }

    /**
     * Connection test button of the admin UI: uses the entered, not yet saved settings.
     *
     * @param obj - Message with `{config}`
     */
    private async testConnection(obj: ioBroker.Message): Promise<void> {
        const cfg = obj.message?.config;
        if (!cfg?.host) {
            this.sendTo(obj.from, obj.command, { error: 'Invalid connection data' }, obj.callback);
            return;
        }

        const testCfg = { ...cfg, password: decodeURIComponent(cfg.password || '') };
        const health = await vm.testHealth(testCfg);
        if (!health.ok) {
            this.sendTo(obj.from, obj.command, { error: health.error }, obj.callback);
            return;
        }
        const retention = await vm.getRetention(testCfg);
        const args = [(retention.ok && retention.retention) || '–'];
        this.sendTo(obj.from, obj.command, { result: 'ok', args }, obj.callback);
    }

    private onUnload(callback: () => void): void {
        try {
            if (this.flushTimer) {
                this.clearInterval(this.flushTimer);
                this.flushTimer = null;
            }
            // The write is started without delaying the unload
            if (this.buffer.size() > 0) {
                void this.persistCache().finally(callback);
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
    // Start the instance directly
    (() => new Victoriametrics())();
}
