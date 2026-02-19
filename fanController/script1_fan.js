// === Bathroom/Shower Fan - Humidity Spike Trigger (with logging) ===

let CONFIG = {
  // Input sensors
  current_humidity_num_id:    200,   // number:200 - Current humidity sensor reading
  
  // State storage (number components)
  baseline_humidity_num_id:   201,   // number:201 - Last "calm" humidity (when fan off)
  fan_start_humidity_num_id:  202,   // number:202 - Humidity when fan turned ON
  last_baseline_update_num_id: 203,  // number:203 - Unix timestamp of last baseline update
  auto_start_time_num_id:     204,   // number:204 - Unix timestamp when auto mode started
  dew_point_num_id:           205,   // number:205 - Calculated field T - (100-RH/5)
  temperature_num_id:         206,   // number:206 - Temperature C
  
  
  // Output display (text component)
  last_updated_text_id:       200,   // text:200 - Shows last important event
  
  // Control components
  fan_switch_id:              0,     // switch:0 - The fan relay
  
  // Logic thresholds
  spike_threshold:            3.0,   // % rise needed to auto turn ON
  auto_return_threshold:      2.0,   // % above baseline to turn OFF (for auto/shower mode)
  dew_point_gap_threshold:    7.0,   // Max °C gap to confirm it is a shower
  manual_runtime_seconds:     900,   // 15 minutes for manual mode (bathroom #2)
  auto_max_runtime_seconds:   3600,  // Max 1 hour for auto mode (safety net)
  baseline_update_interval:   300   // Only update baseline every 5 minutes (prevents chasing slow rises)
};

// Debounce for switch events
let lastSwitchEventTime = 0;
let SWITCH_DEBOUNCE_MS = 500;  // Ignore events within 500ms of each other

let getTimestamp = function() {
  let now = Shelly.getComponentStatus("sys");
  if (now && now.unixtime) {
    return new Date(now.unixtime * 1000).toISOString().replace('T', ' ').substring(0, 19);
  }
  return "N/A";
};

let getUnixTime = function() {
  let sysStatus = Shelly.getComponentStatus("sys");
  return (sysStatus && sysStatus.unixtime) ? sysStatus.unixtime : 0;
};

let log = function(level, message, updateLast) {
  let fullMessage = message;  // Just the message, no tags
  
  print("[" + level + "] " + message);  // Console still gets full format
  
  if (updateLast !== false) {
    Shelly.call("Text.Set", {
      id: CONFIG.last_updated_text_id,
      value: fullMessage
    });
  }
};

// Initialization
log("INFO", "Script initialized - Spike:" + CONFIG.spike_threshold + "% Return:" + CONFIG.auto_return_threshold + "% ManualTime:" + (CONFIG.manual_runtime_seconds/60) + "min AutoMax:" + (CONFIG.auto_max_runtime_seconds/60) + "min");

// === Update Temperature and Set Dew Point ===
Shelly.addStatusHandler(function(event) {
  if (event.component !== "number:" + CONFIG.temperature_num_id) return;
  if (typeof event.delta.value === "undefined") return;
  
  let Temperature = event.delta.value;
  
  let humStatus = Shelly.getComponentStatus("number:" + CONFIG.current_humidity_num_id);
  let RelativeHumidity = (humStatus && typeof humStatus.value === "number") ? humStatus.value : 50;
  
  let DewPoint = Temperature - ((100-RelativeHumidity)/5)
  Shelly.call("Number.Set", {
        id: CONFIG.dew_point_num_id,
        value: DewPoint
      });
});

