// === Bathroom Fan - Dew Point & Absolute Humidity Logic ===

let CONFIG = {
  // Input sensors
  current_humidity_num_id:    200,   // %
  temperature_num_id:         206,   // °C
  external_humidity_num_id:   207,   // %
  external_temp_num_id:       208,   // °C
  
  // State storage
  dew_point_num_id:           205,   // Calculated DP
  fan_switch_id:              0,     
  
  // LOGIC THRESHOLDS
  dp_comfort_limit:           17.0,  // The "Sanity Floor". Below 17C DP, air is fine.
  dp_spike_threshold:         1.5,   // Rapid DP rise (shower start)
  ah_efficiency_threshold:    1.0,   // Outside must be this many g/m3 drier
  auto_max_runtime_seconds:   3600   // 1 hour safety shutoff
};

// Global Tracking
let dpBaseline = 0;

// Helper: Absolute Humidity Formula
function calcAH(temp, rh) {
  return (6.112 * Math.exp((17.67 * temp) / (temp + 243.5)) * rh * 2.1674) / (273.15 + temp);
}

// Helper: Dew Point Formula (Simplified Magnuss)
function calcDP(temp, rh) {
  return temp - ((100 - rh) / 5);
}

let log = function(level, message) {
  print("[" + level + "] " + message);
};

// === MONITOR CLIMATE & CONTROL FAN ===
Shelly.addStatusHandler(function(event) {
  if (event.component !== "number:" + CONFIG.current_humidity_num_id) return;
  
  let nowHum = event.delta.value;
  let tempStat = Shelly.getComponentStatus("number:" + CONFIG.temperature_num_id);
  let nowTemp = (tempStat) ? tempStat.value : 0;

  // 1. CALCULATE CURRENT STATE
  let nowDP = calcDP(nowTemp, nowHum);
  if (dpBaseline === 0) dpBaseline = nowDP;

  // Update Display DP
  Shelly.call("Number.Set", { id: CONFIG.dew_point_num_id, value: nowDP });

  // 2. GET EXTERNAL DATA
  let extHStat = Shelly.getComponentStatus("number:" + CONFIG.external_humidity_num_id);
  let extTStat = Shelly.getComponentStatus("number:" + CONFIG.external_temp_num_id);
  let extHum = (extHStat) ? extHStat.value : nowHum;
  let extTemp = (extTStat) ? extTStat.value : nowTemp;

  // 3. COMPARE ABSOLUTE MOISTURE
  let inAH = calcAH(nowTemp, nowHum);
  let outAH = calcAH(extTemp, extHum);
  let ahDelta = inAH - outAH;

  // 4. CHECK CONDITIONS
  let switchStatus = Shelly.getComponentStatus("switch:" + CONFIG.fan_switch_id);
  let fanOn = (switchStatus && switchStatus.output === true);

  // GATEKEEPER 1: Is it physically muggy in here?
  let isMuggy = nowDP > CONFIG.dp_comfort_limit;
  
  // GATEKEEPER 2: Did we just see a shower spike?
  let isSpiking = (nowDP - dpBaseline) > CONFIG.dp_spike_threshold;

  // GATEKEEPER 3: Is the outside air actually useful?
  let isEfficient = ahDelta > CONFIG.ah_efficiency_threshold;

  // 5. TRIGGER LOGIC
  if (!fanOn) {
    if ((isMuggy || isSpiking) && isEfficient) {
      log("TRIGGER", "Fan ON. DP: " + nowDP.toFixed(1) + "C, AH Delta: " + ahDelta.toFixed(1) + "g");
      Shelly.call("Switch.Set", { id: CONFIG.fan_switch_id, on: true });
      dpBaseline = nowDP; // Reset baseline to current
    }
  } 
  // 6. OFF LOGIC
  else {
    // Stop if air is comfortable OR outside is no longer helping
    let isComfortable = nowDP < (CONFIG.dp_comfort_limit - 0.5); 
    let stoppedHelping = ahDelta < 0.4;

    if (isComfortable || stoppedHelping) {
      log("STOP", "Fan OFF. Reason: " + (isComfortable ? "Comfort Reached" : "Efficiency Lost"));
      Shelly.call("Switch.Set", { id: CONFIG.fan_switch_id, on: false });
    }
  }
});

// Update baseline every 10 mins when fan is off
Timer.set(10 * 60 * 1000, true, function() {
  let switchStatus = Shelly.getComponentStatus("switch:" + CONFIG.fan_switch_id);
  if (switchStatus && !switchStatus.output) {
    let t = Shelly.getComponentStatus("number:" + CONFIG.temperature_num_id);
    let h = Shelly.getComponentStatus("number:" + CONFIG.current_humidity_num_id);
    if (t && h) dpBaseline = calcDP(t.value, h.value);
  }
});
