// version: 1.0.0
// === Shelly Watchdog - GitHub Auto-Deploy & Script Monitor ===

let MANIFEST_FILE = "manifest.json";
let CF_WORKER     = "https://shelly-proxy.ash-b39.workers.dev";
let FETCH_CHUNK   = 8192;   // bytes per HTTP fetch
let DEPLOY_CHUNK  = 1024;   // bytes per Script.PutCode
let WD_SLOT_A     = 2;
let WD_SLOT_B     = 3;

// ================= STATE =================
let cfg = {
  branch: "",
  path: "",
  interval: 604800,
  next_check: 300,
  health_interval: 300,
  rpc_delay: 200
};

let selfId     = Shelly.getCurrentScriptId();
let partnerId  = (selfId === WD_SLOT_A) ? WD_SLOT_B : WD_SLOT_A;

let manifest    = null;
let checkTimer  = null;
let healthTimer = null;

// ================= RPC QUEUE =================
let rpcQueue = [];
let rpcHead  = 0;
let rpcBusy  = false;

function shellyCall(method, params, callback) {
  rpcQueue.push({ method: method, params: params, callback: callback });
  drainQueue();
}

function drainQueue() {
  if (rpcBusy || rpcHead >= rpcQueue.length) return;
  rpcBusy = true;
  let item = rpcQueue[rpcHead];
  rpcHead++;
  if (rpcHead > 20) {
    let q = [];
    for (let j = rpcHead; j < rpcQueue.length; j++) q.push(rpcQueue[j]);
    rpcQueue = q;
    rpcHead = 0;
  }
  Timer.set(cfg.rpc_delay, false, function() {
    Shelly.call(item.method, item.params, function(res, err) {
      rpcBusy = false;
      if (item.callback) item.callback(res, err);
      drainQueue();
    });
  });
}

// ================= KVS =================
function kvsGet(key, callback) {
  shellyCall("KVS.Get", { key: key }, function(res, err) {
    if (err || !res) { callback(null); return; }
    callback(res.value);
  });
}

function kvsSet(key, value, callback) {
  shellyCall("KVS.Set", { key: key, value: String(value) }, function(res, err) {
    if (callback) callback(!err);
  });
}

// ================= LOGGING =================
function log(level, msg) {
  print("[" + level + "][" + selfId + "] " + msg);
  shellyCall("MQTT.Publish", {
    topic: "shelly/watchdog/" + level,
    message: msg,
    qos: 0,
    retain: false
  }, null);
}

// ================= GITHUB — SMALL FILE (manifest) =================
function githubGetSmall(file, callback) {
  let assembled = "";
  let offset    = 0;

  function doFetch() {
    let url = CF_WORKER + "/?file=" + cfg.path + "/" + file +
              "&ref=" + cfg.branch +
              "&offset=" + offset +
              "&len=" + FETCH_CHUNK;

    Shelly.call("HTTP.GET", { url: url }, function(res, err) {
      if (err || !res || res.code !== 200) {
        log("ERROR", "Fetch failed: " + file + " err:" + JSON.stringify(err));
        callback(null);
        return;
      }
      assembled += res.body;
      let left = (res.headers && res.headers["X-Left"] !== undefined) ? (res.headers["X-Left"] * 1) : 0;
      offset   += res.body.length;
      if (left > 0) {
        Timer.set(200, false, doFetch);
      } else {
        callback(assembled);
      }
    });
  }

  doFetch();
}