// === MONITOR SWITCH OUTPUT ===
Shelly.addStatusHandler(function(event) {
  if (event.component !== "switch:" + CONFIG.fan_switch_id) return;
  if (typeof event.delta.output === "undefined") return;
  
  // DEBOUNCE: Ignore rapid fire events
  let nowMs = Date.now();
  if (nowMs - lastSwitchEventTime < SWITCH_DEBOUNCE_MS) {
    print("[DEBOUNCE] Ignoring rapid switch event");
    return;
  }
  lastSwitchEventTime = nowMs;
  
  let switchOn = event.delta.output;
  let source = event.delta.source || "unknown";
  
  print("[SWITCH EVENT] Fan: " + (switchOn ? "ON" : "OFF") + " Source: " + source);
  
  // Fan turned ON
  if (switchOn) {
    let nowHumStatus = Shelly.getComponentStatus("number:" + CONFIG.current_humidity_num_id);
    let nowHum = (nowHumStatus && typeof nowHumStatus.value === "number") ? nowHumStatus.value : 0;
    
    // Manual turn-on (button press) - Set timer via code
    if (source === "switch") {
      log("INFO", "Manual ON - Setting " + (CONFIG.manual_runtime_seconds/60) + " min auto-off timer");
      
      // Re-apply the ON state with our timer
      Shelly.call("Switch.Set", { 
        id: CONFIG.fan_switch_id, 
        on: true,
        toggle_after: CONFIG.manual_runtime_seconds
      }, function(result, error_code, error_message) {
        if (error_code !== 0) {
          log("ERROR", "Failed to set timer: " + error_message);
        } else {
          print("[MANUAL] Timer set for " + CONFIG.manual_runtime_seconds + " seconds");
        }
      });
      
      // Record start humidity
      Shelly.call("Number.Set", {
        id: CONFIG.fan_start_humidity_num_id,
        value: nowHum
      });
      
      print("[MANUAL] Humidity: " + nowHum.toFixed(1) + "%");
    }
    // Auto turn-on (script triggered by spike) - No timer, use humidity logic
    else {
      log("INFO", "Auto ON - Humidity mode, max runtime " + (CONFIG.auto_max_runtime_seconds/60) + " min");
      
      // Record start time for max runtime check
      let startTime = getUnixTime();
      Shelly.call("Number.Set", {
        id: CONFIG.auto_start_time_num_id,
        value: startTime
      });
      
      // Record start humidity
      Shelly.call("Number.Set", {
        id: CONFIG.fan_start_humidity_num_id,
        value: nowHum
      });
      
      print("[AUTO] Start time: " + startTime + ", Humidity: " + nowHum.toFixed(1) + "%");
    }
  }
  
  // Fan turned OFF
  if (!switchOn) {
    if (source === "switch") {
      log("INFO", "Manual OFF - Resuming spike monitoring");
    } else if (source === "timer") {
      log("INFO", "Timer auto-off triggered - Resuming spike monitoring");
    } else {
      log("INFO", "Auto OFF (humidity-based) - Resuming spike monitoring");
    }
    
    // Clear start humidity
    Shelly.call("Number.Set", {
      id: CONFIG.fan_start_humidity_num_id,
      value: 0
    });
    
    // Clear auto start time
    Shelly.call("Number.Set", {
      id: CONFIG.auto_start_time_num_id,
      value: 0
    });
    
    // Update baseline after a short delay to avoid "too many calls"
    Timer.set(1000, false, function() {
      let nowHumStatus = Shelly.getComponentStatus("number:" + CONFIG.current_humidity_num_id);
      if (nowHumStatus && typeof nowHumStatus.value === "number") {
        let nowTime = getUnixTime();
        Shelly.call("Number.Set", {
          id: CONFIG.baseline_humidity_num_id,
          value: nowHumStatus.value
        });
        Shelly.call("Number.Set", {
          id: CONFIG.last_baseline_update_num_id,
          value: nowTime
        });
        print("[BASELINE] Updated to " + nowHumStatus.value.toFixed(1) + "% (fan turned off)");
      }
    });
  }
});

