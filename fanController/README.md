# Shelly Bathroom Fan Humidity Control

Intelligent bathroom fan control for Shelly 1 Gen 3 with humidity sensor integration. Automatically detects humidity spikes (showers) and manages fan runtime with dual-mode operation.

## Features

- 🚿 **Auto Detection**: Detects humidity spikes (e.g., shower starting) and automatically turns fan ON
- ⏱️ **Smart Turn-Off**: Automatically turns fan OFF when humidity returns to near-baseline levels
- 🚽 **Manual Mode**: Button press runs fan for configurable duration (default: 15 minutes)
- 🛡️ **Safety Net**: Maximum runtime limit prevents fan from running indefinitely (default: 60 minutes)
- 📊 **Comprehensive Logging**: Event log tracking and real-time status display
- 🔄 **Crash Protection**: Debounce logic and watchdog script support
- 🎯 **Baseline Tracking**: Intelligent baseline humidity tracking prevents false triggers from slow ambient changes

## How It Works

### Auto Mode (Humidity Spike Detection)
1. Script monitors baseline humidity when fan is OFF
2. When humidity rises ≥3% from baseline → Fan turns ON automatically
3. Fan runs until humidity drops to within 2% of original baseline
4. Safety: Maximum 60-minute runtime if humidity stays high

### Manual Mode (Button Press)
1. User presses wall switch button
2. Fan runs for 15 minutes (configurable)
3. Auto-turns OFF after timer expires
4. If humidity spikes during manual mode, continues in manual mode (timer runs its course)

### Baseline Intelligence
- Baseline only updates every 5 minutes when fan is OFF
- Prevents "chasing" slow ambient humidity rises
- Resets immediately when fan turns OFF
- Allows spike detection to accumulate over gradual increases

## Requirements

### Hardware
- Shelly 1 Gen 3 (relay/switch)
- Shelly H&T (humidity & temperature sensor) or compatible humidity sensor
- Wall-mounted momentary switch connected to input:0

### Shelly Firmware
- Shelly 1 Gen 3 firmware with scripting support
- Tested on firmware version 1.x+

## Installation

### Step 1: Create Virtual Components

Navigate to your Shelly 1 Gen 3 device → **Components** → **Virtual Components**

**Number Components:**
| ID | Name | Min | Max | Purpose |
|---|---|---|---|---|
| 200 | Current Humidity | 0 | 100 | Receives humidity readings from sensor |
| 201 | Baseline Humidity | 0 | 100 | Stores last "calm" humidity level |
| 202 | Fan Start Humidity | 0 | 100 | Records humidity when fan turns ON |
| 203 | Last Baseline Update | 0 | 9999999999 | Unix timestamp of last baseline update |
| 204 | Auto Start Time | 0 | 9999999999 | Unix timestamp when auto mode started |
| 205 | Dew Point | 0 | 100 | Calculated field T - (100-RH/5) |
| 206 | Current Temperature | 0 | 100 | Temperature C |

**Text Components:**
| ID | Name | Enable Event Log | Purpose |
|---|---|---|---|
| 200 | Last Updated | ✅ Yes | Shows last important event with timestamp |

### Step 2: Configure Switch Auto-Off

**CRITICAL**: This must be enabled for timer functionality to work!

1. Go to **Settings** → **switch:0** → **Auto off**
2. ✅ **Enable the "Auto off" checkbox**
3. Set value to any number (e.g., 3600 seconds)
   - The script will override this value when needed
   - But the checkbox MUST be enabled for `toggle_after` to work

### Step 3: Configure H&T Sensor Action

On your Shelly H&T sensor device:

1. Go to **Actions**
2. Create new action with trigger: **Humidity change**
3. Set action URL:
```
   http://192.168.X.X/rpc/number.set?id=200&value=${ev.rh}
```
4. Create new action with trigger: **Temperature change**
5. Set action URL:
```
   http://192.168.X.X/rpc/number.set?id=206&value=${ev.tC}
```
   Replace `192.168.X.X` with your Shelly 1 Gen 3 IP address

