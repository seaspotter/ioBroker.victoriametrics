'use strict';

/**
 * Ein gepufferter Punkt: {pointId, metricName, labels, value, ts}
 * - pointId: ioBroker-Objekt-ID, für die der Fehlerzähler geführt wird
 * - metricName: normalisierter Prometheus-Metrikname
 * - labels: zusätzliche Labels (z.B. unit)
 * - value: numerischer Wert
 * - ts: Zeitstempel in Millisekunden (Unix-Epoch)
 *
 * @typedef {{pointId: string, metricName: string, labels: Record<string, string>, value: number, ts: number}} BufferedPoint
 */

/**
 * Einfache, ioBroker-unabhängige Puffer-Datenstruktur für noch nicht
 * geschriebene Datenpunkte. Kennt weder HTTP noch Adapter-Zustand
 * (Fehlerzähler-Policy lebt bewusst in main.js).
 */
class SeriesBuffer {
    /** Erstellt einen leeren Puffer. */
    constructor() {
        /** @type {BufferedPoint[]} */
        this._points = [];
    }

    /**
     * @param {BufferedPoint} point - Zu puffernder Punkt
     */
    add(point) {
        this._points.push(point);
    }

    /**
     * @returns {number} Anzahl gepufferter Punkte
     */
    size() {
        return this._points.length;
    }

    /**
     * Entfernt und liefert alle gepufferten Punkte.
     *
     * @returns {BufferedPoint[]} Alle bisher gepufferten Punkte
     */
    drainAll() {
        const points = this._points;
        this._points = [];
        return points;
    }

    /**
     * Legt Punkte wieder in den Puffer zurück (z.B. nach fehlgeschlagenem Schreibversuch).
     * Umgeht bewusst jegliche Größenbeschränkung.
     *
     * @param {BufferedPoint[]} points - Wieder einzureihende Punkte
     */
    requeue(points) {
        this._points.push(...points);
    }

    /**
     * @param {number} formatVersion - Cache-Format-Version, die mitgespeichert wird
     * @returns {{version: number, savedAt: number, points: BufferedPoint[]}} Serialisierbare Repräsentation
     */
    toJSON(formatVersion) {
        return {
            version: formatVersion,
            savedAt: Date.now(),
            points: this._points,
        };
    }

    /**
     * Erzeugt einen Puffer aus einer zuvor mit toJSON() erzeugten Struktur.
     *
     * @param {{version?: number, points?: BufferedPoint[]}} data - Geladene Cache-Daten
     * @param {number} expectedVersion - Erwartetes Cache-Format
     * @returns {SeriesBuffer} Neuer Puffer mit den geladenen Punkten
     */
    static fromJSON(data, expectedVersion) {
        const buffer = new SeriesBuffer();
        if (data && data.version === expectedVersion && Array.isArray(data.points)) {
            buffer._points = data.points;
        }
        return buffer;
    }
}

module.exports = { SeriesBuffer };
