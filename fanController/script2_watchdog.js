// === Fan Control Watchdog ===
// Monitors the main fan control script and restarts it if it crashes

let MAIN_SCRIPT_ID = 1;  // Change to your main script's ID
let CHECK_INTERVAL_MS = 30000;  // Check every 30 seconds
let LOG_INTERVAL_MS = 300000;  // Only log "OK" status every 5 minutes

let lastLogTime = 0;

let checkScript = function() {
  Shelly.call("Script.GetStatus", {id: MAIN_SCRIPT_ID}, function(result, error_code, error_message) {
    if (error_code !== 0) {
      print("[WATCHDOG] Error checking script status: " + error_message);
      return;
    }
    
    if (result && result.running === false) {
      print("[WATCHDOG] Main script stopped! Restarting...");
      
      Shelly.call("Script.Start", {id: MAIN_SCRIPT_ID}, function(res, err_code, err_msg) {
        if (err_code !== 0) {
          print("[WATCHDOG] Failed to restart script: " + err_msg);
        } else {
          print("[WATCHDOG] Script restarted successfully");
        }
      });
    } else {
      // Only log "OK" periodically to reduce spam
      let now = Date.now();
      if (now - lastLogTime >= LOG_INTERVAL_MS) {
        print("[WATCHDOG] Script running OK");
        lastLogTime = now;
      }
    }
  });
};

// Check immediately on startup
checkScript();
lastLogTime = Date.now();  // Set initial time so first check logs

// Then check periodically
Timer.set(CHECK_INTERVAL_MS, true, checkScript);

print("[WATCHDOG] Initialized - monitoring script " + MAIN_SCRIPT_ID + " (logging every " + (LOG_INTERVAL_MS/60000) + " min)");
