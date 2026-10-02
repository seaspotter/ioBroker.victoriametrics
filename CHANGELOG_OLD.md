The newest change log is in README.md
## 0.4.0 (2026-08-28)
* (SeaSpotter) Fix: the VMUI sidebar link threw a `URIError` on click (`%native_protocol%` wasn't substituted) – correct placeholder syntax per Admin's own source is `%protocol%`/`%host%`/`%port%` without the `native_` prefix
* (SeaSpotter) Server-side PromQL pushdown for `getHistory` on the average/min/max/total/count aggregation methods (`avg_over_time` etc.) instead of raw-data export + JS aggregation
* (SeaSpotter) `getHistory` with `id: '*'`: latest raw values across all currently enabled datapoints
* (SeaSpotter) New per-datapoint/default filters `changesOnly` (log changes only) and `changesRelogInterval` (periodic relog of unchanged values)
* (SeaSpotter) Retention now also exposed as its own `info.retention` datapoint and in the "Test connection" success alert, not just the log
* (SeaSpotter) New original adapter icon

## 0.3.0 (2026-08-28)
* (SeaSpotter) VMUI sidebar link in the Admin sidebar (`common.adminTab`, similar to Node-RED/Zigbee2MQTT)
* (SeaSpotter) Instance-wide defaults for all history filters (round/changesMinDelta/debounceTime/blockTime/ignoreBelow-/AboveNumber/ignoreZero) – a datapoint's own value still overrides the default
* (SeaSpotter) Retention is now logged read-only on start (`/flags` endpoint)
* (SeaSpotter) New message commands `storeState` (bulk import/migration), `deleteAll` (delete a datapoint's history) and `features` (capability discovery)
* (SeaSpotter) Added `round`, `changesMinDelta`, `debounceTime`, `blockTime`, `ignoreBelowNumber`/`ignoreAboveNumber`, `ignoreZero` as per-datapoint filters

## 0.2.0 (2026-08-28)
* (SeaSpotter) `getHistory()` read path via the shared `@iobroker/aggregate` library

## 0.1.0 (2026-08-28)
* (SeaSpotter) Write path to VictoriaMetrics (native JSON-lines import API), connection test, buffer/retry, History tab integration