This sends humidity updates to `number:200` whenever humidity changes by ±1% or periodically, temperature updates will be sent to `number:206` whenever temperature changes by ±0.5C or periodically.

### Step 4: Install Main Script

1. Go to **Scripts** on your Shelly 1 Gen 3
2. Create new script, name it "Bathroom Fan Control"
3. Paste the script code (see `bathroom-fan-control.js`)
4. ✅ Enable "Start on boot"
5. Save and start the script

### Step 5: (Optional) Install Watchdog Script

For automatic recovery if the main script crashes:

1. Create another new script, name it "Fan Control Watchdog"
2. Paste the watchdog script code (see `fan-watchdog.js`)
3. Update `MAIN_SCRIPT_ID` to match your main script's ID (check in Scripts list)
4. ✅ Enable "Start on boot"
5. Save and start the script

## Configuration

Edit the `CONFIG` object at the top of the script:
```javascript
let CONFIG = {
  // Logic thresholds
  spike_threshold:            3.0,   // % rise needed to auto turn ON
  auto_return_threshold:      2.0,   // % above baseline to turn OFF (for auto/shower mode)
  manual_runtime_seconds:     900,   // 15 minutes for manual mode (bathroom #2)
  auto_max_runtime_seconds:   3600,  // Max 1 hour for auto mode (safety net)
  baseline_update_interval:   300,   // Only update baseline every 5 minutes
  dew_point_num_id:           205,   // number:205 - Calculated field T - (100-RH/5)
  temperature_num_id:         206,   // number:206 - Temperature C
};
```

### Configuration Parameters

| Parameter | Default | Description |
|---|---|---|
| `spike_threshold` | 3.0 | Humidity rise % required to trigger auto turn-ON |
| `auto_return_threshold` | 2.0 | % above baseline before auto turn-OFF |
| `dew_point_gap_threshold` | 7.0 | Max °C gap to confirm it is a shower |
| `manual_runtime_seconds` | 900 | Duration of manual button press (15 min) |
| `auto_max_runtime_seconds` | 3600 | Maximum runtime for auto mode (60 min safety) |
| `baseline_update_interval` | 300 | Seconds between baseline updates (5 min) |

## Usage Examples

### Example 1: Morning Shower
```
Initial: Baseline 45%, Fan OFF
07:00 - Shower starts, humidity rises to 48% (+3%) → AUTO FAN ON
07:05 - Humidity peaks at 85%
07:15 - Shower ends, humidity dropping
07:20 - Humidity drops to 47% (≤ 45% + 2%) → AUTO FAN OFF
Total runtime: 20 minutes
```

### Example 2: Bathroom Break
```
Initial: Baseline 50%, Fan OFF
10:00 - User presses button → MANUAL FAN ON (15 min timer)
10:15 - Timer expires → AUTO FAN OFF
Total runtime: 15 minutes (regardless of humidity)
```

### Example 3: High Ambient Humidity
```
Initial: Baseline 60%, Fan OFF
06:00 - Ambient humidity slowly rises to 63% over 20 minutes
       (No spike detected - baseline updates gradually)
06:20 - Shower starts, humidity jumps to 67% (+4% from current baseline)
        → AUTO FAN ON
```

## Monitoring & Debugging

### Event Log
Enable event logging on `text:200` to see all major events:
- Script initialization
- Manual ON/OFF events
- Auto spike detection
- Auto turn-off triggers
- Error messages

### Console Logs
Access via Shelly web interface → Scripts → [Your Script] → Console

**Log Levels:**
- `[INFO]` - Important state changes
- `[ALERT]` - Fan ON/OFF triggers
- `[DEBUG]` - Periodic humidity readings (every sensor update)
- `[ERROR]` - Failures or issues
- `[BASELINE]` - Baseline update events
- `[AUTO OFF CHECK]` - Turn-off condition monitoring

