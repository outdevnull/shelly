// === Bathroom Fan - Forensic Logic with Startup & Trace Logging ===
// Note: Hard safety cutoff is handled by Shelly's built-in auto-off timer (1hr).

let CONFIG = {
  current_humidity_num_id:    200,
  temperature_num_id:         206,
  external_humidity_num_id:   207,
  external_temp_num_id:       208,
  dew_point_num_id:           205,
  fan_switch_id:              0,

  dp_shower_spike:            0.7,   // °C rise to trigger fan ON normally
  dp_retrigger_threshold:     2.2,   // °C rise required to re-trigger within cooldown window
  dp_retrigger_cooldown:      300,   // seconds after fan OFF before normal sensitivity resumes
  dp_sanity_floor:            21.0,
  dp_stop_threshold:          2.0,
  ah_efficiency_threshold:    0.4,
  dp_min_run_time:            240,   // seconds minimum fan run before stop condition is checked
  mqtt_topic_prefix:          "shelly/bathroom-fan"
};

let dpBaseline = 0;
let lastReportedDP = 0;
let fanJustStopped = false;
let fanStartTime = 0;
let tickCount = 0;

function calcAH(t, rh) { return (6.112 * Math.exp((17.67 * t) / (t + 243.5)) * rh * 2.1674) / (273.15 + t); }
function calcDP(t, rh) { return t - ((100 - rh) / 5); }
function log(level, msg) {
  print("[" + level + "] " + msg);
  if (MQTT.isConnected()) MQTT.publish(CONFIG.mqtt_topic_prefix + "/" + level, msg, 0, false);
}

