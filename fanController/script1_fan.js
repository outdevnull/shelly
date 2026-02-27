// === Bathroom Fan - Forensic Logic with Startup & Trace Logging ===
// Note: Hard safety cutoff is handled by Shelly's built-in auto-off timer (1hr).

let CONFIG = {
  current_humidity_num_id:    200,
  temperature_num_id:         206,
  external_humidity_num_id:   207,
  external_temp_num_id:       208,
  dew_point_num_id:           205,
  fan_switch_id:              0,

  dp_shower_spike:            0.7,
  dp_sanity_floor:            21.0,
  dp_stop_threshold:          1.5,
  ah_efficiency_threshold:    0.4
};

let dpBaseline = 0;
let lastReportedDP = 0;

function calcAH(t, rh) { return (6.112 * Math.exp((17.67 * t) / (t + 243.5)) * rh * 2.1674) / (273.15 + t); }
function calcDP(t, rh) { return t - ((100 - rh) / 5); }
function log(level, msg) { print("[" + level + "] " + msg); }

// === 1. SENSOR UPDATE HANDLER ===
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

  let spikeVal = nowDP - dpBaseline;
  let jumpVal = (lastReportedDP > 0) ? (nowDP - lastReportedDP) : 0;

  let isSpiking = spikeVal > CONFIG.dp_shower_spike;
  let isTropical = nowDP > CONFIG.dp_sanity_floor;
  let isEfficient = ahDelta > CONFIG.ah_efficiency_threshold;

  // --- FORENSIC TRACE ---
  print("--- SENSOR UPDATE RECEIVED ---");
  print("Values  | DP: " + nowDP.toFixed(2) + "C | AH-In: " + inAH.toFixed(2) + "g | AH-Out: " + outAH.toFixed(2) + "g");
  print("Metrics | Total Spike: " + spikeVal.toFixed(2) + "C | Jump: " + jumpVal.toFixed(2) + "C | AH-Delta: " + ahDelta.toFixed(2));
  let fanStatus = fanOn ? "ON | Stop when DP <" + (dpBaseline + CONFIG.dp_stop_threshold).toFixed(1) + "C (now " + nowDP.toFixed(1) + "C, delta +" + spikeVal.toFixed(2) + "C of " + CONFIG.dp_stop_threshold + "C needed)" : "OFF";
  print("Status  | Spike:" + isSpiking + " | Muggy:" + isTropical + " | Efficient:" + isEfficient + " | Fan:" + fanStatus);

  lastReportedDP = nowDP;

  if (!fanOn) {
    if ((isSpiking || isTropical) && isEfficient) {
      let reason = isSpiking ? "SHOWER SPIKE" : "MUGGY OVERRIDE";
      log("TRIGGER", "Fan ON [" + reason + "] DP:+" + spikeVal.toFixed(1) + " AH-D:" + ahDelta.toFixed(1));
      Shelly.call("Switch.Set", { id: CONFIG.fan_switch_id, on: true });
    }
  } else {
    if (nowDP < (dpBaseline + CONFIG.dp_stop_threshold)) {
      log("STOP", "Fan OFF. Air stabilized. DP:" + nowDP.toFixed(1) + "C (baseline+" + (nowDP - dpBaseline).toFixed(1) + "C)");
      Shelly.call("Switch.Set", { id: CONFIG.fan_switch_id, on: false });
    }
  }
});

// === 2. INITIALIZATION LOG (Runs once at start) ===
Timer.set(2000, false, function() {
  let h = Shelly.getComponentStatus("number:" + CONFIG.current_humidity_num_id);
  let t = Shelly.getComponentStatus("number:" + CONFIG.temperature_num_id);
  let eh = Shelly.getComponentStatus("number:" + CONFIG.external_humidity_num_id);
  let et = Shelly.getComponentStatus("number:" + CONFIG.external_temp_num_id);
  let sw = Shelly.getComponentStatus("switch:" + CONFIG.fan_switch_id);
  let fanOn = (sw && sw.output === true);

  if (h && t) {
    dpBaseline = calcDP(t.value, h.value);
    let startInAH = calcAH(t.value, h.value);
    let startOutAH = (eh && et) ? calcAH(et.value, eh.value) : startInAH;

    log("INIT", "Script Started Successfully");
    log("INIT", "Current Bathroom: " + t.value + "C / " + h.value + "% (DP: " + dpBaseline.toFixed(1) + "C)");
    log("INIT", "Current Outside:  " + (et ? et.value : "N/A") + "C / " + (eh ? eh.value : "N/A") + "%");
    log("INIT", "Starting AH Delta: " + (startInAH - startOutAH).toFixed(2) + "g");
    log("INIT", "Thresholds: Spike >" + CONFIG.dp_shower_spike + "C | Stop <baseline+" + CONFIG.dp_stop_threshold + "C | AH-Delta >" + CONFIG.ah_efficiency_threshold + "g");
    let fanMsg = "OFF";
    if (fanOn) {
      let elapsed = (sw.timer_started_at !== undefined) ? (Shelly.getComponentStatus("sys").unixtime - sw.timer_started_at) : -1;
      fanMsg = "ON | Running ~" + (elapsed >= 0 ? Math.round(elapsed / 60) + " mins (auto-off in " + Math.round((3600 - elapsed) / 60) + " mins)" : "unknown duration (no timer active)");
    }
    log("INIT", "Fan is currently: " + fanMsg);
  } else {
    log("WARNING", "Init failed: Sensors not ready. Waiting for first update...");
  }
});

// === 3. BASELINE UPDATER ===
Timer.set(300000, true, function() {
  let sw = Shelly.getComponentStatus("switch:" + CONFIG.fan_switch_id);
  if (sw && !sw.output) {
    let t = Shelly.getComponentStatus("number:" + CONFIG.temperature_num_id);
    let h = Shelly.getComponentStatus("number:" + CONFIG.current_humidity_num_id);
    if (t && h) dpBaseline = calcDP(t.value, h.value);
  }
});
