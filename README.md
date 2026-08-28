![Logo](admin/victoriametrics.png)
# iobroker.victoriametrics

[![NPM version](https://img.shields.io/npm/v/iobroker.victoriametrics.svg)](https://www.npmjs.com/package/iobroker.victoriametrics)

**Tests:** ![Test and Release](https://github.com/seaspotter/iobroker.victoriametrics/workflows/Test%20and%20Release/badge.svg)

Schreibt ioBroker-Datenpunkt-Historie nativ in [VictoriaMetrics](https://victoriametrics.com/) – über
dessen [JSON-Lines-Import-API](https://docs.victoriametrics.com/#how-to-import-data-in-json-line-format),
mit echten Prometheus-Labels statt Feld-Namens-Suffixen (wie sie z.B. beim Schreiben über den
InfluxDB-Kompatibilitätslayer entstehen, etwa `Batterieleistung_value`).

**Hinweis:** Phase 1 (Schreibpfad) ist fertig und produktiv im Einsatz. Phase 2
(`getHistory()`-Lesezugriff, damit vis-Chart-Widgets direkt gegen diesen Adapter abfragen
können) existiert als **Proof-of-Concept** – siehe [Lesepfad](#lesepfad-phase-2-proof-of-concept)
unten für den aktuellen Stand und bekannte Einschränkungen. Für Visualisierung ohne vis
(z.B. Grafana) weiterhin direkt gegen VictoriaMetrics per PromQL abfragen. Der Adapter ist
privat und nicht im offiziellen ioBroker-Repository gelistet.

## Voraussetzungen

- Eine laufende VictoriaMetrics-Instanz (Single-Node), erreichbar per HTTP(S)
- ioBroker js-controller >= 6.0.11, Admin >= 7.0.23

## Installation

Da der Adapter privat ist (nicht im offiziellen Repository), erfolgt die Installation über die
GitHub-URL, entweder in der Admin-Oberfläche unter "Adapter" → "Custom von URL installieren..."
oder per CLI:

```bash
iobroker url https://github.com/seaspotter/iobroker.victoriametrics
```

## Konfiguration

### Tab "Verbindung"

| Feld | Beschreibung |
|------|--------------|
| Protokoll | `http` oder `https` |
| Host / IP-Adresse | Hostname/IP der VictoriaMetrics-Instanz, ohne Protokoll |
| Port | Standard: `8428` |
| Basic-Auth verwenden | Aktiviert Benutzername/Passwort (VictoriaMetrics `-httpAuth.*`) |
| Timeout (ms) | HTTP-Request-Timeout |

Über den Button **"Verbindung testen"** wird der `/health`-Endpunkt von VictoriaMetrics mit den
aktuell eingegebenen (noch nicht gespeicherten) Werten geprüft.

### Tab "Schreibverhalten"

| Feld | Beschreibung |
|------|--------------|
| Schreibintervall (Sekunden) | Wie oft gepufferte Werte gesammelt geschrieben werden |
| Max. Puffergröße (Punkte) | Löst bei Erreichen einen sofortigen Schreibvorgang aus |

### Datenpunkte historisieren

Im Objektbaum bei jedem gewünschten Datenpunkt den Tab **"Historie"** öffnen, diesen Adapter
auswählen und über den Schalter **"Aktiviert"** einschalten.

| Feld | Beschreibung |
|------|--------------|
| Entprellzeit (ms, optional) | Protokolliert den Wert erst, wenn er für die angegebene Zeit unverändert bleibt (wartet auf einen "ruhigen" Zustand vor dem Schreiben) |
| Blockzeit (ms, optional) | Ignoriert neue Werte für die angegebene Zeit nach dem zuletzt geschriebenen Wert (Rate-Limit) |
| Ignoriere Werte kleiner/größer als (optional) | Schwellenwert-Filter, z. B. um offensichtliche Sensor-Ausreißer zu verwerfen |
| Ignoriere Nullwerte (0) | Überspringt Werte, die exakt 0 sind |
| Metrik-Name (optional) | Überschreibt die automatisch aus der Objekt-ID abgeleitete Metrik (`__name__`), siehe unten |
| Runden auf Nachkommastellen (optional) | Rundet den Wert vor dem Schreiben; leer lassen für keine Rundung |
| Minimale Änderung (optional) | Werte, die sich vom zuletzt geschriebenen Wert um weniger als diesen Betrag unterscheiden, werden nicht geschrieben; leer lassen für keine Filterung |

Entprellzeit und Blockzeit sind kombinierbar mit den übrigen Filtern: Entprellzeit
verzögert das Schreiben, bis der Wert eine Zeit lang stabil war; Blockzeit begrenzt,
wie oft ein Datenpunkt maximal geschrieben wird, unabhängig davon, ob er sich ändert.

## Metrik-Namensbildung

Der Prometheus-Metrikname (`__name__`) wird wie folgt ermittelt:

1. Ist im Historie-Tab ein **Metrik-Name** (`aliasId`) gesetzt, wird dieser verwendet.
2. Andernfalls wird die **ioBroker-Objekt-ID** verwendet (nicht der Objektname, da dieser sich
   unbemerkt ändern und die Zeitreihe stillschweigend spalten könnte).

Der gewählte Name wird anschließend normalisiert: kleingeschrieben, `.` wird zu `_`, jede Folge
ungültiger Zeichen wird zu einem einzelnen `_` zusammengefasst, führende/trailing `_` entfernt,
und falls das Ergebnis mit einer Ziffer beginnt, wird ein `_` vorangestellt.

Beispiel: `javascript.0.PV Batterieleistung` → `javascript_0_pv_batterieleistung`. Für einen
kurzen, sprechenden Namen wie `idm_aussentemperatur` das Feld **Metrik-Name** verwenden.

## Datentyp-Behandlung

VictoriaMetrics-Metriken sind grundsätzlich numerisch:

- **Zahlen** werden unverändert geschrieben.
- **Booleans** werden zu `0.0`/`1.0` konvertiert.
- **Strings** werden als Zahl geparst (z.B. `"21.5"` → `21.5`); nicht parsbare Strings werden mit
  einer Warnung im Log übersprungen (kein Schreiben eines String-Labels, um eine
  Kardinalitätsexplosion zu vermeiden).

Zusätzlich wird automatisch ein Label `unit` gesetzt, sofern das ioBroker-Objekt eine Einheit
(`common.unit`) definiert hat.

## Verbindungsabbruch & Datenverlustschutz

Werte werden zunächst in einem Puffer gesammelt und im konfigurierten Schreibintervall (bzw. bei
Erreichen der maximalen Puffergröße) gesammelt an VictoriaMetrics geschrieben.

Schlägt ein Schreibvorgang fehl (z.B. VM nicht erreichbar), wird für jeden betroffenen
Datenpunkt ein Fehlerzähler erhöht:
- Bei einem Zählerstand `< 10` wird der Punkt erneut gepuffert und beim nächsten Intervall erneut
  versucht.
- Bei Erreichen von `10` wird der Punkt verworfen und der Zähler zurückgesetzt (verhindert
  unbegrenztes Anwachsen des Puffers bei dauerhaft nicht erreichbarem VM).

Zusätzlich wird der Puffer beim sauberen Beenden des Adapters sowie (gedrosselt auf max. einmal
pro Minute) nach fehlgeschlagenen Schreibversuchen persistiert, sodass auch ein harter Absturz
(z.B. Container-Neustart) im normalen Rahmen keine Daten verliert.

## Lesepfad (Phase 2, Proof-of-Concept)

Der Adapter beantwortet `getHistory()`-Anfragen (das, was vis-Chart-Widgets aufrufen), indem
er rohe Datenpunkte der angefragten Metrik aus VictoriaMetrics liest (`/api/v1/export`) und sie
an die geteilte [`@iobroker/aggregate`](https://github.com/ioBroker/aggregate)-Bibliothek
übergibt – dieselbe Bibliothek, die `iobroker.influxdb`, `iobroker.sql` und `iobroker.history`
für Bucket-Aggregation (Durchschnitt/Min/Max/Summe/Anzahl/Perzentil/...), Lücken-Behandlung und
Rand-Interpolation verwenden. Dadurch funktionieren grundsätzlich alle Standard-Aggregationstypen,
ohne dass dieser Adapter die Bucket-Logik selbst nachbauen musste.

**Bekannte Einschränkungen des POC:**
- Nur einzelne `id`-Anfragen (kein `id: '*'` für mehrere Datenpunkte gleichzeitig)
- Kein serverseitiges PromQL-Pushdown (`avg_over_time` etc.) – die Aggregation läuft
  vollständig in JS auf den rohen, unaggregierten Werten; bei sehr langen Zeiträumen mit sehr
  vielen Rohpunkten ist das langsamer als eine native VM-Aggregation (spätere Optimierung)
- Antworten enthalten kein `ack`/`q`/`from` – Phase 1 speichert diese Felder gar nicht erst in
  VictoriaMetrics
- Kein Vorab-Flush noch nicht geschriebener, gepufferter Werte vor einer Abfrage (anders als
  `iobroker.influxdb`) – ein `getHistory()`-Aufruf direkt nach einer Zustandsänderung sieht den
  neuesten Wert ggf. erst nach dem nächsten Schreibintervall

## Sonstige bekannte Einschränkungen

- Kein Multi-Cluster-Support (vminsert/vmselect) – nur ein Single-Node-Ziel.
- Retention/Downsampling wird ausschließlich VictoriaMetrics-seitig konfiguriert
  (`-retentionPeriod`), nicht über diesen Adapter.
- Freie, pro Datenpunkt konfigurierbare Zusatz-Labels (über `unit` hinaus) sind nicht
  implementiert.

## Entwicklung

| Script | Beschreibung |
|--------|--------------|
| `npm run lint` | ESLint |
| `npm run check` | Type-Check (`tsc --noEmit`) |
| `npm run test:js` | Unit-Tests |
| `npm run test:package` | Prüft `package.json`/`io-package.json` |
| `npm run dev-server` | Startet [`dev-server`](https://github.com/ioBroker/dev-server) für einen lokalen Testlauf inkl. Admin-UI |

## Changelog

### 0.2.0
* (Florian Horch) Phase 2 Proof-of-Concept: getHistory()-Lesepfad über die geteilte `@iobroker/aggregate`-Bibliothek

### 0.1.0
* (Florian Horch) Phase 1: Schreibpfad nach VictoriaMetrics (native JSON-Lines-Import-API), Verbindungstest, Puffer/Retry, Historie-Tab-Integration

## License
MIT License

Copyright (c) 2026 Florian Horch <florian.horch@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
