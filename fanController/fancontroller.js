// version: 1.0.0
// === Bathroom Fan - Forensic Logic with Startup & Trace Logging ===
// Note: Hard safety cutoff is handled by Shelly's built-in auto-off timer (1hr).

// ================= HARDCODED CONFIG =================
// Device wiring, physics constants, internal tuning — not user facing
let CONFIG = {
  current_humidity_num_id:    200,
  current_temperature_num_id: 201,
  external_humidity_num_id:   203,
  external_temperature_num_id:204,
  moistureTrend_text_id:      200,
  fan_switch_id:              0,
  moistureTrendSamples:       10,
  abs_surplus_min_ticks:      3,
  passive_min_ticks:          5,
  stale_history_ratio:        0.75
};

// ================= KVS DEFAULTS =================
// Written to KVS only if key is missing — user can override via KVS
let KVS_DEFAULTS = {
  "fan.room_name":                  "Bathroom",
  "fan.shower_spike":               0.60,
  "fan.abs_surplus_threshold":      2.0,
  "fan.dry_target":                 0.40,
  "fan.equilibrium_gap":            0.02,
  "fan.equilibrium_max":            0.90,
  "fan.boost_cycles":               5,
  "fan.min_runtime":                900,
  "fan.quiet_hours_start":          11,
  "fan.quiet_hours_end":            18,
  "fan.quiet_hours_avg_override":   0.5,
  "fan.passive_surplus_threshold":  1.0,
  "fan.passive_drying_min":         1.10,
  "fan.passive_runtime":            600
};

// ================= LIVE SETTINGS =================
// Populated from KVS at boot — all runtime logic reads from here
let S = {};

// ================= STATE =================
let fanOnReason       = "";
let boostCounter      = 0;
let aboveSurplusCount = 0;
let passiveCount      = 0;
let tickCount         = 0;
let fanOnTime         = 0;
let isPassiveRun      = false;  // true when fan on for passive ventilation

let int_humidity         = 0;
let int_temperature      = 0;
let int_AbsoluteHumidity = 0;
let int_dewpoint         = 0;
let int_spread           = 0;

let ext_humidity         = 0;
let ext_temperature      = 0;
let ext_AbsoluteHumidity = 0;
let ext_dewpoint         = 0;

let dryingPotential    = 0;
let moistureSurplus    = 0;
let avgMoistureSurplus = 0;
let surplus_trend      = 0;

let fan_switch_status  = false;
let fan_output_status  = false;

let lastSeenRH   = null;
let lastSeenTemp = null;

// ================= PHYSICS =================
function calcAH(t, rh) {
  const Psat = 6.1078 * Math.exp((17.625 * t) / (243.04 + t));
  return (Psat * rh * 2.16679) / (273.15 + t);
}

function calcDP(t, rh) {
  const b = 17.625;
  const c = 243.04;
  const gamma = (b * t / (c + t)) + Math.log(rh / 100);
  return (c * gamma) / (b - gamma);
}

