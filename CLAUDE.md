# Shelly Fan Controller — Claude Instructions

## Git workflow

- All work happens on feature branches (`claude/<feature>-<id>`)
- **Always merge to `main` when work is complete** — push to both the feature branch and main
- Resolve conflicts by preferring the feature branch version unless it's clearly stale

## Project layout

```
fanController/
  bootstrap.js       # id:1 — user-started, fresh install + full provisioning
  supervisor.js      # id:2 — autostart:true, permanent health monitor + update scheduler
  updater.js         # id:3 — OTA deploy, started by supervisor, stops self
  kvs_restore        # id:4 — generated dynamically by updater, no source file
  fancontroller.js   # id:5 — fan automation logic, lifecycle managed by supervisor
  manifest.json      # source of truth for script versions, KVS defaults, device config
  watchdog.js        # superseded — kept for reference only
  watchdog_bootstrap.js  # superseded — kept for reference only
```

## Versioning

- Each `.js` file has `// version: X.Y.Z` on line 1 — this is what the updater compares remotely vs locally
- `manifest.json` → `scripts[].version` is informational only, not used for update decisions
- `manifest.json` → `kvsDefaultsVersion` must be bumped whenever `kvsDefaults` changes — triggers force-write on all devices

## KVS keys

| Key | Owner | Purpose |
|-----|-------|---------|
| `wd.br` | bootstrap | Git branch to fetch from (e.g. `main`) |
| `wd.pt` | bootstrap | Path within repo (e.g. `fanController`) |
| `wd.pv` | bootstrap | Provisioned flag (`1` = done) |
| `wd.kvd_ver` | updater | Applied kvsDefaults version |
| `wd.last_upd` | supervisor | Day-number of last updater run |
| `wd.tz_offset` | supervisor | Seconds offset from UTC for 2am scheduling (default 36000 = AEST) |
| `wd.force_upd` | user | Set to `1` to trigger immediate update on next 60s tick |
| `wd.health_interval` | supervisor | Fan health check interval in seconds (default 300) |
| `wd.rpc_delay` | shared | RPC queue delay in ms (default 200) |

## Triggering an update now

```
POST http://<device-ip>/rpc/KVS.Set
{"key": "wd.force_upd", "value": "1"}
```

Supervisor picks it up within 60 seconds.

## Memory notes (Shelly Gen3 ~1712 jsvars total)

- supervisor + fancontroller run concurrently at steady state (~150 + ~400 jsvars)
- updater runs WITHOUT fancontroller (supervisor stops it first) to avoid OOM
- FCHK=1024 in updater (safe for heap); FCHK=2048 in bootstrap (nothing else running)
- supervisor self-update: updater deploys new supervisor.js via PutCode while it runs; new code takes effect on next reboot
