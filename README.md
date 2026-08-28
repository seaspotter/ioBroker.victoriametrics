![Logo](admin/victoriametrics.png)
# iobroker.victoriametrics

[![NPM version](https://img.shields.io/npm/v/iobroker.victoriametrics.svg)](https://www.npmjs.com/package/iobroker.victoriametrics)

**Tests:** ![Test and Release](https://github.com/seaspotter/iobroker.victoriametrics/workflows/Test%20and%20Release/badge.svg)

Schreibt ioBroker-Datenpunkt-Historie nativ in [VictoriaMetrics](https://victoriametrics.com/) – über
dessen [JSON-Lines-Import-API](https://docs.victoriametrics.com/#how-to-import-data-in-json-line-format),
mit echten Prometheus-Labels statt Feld-Namens-Suffixen (wie sie z.B. beim Schreiben über den
InfluxDB-Kompatibilitätslayer entstehen, etwa `Batterieleistung_value`).

**Hinweis:** Dies ist Phase 1 dieses Adapters – **nur Schreibpfad**. Es gibt (noch) keinen
`getHistory()`-Lesezugriff; zum Anzeigen der Daten wird direkt gegen VictoriaMetrics per PromQL
abgefragt (z.B. mit Grafana). Der Adapter ist privat und nicht im offiziellen
ioBroker-Repository gelistet.

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
| Metrik-Name (optional) | Überschreibt die automatisch aus der Objekt-ID abgeleitete Metrik (`__name__`), siehe unten |
| Runden auf Nachkommastellen (optional) | Rundet den Wert vor dem Schreiben; leer lassen für keine Rundung |
| Minimale Änderung (optional) | Werte, die sich vom zuletzt geschriebenen Wert um weniger als diesen Betrag unterscheiden, werden nicht geschrieben; leer lassen für keine Filterung |

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

## Bekannte Einschränkungen (Phase 1)

- Kein `getHistory()`-Lesezugriff – vis-Chart-Widgets können (noch) nicht direkt gegen diesen
  Adapter abgefragt werden. Für Visualisierung z.B. Grafana direkt gegen VictoriaMetrics nutzen.
- Kein Multi-Cluster-Support (vminsert/vmselect) – nur ein Single-Node-Ziel.
- Retention/Downsampling wird ausschließlich VictoriaMetrics-seitig konfiguriert
  (`-retentionPeriod`), nicht über diesen Adapter.
- Freie, pro Datenpunkt konfigurierbare Zusatz-Labels (über `unit` hinaus) sind nicht Teil von
  Phase 1.

## Entwicklung

| Script | Beschreibung |
|--------|--------------|
| `npm run lint` | ESLint |
| `npm run check` | Type-Check (`tsc --noEmit`) |
| `npm run test:js` | Unit-Tests |
| `npm run test:package` | Prüft `package.json`/`io-package.json` |
| `npm run dev-server` | Startet [`dev-server`](https://github.com/ioBroker/dev-server) für einen lokalen Testlauf inkl. Admin-UI |

## Changelog

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
