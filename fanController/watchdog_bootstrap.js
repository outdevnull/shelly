// version: 1.0.0
// === Shelly Watchdog Bootstrapper ===
// Fetches watchdog.js in chunks, immediately PutCode each chunk — no full file in memory.
// Writes to Script 99, starts it, then exits.

let SCRIPT_ID    = 99;
let FETCH_CHUNK  = 4096;
let DEPLOY_CHUNK = 1024;
let CF_WORKER    = "https://shelly-proxy.ash-b39.workers.dev";

function log(msg) { print("[BOOTSTRAP] " + msg); }
function halt(msg) { print("[BOOTSTRAP ERROR] " + msg); }

// Fetch one HTTP chunk, then immediately PutCode it in DEPLOY_CHUNK pieces
function fetchAndPut(file, branch, path, fetchOffset, isFirstPut, callback) {
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

    // PutCode this chunk in DEPLOY_CHUNK pieces
    putPieces(data, 0, isFirstPut, function(ok) {
      if (!ok) return;
      if (left > 0) {
        Timer.set(300, false, function() {
          fetchAndPut(file, branch, path, newFetchOffset, false, callback);
        });
      } else {
        callback();
      }
    });
  });
}

function putPieces(data, pos, isFirst, callback) {
  if (pos >= data.length) { callback(true); return; }
  let piece = data.slice(pos, pos + DEPLOY_CHUNK);

  Shelly.call("Script.PutCode", {
    id:     SCRIPT_ID,
    code:   piece,
    append: !isFirst
  }, function(res, err) {
    if (err) {
      halt("PutCode failed pos:" + pos + " err:" + JSON.stringify(err));
      callback(false);
      return;
    }
    Timer.set(200, false, function() {
      putPieces(data, pos + piece.length, false, callback);
    });
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

      log("Fetching watchdog.js branch:" + branch + " path:" + path);

      fetchAndPut("watchdog.js", branch, path, 0, true, function() {
        log("Deploy complete. Starting Script " + SCRIPT_ID + "...");
        Shelly.call("Script.Start", { id: SCRIPT_ID }, function(res, err) {
          if (err) {
            halt("Failed to start Script " + SCRIPT_ID + " err:" + JSON.stringify(err));
            return;
          }
          log("Watchdog running. Bootstrap complete.");
        });
      });
    });
  });
});