function logFanOff(source, nowDP, nowTemp, nowHum, extTStat, extHStat) {
  let inAH = calcAH(nowTemp, nowHum);
  let outAH = (extTStat && extHStat) ? calcAH(extTStat.value, extHStat.value) : null;
  let outStr = (extTStat && extHStat) ? extTStat.value + "C/" + extHStat.value + "% AH:" + outAH.toFixed(2) + "g" : "N/A";
  log(source, "Fan OFF. Air stabilized. | Bath:" + nowTemp + "C/" + nowHum + "% DP:" + nowDP.toFixed(1) + "C AH:" + inAH.toFixed(2) + "g | Out:" + outStr + " | Baseline:" + dpBaseline.toFixed(1) + "C (delta+" + (nowDP - dpBaseline).toFixed(2) + "C)");
  fanJustStopped = true;
  Timer.set(CONFIG.dp_retrigger_cooldown * 1000, false, function() { fanJustStopped = false; });
}

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

  let spikeNeeded = fanJustStopped ? CONFIG.dp_retrigger_threshold : CONFIG.dp_shower_spike;
  let isSpiking = spikeVal > spikeNeeded;
  let isTropical = nowDP > CONFIG.dp_sanity_floor;
  let isEfficient = ahDelta > CONFIG.ah_efficiency_threshold;

  // --- FORENSIC TRACE ---
  print("--- SENSOR UPDATE RECEIVED ---");
  print("Values  | DP: " + nowDP.toFixed(2) + "C | AH-In: " + inAH.toFixed(2) + "g | AH-Out: " + outAH.toFixed(2) + "g");
  print("Metrics | Total Spike: " + spikeVal.toFixed(2) + "C | Jump: " + jumpVal.toFixed(2) + "C | AH-Delta: " + ahDelta.toFixed(2));
  let fanStatus = fanOn
    ? "ON | Stop when DP <" + (dpBaseline + CONFIG.dp_stop_threshold).toFixed(1) + "C (now " + nowDP.toFixed(1) + "C, delta +" + spikeVal.toFixed(2) + "C of " + CONFIG.dp_stop_threshold + "C needed)"
    : "OFF" + (fanJustStopped ? " [COOLDOWN - retrigger needs DP:+" + CONFIG.dp_retrigger_threshold + "C, currently +" + spikeVal.toFixed(2) + "C]" : "");
  print("Status  | Spike:" + isSpiking + " | Muggy:" + isTropical + " | Efficient:" + isEfficient + " | Fan:" + fanStatus);

  lastReportedDP = nowDP;

  if (!fanOn) {
    if ((isSpiking || isTropical) && isEfficient) {
      let reason = isSpiking ? "SHOWER SPIKE" : "MUGGY OVERRIDE";
      let retriggered = fanJustStopped ? " [RETRIGGER]" : "";
      log("TRIGGER", "Fan ON [" + reason + retriggered + "] DP:+" + spikeVal.toFixed(1) + " AH-D:" + ahDelta.toFixed(1));
      fanJustStopped = false;
      fanStartTime = Date.now();
      Shelly.call("Switch.Set", { id: CONFIG.fan_switch_id, on: true });
    }
  } else {
    let runSecs = (Date.now() - fanStartTime) / 1000;
    if (runSecs < CONFIG.dp_min_run_time) {
      print("Status  | Min run time not reached (" + Math.round(runSecs) + "s of " + CONFIG.dp_min_run_time + "s)");
    } else if (nowDP < (dpBaseline + CONFIG.dp_stop_threshold)) {
      logFanOff("STOP", nowDP, nowTemp, nowHum, extTStat, extHStat);
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
    log("INIT", "Thresholds: Spike >" + CONFIG.dp_shower_spike + "C | Retrigger >" + CONFIG.dp_retrigger_threshold + "C (" + (CONFIG.dp_retrigger_cooldown / 60) + "min cooldown) | Stop <baseline+" + CONFIG.dp_stop_threshold + "C | Min run:" + CONFIG.dp_min_run_time + "s | AH-Delta >" + CONFIG.ah_efficiency_threshold + "g");
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

// === 3. COMBINED 2-MINUTE TICK (Stop Poll + Baseline Update + Periodic Status) ===
Timer.set(120000, true, function() {
  tickCount++;
  let t = Shelly.getComponentStatus("number:" + CONFIG.temperature_num_id);
  let h = Shelly.getComponentStatus("number:" + CONFIG.current_humidity_num_id);
  let et = Shelly.getComponentStatus("number:" + CONFIG.external_temp_num_id);
  let eh = Shelly.getComponentStatus("number:" + CONFIG.external_humidity_num_id);
  let sw = Shelly.getComponentStatus("switch:" + CONFIG.fan_switch_id);
  if (!t || !h) return;

  let nowDP = calcDP(t.value, h.value);
  let inAH = calcAH(t.value, h.value);
  let outAH = (et && eh) ? calcAH(et.value, eh.value) : inAH;
  let fanOn = (sw && sw.output === true);

  if (fanOn) {
    // --- Stop condition poll ---
    let spikeVal = nowDP - dpBaseline;
    let stopTarget = dpBaseline + CONFIG.dp_stop_threshold;
    let runSecs = (Date.now() - fanStartTime) / 1000;
    if (runSecs < CONFIG.dp_min_run_time) {
      log("POLL", "Fan ON | Min run time active (" + Math.round(runSecs) + "s of " + CONFIG.dp_min_run_time + "s) | DP:" + nowDP.toFixed(1) + "C");
    } else if (nowDP < stopTarget) {
      logFanOff("POLL-STOP", nowDP, t.value, h.value, et, eh);
      Shelly.call("Switch.Set", { id: CONFIG.fan_switch_id, on: false });
    } else {
      log("POLL", "Fan still ON | Stop when DP <" + stopTarget.toFixed(1) + "C (now " + nowDP.toFixed(1) + "C, delta +" + spikeVal.toFixed(2) + "C of " + CONFIG.dp_stop_threshold + "C needed)");
    }
  } else if (!fanJustStopped) {
    // --- Baseline update (only when fan off and not in cooldown) ---
    dpBaseline = nowDP;
  }

  // --- Status log every 5 ticks (10 mins) ---
  if (tickCount % 5 === 0) {
    log("STATUS", "Bath:" + t.value + "C/" + h.value + "% DP:" + nowDP.toFixed(1) + "C | Out:" + (et?et.value:"N/A") + "C/" + (eh?eh.value:"N/A") + "% | AH-Delta:" + (inAH-outAH).toFixed(2) + "g | Baseline:" + dpBaseline.toFixed(1) + "C | Fan:" + (fanOn?"ON":"OFF") + (fanJustStopped?" [COOLDOWN]":""));
  }
});
