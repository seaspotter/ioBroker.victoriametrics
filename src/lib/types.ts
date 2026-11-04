/**
 * Custom-Settings eines Datenpunkts für diesen Adapter (common.custom[namespace]).
 * Zahlenfelder kommen aus dem Admin-UI und können Zahl oder numerischer String sein.
 */
export interface CustomSettings {
    enabled?: boolean;
    aliasId?: string;
    debounceTime?: string | number;
    blockTime?: string | number;
    round?: string | number;
    changesMinDelta?: string | number;
    changesOnly?: boolean;
    changesRelogInterval?: string | number;
    ignoreBelowNumber?: string | number;
    ignoreAboveNumber?: string | number;
    ignoreZero?: boolean;
}