**Example Console Output:**
```
2026-02-14 06:03:00 [ALERT] SPIKE! 70.7→74.7% (+4.0%) → AUTO FAN ON
2026-02-14 06:04:00 [DEBUG] H:76.5% B:70.7% S:74.7% Fan:ON Timer:NO
2026-02-14 06:04:00 [AUTO OFF CHECK] Current:76.5% Target:72.7% Elapsed:0.9min
2026-02-14 06:06:00 [ALERT] Humidity normalized: 71.4% ≤ 72.7% → AUTO FAN OFF
```

### Component Status
Monitor virtual components to see current state:
- **number:200** (Current Humidity) - Latest sensor reading
- **number:201** (Baseline Humidity) - Reference point for spike detection
- **number:202** (Fan Start Humidity) - Humidity when fan turned ON
- **number:204** (Auto Start Time) - Unix timestamp (0 = not in auto mode)
- **text:200** (Last Updated) - Most recent event message

## Troubleshooting

### Fan doesn't turn on automatically
1. Check `number:200` is updating when humidity changes
   - Verify H&T sensor action URL is correct
   - Check H&T sensor action is enabled
2. Check baseline value in `number:201`
   - Must be lower than current humidity by spike_threshold amount
3. Check console logs for `[ALERT] SPIKE!` messages
4. Verify spike_threshold is appropriate (try lowering to 2.0 for testing)

### Fan doesn't turn off
1. Check if in manual mode (Timer:YES in debug logs)
   - Manual mode runs for full duration, won't turn off early
2. Check `number:204` (Auto Start Time)
   - Should be > 0 if in auto mode
   - If 0, auto turn-off won't work
3. Verify `number:203` and `number:204` max value is 9999999999 (not 100!)
4. Check console for `[AUTO OFF CHECK]` messages showing target humidity

### "Too many calls in progress" errors
- This should be resolved in current version with debouncing and delayed baseline updates
- If it occurs, check console to see which operation triggered it
- Watchdog script will automatically restart if crash occurs

### Timer doesn't work in manual mode
- Verify switch:0 has "Auto off" checkbox **enabled** in device settings
- This is required for `toggle_after` parameter to function
- Value doesn't matter (script overrides it), but checkbox must be checked

### Baseline keeps updating too frequently
- Check `number:203` max value is 9999999999 (not 100)
- Timestamps need large max values to store properly
- Script should show `[BASELINE] Skipping, Xs remaining` between updates

## Known Limitations

1. **H&T Sensor Update Frequency**: Sensor only sends updates on ±1% humidity change or periodic interval. Fast humidity changes < 1% won't trigger immediate updates.

2. **Network Latency**: HTTP action from H&T to Shelly 1 has small delay. Spike detection happens ~1-2 seconds after actual humidity change.

3. **Single Sensor**: Script assumes one humidity sensor. Multiple sensors would require code modifications.

4. **No Learning**: Baseline resets every 5 minutes to current value when fan is OFF. Doesn't learn daily/seasonal patterns.

## Advanced Customization

### Adjust for Different Room Sizes
Larger bathrooms may need:
- Higher `spike_threshold` (slower humidity rise)
- Lower `auto_return_threshold` (takes longer to clear)
- Longer `auto_max_runtime_seconds`

### Adjust for Climate
High ambient humidity areas:
- May want higher `spike_threshold` to avoid false triggers
- Increase `baseline_update_interval` to prevent chasing slow rises

### Multiple Sensors
To use multiple humidity sensors:
1. Create additional number components (e.g., 210, 211)
2. Add status handlers for each sensor
3. Average values or use highest reading
4. Modify spike detection logic accordingly

## License

MIT License - feel free to modify and distribute

## Credits

Developed through iterative testing and debugging. Special thanks to the Shelly scripting community and documentation.

## Contributing

Issues and pull requests welcome! Please test thoroughly before submitting.

## Version History

- **v1.0** (2026-02-14) - Initial release
  - Auto spike detection
  - Manual timer mode  
  - Baseline tracking with update interval
  - Debounce protection
  - Comprehensive logging
  - Watchdog support

## Support

For issues or questions:
1. Check troubleshooting section above
2. Review console logs for error messages
3. Verify all virtual components are created correctly
4. Check Shelly firmware is up to date
