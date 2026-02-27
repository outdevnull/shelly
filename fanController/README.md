# Shelly Bathroom Fan Humidity Control

Intelligent bathroom fan control using dew point and absolute humidity calculations to detect showers and manage fan runtime. Runs on a Shelly switch device with an external Shelly H&T G3 sensor.

## How It Works

Rather than reacting to raw humidity percentage, the script uses **dew point (DP)** and **absolute humidity (AH)** to make smarter decisions:

- **Dew point spike detection** — a rising DP indicates moisture being added to the air (e.g. a shower), not just ambient humidity fluctuation
- **Absolute humidity efficiency check** — compares indoor vs outdoor AH to confirm running the fan will actually remove moisture. If outdoor air is already as humid as indoor, the fan won't run
- **Baseline tracking** — a rolling baseline DP is maintained when the fan is off, so spike detection is always relative to current ambient conditions

### Fan ON Logic
The fan turns on when **both** conditions are true:
1. Indoor DP has risen > `dp_shower_spike` (0.7°C) above baseline — **or** DP is above `dp_sanity_floor` (21°C) for very muggy conditions
2. Indoor AH exceeds outdoor AH by > `ah_efficiency_threshold` (0.4 g/kg) — running the fan is worthwhile

### Fan OFF Logic
The fan turns off when indoor DP drops back to within `dp_stop_threshold` (1.5°C) of baseline. The script checks this:
- On every sensor update (event-driven)
- Every 2 minutes via a poll timer (catches the case where humidity plateaus and the sensor stops firing)

### Safety Net
The Shelly hardware auto-off timer (set to 1 hour) acts as the hard safety cutoff. This is intentionally handled in hardware rather than code — it survives script crashes and watchdog restarts.

---

## Requirements

### Hardware
- Shelly switch device (e.g. Shelly 1 Gen 3)
- Shelly H&T G3 — mounted inside the bathroom (humidity & temperature)
- Shelly H&T G3 — mounted outside (used for outdoor AH efficiency comparison)

### Virtual Components on Shelly Switch

Navigate to your device → **Components** → **Virtual Components** and create:

| Type | ID | Name | Purpose |
|---|---|---|---|
| Number | 200 | Current Humidity | Receives bathroom humidity from H&T |
| Number | 205 | Dew Point | Calculated reference field |
| Number | 206 | Current Temperature | Receives bathroom temperature from H&T |
| Number | 207 | External Humidity | Receives outdoor humidity |
| Number | 208 | External Temperature | Receives outdoor temperature |

---

## Installation

### Step 1: Configure Shelly Auto-Off Timer

1. Go to **Settings** → **switch:0** → **Auto off**
2. Enable **Auto off** and set to **3600 seconds** (1 hour)

This is the hard safety cutoff. The script does not manage its own maximum runtime timer.

### Step 2: Configure Bathroom H&T G3 Sensor Actions

On your **bathroom** Shelly H&T G3:

1. Go to **Actions** → create action with trigger **Humidity change**:
```
http://SHELLY_1_GEN3_IP/rpc/number.set?id=200&value=${ev.rh}
```
2. Create action with trigger **Temperature change**:
```
http://SHELLY_1_GEN3_IP/rpc/number.set?id=206&value=${ev.tC}
```

The H&T G3 will push updates on every 1% humidity change and every 0.5°C temperature change.

### Step 3: Configure Outdoor H&T G3 Sensor Actions

On your **outdoor** Shelly H&T G3:

1. Go to **Actions** → create action with trigger **Humidity change**:
```
http://SHELLY_1_GEN3_IP/rpc/number.set?id=207&value=${ev.rh}
```
2. Create action with trigger **Temperature change**:
```
http://SHELLY_1_GEN3_IP/rpc/number.set?id=208&value=${ev.tC}
```

Replace `SHELLY_1_GEN3_IP` with the IP address of your Shelly 1 Gen 3 switch device in all four URLs above.

### Step 4: Install Main Script (script1_fan.js)

1. Go to **Scripts** → create new script named **Bathroom Fan Control**
2. Paste the contents of `script1_fan.js`
3. Enable **Start on boot**
4. Save and start

### Step 5: Install Watchdog Script (script2_watchdog.js)

1. Create another script named **Fan Control Watchdog**
2. Paste the contents of `script2_watchdog.js`
3. Verify `main_script_id: 1` matches the ID of your main script
4. Enable **Start on boot**
5. Save and start

---

## Configuration

Edit the `CONFIG` object at the top of `script1_fan.js`:

```javascript
let CONFIG = {
  current_humidity_num_id:    200,   // Virtual component ID for bathroom humidity
  temperature_num_id:         206,   // Virtual component ID for bathroom temperature
  external_humidity_num_id:   207,   // Virtual component ID for outdoor humidity
  external_temp_num_id:       208,   // Virtual component ID for outdoor temperature
  dew_point_num_id:           205,   // Virtual component ID for dew point (reference)
  fan_switch_id:              0,     // Switch ID controlling the fan

  dp_shower_spike:            0.7,   // °C DP rise above baseline to trigger fan ON
  dp_sanity_floor:            21.0,  // °C DP absolute floor to trigger fan ON (muggy override)
  dp_stop_threshold:          1.5,   // °C above baseline — fan runs until DP drops below this
  ah_efficiency_threshold:    0.4    // g/kg — minimum AH delta (indoor vs outdoor) to run fan
};
```