// ================= LOGGING =================
function utcTimestamp() {
  let t = Shelly.getComponentStatus("sys").unixtime;
  let pad = function(n) { return n < 10 ? "0" + n : "" + n; };
  let s   = t % 60;   t = (t - s) / 60;
  let min = t % 60;   t = (t - min) / 60;
  let h   = t % 24;   t = (t - h) / 24;
  let year = 1970;
  while (true) {
    let diy = ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) ? 366 : 365;
    if (t < diy) break;
    t -= diy;
    year++;
  }
  let dim = [31, (((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) ? 29 : 28),
             31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let month = 0;
  while (t >= dim[month]) { t -= dim[month]; month++; }
  let day = t + 1;
  return year + "-" + pad(month + 1) + "-" + pad(day) + " " +
         pad(h) + ":" + pad(min) + ":" + pad(s) + " UTC";
}

function log(level, msg) {
  let line = utcTimestamp() + " | " + S.room_name + " | " + level + " | " + msg;
  print(line);
  if (MQTT.isConnected()) MQTT.publish(S.mqtt_prefix + "/" + level, msg, 0, false);
}

// ================= KVS BOOT =================
// Reads all KVS_DEFAULTS keys into S, writing defaults for any missing keys.
// Also reads mqtt.topic_prefix from KVS (set by watchdog via kvsConfig) as S.mqtt_prefix.
function loadSettings(callback) {
  let keys = Object.keys(KVS_DEFAULTS);
  let i = 0;

  // Seed S with defaults first so log() works even before KVS reads complete
  for (let k in KVS_DEFAULTS) {
    let short = k.slice(4); // strip "fan." prefix
    S[short] = KVS_DEFAULTS[k];
  }
  S.mqtt_prefix = "shelly/bathroom-fan"; // fallback until KVS read completes

  function next() {
    if (i >= keys.length) {
      // All fan.* keys loaded — now read mqtt.topic_prefix as single source of truth
      Shelly.call("KVS.Get", { key: "mqtt.topic_prefix" }, function(res, err) {
        if (!err && res && res.value) {
          S.mqtt_prefix = res.value;
        }
        callback();
      });
      return;
    }
    let key = keys[i];
    let short = key.slice(4); // strip "fan." prefix
    i++;

    Shelly.call("KVS.Get", { key: key }, function(res, err) {
      if (err || !res) {
        // Key missing — write default
        Shelly.call("KVS.Set", { key: key, value: String(KVS_DEFAULTS[key]) }, function() {
          next();
        });
        return;
      }
      // Key exists — parse and load into S
      let val = res.value;
      let num = val * 1;
      S[short] = (val !== "" && !isNaN(num)) ? num : val;
      next();
    });
  }

  next();
}

// ================= HISTORY =================
function updateMoistureHistory(currentValue) {
  let res = Shelly.getComponentStatus("text", CONFIG.moistureTrend_text_id);
  let historyStr = (res && typeof res.value === "string") ? res.value : "";
  let history = historyStr.length > 0 ? historyStr.split(",") : [];

  if (currentValue !== null) {
    let newHistory = [];
    newHistory[0] = currentValue.toFixed(2);
    for (let i = 0; i < (CONFIG.moistureTrendSamples - 1); i++) {
      if (i < history.length) newHistory[i + 1] = history[i];
    }
    history = newHistory;
    Shelly.call("Text.Set", {
      id: CONFIG.moistureTrend_text_id,
      value: history.join(",")
    });
  }

  if (historyStr === "" && currentValue === null) return 0;

  let sum = 0;
  let count = 0;
  for (let i = 0; i < (CONFIG.moistureTrendSamples - 1); i++) {
    if (typeof history[i] !== "undefined") {
      sum = sum + (history[i] * 1.0);
      count = count + 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

// ================= SENSOR READ =================
function get_componentsStatus() {
  let ih = Shelly.getComponentStatus("number:" + CONFIG.current_humidity_num_id);
  let it = Shelly.getComponentStatus("number:" + CONFIG.current_temperature_num_id);
  let eh = Shelly.getComponentStatus("number:" + CONFIG.external_humidity_num_id);
  let et = Shelly.getComponentStatus("number:" + CONFIG.external_temperature_num_id);

  int_humidity    = ih;
  int_temperature = it;
  ext_humidity    = eh;
  ext_temperature = et;

  fan_output_status = (Shelly.getComponentStatus("switch:" + CONFIG.fan_switch_id)).output;
  fan_switch_status = (Shelly.getComponentStatus("input:"  + CONFIG.fan_switch_id)).state;

  int_dewpoint = calcDP(it.value, ih.value);
  ext_dewpoint = calcDP(et.value, eh.value);

  int_AbsoluteHumidity = calcAH(it.value, ih.value);
  ext_AbsoluteHumidity = calcAH(et.value, eh.value);

  int_spread = it.value - int_dewpoint;

  dryingPotential = int_AbsoluteHumidity / ext_AbsoluteHumidity;
  moistureSurplus = int_AbsoluteHumidity - ext_AbsoluteHumidity;
}

function onNewSensorReading() {
  avgMoistureSurplus = updateMoistureHistory(null);
  surplus_trend      = moistureSurplus - avgMoistureSurplus;
  updateMoistureHistory(moistureSurplus);
  log("SENSOR", "New reading. surplus: " + moistureSurplus.toFixed(2) + "g trend: " + surplus_trend.toFixed(2));
}

// ================= QUIET HOURS =================
function inQuietHours() {
  let hour = (Shelly.getComponentStatus("sys").unixtime / 3600) % 24 | 0;
  return (hour >= S.quiet_hours_start || hour < S.quiet_hours_end);
}

// ================= FAN CONTROL =================
function autoFanControl(onNewReading) {

  // --- 0. SUSTAINED ABSOLUTE SURPLUS TRIGGER (shower) ---
  if (onNewReading) {
    if (moistureSurplus > S.abs_surplus_threshold) {
      aboveSurplusCount++;
    } else {
      aboveSurplusCount = 0;
    }
  }

  if (fan_output_status === false && aboveSurplusCount >= CONFIG.abs_surplus_min_ticks) {
    if (inQuietHours() && avgMoistureSurplus < S.quiet_hours_avg_override) {
      log("STATUS", "Abs surplus suppressed (quiet hours). surplus: " + moistureSurplus.toFixed(2) + "g");
    } else {
      log("ACTION", "Sustained surplus (" + moistureSurplus.toFixed(2) + "g x" + aboveSurplusCount + " readings). Fan ON.");
      fanOnReason  = "Sustained surplus (" + moistureSurplus.toFixed(2) + "g)";
      boostCounter = 0;
      aboveSurplusCount = 0;
      passiveCount = 0;
      isPassiveRun = false;
      fanOnTime    = Shelly.getComponentStatus("sys").unixtime;
      Shelly.call("Switch.Set", { id: CONFIG.fan_switch_id, on: true });
    }
    return;
  }

  // --- 1. SHOWER SPIKE DETECTION ---
  if (fan_output_status === false && surplus_trend > S.shower_spike && moistureSurplus > S.abs_surplus_threshold) {
    if (inQuietHours() && avgMoistureSurplus < S.quiet_hours_avg_override) {
      log("STATUS", "Spike suppressed (quiet hours). avgMoistureSurplus: " + avgMoistureSurplus.toFixed(2) + "g.");
      return;
    }
    log("ACTION", "Shower spike (" + surplus_trend.toFixed(2) + "g). Fan ON.");
    fanOnReason  = "Shower spike (" + surplus_trend.toFixed(2) + "g)";
    boostCounter = 0;
    aboveSurplusCount = 0;
    passiveCount = 0;
    isPassiveRun = false;
    fanOnTime    = Shelly.getComponentStatus("sys").unixtime;
    Shelly.call("Switch.Set", { id: CONFIG.fan_switch_id, on: true });
    return;
  }

  // --- 2. PASSIVE VENTILATION TRIGGER ---
  if (onNewReading) {
    if (fan_output_status === false &&
        avgMoistureSurplus > S.passive_surplus_threshold &&
        dryingPotential > S.passive_drying_min) {
      passiveCount++;
    } else {
      passiveCount = 0;
    }
  }

  if (fan_output_status === false && passiveCount >= CONFIG.passive_min_ticks) {
    if (inQuietHours() && avgMoistureSurplus < S.quiet_hours_avg_override) {
      log("STATUS", "Passive ventilation suppressed (quiet hours).");
    } else {
      log("ACTION", "Passive ventilation triggered. avgSurplus: " + avgMoistureSurplus.toFixed(2) + "g dryingPotential: " + ((dryingPotential - 1) * 100).toFixed(0) + "%. Fan ON.");
      fanOnReason  = "Passive ventilation";
      passiveCount = 0;
      isPassiveRun = true;
      fanOnTime    = Shelly.getComponentStatus("sys").unixtime;
      Shelly.call("Switch.Set", { id: CONFIG.fan_switch_id, on: true });
    }
    return;
  }

  // --- 3. USER OVERRIDE (The "Boss" Rule) ---
  if (fan_switch_status === true) {
    boostCounter = 0;
    return;
  }

  // --- 4. AUTO-OFF LOGIC ---
  if (fan_output_status === true && fan_switch_status === false) {
    let runtime = Shelly.getComponentStatus("sys").unixtime - fanOnTime;

    // Passive run — fixed runtime, no dry target needed
    if (isPassiveRun) {
      if (runtime >= S.passive_runtime) {
        log("ACTION", "Passive ventilation complete (" + runtime + "s). Fan OFF.");
        fanOnReason  = "Passive ventilation complete";
        isPassiveRun = false;
        Shelly.call("Switch.Set", { id: CONFIG.fan_switch_id, on: false });
      }
      return;
    }

    // Shower run — minimum runtime + dry target
    if (runtime < S.min_runtime) {
      log("STATUS", "Min runtime not reached (" + runtime + "s / " + S.min_runtime + "s) — continuing.");
      return;
    }

    let isDry     = avgMoistureSurplus < S.dry_target;
    let isStalled = Math.abs(surplus_trend) < S.equilibrium_gap && avgMoistureSurplus < S.equilibrium_max;

    if (isDry || isStalled) {
      if (boostCounter < S.boost_cycles) {
        boostCounter++;
        log("BOOST", "Target reached. Over-run cycle: " + boostCounter + "/" + S.boost_cycles);
      } else {
        log("ACTION", "Drying complete. Fan OFF.");
        fanOnReason  = "Room is as dry as it can be";
        boostCounter = 0;
        Shelly.call("Switch.Set", { id: CONFIG.fan_switch_id, on: false });
      }
    } else {
      boostCounter = 0;
    }
  }
}

// ================= STATUS LOG =================
function log_status() {
  log("STATUS", [
    S.room_name + ": " + int_temperature.value + "C / " + int_humidity.value + "%",
    "DewPoint: " + int_dewpoint.toFixed(1) + "C",
    "IntSpread: " + int_spread.toFixed(1) + "C |",
    "External: " + (ext_temperature ? ext_temperature.value : "N/A") + "C / " + (ext_humidity ? ext_humidity.value : "N/A") + "%",
    "DewPoint: " + ext_dewpoint.toFixed(1) + "C",
  ].join(" "));
  log("STATUS", [
    "moistureSurplus: " + moistureSurplus.toFixed(2) + "g |",
    "avgMoistureSurplus: " + avgMoistureSurplus.toFixed(2) + "g |",
    "surplus_trend: " + surplus_trend.toFixed(2) + " |",
    "aboveSurplusCount: " + aboveSurplusCount + " |",
    "passiveCount: " + passiveCount + " |",
    "dryingPotential: " + ((dryingPotential - 1) * 100).toFixed(0) + "% |",
  ].join(" "));
  log("STATUS", [
    "FanOn: " + fan_output_status + " |",
    "FanSwitchOn: " + fan_switch_status + " |",
    "Reason: " + fanOnReason
  ].join(" "));
}

// ================= SENSOR EVENT HANDLER =================
Shelly.addStatusHandler(function(event) {
  if (event.component !== "number:" + CONFIG.current_humidity_num_id &&
      event.component !== "number:" + CONFIG.current_temperature_num_id) return;
  if (typeof event.delta.value === "undefined") return;

  let ih = Shelly.getComponentStatus("number:" + CONFIG.current_humidity_num_id);
  let it = Shelly.getComponentStatus("number:" + CONFIG.current_temperature_num_id);

  if (ih.value === lastSeenRH && it.value === lastSeenTemp) return;
  lastSeenRH   = ih.value;
  lastSeenTemp = it.value;

  get_componentsStatus();
  onNewSensorReading();
  autoFanControl(true);
  log_status();
});

// ================= INIT =================
Timer.set(2000, false, function() {
  loadSettings(function() {
    get_componentsStatus();
    avgMoistureSurplus = updateMoistureHistory(null);
    surplus_trend = 0;

    if (fan_output_status === true) {
      fanOnTime   = Shelly.getComponentStatus("sys").unixtime;
      fanOnReason = "Pre-existing (startup)";
    }

    if (avgMoistureSurplus > 0 && moistureSurplus < avgMoistureSurplus * CONFIG.stale_history_ratio) {
      log("INIT", "Stale history detected (surplus " + moistureSurplus.toFixed(2) + "g << avg " + avgMoistureSurplus.toFixed(2) + "g). History reset.");
      Shelly.call("Text.Set", { id: CONFIG.moistureTrend_text_id, value: "" });
      avgMoistureSurplus = moistureSurplus;
    }

    log("INIT", "Script Started. Settings loaded from KVS.");
    log_status();
  });
});

// ================= TICK =================
Timer.set(10000, true, function() {
  tickCount++;
  get_componentsStatus();
  autoFanControl(false);
});