// ================= GITHUB — PIPELINED FETCH+DEPLOY =================
function githubFetchAndDeploy(file, scriptId, isFirst, callback) {
  let fetchOffset = 0;
  let firstPut    = isFirst;

  function doPut(data, pos, left, putDone) {
    if (pos >= data.length) { putDone(true); return; }
    let piece  = data.slice(pos, pos + DEPLOY_CHUNK);
    let append = !firstPut;
    firstPut   = false;

    shellyCall("Script.PutCode", { id: scriptId, code: piece, append: append }, function(res, err) {
      if (err) {
        log("ERROR", "PutCode failed script:" + scriptId + " err:" + JSON.stringify(err));
        putDone(false);
        return;
      }
      doPut(data, pos + piece.length, left, putDone);
    });
  }

  function doFetch() {
    let url = CF_WORKER + "/?file=" + cfg.path + "/" + file +
              "&ref=" + cfg.branch +
              "&offset=" + fetchOffset +
              "&len=" + FETCH_CHUNK;

    Shelly.call("HTTP.GET", { url: url }, function(res, err) {
      if (err || !res || res.code !== 200) {
        log("ERROR", "Fetch failed: " + file + " offset:" + fetchOffset + " err:" + JSON.stringify(err));
        callback(false);
        return;
      }

      let chunk = res.body;
      let left  = (res.headers && res.headers["X-Left"] !== undefined) ? (res.headers["X-Left"] * 1) : 0;
      fetchOffset += chunk.length;

      doPut(chunk, 0, left, function(ok) {
        if (!ok) { callback(false); return; }
        if (left > 0) {
          Timer.set(200, false, doFetch);
        } else {
          callback(true);
        }
      });
    });
  }

  doFetch();
}

// ================= VERSION =================
function extractVersion(code) {
  let end = code.indexOf("\n");
  let firstLine = end > -1 ? code.slice(0, end) : code;
  let marker = "// version: ";
  let idx = firstLine.indexOf(marker);
  if (idx === -1) return null;
  return firstLine.slice(idx + marker.length).trim();
}

function getDeployedVersion(scriptId, callback) {
  shellyCall("Script.GetCode", { id: scriptId, offset: 0, len: 20 }, function(res, err) {
    if (err || !res) { callback(null); return; }
    callback(extractVersion(res.data));
  });
}

// ================= CONFIG DIFF =================
function configDiffers(desired, actual) {
  if (actual === null || actual === undefined) return true;
  let keys = Object.keys(desired);
  for (let i = 0; i < keys.length; i++) {
    let k = keys[i];
    if (typeof desired[k] === "object" && desired[k] !== null) {
      if (configDiffers(desired[k], actual[k])) return true;
    } else {
      if (desired[k] !== actual[k]) return true;
    }
  }
  return false;
}

// ================= PROVISIONING =================
function provisionConfig(config, callback) {
  let methods = Object.keys(config);
  let i = 0;
  function next() {
    if (i >= methods.length) { callback(); return; }
    let setMethod = methods[i];
    let desired   = config[setMethod];
    i++;
    let getMethod = setMethod.replace("SetConfig", "GetConfig");
    if (getMethod === setMethod) {
      shellyCall(setMethod, desired, function(res, err) {
        if (err) log("WARN", "Failed: " + setMethod);
        next();
      });
      return;
    }
    shellyCall(getMethod, {}, function(res, err) {
      if (!err && res && !configDiffers(desired.config, res)) { next(); return; }
      shellyCall(setMethod, desired, function(res2, err2) {
        if (err2) log("WARN", "Failed: " + setMethod);
        else if (res2 && res2.restart_required) log("WARN", setMethod + " REBOOT REQUIRED");
        else log("INFO", setMethod + " applied OK");
        next();
      });
    });
  }
  next();
}

function provisionKvsConfig(kvsConfig, callback) {
  let keys = Object.keys(kvsConfig);
  let i = 0;
  function next() {
    if (i >= keys.length) { callback(); return; }
    let key   = keys[i];
    let entry = kvsConfig[key];
    i++;
    shellyCall("KVS.Get", { key: key }, function(res, err) {
      if (!err && res) { next(); return; }
      let getMethod = entry.method.replace("SetConfig", "GetConfig");
      shellyCall(getMethod, {}, function(gres, gerr) {
        if (!gerr && gres && !configDiffers(entry.config, gres)) {
          shellyCall("KVS.Set", { key: key, value: "configured" }, function() { next(); });
          return;
        }
        shellyCall(entry.method, { config: entry.config }, function(sres, serr) {
          if (serr) log("WARN", "Failed kvsConfig: " + key);
          else if (sres && sres.restart_required) log("WARN", key + " REBOOT REQUIRED");
          else log("INFO", key + " applied OK");
          shellyCall("KVS.Set", { key: key, value: "configured" }, function() { next(); });
        });
      });
    });
  }
  next();
}

