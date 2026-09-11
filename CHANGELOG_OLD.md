The newest change log is in README.md
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