// === MONITOR HUMIDITY FOR AUTO CONTROL ===
Shelly.addStatusHandler(function(event) {
  if (event.component !== "number:" + CONFIG.current_humidity_num_id) return;
  if (typeof event.delta.value === "undefined") return;
  
  let nowHum = event.delta.value;
  
  let baselineStatus = Shelly.getComponentStatus("number:" + CONFIG.baseline_humidity_num_id);
  let startHumStatus = Shelly.getComponentStatus("number:" + CONFIG.fan_start_humidity_num_id);
  let autoStartTimeStatus = Shelly.getComponentStatus("number:" + CONFIG.auto_start_time_num_id);
  
  // Fetch current Temp and DewPoint to check the "Saturation Gap"
  let tempStat = Shelly.getComponentStatus("number:" + CONFIG.temperature_num_id);
  let dpStat = Shelly.getComponentStatus("number:" + CONFIG.dew_point_num_id);
  
  let currentT = (tempStat) ? tempStat.value : 0;
  let currentDP = (dpStat) ? dpStat.value : 0;
  let gap = currentT - currentDP;
  
  let baselineHum = (baselineStatus && typeof baselineStatus.value === "number")
    ? baselineStatus.value : nowHum;
  let startHum = (startHumStatus && typeof startHumStatus.value === "number")
    ? startHumStatus.value : nowHum;
  let autoStartTime = (autoStartTimeStatus && typeof autoStartTimeStatus.value === "number")
    ? autoStartTimeStatus.value : 0;
  
  let switchStatus = Shelly.getComponentStatus("switch:" + CONFIG.fan_switch_id);
  let fanOn = switchStatus && switchStatus.output === true;
  let hasTimer = switchStatus && switchStatus.timer_duration && switchStatus.timer_duration > 0;
  
  log("DEBUG", "H:" + nowHum.toFixed(1) + "% B:" + baselineHum.toFixed(1) + "% S:" + 
      startHum.toFixed(1) + "% Fan:" + (fanOn?"ON":"OFF") + " Timer:" + (hasTimer?"YES":"NO"), false);
  
  let rise = nowHum - baselineHum;
  
  // Check for spike FIRST before updating baseline
  //let spikeDetected = !fanOn && rise >= CONFIG.spike_threshold;
  let spikeDetected = !fanOn && (rise >= CONFIG.spike_threshold) && (gap < CONFIG.dew_point_gap_threshold);
  
  // LOGGING (Update your DEBUG log to show the gap)
  log("DEBUG", "H:" + nowHum.toFixed(1) + "% Gap:" + gap.toFixed(1) + "C Fan:" + (fanOn?"ON":"OFF"), false);
  
  // Update baseline when fan is off - but only every X minutes (prevents chasing slow rises)
  // SKIP baseline update if we're about to turn the fan on (avoid too many calls)
  if (!fanOn && !spikeDetected) {
    let lastUpdateStatus = Shelly.getComponentStatus("number:" + CONFIG.last_baseline_update_num_id);
    let lastUpdate = (lastUpdateStatus && typeof lastUpdateStatus.value === "number") 
      ? lastUpdateStatus.value : 0;
    let nowTime = getUnixTime();
    
    // If never initialized, treat as if update interval has passed
    let timeSinceUpdate = (lastUpdate > 0) ? (nowTime - lastUpdate) : CONFIG.baseline_update_interval;
    
    if (timeSinceUpdate >= CONFIG.baseline_update_interval) {
      Shelly.call("Number.Set", {
        id: CONFIG.baseline_humidity_num_id,
        value: nowHum
      });
      Shelly.call("Number.Set", {
        id: CONFIG.last_baseline_update_num_id,
        value: nowTime
      });
      print("[BASELINE] Updated to " + nowHum.toFixed(1) + "% (" + timeSinceUpdate + "s since last)");
    } else {
      let remaining = CONFIG.baseline_update_interval - timeSinceUpdate;
      print("[BASELINE] Skipping, " + remaining + "s remaining");
    }
  }
  
  // === AUTO TURN FAN ON (spike detected) ===
  if (spikeDetected) {
    log("ALERT", "SPIKE! " + baselineHum.toFixed(1) + "→" + nowHum.toFixed(1) + 
        "% (+" + rise.toFixed(1) + "%) → AUTO FAN ON");
    
    Shelly.call("Switch.Set", { 
      id: CONFIG.fan_switch_id, 
      on: true
    }, function(result, error_code, error_message) {
      if (error_code !== 0) {
        log("ERROR", "Fan ON failed: " + error_message);
      }
    });
  }
  
  // === AUTO TURN FAN OFF (humidity-based or max runtime, only if no manual timer active) ===
  else if (fanOn && autoStartTime > 0) {
    let targetOff = baselineHum + CONFIG.auto_return_threshold;
    let nowTime = getUnixTime();
    let elapsed = nowTime - autoStartTime;
    
    print("[AUTO OFF CHECK] Current:" + nowHum.toFixed(1) + "% Target:" + targetOff.toFixed(1) + "% Elapsed:" + (elapsed/60).toFixed(1) + "min");
    
    // Check if humidity normalized
    if (nowHum <= targetOff) {
      log("ALERT", "Humidity normalized: " + nowHum.toFixed(1) + "% ≤ " + targetOff.toFixed(1) + "% → AUTO FAN OFF");
      
      Shelly.call("Switch.Set", { 
        id: CONFIG.fan_switch_id, 
        on: false 
      }, function(result, error_code, error_message) {
        if (error_code !== 0) {
          log("ERROR", "Fan OFF failed: " + error_message);
        }
      });
    }
    // Check if max runtime exceeded
    else if (elapsed >= CONFIG.auto_max_runtime_seconds) {
      let elapsedMin = (elapsed / 60).toFixed(1);
      log("ALERT", "Max runtime reached (" + elapsedMin + " min) → AUTO FAN OFF");
      
      Shelly.call("Switch.Set", { 
        id: CONFIG.fan_switch_id, 
        on: false 
      }, function(result, error_code, error_message) {
        if (error_code !== 0) {
          log("ERROR", "Fan OFF failed: " + error_message);
        }
      });
    } else {
      print("[AUTO] Humidity still high, waiting... (" + (CONFIG.auto_max_runtime_seconds - elapsed) + "s remaining)");
    }
  }
});

log("INFO", "Status handler registered");