function provisionKvsDefaults(defaults, callback) {
  let keys = Object.keys(defaults);
  let i = 0;
  function next() {
    if (i >= keys.length) { callback(); return; }
    let key = keys[i];
    let val = defaults[key];
    i++;
    shellyCall("KVS.Get", { key: key }, function(res, err) {
      if (!err && res) { next(); return; }
      shellyCall("KVS.Set", { key: key, value: String(val) }, function(r2, e2) {
        if (!e2) log("INFO", "KVS default: " + key + "=" + val);
        next();
      });
    });
  }
  next();
}

function provisionComponents(components, callback) {
  let i = 0;
  function next() {
    if (i >= components.length) { callback(); return; }
    let comp = components[i]; i++;
    let getMethod = (comp.type === "text") ? "Text.GetConfig" : "Number.GetConfig";
    shellyCall(getMethod, { id: comp.id }, function(res, err) {
      if (!err && res && res.name === comp.name) { next(); return; }
      if (!err && res) {
        let setMethod = (comp.type === "text") ? "Text.SetConfig" : "Number.SetConfig";
        shellyCall(setMethod, { id: comp.id, config: { name: comp.name } }, function() {
          log("INFO", "Renamed " + comp.type + ":" + comp.id + " to " + comp.name);
          next();
        });
        return;
      }
      let addMethod = (comp.type === "text") ? "Text.Add" : "Number.Add";
      shellyCall(addMethod, { id: comp.id, config: { name: comp.name } }, function(r2, e2) {
        if (e2) log("ERROR", "Failed to create " + comp.type + ":" + comp.id);
        else log("INFO", "Created " + comp.type + ":" + comp.id);
        next();
      });
    });
  }
  next();
}

// ================= WATCHDOG SELF-UPDATE =================
function selfUpdate(remoteVersion, callback) {
  log("INFO", "Self-update to " + remoteVersion + " — deploying to slot " + partnerId);

  // Stop partner if running
  shellyCall("Script.GetStatus", { id: partnerId }, function(res, err) {
    if (!err && res && res.running) {
      shellyCall("Script.Stop", { id: partnerId }, function() {
        writeToPartner(remoteVersion, callback);
      });
    } else {
      writeToPartner(remoteVersion, callback);
    }
  });
}

function writeToPartner(remoteVersion, callback) {
  kvsSet("s." + partnerId + ".ok", "0", function() {
    githubFetchAndDeploy("watchdog.js", partnerId, true, function(ok) {
      if (!ok) {
        log("ERROR", "Self-update deploy failed");
        callback(false);
        return;
      }
      kvsSet("s." + partnerId + ".ok", "1", function() {
        log("INFO", "Self-update written to slot " + partnerId + " — starting");
        shellyCall("Script.Start", { id: partnerId }, function(res, err) {
          if (err) {
            log("ERROR", "Failed to start slot " + partnerId);
            callback(false);
          } else {
            // New watchdog takes over — we exit
            callback(true);
          }
        });
      });
    });
  });
}

// On boot — check if partner is older and delete it
function cleanupPartner(callback) {
  shellyCall("Script.GetCode", { id: partnerId, offset: 0, len: 20 }, function(res, err) {
    if (err || !res) {
      // Partner doesn't exist — nothing to clean up
      callback();
      return;
    }
    let partnerVersion = extractVersion(res.data);
    getDeployedVersion(selfId, function(myVersion) {
      if (partnerVersion && myVersion && partnerVersion < myVersion) {
        log("INFO", "Deleting older partner slot " + partnerId + " v" + partnerVersion);
        shellyCall("Script.Stop",   { id: partnerId }, function() {
          shellyCall("Script.Delete", { id: partnerId }, function() {
            callback();
          });
        });
      } else {
        callback();
      }
    });
  });
}

