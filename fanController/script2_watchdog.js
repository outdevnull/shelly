// === Fan Control Watchdog ===
// Monitors the main fan control script and restarts it if it crashes

let MAIN_SCRIPT_ID = 1;  // Change to your main script's ID
let CHECK_INTERVAL_MS = 30000;  // Check every 30 seconds

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
      print("[WATCHDOG] Script running OK");
    }
  });
};

// Check immediately on startup
checkScript();

// Then check periodically
Timer.set(CHECK_INTERVAL_MS, true, checkScript);

print("[WATCHDOG] Initialized - monitoring script " + MAIN_SCRIPT_ID);
