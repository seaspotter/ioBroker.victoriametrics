import type { CustomSettings } from './types';

type NumericKey =
    | 'debounceTime'
    | 'blockTime'
    | 'round'
    | 'changesMinDelta'
    | 'changesRelogInterval'
    | 'ignoreBelowNumber'
    | 'ignoreAboveNumber';

type FlagKey = 'ignoreZero' | 'changesOnly';

/** Instance-wide defaults (`default<Setting>` fields of the adapter config) for the per-datapoint settings. */
export type FilterDefaults = {
    [K in NumericKey as `default${Capitalize<K>}`]?: string | number;
} & {
    [K in FlagKey as `default${Capitalize<K>}`]?: boolean;
};

/**
 * Parses an optional number from the admin UI (number, numeric string, empty string or undefined).
 *
 * @param raw - Raw field value
 * @returns The number, or undefined if not set or invalid
 */
export function parseOptionalNumber(raw: string | number | null | undefined): number | undefined {
    if (raw === undefined || raw === null || raw === '') {
        return undefined;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}

const defaultKey = (key: string): string => `default${key[0].toUpperCase()}${key.slice(1)}`;

/**
 * Value filters of a datapoint. Every setting is read from the datapoint first, then from the
 * instance-wide default. Keeps the last written value and time per datapoint.
 */
export class PointFilter {
    private readonly lastValues = new Map<string, number>();
    private readonly lastLogTimes = new Map<string, number>();

    /**
     * @param getDefaults - Returns the instance-wide defaults (the config is only available after startup)
     */
    constructor(private readonly getDefaults: () => FilterDefaults) {}

    private number(settings: CustomSettings, key: NumericKey): number | undefined {
        const defaults = this.getDefaults() as Record<string, string | number | undefined>;
        return parseOptionalNumber(settings[key]) ?? parseOptionalNumber(defaults[defaultKey(key)]);
    }

    private flag(settings: CustomSettings, key: FlagKey): boolean {
        const defaults = this.getDefaults() as Record<string, boolean | undefined>;
        return !!(settings[key] ?? defaults[defaultKey(key)]);
    }

    /**
     * @param settings - Custom settings of the datapoint
     * @returns Debounce time in ms (0 = off)
     */
    debounceMs(settings: CustomSettings): number {
        return this.number(settings, 'debounceTime') ?? 0;
    }

    /**
     * Applies the value filters (threshold, ignore zero) and rounding. Also used for imports.
     *
     * @param value - Numeric value
     * @param settings - Custom settings of the datapoint
     * @returns The value to write, or null if it is filtered out
     */
    validate(value: number, settings: CustomSettings): number | null {
        const below = this.number(settings, 'ignoreBelowNumber');
        const above = this.number(settings, 'ignoreAboveNumber');
        if ((below !== undefined && value < below) || (above !== undefined && value > above)) {
            return null;
        }
        if (value === 0 && this.flag(settings, 'ignoreZero')) {
            return null;
        }
        const decimals = this.number(settings, 'round');
        if (decimals === undefined || decimals < 0) {
            return value;
        }
        const factor = 10 ** decimals;
        return Math.round(value * factor) / factor;
    }

    /**
     * Checks the filters for live changes: minimum change, changes only (with relog interval)
     * and block time. The first value of a datapoint is never filtered by the first two.
     *
     * @param id - Object ID
     * @param value - New value, already validated
     * @param settings - Custom settings of the datapoint
     * @param now - Current time in ms
     * @returns true if the value should not be written
     */
    isRedundant(id: string, value: number, settings: CustomSettings, now = Date.now()): boolean {
        const last = this.lastValues.get(id);
        const lastTime = this.lastLogTimes.get(id);

        const minDelta = this.number(settings, 'changesMinDelta');
        if (minDelta !== undefined && minDelta > 0 && last !== undefined && Math.abs(value - last) < minDelta) {
            return true;
        }

        if (this.flag(settings, 'changesOnly') && last === value) {
            const relogMs = this.number(settings, 'changesRelogInterval');
            if (relogMs === undefined || relogMs <= 0 || (lastTime !== undefined && now - lastTime < relogMs)) {
                return true;
            }
        }

        const blockMs = this.number(settings, 'blockTime');
        return blockMs !== undefined && blockMs > 0 && lastTime !== undefined && now - lastTime < blockMs;
    }

    /**
     * Remembers a written value.
     *
     * @param id - Object ID
     * @param value - Written value
     * @param now - Current time in ms
     */
    record(id: string, value: number, now = Date.now()): void {
        this.lastValues.set(id, value);
        this.lastLogTimes.set(id, now);
    }

    /**
     * @param id - Object ID whose history is no longer logged
     */
    forget(id: string): void {
        this.lastValues.delete(id);
        this.lastLogTimes.delete(id);
    }
}
