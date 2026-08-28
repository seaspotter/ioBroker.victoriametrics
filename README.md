![Logo](admin/victoriametrics.png)
# iobroker.victoriametrics

<!-- Diese Badges brauchen eine npm-Veröffentlichung bzw. Aufnahme ins offizielle
     ioBroker-Repository/Weblate und funktionieren daher noch nicht - sobald einer dieser
     Schritte passiert, hier einkommentieren:
![Number of Installations](https://iobroker.live/badges/victoriametrics-installed.svg)
![Number of Installations](https://iobroker.live/badges/victoriametrics-stable.svg)
[![NPM version](https://img.shields.io/npm/v/iobroker.victoriametrics.svg)](https://www.npmjs.com/package/iobroker.victoriametrics)
[![Downloads](https://img.shields.io/npm/dm/iobroker.victoriametrics.svg)](https://www.npmjs.com/package/iobroker.victoriametrics)
[![Translation status](https://weblate.iobroker.net/widgets/adapters/-/victoriametrics/svg-badge.svg)](https://weblate.iobroker.net/engage/adapters/?utm_source=widget)
-->
![Test and Release](https://github.com/seaspotter/iobroker.victoriametrics/workflows/Test%20and%20Release/badge.svg)

Schreibt ioBroker-Datenpunkt-Historie nativ in [VictoriaMetrics](https://victoriametrics.com/) – über
dessen [JSON-Lines-Import-API](https://docs.victoriametrics.com/#how-to-import-data-in-json-line-format),
mit echten Prometheus-Labels statt Feld-Namens-Suffixen (wie sie z.B. beim Schreiben über den
InfluxDB-Kompatibilitätslayer entstehen, etwa `Wohnzimmer_Temperatur_value`).

Schreibt Datenpunkt-Änderungen gepuffert an VictoriaMetrics und beantwortet `getHistory()`-Anfragen
(damit vis-Chart-Widgets direkt gegen diesen Adapter abfragen können) – siehe [Lesepfad](#lesepfad)
unten für Details und bekannte Einschränkungen. Für Visualisierung ohne vis (z.B. Grafana)
weiterhin direkt gegen VictoriaMetrics per PromQL abfragen. Der Adapter ist privat und (noch)
nicht im offiziellen ioBroker-Repository gelistet.

## Voraussetzungen

- Eine laufende VictoriaMetrics-Instanz (Single-Node), erreichbar per HTTP(S) – siehe
  [Installation von VictoriaMetrics](#installation-von-victoriametrics) unten
- ioBroker js-controller >= 6.0.11, Admin >= 7.0.23

## Installation von VictoriaMetrics

VictoriaMetrics läuft als einzelne, eigenständige Binary/Docker-Image – kein separater
Datenbank-Server-Setup wie bei InfluxDB nötig. Offizielle Installationsanleitungen für alle
Plattformen (Linux-Binary, Docker, Kubernetes-Helm-Chart, …): siehe
[VictoriaMetrics-Dokumentation](https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/).

### Per Docker

```bash
docker run -d --name victoriametrics \
  -p 8428:8428 \
  -v victoria-metrics-data:/victoria-metrics-data \
  victoriametrics/victoria-metrics:latest \
  --storageDataPath=/victoria-metrics-data \
  --retentionPeriod=100y
```

Danach ist VictoriaMetrics unter `http://<Docker-Host>:8428` erreichbar (Health-Check:
`http://<Docker-Host>:8428/health`, VMUI: `http://<Docker-Host>:8428/vmui/`). Offizielles
Docker-Image: [victoriametrics/victoria-metrics auf Docker Hub](https://hub.docker.com/r/victoriametrics/victoria-metrics/).
Für dauerhaften Betrieb empfiehlt sich ein Volume/Bind-Mount für `-storageDataPath` (siehe
oben) sowie – je nach Umgebung – ein `docker-compose.yml` mit `restart: unless-stopped`.

### Ohne Docker

Statisch gelinktes Binary für die jeweilige Plattform von der
[GitHub-Releases-Seite](https://github.com/VictoriaMetrics/VictoriaMetrics/releases) laden,
entpacken und starten:

```bash
./victoria-metrics-prod --storageDataPath=/path/to/data --retentionPeriod=100y
```

Ausführliche Installationsanleitungen (inkl. systemd-Service, Kubernetes, Cluster-Setup) in der
[offiziellen Dokumentation](https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/#how-to-start-victoriametrics).

## Installation des Adapters

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
aktuell eingegebenen (noch nicht gespeicherten) Werten geprüft; bei Erfolg zeigt die Meldung
zusätzlich die aktuell konfigurierte Retention an.

Beim Start des Adapters wird zusätzlich die aktuell auf dem VM-Server konfigurierte Retention
geloggt (`VictoriaMetrics unter ... erreichbar (Retention: 100y)`) – reines Anzeigen, siehe
[Retention](#retention) unten, warum sich das nicht über den Adapter ändern lässt.

In der linken Seitenleiste von ioBroker.admin erscheint außerdem ein **"VictoriaMetrics"**-Menüpunkt
(analog zu Node-RED/Zigbee2MQTT), der die VMUI (VictoriaMetrics' eigene Web-Oberfläche zum
Ausführen von PromQL-Abfragen, Graphen etc.) direkt unter `http://<Host>:<Port>/vmui/` einbettet.
**Achtung:** Läuft ioBroker.admin über HTTPS, aber VictoriaMetrics nur über HTTP, blockiert der
Browser das Einbetten (Mixed-Content-Schutz) – dann öffnet sich eine leere Seite. Abhilfe nur durch
VictoriaMetrics ebenfalls über HTTPS erreichbar zu machen, ein Workaround im Adapter ist nicht möglich.

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
| Nur Änderungen aufzeichnen | Schreibt einen Wert nur, wenn er sich vom zuletzt geschriebenen Wert unterscheidet |
| Relog-Intervall (ms, optional) | Nur bei aktiviertem "Nur Änderungen aufzeichnen": schreibt einen unveränderten Wert spätestens nach dieser Zeit erneut, damit im Chart keine Lücken entstehen |

Entprellzeit und Blockzeit sind kombinierbar mit den übrigen Filtern: Entprellzeit
verzögert das Schreiben, bis der Wert eine Zeit lang stabil war; Blockzeit begrenzt,
wie oft ein Datenpunkt maximal geschrieben wird, unabhängig davon, ob er sich ändert.
"Nur Änderungen aufzeichnen" ist unabhängig von "Minimale Änderung" nutzbar: Erstere schreibt
nur bei einer *exakten* Wertänderung (mit optionalem periodischem Relog), Letztere filtert
Änderungen unterhalb eines *Schwellenwerts*.

### Tab "Standardwerte"

Dieselben Felder (außer Metrik-Name) lassen sich auch **instanzweit** setzen, im Instanz-Konfig-Tab
"Standardwerte". Sie gelten für alle Datenpunkte, die im Historie-Tab kein eigenes Feld gesetzt
haben – so muss nicht jeder einzelne Datenpunkt konfiguriert werden. Ein Datenpunkt-eigener Wert
überschreibt immer den instanzweiten Standard.

## Metrik-Namensbildung

Der Prometheus-Metrikname (`__name__`) wird wie folgt ermittelt:

1. Ist im Historie-Tab ein **Metrik-Name** (`aliasId`) gesetzt, wird dieser verwendet.
2. Andernfalls wird die **ioBroker-Objekt-ID** verwendet (nicht der Objektname, da dieser sich
   unbemerkt ändern und die Zeitreihe stillschweigend spalten könnte).

Der gewählte Name wird anschließend normalisiert: kleingeschrieben, `.` wird zu `_`, jede Folge
ungültiger Zeichen wird zu einem einzelnen `_` zusammengefasst, führende/trailing `_` entfernt,
und falls das Ergebnis mit einer Ziffer beginnt, wird ein `_` vorangestellt.

Beispiel: `javascript.0.Room Temperature` → `javascript_0_room_temperature`. Für einen
kurzen, sprechenden Namen wie `room_temperature` das Feld **Metrik-Name** verwenden.

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

## Lesepfad

Der Adapter beantwortet `getHistory()`-Anfragen (das, was vis-Chart-Widgets aufrufen), indem
er Datenpunkte der angefragten Metrik aus VictoriaMetrics liest und sie an die geteilte
[`@iobroker/aggregate`](https://github.com/ioBroker/aggregate)-Bibliothek übergibt – dieselbe
Bibliothek, die `iobroker.influxdb`, `iobroker.sql` und `iobroker.history` für
Bucket-Aggregation (Durchschnitt/Min/Max/Summe/Anzahl/Perzentil/...), Lücken-Behandlung und
Rand-Interpolation verwenden. Dadurch funktionieren grundsätzlich alle Standard-Aggregationstypen,
ohne dass dieser Adapter die Bucket-Logik selbst nachbauen musste.

**Serverseitiges Pushdown:** für die Aggregationsmethoden `average`, `min`, `max`, `total` und
`count` mit bekanntem Zeit-`step` rechnet VictoriaMetrics selbst per PromQL (`avg_over_time`,
`min_over_time`, `max_over_time`, `sum_over_time`, `count_over_time`) – der Adapter überträgt
dann nur die fertigen Bucket-Werte statt aller Rohpunkte. Für `onchange`/`none`/`minmax` sowie
`percentile`/`quantile`/`integral` (kein direktes PromQL-Äquivalent) und immer dann, wenn das
Pushdown fehlschlägt, wird transparent auf den Rohdaten-Pfad (`/api/v1/export` + JS-seitige
Aggregation) zurückgefallen.

**`id: '*'`:** liefert die letzten Rohwerte über alle *aktuell in Admin aktivierten*
Datenpunkte hinweg (nicht verwaiste Metriken zwischenzeitlich deaktivierter Datenpunkte),
jeweils mit `id`-Feld pro Punkt. Aggregation wird hierfür nicht unterstützt (ergibt über
verschiedene Metriken hinweg keinen Sinn) – es werden immer Rohwerte zurückgegeben.

**Weitere bekannte Einschränkungen:**
- Antworten enthalten kein `ack`/`q`/`from` – der Adapter speichert diese Felder gar nicht erst
  in VictoriaMetrics
- Kein Vorab-Flush noch nicht geschriebener, gepufferter Werte vor einer Abfrage (anders als
  `iobroker.influxdb`) – ein `getHistory()`-Aufruf direkt nach einer Zustandsänderung sieht den
  neuesten Wert ggf. erst nach dem nächsten Schreibintervall

### Zugriff aus dem JavaScript-Adapter

```javascript
// Letzte 50 Rohwerte
sendTo('victoriametrics.0', 'getHistory', {
    id: 'javascript.0.exampleValue',
    options: {
        end: Date.now(),
        count: 50,
        aggregate: 'onchange',
    }
}, function (result) {
    for (var i = 0; i < result.result.length; i++) {
        console.log(result.result[i].ts + ' ' + result.result[i].val);
    }
});

// Stundenmittelwert der letzten 24h
var end = Date.now();
sendTo('victoriametrics.0', 'getHistory', {
    id: 'javascript.0.exampleValue',
    options: {
        start: end - 24 * 3600000,
        end: end,
        aggregate: 'average',
        step: 3600000,
    }
}, function (result) {
    console.log(JSON.stringify(result.result));
});

// Letzte 20 Rohwerte über alle aktivierten Datenpunkte hinweg
sendTo('victoriametrics.0', 'getHistory', {
    id: '*',
    options: {
        end: Date.now(),
        count: 20,
        addId: true,
    }
}, function (result) {
    for (var i = 0; i < result.result.length; i++) {
        console.log(result.result[i].id + ' ' + result.result[i].val);
    }
});
```

Unterstützte `options`-Felder und `aggregate`-Werte entsprechen dem ioBroker-Standard (siehe
[`iobroker.history`-Dokumentation](https://github.com/ioBroker/ioBroker.history#access-values-from-javascript-adapter)
für die vollständige Referenz) – mit den oben genannten Einschränkungen.

## Datenmanagement / Skript-Schnittstellen

Der Adapter beantwortet zusätzlich drei weitere ioBroker-Message-Kommandos (`sendTo`), z.B. für
Skripte oder Migrationswerkzeuge:

### features

Capability-Discovery:

```javascript
sendTo('victoriametrics.0', 'features', {}, function (result) {
    console.log(JSON.stringify(result.supportedFeatures)); // ['storeState', 'deleteAll']
});
```

### storeState

Schreibt einen oder mehrere historische Punkte, z.B. um alte Historie aus einer anderen Quelle
(z.B. InfluxDB) nachträglich zu importieren:

```javascript
sendTo('victoriametrics.0', 'storeState', {
    id: 'javascript.0.exampleValue',
    state: { ts: 1690000000000, val: 512.3 },
    rules: true, // Rundung + Schwellenwert-/Nullwert-Filter anwenden (siehe unten)
}, result => console.log(JSON.stringify(result)));

// auch als Batch für dieselbe id:
sendTo('victoriametrics.0', 'storeState', {
    id: 'javascript.0.exampleValue',
    state: [
        { ts: 1690000000000, val: 512.3 },
        { ts: 1690000060000, val: 498.1 },
    ],
}, result => console.log(JSON.stringify(result)));

// oder als Array mehrerer ids:
sendTo('victoriametrics.0', 'storeState', [
    { id: 'javascript.0.a', state: { ts: 1690000000000, val: 1 } },
    { id: 'javascript.0.b', state: { ts: 1690000000000, val: 2 } },
], result => console.log(JSON.stringify(result)));
```

`rules: true` wendet Rundung und Schwellenwert-/Nullwert-Filter an (Werte-Validität, sinnvoll
auch für Importe); Entprellzeit/Blockzeit/Minimale Änderung werden **immer** ignoriert, da diese
auf Live-Zustandsänderungen ausgelegt sind und für rückdatierte Bulk-Importe keinen Sinn ergeben.
Erfordert nicht, dass der Datenpunkt aktuell für Live-Historisierung aktiviert ist. Bei
Teilfehlern liefert die Antwort `{error, errors: [...], successCount}`, bei vollem Erfolg
`{success: true, successCount}`.

### deleteAll

Löscht die komplette in VictoriaMetrics gespeicherte Historie eines Datenpunkts:

```javascript
sendTo('victoriametrics.0', 'deleteAll', { id: 'javascript.0.exampleValue' },
    result => console.log(JSON.stringify(result)));

// auch als Array mehrerer ids:
sendTo('victoriametrics.0', 'deleteAll', [
    { id: 'javascript.0.a' },
    { id: 'javascript.0.b' },
], result => console.log(JSON.stringify(result)));
```

**Bewusst nicht implementiert:** `delete`/`deleteRange`/`update` (Einzelpunkt-Löschung/-Bearbeitung,
wie es das influxdb-Admin-UI per Klick auf einen Chart-Punkt anbietet). VictoriaMetrics kann
technisch keine einzelnen Datenpunkte löschen oder bearbeiten – nur ganze Zeitreihen per
Label-Match, da die Speicherung auf unveränderlichen, zeitsortierten Blöcken beruht (wie bei
Prometheus). Ein Löschen "einzelner Punkte" würde in Wirklichkeit die komplette Zeitreihe löschen –
das wäre überraschend und gefährlich, deshalb absichtlich weggelassen.

## Retention

VictoriaMetrics' Retention ist ein **serverseitiges Start-Flag** (`-retentionPeriod`) des
VM-Prozesses selbst, nicht per HTTP-API zur Laufzeit änderbar (anders als z.B. InfluxDB, wo der
Adapter per `ALTER RETENTION POLICY` aktiv einen Wert setzen kann). Dieser Adapter zeigt die
aktuell konfigurierte Retention deshalb nur lesend an – zum Ändern muss VM mit einem anderen
`-retentionPeriod`-Wert neu gestartet werden (bei Docker: den `--retentionPeriod=...`-Parameter
im `docker run`/`docker-compose.yml` ändern und den Container neu erstellen).

Sichtbar ist die aktuelle Retention an drei Stellen (alle read-only, beim Adapterstart einmalig
vom `/flags`-Endpunkt gelesen):
- Datenpunkt **`<instance>.info.retention`** (String, z.B. `"100y"`) – für Skripte/VIS
- Log-Eintrag beim Start (`VictoriaMetrics unter ... erreichbar (Retention: 100y)`)
- Erfolgs-Meldung des Buttons **"Verbindung testen"** im Tab "Verbindung"

**Details:**
- **Standard-Retention**, falls `-retentionPeriod` nicht gesetzt ist: **1 Monat (31 Tage)**.
- **Minimum**: 24h/1 Tag. VictoriaMetrics unterstützt keine "unbegrenzte" Retention im engeren
  Sinne, aber beliebig hohe Werte sind möglich, z.B. `-retentionPeriod=100y`.
- Daten werden **pro Monats-Partition** gelöscht, jeweils am ersten Tag des neuen Monats – nicht
  sofort beim Erreichen der Grenze. Der maximale Plattenplatzverbrauch liegt daher bei
  `retentionPeriod + 1 Monat`.
- Eine bestehende Retention kann jederzeit **verlängert** werden, ohne Daten zu verlieren. Wird
  sie **verkürzt**, werden Daten außerhalb der neuen Grenze beim nächsten Monatswechsel gelöscht.
- Ausführliche Details: [VictoriaMetrics-Dokumentation, Abschnitt "Retention"](https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/#retention).

## Sonstige bekannte Einschränkungen

- Kein Multi-Cluster-Support (vminsert/vmselect) – nur ein Single-Node-Ziel.
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

### **WORK IN PROGRESS**

### 0.4.0 (2026-08-28)
* (SeaSpotter) Fix: VMUI-Sidebar-Link warf einen `URIError` beim Anklicken (`%native_protocol%` wurde nicht ersetzt) – korrekte Platzhalter-Syntax laut Admin-Quellcode ist `%protocol%`/`%host%`/`%port%` ohne `native_`-Präfix
* (SeaSpotter) Serverseitiges PromQL-Pushdown für `getHistory` bei den Aggregationsmethoden average/min/max/total/count (`avg_over_time` etc.) statt Rohdaten-Export + JS-Aggregation
* (SeaSpotter) `getHistory` mit `id: '*'`: letzte Rohwerte über alle aktuell aktivierten Datenpunkte hinweg
* (SeaSpotter) Neue Pro-Datenpunkt-/Standardwert-Filter `changesOnly` (nur Änderungen aufzeichnen) und `changesRelogInterval` (periodisches Relog unveränderter Werte)
* (SeaSpotter) Retention jetzt auch als eigener Datenpunkt `info.retention` und im Erfolgs-Alert von "Verbindung testen" sichtbar, nicht nur im Log
* (SeaSpotter) Eigenes Adapter-Icon

### 0.3.0 (2026-08-28)
* (SeaSpotter) VMUI-Sidebar-Link in der Admin-Seitenleiste (`common.adminTab`, analog Node-RED/Zigbee2MQTT)
* (SeaSpotter) Instanzweite Standardwerte für alle Historie-Filter (round/changesMinDelta/debounceTime/blockTime/ignoreBelow-/AboveNumber/ignoreZero) – Datenpunkt-eigene Werte überschreiben weiterhin den Standard
* (SeaSpotter) Retention wird beim Start read-only geloggt (`/flags`-Endpunkt)
* (SeaSpotter) Neue Message-Kommandos `storeState` (Bulk-Import/Migration), `deleteAll` (Historie eines Datenpunkts löschen) und `features` (Capability-Discovery)
* (SeaSpotter) `round`, `changesMinDelta`, `debounceTime`, `blockTime`, `ignoreBelowNumber`/`ignoreAboveNumber`, `ignoreZero` als Pro-Datenpunkt-Filter ergänzt

### 0.2.0 (2026-08-28)
* (SeaSpotter) `getHistory()`-Lesepfad über die geteilte `@iobroker/aggregate`-Bibliothek

### 0.1.0 (2026-08-28)
* (SeaSpotter) Schreibpfad nach VictoriaMetrics (native JSON-Lines-Import-API), Verbindungstest, Puffer/Retry, Historie-Tab-Integration

## License
MIT License

Copyright (c) 2026 SeaSpotter <seatowage@gmail.com>

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
