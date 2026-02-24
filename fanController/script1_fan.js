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
  external_humidity_num_id:   207,   // number:207 - External Humidity %
  external_temp_num_id:       208,   // number:208 - External Temperature C
  
  // Output display (text component)
  last_updated_text_id:       200,   // text:200 - Shows last important event
  
  // Control components
  fan_switch_id:              0,     // switch:0 - The fan relay
  
  // Logic thresholds
  spike_threshold:            5.0,   // % rise needed to auto turn ON
  auto_return_threshold:      2.0,   // % above baseline to turn OFF (for auto/shower mode)
  dew_point_gap_threshold:    4.8,   // Max °C gap to confirm it is a shower
  manual_runtime_seconds:     900,   // 15 minutes for manual mode (bathroom #2)
  auto_max_runtime_seconds:   3600,  // Max 1 hour for auto mode (safety net)
  baseline_update_interval:   300   // Only update baseline every 5 minutes (prevents chasing slow rises)
};

// Debounce for switch events
let lastSwitchEventTime = 0;
let SWITCH_DEBOUNCE_MS = 500;  // Ignore events within 500ms of each other

let MIN_HUM_FOR_OVERRIDE = 80.0;


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

function calcAH(temp, rh) {
  // Absolute Humidity formula (g/m3)
  return (6.112 * Math.exp((17.67 * temp) / (temp + 243.5)) * rh * 2.1674) / (273.15 + temp);
}

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
  if (humBaseline === 0) humBaseline = nowHum; // Initial boot safety

  // 1. GET INTERNAL DATA
  let tempStat = Shelly.getComponentStatus("number:" + CONFIG.temperature_num_id);
  let currentT = (tempStat) ? tempStat.value : 0;
  
  // 2. GET EXTERNAL DATA
  let extStat = Shelly.getComponentStatus("number:" + CONFIG.external_humidity_num_id);
  let extTempStat = Shelly.getComponentStatus("number:" + CONFIG.external_temp_num_id);
  let extHum = (extStat && extStat.value > 0) ? extStat.value : nowHum;
  let extTemp = (extTempStat) ? extTempStat.value : currentT;

  // 3. CALCULATE ABSOLUTE MOISTURE (The "Gundaroo Fix")
  let inAH = calcAH(currentT, nowHum);
  let outAH = calcAH(extTemp, extHum);
  let ahDelta = inAH - outAH; // How many grams drier is the outside air?

  // 4. DETECT SPIKE (Human activity)
  let rhSpike = nowHum - humBaseline;

  // 5. GET SYSTEM STATE
  let switchStatus = Shelly.getComponentStatus("switch:" + CONFIG.fan_switch_id);
  let fanOn = (switchStatus && switchStatus.output === true);
  
  // 6. TRIGGER LOGIC
  let shouldTrigger = false;

  // Rule A: Shower Spike + Outside air is actually drier (AH)
  if (rhSpike >= 5.0 && ahDelta > 0.5) {
    shouldTrigger = true;
    log("ALERT", "Shower Spike Detected (+" + rhSpike.toFixed(1) + "%). Outside air is drier by " + ahDelta.toFixed(1) + "g/m3.");
  }
  // 1. Define a DYNAMIC floor based on the current outside air
  let humidityFloor = extHum + 2.0;
  
   // Rule B: Adaptive High Humidity Override
  if (nowHum > humidityFloor && nowHum > MIN_HUM_FOR_OVERRIDE && ahDelta > 1.2) { 
    shouldTrigger = true;
    log("ALERT", "High Humidity Override. Bathroom (" + nowHum.toFixed(1) + "%) is wetter than outside (" + extHum.toFixed(1) + "%).");
  }
  // 7. ACTIONS
  if (!fanOn && shouldTrigger) {
    Shelly.call("Switch.Set", { id: CONFIG.fan_switch_id, on: true });
    // Reset baseline so we don't double-trigger
    humBaseline = nowHum; 
  } 
  else if (fanOn) {
    // OFF LOGIC: Switch off if AH equalizes or humidity drops back to baseline
    // Check if we are still in "Soup" territory (Rule B)
    //let stillSoup = (nowHum > 84.0 && ahDelta > 1.0);
    let stillSoup = (nowHum > humidityFloor || ahDelta > 0.8);
    
    // Only turn off if we are NOT in the soup AND we hit a stop condition
    //if (!stillSoup && (ahDelta <= 0.2 || nowHum <= (humBaseline + 2))) {
    if (!stillSoup && (ahDelta <= 0.3)) {
      log("INFO", "Air cleared. AH Delta: " + ahDelta.toFixed(1) + "g. Turning off.");
      Shelly.call("Switch.Set", { id: CONFIG.fan_switch_id, on: false });
    }
  }

  // Updated Debug Logging
  log("DEBUG", 
    "IN: " + nowHum.toFixed(1) + "% (" + inAH.toFixed(1) + "g) " +
    "OUT: " + extHum.toFixed(1) + "% (" + outAH.toFixed(1) + "g) " +
    "AH Delta: " + ahDelta.toFixed(1) + "g", 
    false
  );
});
 

// === Initialization: Set Dew Point with Safety Check ===
Timer.set(2000, false, function() { // Wait 2 seconds for sensors to wake up
  let initHum = Shelly.getComponentStatus("number:" + CONFIG.current_humidity_num_id);
  let initTemp = Shelly.getComponentStatus("number:" + CONFIG.temperature_num_id);

  if (initHum && initTemp && initTemp.value > 0) {
    let startDP = initTemp.value - ((100 - initHum.value) / 5);
    Shelly.call("Number.Set", {
      id: CONFIG.dew_point_num_id,
      value: startDP
    });
    print("Init: Success. Dew Point set to " + startDP.toFixed(1) + "C");
  } else {
    print("Init: Waiting for valid sensor data...");
  }
});
// Global baseline for spike detection
let humBaseline = 0;
Timer.set(15 * 60 * 1000, true, function() {
  let h = Shelly.getComponentStatus("number:" + CONFIG.current_humidity_num_id);
  if (h) humBaseline = h.value;
});


log("INFO", "Status handlers registered");
