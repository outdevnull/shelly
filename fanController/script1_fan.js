// === Bathroom Fan - High-Frequency Forensic Logic ===

let CONFIG = {
  current_humidity_num_id:    200,   
  temperature_num_id:         206,   
  external_humidity_num_id:   207,   
  external_temp_num_id:       208,   
  dew_point_num_id:           205,   
  fan_switch_id:              0,     
  
  // --- AGGRESSIVE TUNING FOR BATTERY SENSORS ---
  dp_shower_spike:            0.8,   // Very sensitive to catch slow sensor wake-ups
  dp_sanity_floor:            21.0,  
  ah_efficiency_threshold:    0.8,   // Lowered to ensure logic doesn't block a trigger
  auto_max_runtime_seconds:   3600   
};

let dpBaseline = 0;
let lastReportedDP = 0;
let autoStartTime = 0;

function calcAH(t, rh) { return (6.112 * Math.exp((17.67 * t) / (t + 243.5)) * rh * 2.1674) / (273.15 + t); }
function calcDP(t, rh) { return t - ((100 - rh) / 5); }

Shelly.addStatusHandler(function(event) {
  if (event.component !== "number:" + CONFIG.current_humidity_num_id) return;
  if (typeof event.delta.value === "undefined") return;
  
  let nowHum = event.delta.value;
  let tempStat = Shelly.getComponentStatus("number:" + CONFIG.temperature_num_id);
  let nowTemp = (tempStat) ? tempStat.value : 0;
  let nowDP = calcDP(nowTemp, nowHum);
  
  if (dpBaseline === 0) dpBaseline = nowDP;

  let extHStat = Shelly.getComponentStatus("number:" + CONFIG.external_humidity_num_id);
  let extTStat = Shelly.getComponentStatus("number:" + CONFIG.external_temp_num_id);
  let outAH = (extHStat && extTStat) ? calcAH(extTStat.value, extHStat.value) : calcAH(nowTemp, nowHum);
  let inAH = calcAH(nowTemp, nowHum);
  let ahDelta = inAH - outAH;

  let swStatus = Shelly.getComponentStatus("switch:" + CONFIG.fan_switch_id);
  let fanOn = (swStatus && swStatus.output === true);

  // --- LOGIC CALCULATIONS ---
  let spikeVsBaseline = nowDP - dpBaseline;
  let suddenJump = (lastReportedDP > 0) ? (nowDP - lastReportedDP) : 0;
  
  let isSpiking = spikeVsBaseline > CONFIG.dp_shower_spike;
  let isTropical = nowDP > CONFIG.dp_sanity_floor;
  let isEfficient = ahDelta > CONFIG.ah_efficiency_threshold;

  // --- THE "FORENSIC TRACE" ---
  // This will tell us if the sensor is "holding back" data
  print("--- DATA RECEIVED ---");
  print("DP Now: " + nowDP.toFixed(2) + " (Baseline: " + dpBaseline.toFixed(2) + ")");
  print("DP Change since last Wi-Fi Wake: +" + suddenJump.toFixed(2));
  print("Total Spike: +" + spikeVsBaseline.toFixed(2) + " (Need: " + CONFIG.dp_shower_spike + ")");
  print("AH Delta (Efficiency): " + ahDelta.toFixed(2) + " (Need: " + CONFIG.ah_efficiency_threshold + ")");
  print("Gatekeepers: Spike:" + isSpiking + " | Muggy:" + isTropical + " | Efficient:" + isEfficient);

  lastReportedDP = nowDP;

  if (!fanOn) {
    if ((isSpiking || isTropical) && isEfficient) {
      let reason = isSpiking ? "SHOWER SPIKE" : "MUGGY OVERRIDE";
      autoStartTime = Shelly.getComponentStatus("sys").unixtime;
      log("TRIGGER", "Fan ON [" + reason + "] DP:+" + spikeVsBaseline.toFixed(1));
      Shelly.call("Switch.Set", { id: CONFIG.fan_switch_id, on: true });
    }
  } 
  else {
    // Off logic remains the same
    let now = Shelly.getComponentStatus("sys").unixtime;
    if (nowDP < (dpBaseline + 0.5) || (now - autoStartTime) > CONFIG.auto_max_runtime_seconds) {
      log("STOP", "Fan OFF. Air stabilized.");
      Shelly.call("Switch.Set", { id: CONFIG.fan_switch_id, on: false });
    }
  }
});

// Update baseline every 5 minutes when fan is off
Timer.set(300000, true, function() {
  let sw = Shelly.getComponentStatus("switch:" + CONFIG.fan_switch_id);
  if (sw && !sw.output) {
    let t = Shelly.getComponentStatus("number:" + CONFIG.temperature_num_id);
    let h = Shelly.getComponentStatus("number:" + CONFIG.current_humidity_num_id);
    if (t && h) dpBaseline = calcDP(t.value, h.value);
  }
});

function log(level, msg) { print("[" + level + "] " + msg); }
