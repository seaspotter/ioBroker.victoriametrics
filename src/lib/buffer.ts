/** A buffered point not yet written to VictoriaMetrics. */
export interface BufferedPoint {
    /** Object ID, used for the error counter */
    pointId: string;
    metricName: string;
    labels: Record<string, string>;
    value: number;
    /** Unix epoch in ms */
    ts: number;
}

/** Buffer for points that are not yet written. Knows neither HTTP nor adapter state. */
export class SeriesBuffer {
    private _points: BufferedPoint[] = [];

    /**
     * @param point - Point to buffer
     */
    add(point: BufferedPoint): void {
        this._points.push(point);
    }

    /**
     * @returns Number of buffered points
     */
    size(): number {
        return this._points.length;
    }

    /**
     * Removes and returns all buffered points.
     *
     * @returns The points
     */
    drainAll(): BufferedPoint[] {
        const points = this._points;
        this._points = [];
        return points;
    }

    /**
     * Puts points back, e.g. after a failed write. Ignores any size limit.
     *
     * @param points - Points to re-add
     */
    requeue(points: BufferedPoint[]): void {
        this._points.push(...points);
    }

    /**
     * @param formatVersion - Cache format version to store
     * @returns The serializable state
     */
    toJSON(formatVersion: number): { version: number; savedAt: number; points: BufferedPoint[] } {
        return { version: formatVersion, savedAt: Date.now(), points: this._points };
    }

    /**
     * Restores a buffer from `toJSON()` output; data of another format version is ignored.
     *
     * @param data - Loaded cache data
     * @param expectedVersion - Expected cache format version
     * @returns The restored buffer
     */
    static fromJSON(
        data: { version?: number; points?: BufferedPoint[] } | null | undefined,
        expectedVersion: number,
    ): SeriesBuffer {
        const buffer = new SeriesBuffer();
        if (data?.version === expectedVersion && Array.isArray(data.points)) {
            buffer._points = data.points;
        }
        return buffer;
    }
}

/**
 * Groups points by metric and labels into the newline-delimited JSON body of `/api/v1/import`.
 *
 * @param points - Points to write
 * @returns The NDJSON body
 */
export function buildImportBody(points: BufferedPoint[]): string {
    const groups = new Map<string, { metric: Record<string, string>; values: number[]; timestamps: number[] }>();
    for (const { metricName, labels, value, ts } of points) {
        const key = `${metricName}|${JSON.stringify(labels)}`;
        let group = groups.get(key);
        if (!group) {
            group = { metric: { __name__: metricName, ...labels }, values: [], timestamps: [] };
            groups.set(key, group);
        }
        group.values.push(value);
        group.timestamps.push(ts);
    }
    return Array.from(groups.values(), group => JSON.stringify(group)).join('\n');
}