// ================= SCRIPT DEPLOY =================
function deployScript(script, callback) {
  kvsSet("s." + script.id + ".ok", "0", function() {
    shellyCall("Script.GetStatus", { id: script.id }, function(res, err) {
      let running = (!err && res && res.running);
      function doWrite() {
        githubFetchAndDeploy(script.file, script.id, true, function(ok) {
          if (!ok) {
            log("ERROR", "Deploy failed: " + script.name);
            callback(false);
            return;
          }
          kvsSet("s." + script.id + ".ok", "1", function() {
            log("INFO", "Deployed: " + script.name);
            if (!script.autostart) { callback(true); return; }
            shellyCall("Script.Start", { id: script.id }, function(r2, e2) {
              if (e2) {
                log("ERROR", "Failed to start: " + script.name);
                kvsSet("s." + script.id + ".ok", "0", null);
                callback(false);
                return;
              }
              Timer.set(5000, false, function() {
                shellyCall("Script.GetStatus", { id: script.id }, function(r3) {
                  if (!r3 || !r3.running) {
                    log("ERROR", script.name + " failed to stay running");
                    kvsSet("s." + script.id + ".ok", "0", null);
                    callback(false);
                  } else {
                    callback(true);
                  }
                });
              });
            });
          });
        });
      }
      if (running) {
        shellyCall("Script.Stop", { id: script.id }, function() { doWrite(); });
      } else {
        doWrite();
      }
    });
  });
}

// ================= HEALTH CHECK =================
function healthCheck(scripts, callback) {
  let i = 0;
  let forceRedeploy = false;
  function next() {
    if (i >= scripts.length) { callback(forceRedeploy); return; }
    let script = scripts[i]; i++;
    if (!script.autostart || script.id === selfId || script.id === partnerId) { next(); return; }
    shellyCall("Script.GetStatus", { id: script.id }, function(res, err) {
      if (!err && res && res.running) {
        kvsSet("s." + script.id + ".fails", "0", null);
        next();
        return;
      }
      kvsGet("s." + script.id + ".fails", function(val) {
        let fails = val ? (val * 1) : 0;
        fails++;
        if (fails >= 3) {
          log("WARN", "Script " + script.id + " failed 3 times — forcing redeploy");
          kvsSet("s." + script.id + ".ok", "0", null);
          kvsSet("s." + script.id + ".fails", "0", null);
          forceRedeploy = true;
          next();
        } else {
          kvsSet("s." + script.id + ".fails", String(fails), function() {
            log("WARN", "Script " + script.id + " not running, restart " + fails + "/3");
            shellyCall("Script.Start", { id: script.id }, function() { next(); });
          });
        }
      });
    });
  }
  next();
}

// ================= VERSION CYCLE =================
function checkForcedFlags(scripts, callback) {
  let flags = [];
  let i = 0;
  function next() {
    if (i >= scripts.length) { callback(flags); return; }
    let script = scripts[i]; i++;
    kvsGet("s." + script.id + ".ok", function(val) {
      flags.push(val === "0");
      next();
    });
  }
  next();
}

function checkAndDeployScript(scripts, i, forcedFlags, anyDeployed, callback) {
  if (i >= scripts.length) { callback(anyDeployed); return; }
  let script = scripts[i];
  let forced = forcedFlags[i];

  // Skip watchdog slots — handled separately via selfUpdate
  if (script.id === selfId || script.id === partnerId) {
    checkAndDeployScript(scripts, i + 1, forcedFlags, anyDeployed, callback);
    return;
  }

  // Fetch only first 20 bytes for version check — avoids full file load
  let versionUrl = CF_WORKER + "/?file=" + cfg.path + "/" + script.file +
                   "&ref=" + cfg.branch + "&offset=0&len=20";

  Shelly.call("HTTP.GET", { url: versionUrl }, function(res, err) {
    if (err || !res || res.code !== 200) {
      log("ERROR", "Version check failed: " + script.file + " — skipping");
      checkAndDeployScript(scripts, i + 1, forcedFlags, anyDeployed, callback);
      return;
    }
    let remoteVersion = extractVersion(res.body);
    getDeployedVersion(script.id, function(localVersion) {
      log("INFO", script.name + " local:" + localVersion + " remote:" + remoteVersion);
      if (!forced && localVersion === remoteVersion) {
        checkAndDeployScript(scripts, i + 1, forcedFlags, anyDeployed, callback);
        return;
      }
      deployScript(script, function(ok) {
        checkAndDeployScript(scripts, i + 1, forcedFlags, true, callback);
      });
    });
  });
}

