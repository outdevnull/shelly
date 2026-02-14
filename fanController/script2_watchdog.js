// === Fan Control Watchdog ===
// Monitors the main fan control script and restarts it if it crashes or hangs
// Monitors number:200 (humidity input) to detect sensor or script failures

let CONFIG = {
  main_script_id: 1,              // Main script ID to monitor
  humidity_num_id: 200,           // number:200 - humidity input to monitor
  check_interval_ms: 30000,       // Check every 30 seconds
  log_interval_ms: 300000,        // Log "OK" status every 5 minutes
  max_stale_seconds: 1800         // Restart if no humidity update for 30 minutes
};

let lastLogTime = 0;

let checkScript = function() {
  Shelly.call("Script.GetStatus", {id: CONFIG.main_script_id}, function(result, error_code, error_message) {
    if (error_code !== 0) {
      print("[WATCHDOG] Error checking script status: " + error_message);
      return;
    }
    
    // Check if script is stopped
    if (result && result.running === false) {
      print("[WATCHDOG] Main script stopped! Restarting...");
      restartScript();
      return;
    }
    
    // Script is running - now check if humidity sensor is updating
    let humidityStatus = Shelly.getComponentStatus("number:" + CONFIG.humidity_num_id);
    
    if (!humidityStatus) {
      print("[WATCHDOG] ERROR: Cannot read number:" + CONFIG.humidity_num_id);
      return;
    }
    
    // Use the last_update_ts from component status
    let lastUpdateTimestamp = humidityStatus.last_update_ts || 0;
    
    if (lastUpdateTimestamp === 0) {
      print("[WATCHDOG] WARN: number:200 has never been updated (sensor issue?)");
      logOkPeriodically();
      return;
    }
    
    // Compare to now
    let sysStatus = Shelly.getComponentStatus("sys");
    let nowTimestamp = sysStatus.unixtime;
    let ageSeconds = nowTimestamp - lastUpdateTimestamp;
    
    if (ageSeconds > CONFIG.max_stale_seconds) {
      print("[WATCHDOG] No humidity updates for " + Math.floor(ageSeconds/60) + " min! Restarting script...");
      restartScript();
    } else {
      // Script is running and sensor is updating
      logOkPeriodically("Last humidity update " + Math.floor(ageSeconds/60) + " min ago");
    }
  });
};

let restartScript = function() {
  Shelly.call("Script.Stop", {id: CONFIG.main_script_id}, function(res, err_code, err_msg) {
    if (err_code !== 0) {
      print("[WATCHDOG] Failed to stop script: " + err_msg);
    } else {
      print("[WATCHDOG] Script stopped, restarting...");
      
      // Wait a moment before restarting
      Timer.set(2000, false, function() {
        Shelly.call("Script.Start", {id: CONFIG.main_script_id}, function(res2, err_code2, err_msg2) {
          if (err_code2 !== 0) {
            print("[WATCHDOG] Failed to restart script: " + err_msg2);
          } else {
            print("[WATCHDOG] Script restarted successfully");
          }
        });
      });
    }
  });
};

let logOkPeriodically = function(extraInfo) {
  let now = Date.now();
  if (now - lastLogTime >= CONFIG.log_interval_ms) {
    let msg = "[WATCHDOG] Script running OK";
    if (extraInfo) {
      msg += " (" + extraInfo + ")";
    }
    print(msg);
    lastLogTime = now;
  }
};

// Check immediately on startup
checkScript();
lastLogTime = Date.now();

// Then check periodically
Timer.set(CONFIG.check_interval_ms, true, checkScript);

print("[WATCHDOG] Initialized - monitoring script " + CONFIG.main_script_id);
print("[WATCHDOG] Monitoring number:200 (humidity sensor)");
print("[WATCHDOG] Will restart if no updates for " + (CONFIG.max_stale_seconds/60) + " minutes");
print("[WATCHDOG] Status logs every " + (CONFIG.log_interval_ms/60000) + " minutes");
