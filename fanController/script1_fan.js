// === Bathroom Fan - Forensic Logic with Startup & Trace Logging ===
// Note: Hard safety cutoff is handled by Shelly's built-in auto-off timer (1hr).

let CONFIG = {
  room_name:                  "Bathroom",
  current_humidity_num_id:    200,
  current_temperature_num_id: 201,
  current_dew_point:          202,
  external_humidity_num_id:   203,
  external_temperature_num_id:204,
  external_dew_point_num_id:  205,
  moistureTrend_text_id:      200,
  fan_switch_id:              0,

  mqtt_topic_prefix:          "shelly/bathroom-fan",
  shower_spike: 0.80,      // surplus_trend trigger to start fan
  dry_target: 0.40,        // avgMoistureSurplus target to stop fan
  equilibrium_gap: 0.02,   // abs(surplus_trend) to detect stalled drying
  equilibrium_max: 0.90,   // max avgMoistureSurplus to allow equilibrium shutoff
  boost_cycles: 5,         // Extra minutes to run after reaching dry_target
  quiet_hours_start: 22,  // 10pm
  quiet_hours_end: 5,     // 5am
  quiet_hours_avg_override: 0.5,  // allow trigger during quiet hours if avg is this high
  moistureTrendSamples:  10 //keep the last 10 moisture samples for reference
};

// Setup globals
let fanOnReason = "";
let boostCounter = 0;
let int_humidity = 0;
let int_temperature = 0;
let int_AbsoluteHumidity = 0;
let int_spread = 0;

let ext_humidity = 0;
let ext_temperature = 0;
let ext_AbsoluteHumidity  = 0;

let dryingPotential    = 0;
let moistureSurplus    = 0;
let avgMoistureSurplus = 0;
let surplus_trend      = 0;

let fan_switch_status = 0;
let fan_output_status = 0;
let fanOn = 0;
let tickCount = 0;

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

  
});