function checkWatchdogUpdate(callback) {
  // Fetch just the first chunk to get version line
  let url = CF_WORKER + "/?file=" + cfg.path + "/watchdog.js" +
            "&ref=" + cfg.branch + "&offset=0&len=20";
  Shelly.call("HTTP.GET", { url: url }, function(res, err) {
    if (err || !res || res.code !== 200) {
      log("WARN", "Could not check watchdog version");
      callback(false);
      return;
    }
    let remoteVersion = extractVersion(res.body);
    getDeployedVersion(selfId, function(localVersion) {
      log("INFO", "Watchdog local:" + localVersion + " remote:" + remoteVersion);
      if (remoteVersion && localVersion !== remoteVersion) {
        selfUpdate(remoteVersion, function(ok) {
          if (ok) {
            // New watchdog is running — stop here
            callback("updated");
          } else {
            callback(false);
          }
        });
      } else {
        callback(false);
      }
    });
  });
}

// ================= CYCLES =================
function runHealthCycle() {
  if (!manifest) { scheduleHealth(); return; }
  healthCheck(manifest.scripts, function(forceRedeploy) {
    if (forceRedeploy) {
      if (checkTimer) { Timer.clear(checkTimer); checkTimer = null; }
      log("INFO", "Health check triggered version cycle");
      runVersionCycle();
    }
    scheduleHealth();
  });
}

function runVersionCycle() {
  if (checkTimer) { Timer.clear(checkTimer); checkTimer = null; }
  log("INFO", "Version cycle starting");

  // Check watchdog update first
  checkWatchdogUpdate(function(result) {
    if (result === "updated") return; // new watchdog takes over

    githubGetSmall(MANIFEST_FILE, function(body) {
      if (!body) {
        log("ERROR", "Failed to fetch manifest — retry in 300s");
        scheduleNext(300);
        return;
      }
      try { manifest = JSON.parse(body); } catch(e) {
        log("ERROR", "Failed to parse manifest");
        scheduleNext(300);
        return;
      }
      provisionComponents(manifest.components, function() {
        provisionConfig(manifest.config || {}, function() {
          provisionKvsConfig(manifest.kvsConfig || {}, function() {
            provisionKvsDefaults(manifest.kvsDefaults || {}, function() {
              checkForcedFlags(manifest.scripts, function(flags) {
                checkAndDeployScript(manifest.scripts, 0, flags, false, function(anyDeployed) {
                  if (anyDeployed || result) {
                    cfg.next_check = 300;
                    kvsSet("wd.next_check", "300", null);
                    scheduleNext(300);
                  } else {
                    let n = cfg.next_check * 2;
                    if (n > cfg.interval) n = cfg.interval;
                    cfg.next_check = n;
                    kvsSet("wd.next_check", String(n), null);
                    scheduleNext(n);
                  }
                });
              });
            });
          });
        });
      });
    });
  });
}

// ================= SCHEDULING =================
function scheduleHealth() {
  healthTimer = Timer.set(cfg.health_interval * 1000, false, function() { runHealthCycle(); });
}

function scheduleNext(seconds) {
  log("INFO", "Next check in " + seconds + "s");
  checkTimer = Timer.set(seconds * 1000, false, function() { runVersionCycle(); });
}

// ================= BOOT =================
function boot() {
  log("INFO", "Watchdog booting. selfId:" + selfId + " partnerId:" + partnerId);

  kvsGet("wd.branch", function(branch) {
    kvsGet("wd.path", function(path) {
      kvsGet("wd.interval", function(interval) {
        kvsGet("wd.next_check", function(next_check) {
          kvsGet("wd.health_interval", function(health_interval) {
            kvsGet("wd.rpc_delay", function(rpc_delay) {

              if (!branch || !path) {
                log("ERROR", "Missing wd.branch or wd.path — halting");
                return;
              }

              cfg.branch          = branch;
              cfg.path            = path;
              cfg.interval        = interval        ? (interval * 1)        : 604800;
              cfg.next_check      = next_check      ? (next_check * 1)      : 300;
              cfg.health_interval = health_interval ? (health_interval * 1) : 300;
              cfg.rpc_delay       = rpc_delay       ? (rpc_delay * 1)       : 200;

              log("INFO", "Config loaded. branch:" + cfg.branch + " path:" + cfg.path);

              // Clean up older partner slot if present
              cleanupPartner(function() {
                runVersionCycle();
                scheduleHealth();
              });
            });
          });
        });
      });
    });
  });
}

// ================= ENTRY =================
Timer.set(2000, false, function() { boot(); });
