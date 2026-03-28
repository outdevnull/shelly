// version: 1.0.0
// === Shelly Watchdog Bootstrapper ===
// One-shot: fetches watchdog.js from GitHub via CF Worker in chunks, deploys to Script 1, starts it.
// Overwrites itself in the process — runs once and ceases to exist.

let WATCHDOG_FILE = "watchdog.js";
let SCRIPT_ID     = 99;    // bootstrapper writes watchdog into slot 99
let CHUNK_SIZE    = 4096;  // bytes per download chunk — safely under Shelly's ~16KB limit
let DEPLOY_CHUNK  = 1024;  // bytes per Script.PutCode chunk
let CF_WORKER     = "https://shelly-proxy.ash-b39.workers.dev";

function log(msg) {
  print("[BOOTSTRAP] " + msg);
  Shelly.call("MQTT.Publish", { topic: "shelly/bootstrap/INFO",  message: msg, qos: 0, retain: false }, null);
}

function halt(msg) {
  print("[BOOTSTRAP ERROR] " + msg);
  Shelly.call("MQTT.Publish", { topic: "shelly/bootstrap/ERROR", message: msg, qos: 0, retain: false }, null);
}

// ================= DOWNLOAD IN CHUNKS =================
function downloadChunked(branch, path, offset, accumulated, callback) {
  let url = CF_WORKER + "/?file=" + path + "/" + WATCHDOG_FILE +
            "&ref=" + branch +
            "&offset=" + offset +
            "&len=" + CHUNK_SIZE;

  Shelly.call("HTTP.GET", { url: url }, function(res, err) {
    if (err || !res || res.code !== 200) {
      halt("Download failed at offset " + offset + " err:" + JSON.stringify(err));
      return;
    }

    accumulated = accumulated + res.body;

    // Parse X-Left from response headers
    let left = 0;
    if (res.headers && res.headers["X-Left"] !== undefined) {
      left = res.headers["X-Left"] * 1;
    }

    log("Downloaded " + accumulated.length + " bytes, " + left + " remaining...");

    if (left > 0) {
      // More chunks to fetch
      Timer.set(200, false, function() {
        downloadChunked(branch, path, offset + CHUNK_SIZE, accumulated, callback);
      });
    } else {
      // All chunks received
      callback(accumulated);
    }
  });
}

// ================= DEPLOY IN CHUNKS =================
function deployChunked(content, offset) {
  let chunk   = content.slice(offset, offset + DEPLOY_CHUNK);
  let isFirst = (offset === 0);
  offset += chunk.length;

  Shelly.call("Script.PutCode", {
    id:     SCRIPT_ID,
    code:   chunk,
    append: !isFirst
  }, function(res, err) {
    if (err) {
      halt("PutCode failed at offset " + (offset - chunk.length) + " err:" + JSON.stringify(err));
      return;
    }

    if (offset < content.length) {
      Timer.set(200, false, function() {
        deployChunked(content, offset);
      });
    } else {
      log("Deploy complete. Starting watchdog...");
      Shelly.call("Script.Start", { id: SCRIPT_ID }, function(res, err) {
        if (err) {
          halt("Failed to start watchdog — err:" + JSON.stringify(err));
          return;
        }
        log("Watchdog running. Bootstrap complete.");
      });
    }
  });
}

// ================= BOOT =================
Timer.set(2000, false, function() {
  log("Bootstrapper starting...");

  Shelly.call("KVS.Get", { key: "wd.branch" }, function(r1, e1) {
    if (e1 || !r1) { halt("Missing wd.branch in KVS"); return; }
    Shelly.call("KVS.Get", { key: "wd.path" }, function(r2, e2) {
      if (e2 || !r2) { halt("Missing wd.path in KVS"); return; }

      let branch = r1.value;
      let path   = r2.value;

      log("Fetching " + WATCHDOG_FILE + " from " + CF_WORKER + " branch:" + branch + " path:" + path);
      downloadChunked(branch, path, 0, "", function(content) {
        log("Full file received (" + content.length + " bytes). Deploying to Script " + SCRIPT_ID + "...");
        deployChunked(content, 0);
      });
    });
  });
});
