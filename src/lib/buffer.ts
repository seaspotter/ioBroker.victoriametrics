/**
 * Ein gepufferter Punkt: {pointId, metricName, labels, value, ts}
 * - pointId: ioBroker-Objekt-ID, für die der Fehlerzähler geführt wird
 * - metricName: normalisierter Prometheus-Metrikname
 * - labels: zusätzliche Labels (z.B. unit)
 * - value: numerischer Wert
 * - ts: Zeitstempel in Millisekunden (Unix-Epoch)
 */
export interface BufferedPoint {
    /** ioBroker-Objekt-ID, für die der Fehlerzähler geführt wird */
    pointId: string;
    /** Normalisierter Prometheus-Metrikname */
    metricName: string;
    /** Zusätzliche Labels (z.B. unit) */
    labels: Record<string, string>;
    /** Numerischer Wert */
    value: number;
    /** Zeitstempel in Millisekunden (Unix-Epoch) */
    ts: number;
}

/**
 * Einfache, ioBroker-unabhängige Puffer-Datenstruktur für noch nicht
 * geschriebene Datenpunkte. Kennt weder HTTP noch Adapter-Zustand
 * (Fehlerzähler-Policy lebt bewusst in main.ts).
 */
export class SeriesBuffer {
    private _points: BufferedPoint[] = [];

    /**
     * @param point - Zu puffernder Punkt
     */
    add(point: BufferedPoint): void {
        this._points.push(point);
    }

    /**
     * @returns Anzahl gepufferter Punkte
     */
    size(): number {
        return this._points.length;
    }

    /**
     * Entfernt und liefert alle gepufferten Punkte.
     *
     * @returns Alle bisher gepufferten Punkte
     */
    drainAll(): BufferedPoint[] {
        const points = this._points;
        this._points = [];
        return points;
    }

    /**
     * Legt Punkte wieder in den Puffer zurück (z.B. nach fehlgeschlagenem Schreibversuch).
     * Umgeht bewusst jegliche Größenbeschränkung.
     *
     * @param points - Wieder einzureihende Punkte
     */
    requeue(points: BufferedPoint[]): void {
        this._points.push(...points);
    }

    /**
     * @param formatVersion - Cache-Format-Version, die mitgespeichert wird
     * @returns Serialisierbare Repräsentation
     */
    toJSON(formatVersion: number): { version: number; savedAt: number; points: BufferedPoint[] } {
        return {
            version: formatVersion,
            savedAt: Date.now(),
            points: this._points,
        };
    }

    /**
     * Erzeugt einen Puffer aus einer zuvor mit toJSON() erzeugten Struktur.
     *
     * @param data - Geladene Cache-Daten
     * @param expectedVersion - Erwartetes Cache-Format
     * @returns Neuer Puffer mit den geladenen Punkten
     */
    static fromJSON(
        data: { version?: number; points?: BufferedPoint[] } | null | undefined,
        expectedVersion: number,
    ): SeriesBuffer {
        const buffer = new SeriesBuffer();
        if (data && data.version === expectedVersion && Array.isArray(data.points)) {
            buffer._points = data.points;
        }
        return buffer;
    }
}