function autoFanControl() {
  // --- 1. SHOWER DETECTION (Auto-ON) ---
  if (fan_output_status === false && surplus_trend > CONFIG.shower_spike) {
    let hour = (new Date()).getHours();
    let inQuietHours = (hour >= CONFIG.quiet_hours_start || hour < CONFIG.quiet_hours_end);
    
    if (inQuietHours && avgMoistureSurplus < CONFIG.quiet_hours_avg_override) {
      log("STATUS", "Spike suppressed (quiet hours). avgMoistureSurplus: " + avgMoistureSurplus.toFixed(2) + "g.");
      return;
    }
    log("ACTION", "Shower spike (" + surplus_trend.toFixed(2) + "g). Fan ON.");
    fanOnReason = "Shower spike (" + surplus_trend.toFixed(2) + "g)";
    boostCounter = 0;
    Shelly.call("Switch.Set", { id: CONFIG.fan_switch_id, on: true });
    return;
  }

  // --- 2. USER OVERRIDE (The "Boss" Rule) ---
  if (fan_switch_status === true) {
    boostCounter = 0; // Reset boost if human is in control
    return; 
  }

  // --- 3. AUTO-OFF & BOOST LOGIC ---
  if (fan_output_status === true && fan_switch_status === false) {
    
    // Check if we have hit the dryness target or stalled out
    let isDry = avgMoistureSurplus < CONFIG.dry_target;
    let isStalled = Math.abs(surplus_trend) < CONFIG.equilibrium_gap && avgMoistureSurplus < CONFIG.equilibrium_max;

    if (isDry || isStalled) {
      // If we haven't finished the boost yet, keep going
      if (boostCounter < CONFIG.boost_cycles) {
        boostCounter++;
        log("BOOST", "Target reached. Over-run cycle: " + boostCounter + "/" + CONFIG.boost_cycles);
      } else {
        // Boost finished or not needed
        log("ACTION", "Drying complete. Fan OFF.");
        fanOnReason = "Room is as dry as it can be";
        boostCounter = 0;
        Shelly.call("Switch.Set", { id: CONFIG.fan_switch_id, on: false });
      }
    } else {
      // If the room gets wet again (someone jumped back in shower), reset boost
      log("STATUS", "Still drying... avgMoistureSurplus: " + avgMoistureSurplus.toFixed(2) + "g → target: <" + CONFIG.dry_target + "g | surplus_trend: " + surplus_trend.toFixed(2) + "g → equilibrium: <" + CONFIG.equilibrium_gap + "g");
      boostCounter = 0;
    }
  }
}
function updateMoistureHistory(currentValue) {
  let res = Shelly.getComponentStatus("text", CONFIG.moistureTrend_text_id);
  // Ensure we have a string to work with
  let historyStr = (res && typeof res.value === "string") ? res.value : "";
  let history = historyStr.length > 0 ? historyStr.split(",") : [];

  if (currentValue !== null) {
    let newHistory = [];
    newHistory[0] = currentValue.toFixed(2);
    
    // Manual shift to keep last x samples
    for (let i = 0; i < (CONFIG.moistureTrendSamples - 1); i++) {
      if (i < history.length) {
        newHistory[i + 1] = history[i];
      }
    }
    
    history = newHistory;
    let newStr = history.join(",");
    
    Shelly.call("Text.Set", { 
      id: CONFIG.moistureTrend_text_id, 
      value: newStr 
    });
  }

  // Use a more robust check for empty arrays in mJS
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

function get_componentsStatus() {
  int_humidity = Shelly.getComponentStatus("number:" + CONFIG.current_humidity_num_id);
  int_temperature = Shelly.getComponentStatus("number:" + CONFIG.current_temperature_num_id);
  ext_humidity = Shelly.getComponentStatus("number:" + CONFIG.external_humidity_num_id);
  ext_temperature = Shelly.getComponentStatus("number:" + CONFIG.external_temperature_num_id);
  fan_output_status = (Shelly.getComponentStatus("switch:" + CONFIG.fan_switch_id)).output;
  fan_switch_status = (Shelly.getComponentStatus("input:" + CONFIG.fan_switch_id)).state; //physical switch

  
  
  int_dewpoint = calcDP(int_temperature.value, int_humidity.value);
  ext_dewpoint = calcDP(ext_temperature.value, ext_humidity.value);
  
  int_AbsoluteHumidity = calcAH(int_temperature.value, int_humidity.value);
  ext_AbsoluteHumidity  = calcAH(ext_temperature.value, ext_humidity.value);
  
  int_spread = int_temperature.value - int_dewpoint;
  
  
  dryingPotential = int_AbsoluteHumidity / ext_AbsoluteHumidity;
  moistureSurplus = int_AbsoluteHumidity - ext_AbsoluteHumidity;
  avgMoistureSurplus = updateMoistureHistory(null);
  surplus_trend = moistureSurplus - avgMoistureSurplus
  updateMoistureHistory(moistureSurplus);
  
}

function log_status(){
  log("STATUS", [
     CONFIG.room_name + ": " + int_temperature.value + "C / " + int_humidity.value + "%",
     "DewPoint: " + int_dewpoint.toFixed(1) + "C",
     "IntSpread: " + int_spread.toFixed(1) + "C |",
     "External: " + (ext_temperature ? ext_temperature.value : "N/A") + "C / " + (ext_humidity ? ext_humidity.value : "N/A") + "%",
     "DewPoint: " + ext_dewpoint.toFixed(1) + "C",
  ].join(" "));
  log("STATUS", [
    "moistureSurplus: " + moistureSurplus.toFixed(2) + "g |",
    "avgMoistureSurplus: " + avgMoistureSurplus.toFixed(2) + "g |",
    "surplus_trend: " + surplus_trend.toFixed(2) + " |",
    "dryingPotential: " + (dryingPotential.toFixed(2)-1)*100 + "% |",
  ].join(" "));
  log("STATUS", [
    "FanOn: " + fan_output_status + " |",
    "FanSwitchOn: " + fan_switch_status + " |",
    "Reason: " + fanOnReason
  ].join(" "));
}

// === 2. INITIALIZATION LOG (Runs once at start) ===
Timer.set(2000, false, function() {
  get_componentsStatus();

  

  log("INIT", "Script Started Successfully");
  log_status();
  
    
});

// === 3. COMBINED 2-MINUTE TICK (Stop Poll + Baseline Update + Periodic Status) ===
Timer.set(10000, true, function() {
  tickCount++;
  get_componentsStatus();
  autoFanControl();
   // --- Status log every 5 ticks (10 mins) ---
  log_status(); //log every two for now
  if (tickCount % 5 === 0) {
    //log_status();
  }
});
