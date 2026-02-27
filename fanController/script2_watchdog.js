// === Smart "Either-Or" Watchdog ===
let CONFIG = {
  main_script_id: 1,
  humidity_id: 200,    // number:200
  temperature_id: 206, // number:206
  check_interval: 30000,
  max_stale_sec: 5400,       // 90 minutes (Relaxed for overnight stability)
  startup_grace_sec: 3600    // 60 minutes
};

let watchdogStart = Math.floor(Date.now() / 1000);

let runCheck = function() {
  let now = Math.floor(Date.now() / 1000);
  let uptime = now - watchdogStart;

  Shelly.call("Script.GetStatus", {id: CONFIG.main_script_id}, function(res, err) {
    if (err !== 0 || !res.running) {
      print("[WATCHDOG] Main script stopped. Starting...");
      Shelly.call("Script.Start", {id: CONFIG.main_script_id});
      return;
    }

    // 1. Startup Grace Period
    if (uptime < CONFIG.startup_grace_sec) return;

    // 2. Check Data Health
    let hStat = Shelly.getComponentStatus("number:" + CONFIG.humidity_id);
    let tStat = Shelly.getComponentStatus("number:" + CONFIG.temperature_id);

    let hAge = now - (hStat.last_update_ts || 0);
    let tAge = now - (tStat.last_update_ts || 0);

    // THE FIX: We only care about the FRESHEST data point.
    // If temp updated 2 mins ago but humidity hasn't moved in 2 hours, the sensor is ALIVE.
    let sensorAge = (hAge < tAge) ? hAge : tAge;

    if (sensorAge > CONFIG.max_stale_sec) {
      print("[WATCHDOG] SENSOR OFFLINE (No update from either for " + Math.floor(sensorAge/60) + "m). Restarting...");
      watchdogStart = now; // Reset grace period
      Shelly.call("Script.Stop", {id: CONFIG.main_script_id}, function() {
        Timer.set(2000, false, function() { Shelly.call("Script.Start", {id: CONFIG.main_script_id}); });
      });
    }
  });
};

Timer.set(CONFIG.check_interval, true, runCheck);
print("[WATCHDOG] Started. Monitoring life signals from Temp & Humidity...");
