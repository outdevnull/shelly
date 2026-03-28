// version: 1.0.0
// === Shelly Watchdog Bootstrapper - Bathroom Fan Controller ===
// Permanent script in slot 1 -- run manually to bootstrap or re-bootstrap.
// Creates Script 2, fetches watchdog.js in chunks, deploys and starts it.

let SCRIPT_ID    = 2;
let FETCH_CHUNK  = 4096;
let DEPLOY_CHUNK = 1024;
let CF_WORKER    = "https://shelly-proxy.ash-b39.workers.dev";

// Hardcoded KVS defaults for this device -- written if missing
let KVS_REQUIRED = {
  "wd.branch": "main",
  "wd.path":   "fanController"
};

function log(msg) { print("[BOOTSTRAP] " + msg); }
function halt(msg) { print("[BOOTSTRAP ERROR] " + msg); }

// Fetch one HTTP chunk, then immediately PutCode it in DEPLOY_CHUNK pieces
function fetchAndPut(file, branch, path, scriptId, fetchOffset, isFirstPut, callback) {
  let url = CF_WORKER + "/?file=" + path + "/" + file +
            "&ref=" + branch +
            "&offset=" + fetchOffset +
            "&len=" + FETCH_CHUNK;

  Shelly.call("HTTP.GET", { url: url }, function(res, err) {
    if (err || !res || res.code !== 200) {
      halt("Fetch failed offset:" + fetchOffset + " err:" + JSON.stringify(err));
      return;
    }

    let data = res.body;
    let left = (res.headers && res.headers["X-Left"] !== undefined) ? (res.headers["X-Left"] * 1) : 0;
    let newFetchOffset = fetchOffset + data.length;

    log("Chunk " + fetchOffset + "-" + newFetchOffset + " left:" + left);

    putPieces(data, 0, scriptId, isFirstPut, function(ok) {
      if (!ok) return;
      if (left > 0) {
        Timer.set(300, false, function() {
          fetchAndPut(file, branch, path, scriptId, newFetchOffset, false, callback);
        });
      } else {
        callback();
      }
    });
  });
}

function putPieces(data, pos, scriptId, isFirst, callback) {
  if (pos >= data.length) { callback(true); return; }
  let piece = data.slice(pos, pos + DEPLOY_CHUNK);

  Shelly.call("Script.PutCode", {
    id:     scriptId,
    code:   piece,
    append: !isFirst
  }, function(res, err) {
    if (err) {
      halt("PutCode failed pos:" + pos + " err:" + JSON.stringify(err));
      callback(false);
      return;
    }
    Timer.set(200, false, function() {
      putPieces(data, pos + piece.length, scriptId, false, callback);
    });
  });
}

// ================= BOOT =================
Timer.set(2000, false, function() {
  log("Bootstrapper starting...");

  // Ensure required KVS keys exist -- write defaults if missing
  let kvsKeys = Object.keys(KVS_REQUIRED);
  let ki = 0;
  function ensureKvs() {
    if (ki >= kvsKeys.length) { doBootstrap(); return; }
    let key = kvsKeys[ki]; ki++;
    Shelly.call("KVS.Get", { key: key }, function(r, e) {
      if (e || !r) {
        Shelly.call("KVS.Set", { key: key, value: KVS_REQUIRED[key] }, function() {
          log("KVS set: " + key + "=" + KVS_REQUIRED[key]);
          ensureKvs();
        });
      } else {
        ensureKvs();
      }
    });
  }

  function doBootstrap() {
  Shelly.call("KVS.Get", { key: "wd.branch" }, function(r1, e1) {
    if (e1 || !r1) { halt("Missing wd.branch in KVS"); return; }
    Shelly.call("KVS.Get", { key: "wd.path" }, function(r2, e2) {
      if (e2 || !r2) { halt("Missing wd.path in KVS"); return; }

      let branch = r1.value;
      let path   = r2.value;

      log("Fetching watchdog.js branch:" + branch + " path:" + path);

      // Stop Script 2 if running, then overwrite it
      Shelly.call("Script.GetStatus", { id: SCRIPT_ID }, function(sr, se) {
        function doCreate() {
          Shelly.call("Script.Create", { name: "watchdog" }, function(res, err) {
            if (err) {
              // Name conflict -- create without name
              Shelly.call("Script.Create", {}, function(res2, err2) {
                if (err2) { halt("Script.Create failed err:" + JSON.stringify(err2)); return; }
                let targetId = res2.id;
                log("Deploying to Script " + targetId);
                fetchAndPut("watchdog.js", branch, path, targetId, 0, true, function() {
                  log("Deploy complete. Starting Script " + targetId + "...");
                  Shelly.call("Script.Start", { id: targetId }, function(r3, e3) {
                    if (e3) { halt("Failed to start Script " + targetId); return; }
                    log("Watchdog running. Bootstrap complete. Stopping self.");
                    Shelly.call("Script.Stop", { id: 1 }, null);
                  });
                });
              });
              return;
            }
            let targetId = res.id;
            log("Deploying to Script " + targetId);
            fetchAndPut("watchdog.js", branch, path, targetId, 0, true, function() {
              log("Deploy complete. Starting Script " + targetId + "...");
              Shelly.call("Script.Start", { id: targetId }, function(res2, err2) {
                if (err2) { halt("Failed to start Script " + targetId + " err:" + JSON.stringify(err2)); return; }
                log("Watchdog running. Bootstrap complete. Stopping self.");
                Shelly.call("Script.Stop", { id: 1 }, null);
              });
            });
          });
        }
        if (!se && sr && sr.running) {
          Shelly.call("Script.Stop", { id: SCRIPT_ID }, function() { doCreate(); });
        } else {
          doCreate();
        }
      });
    });
  });
  } // end doBootstrap

  ensureKvs();
});