| Parameter | Default | Description |
|---|---|---|
| `dp_shower_spike` | 0.7°C | DP rise from baseline to detect a shower |
| `dp_sanity_floor` | 21.0°C | Absolute DP trigger for very muggy conditions |
| `dp_stop_threshold` | 1.5°C | How far above baseline DP must drop before fan stops |
| `ah_efficiency_threshold` | 0.4 g/kg | Minimum indoor/outdoor AH difference to justify running fan |

---

## Console Log Reference

All log output is visible via **Scripts → Console** in the Shelly web interface.

### Log Levels

| Level | When |
|---|---|
| `[INIT]` | Script startup — sensor readings, thresholds, fan state |
| `[TRIGGER]` | Fan turned ON — reason and metrics |
| `[STOP]` | Fan turned OFF by script — DP values at stop |
| `[POLL]` | Every 2 mins while fan is ON — current DP vs stop target |
| `[POLL-STOP]` | Fan turned OFF by poll timer (sensor went quiet) |
| `[STATUS]` | Every 10 mins — full snapshot of all conditions |
| `[WATCHDOG]` | Only on problems — script stopped or sensor offline |

### Example Output

**Startup:**
```
[INIT] Script Started Successfully
[INIT] Current Bathroom: 18C / 79% (DP: 14.8C)
[INIT] Current Outside:  16C / 90.7%
[INIT] Starting AH Delta: 0.53g
[INIT] Thresholds: Spike >0.7C | Stop <baseline+1.5C | AH-Delta >0.4g
[INIT] Fan is currently: OFF
```

**Restart while fan running:**
```
[INIT] Fan is currently: ON | Running ~12 mins (auto-off in 48 mins)
```

**Shower detected:**
```
--- SENSOR UPDATE RECEIVED ---
Values  | DP: 16.20C | AH-In: 14.21g | AH-Out: 12.37g
Metrics | Total Spike: 1.40C | Jump: 0.20C | AH-Delta: 1.84
Status  | Spike:true | Muggy:false | Efficient:true | Fan:OFF
[TRIGGER] Fan ON [SHOWER SPIKE] DP:+1.4 AH-D:1.8
```

**Fan running — sensor update:**
```
Status  | Spike:true | Muggy:false | Efficient:true | Fan:ON | Stop when DP <16.3C (now 15.9C, delta +1.10C of 1.5C needed)
```

**Fan running — poll check:**
```
[POLL] Fan still ON | Stop when DP <16.3C (now 15.8C, delta +1.00C of 1.5C needed)
```

**Fan off:**
```
[STOP] Fan OFF. Air stabilized. DP:15.1C (baseline+0.30C)
```

**Periodic status (fan off):**
```
[STATUS] Bath:18.1C/79% DP:14.8C | Out:16C/90.7% | AH-Delta:0.53g | Baseline:14.8C | Fan:OFF
```

---

## Watchdog (script2_watchdog.js)

The watchdog runs independently and checks every 30 seconds that:
1. The main fan script is still running — restarts it if stopped
2. The H&T sensor is still sending data — restarts the main script if no update received in 90 minutes

The watchdog is **silent when healthy** — it only logs when it takes action or detects a problem.

```javascript
let CONFIG = {
  main_script_id:     1,
  humidity_id:        200,
  temperature_id:     206,
  check_interval:     30000,   // Check every 30 seconds
  max_stale_sec:      5400,    // Alert after 90 minutes without sensor update
  startup_grace_sec:  3600     // 60 minute grace period after boot
};
```

---

## Troubleshooting

### Fan doesn't turn on
- Check `number:200` is updating when humidity changes — verify H&T action URLs
- Check console for sensor update trace — is `Efficient:false` blocking the trigger?
- If outdoor humidity is very high, AH delta may be below `ah_efficiency_threshold` — try lowering to `0.3`
- Check baseline DP in console — if it was set during elevated conditions, spike detection needs a larger rise

### Fan turns off too early
- Increase `dp_stop_threshold` (e.g. `2.0`)
- Check if sensor is updating frequently enough — if humidity plateaus below 1% change, poll timer handles this every 2 mins

### Fan runs too long
- Decrease `dp_stop_threshold` (e.g. `1.0`)
- Shelly hardware auto-off timer is the hard backstop at 1 hour

### No outdoor sensor data
- If outdoor sensor is unavailable, the script falls back to using indoor AH for both sides — `ahDelta` will be 0 and `isEfficient` will be false, meaning the fan won't trigger automatically
- Ensure outdoor sensor actions are configured and firing

### Watchdog keeps restarting the script
- Check `max_stale_sec` — 90 minutes is relaxed enough for normal H&T G3 sleep cycles
- If sensor is genuinely going offline, check H&T battery level and WiFi signal

---

## Version History

- **v2.0** (2026-02-28) — Full rewrite
  - Replaced raw RH% spike detection with dew point based detection
  - Added absolute humidity efficiency gate (indoor vs outdoor AH comparison)
  - Added outdoor sensor support
  - Removed manual button mode
  - Removed code-level max runtime — delegated to Shelly hardware auto-off timer
  - Added periodic poll timer (2 min) for stop condition when sensor goes quiet
  - Added periodic status log (10 min)
  - Improved restart logging — shows fan runtime from hardware timer
  - Watchdog simplified — silent when healthy, logs on problems only

- **v1.0** (2026-02-14) — Initial release
  - RH% spike detection
  - Manual timer mode
  - Baseline tracking
  - Watchdog support
