// version: 1.0.0
// === Shelly Watchdog - GitHub Auto-Deploy & Script Monitor ===

let MANIFEST_FILE = "manifest.json";

// ================= STATE =================
let cfg = {
  url: "",
  branch: "",
  path: "",
  interval: 604800,     // default weekly
  next_check: 300,
  health_interval: 300, // default 5 mins
  rpc_delay: 200        // ms between RPC calls
};

let manifest = null;
let checkTimer = null;
let healthTimer = null;

// ================= RPC QUEUE =================
let rpcQueue = [];
let rpcHead = 0;
let rpcBusy = false;

function shellyCall(method, params, callback) {
  rpcQueue.push({ method: method, params: params, callback: callback });
  drainQueue();
}

function drainQueue() {
  if (rpcBusy || rpcHead >= rpcQueue.length) return;
  rpcBusy = true;
  let item = rpcQueue[rpcHead];
  rpcHead++;
  // Periodically compact the queue to avoid unbounded growth
  if (rpcHead > 20) {
    let newQueue = [];
    for (let j = rpcHead; j < rpcQueue.length; j++) {
      newQueue.push(rpcQueue[j]);
    }
    rpcQueue = newQueue;
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
  print("[" + level + "] " + msg);
  shellyCall("MQTT.Publish", {
    topic: "shelly/watchdog/" + level,
    message: msg,
    qos: 0,
    retain: false
  }, null);
}

// ================= GITHUB =================
// HTTP.GET goes direct — separate subsystem, not subject to RPC rate limits
function githubGet(file, callback) {
  let fullPath = cfg.path ? cfg.path + "/" + file : file;
  let url = cfg.url + "/contents/" + fullPath + "?ref=" + cfg.branch;
  Shelly.call("HTTP.GET", {
    url: url,
    headers: {
      "Accept": "application/vnd.github.v3+json"
    }
  }, function(res, err) {
    if (err || !res || res.code !== 200) {
      log("ERROR", "GitHub fetch failed: " + path + " err:" + JSON.stringify(err));
      callback(null);
      return;
    }
    let body = null;
    try { body = JSON.parse(res.body); } catch(e) {
      log("ERROR", "JSON parse failed: " + path);
      callback(null);
      return;
    }
    callback(body);
  });
}

function decodeBase64Content(encoded) {
  let stripped = "";
  for (let i = 0; i < encoded.length; i++) {
    let c = encoded[i];
    if (c !== "\n" && c !== "\r" && c !== " ") stripped += c;
  }
  return atob(stripped);
}

function extractVersion(code) {
  // Expects first line: // version: 1.0.0
  let end = code.indexOf("\n");
  let firstLine = end > -1 ? code.slice(0, end) : code;
  let marker = "// version: ";
  let idx = firstLine.indexOf(marker);
  if (idx === -1) return null;
  return firstLine.slice(idx + marker.length).trim();
}

// ================= CONFIG PROVISIONING =================
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

function provisionConfig(config, callback) {
  let methods = Object.keys(config);
  let i = 0;

  function next() {
    if (i >= methods.length) { callback(); return; }

    let setMethod = methods[i];                  // e.g. "Sys.SetConfig"
    let desired   = config[setMethod];           // e.g. { config: { location: { tz: "..." } } }
    i++;

    // Derive the Get method — swap "Set" for "Get"
    let getMethod = setMethod.replace("SetConfig", "GetConfig");
    if (getMethod === setMethod) {
      // No SetConfig/GetConfig pattern — just fire it blindly
      log("INFO", "Applying " + setMethod + " (no Get counterpart)");
      shellyCall(setMethod, desired, function(res, err) {
        if (err) log("WARN", "Failed to apply " + setMethod + ": " + JSON.stringify(err));
        next();
      });
      return;
    }

    shellyCall(getMethod, {}, function(res, err) {
      if (err || !res) {
        log("WARN", getMethod + " failed — applying " + setMethod + " blindly");
        shellyCall(setMethod, desired, function(res2, err2) {
          if (err2) log("WARN", "Failed to apply " + setMethod + ": " + JSON.stringify(err2));
          next();
        });
        return;
      }

      // Compare desired config against current
      if (!configDiffers(desired.config, res)) {
        log("INFO", setMethod + " already up to date — skipping");
        next();
        return;
      }

      log("INFO", "Applying " + setMethod);
      shellyCall(setMethod, desired, function(res2, err2) {
        if (err2) {
          log("WARN", "Failed to apply " + setMethod + ": " + JSON.stringify(err2));
        } else if (res2 && res2.restart_required) {
          log("WARN", setMethod + " applied but REBOOT REQUIRED to take effect");
        } else {
          log("INFO", setMethod + " applied OK");
        }
        next();
      });
    });
  }

  next();
}

// ================= COMPONENTS =================
function provisionComponents(components, callback) {
  let i = 0;

  function next() {
    if (i >= components.length) { callback(); return; }
    let comp = components[i];
    i++;

    let getMethod = (comp.type === "text") ? "Text.GetConfig" : "Number.GetConfig";
    shellyCall(getMethod, { id: comp.id }, function(res, err) {
      if (!err && res && res.name === comp.name) {
        // exists and name matches — skip
        next();
        return;
      }
      if (!err && res) {
        // exists but wrong name — rename
        let setMethod = (comp.type === "text") ? "Text.SetConfig" : "Number.SetConfig";
        shellyCall(setMethod, { id: comp.id, config: { name: comp.name } }, function() {
          log("INFO", "Renamed component " + comp.type + ":" + comp.id + " to " + comp.name);
          next();
        });
        return;
      }
      // doesn't exist — create it
      let addMethod = (comp.type === "text") ? "Text.Add" : "Number.Add";
      shellyCall(addMethod, { id: comp.id, config: { name: comp.name } }, function(res2, err2) {
        if (err2) {
          log("ERROR", "Failed to create component " + comp.type + ":" + comp.id);
        } else {
          log("INFO", "Created component " + comp.type + ":" + comp.id + " name:" + comp.name);
        }
        next();
      });
    });
  }

  next();
}

// ================= SCRIPT VERSION =================
function getDeployedVersion(scriptId, callback) {
  // Read just the first 20 bytes — enough for "// version: 1.0.0\n"
  shellyCall("Script.GetCode", { id: scriptId, offset: 0, len: 20 }, function(res, err) {
    if (err || !res) { callback(null); return; }
    callback(extractVersion(res.data));
  });
}

// ================= DEPLOY =================
function deployScript(script, content, callback) {
  let CHUNK = 1024;
  let offset = 0;

  kvsSet("s." + script.id + ".ok", "0", function() {

    function stopThenDeploy() {
      shellyCall("Script.GetStatus", { id: script.id }, function(res, err) {
        if (!err && res && res.running) {
          shellyCall("Script.Stop", { id: script.id }, function() {
            putNextChunk();
          });
        } else {
          putNextChunk();
        }
      });
    }

    function putNextChunk() {
      let chunk = content.slice(offset, offset + CHUNK);
      let isFirst = (offset === 0);
      offset += chunk.length;

      shellyCall("Script.PutCode", {
        id: script.id,
        code: chunk,
        append: !isFirst
      }, function(res, err) {
        if (err) {
          log("ERROR", "PutCode failed for script " + script.id + " at offset " + (offset - chunk.length));
          callback(false);
          return;
        }
        if (offset < content.length) {
          putNextChunk();
        } else {
          // All chunks sent
          kvsSet("s." + script.id + ".ok", "1", function() {
            log("INFO", "Deploy complete: " + script.name + " v" + extractVersion(content));
            if (script.autostart) {
              shellyCall("Script.Start", { id: script.id }, function(res2, err2) {
                if (err2) {
                  log("ERROR", "Failed to start script " + script.id);
                  callback(false);
                  return;
                }
                // Wait 5s then verify running
                Timer.set(5000, false, function() {
                  shellyCall("Script.GetStatus", { id: script.id }, function(res3) {
                    if (!res3 || !res3.running) {
                      log("ERROR", "Script " + script.id + " failed to start after deploy");
                      kvsSet("s." + script.id + ".ok", "0", null);
                      callback(false);
                    } else {
                      log("INFO", "Script " + script.id + " running OK after deploy");
                      callback(true);
                    }
                  });
                });
              });
            } else {
              callback(true);
            }
          });
        }
      });
    }

    stopThenDeploy();
  });
}

// ================= HEALTH CHECK =================
function healthCheck(scripts, callback) {
  let i = 0;
  let forceRedeploy = false;

  function next() {
    if (i >= scripts.length) { callback(forceRedeploy); return; }
    let script = scripts[i];
    i++;

    if (!script.autostart || script.name === "watchdog") { next(); return; }

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
          log("WARN", "Script " + script.id + " failed to stay running 3 times — forcing redeploy");
          kvsSet("s." + script.id + ".ok", "0", null);
          kvsSet("s." + script.id + ".fails", "0", null);
          forceRedeploy = true;
          next();
        } else {
          kvsSet("s." + script.id + ".fails", String(fails), function() {
            log("WARN", "Script " + script.id + " not running, attempt restart " + fails + "/3");
            shellyCall("Script.Start", { id: script.id }, function() { next(); });
          });
        }
      });
    });
  }

  next();
}

// ================= HEALTH CYCLE =================
function runHealthCycle() {
  if (!manifest) {
    scheduleHealth();
    return;
  }

  healthCheck(manifest.scripts, function(forceRedeploy) {
    if (forceRedeploy) {
      if (checkTimer) { Timer.clear(checkTimer); checkTimer = null; }
      log("INFO", "Health check triggered immediate version cycle");
      runVersionCycle();
    }
    scheduleHealth();
  });
}

// ================= VERSION CYCLE =================
function runVersionCycle() {
  if (checkTimer) { Timer.clear(checkTimer); checkTimer = null; }
  log("INFO", "Version check cycle starting");
  fetchManifestAndDeploy();
}

function fetchManifestAndDeploy() {
  githubGet(MANIFEST_FILE, function(body) {
    if (!body) {
      log("ERROR", "Failed to fetch manifest — will retry");
      scheduleNext(300);
      return;
    }

    let content = null;
    try { content = decodeBase64Content(body.content); } catch(e) {
      log("ERROR", "Failed to decode manifest");
      scheduleNext(300);
      return;
    }

    try { manifest = JSON.parse(content); } catch(e) {
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
                if (anyDeployed) {
                  cfg.next_check = 300;
                  kvsSet("wd.next_check", "300", null);
                  scheduleNext(300);
                } else {
                  let next = cfg.next_check * 2;
                  if (next > cfg.interval) next = cfg.interval;
                  cfg.next_check = next;
                  kvsSet("wd.next_check", String(next), null);
                  scheduleNext(next);
                }
              });
            });
          });
        });
      });
    });
  });
}

// ================= KVS CONFIG =================
// Applies RPC config only if KVS key doesn't exist — user can override by setting the key
function provisionKvsConfig(kvsConfig, callback) {
  let keys = Object.keys(kvsConfig);
  let i = 0;

  function next() {
    if (i >= keys.length) { callback(); return; }
    let key   = keys[i];
    let entry = kvsConfig[key];
    i++;

    shellyCall("KVS.Get", { key: key }, function(res, err) {
      if (!err && res) {
        // Key exists — user has configured this, skip
        next();
        return;
      }

      // Key missing — check if device already has correct value
      let getMethod = entry.method.replace("SetConfig", "GetConfig");
      shellyCall(getMethod, {}, function(gres, gerr) {
        if (!gerr && gres && !configDiffers(entry.config, gres)) {
          // Already correct — just mark as configured in KVS
          shellyCall("KVS.Set", { key: key, value: "configured" }, function() { next(); });
          return;
        }

        log("INFO", "Applying kvsConfig: " + entry.method + " for " + key);
        shellyCall(entry.method, { config: entry.config }, function(sres, serr) {
          if (serr) {
            log("WARN", "Failed to apply " + entry.method + " for " + key + ": " + JSON.stringify(serr));
            next();
            return;
          }
          if (sres && sres.restart_required) {
            log("WARN", entry.method + " (" + key + ") applied but REBOOT REQUIRED to take effect");
          } else {
            log("INFO", entry.method + " (" + key + ") applied OK");
          }
          shellyCall("KVS.Set", { key: key, value: "configured" }, function() { next(); });
        });
      });
    });
  }

  next();
}

// ================= KVS DEFAULTS =================
// Writes manifest kvsDefaults to KVS only if key doesn't already exist
function provisionKvsDefaults(defaults, callback) {
  let keys = Object.keys(defaults);
  let i = 0;

  function next() {
    if (i >= keys.length) { callback(); return; }
    let key = keys[i];
    let val = defaults[key];
    i++;

    shellyCall("KVS.Get", { key: key }, function(res, err) {
      if (!err && res) {
        next();
        return;
      }
      shellyCall("KVS.Set", { key: key, value: String(val) }, function(res2, err2) {
        if (err2) {
          log("WARN", "Failed to set KVS default: " + key);
        } else {
          log("INFO", "KVS default set: " + key + " = " + val);
        }
        next();
      });
    });
  }

  next();
}

function checkForcedFlags(scripts, callback) {
  let flags = [];
  let i = 0;

  function next() {
    if (i >= scripts.length) { callback(flags); return; }
    let script = scripts[i];
    i++;
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

  githubGet(script.file, function(body) {
    if (!body) {
      log("ERROR", "Failed to fetch " + script.file + " — skipping");
      checkAndDeployScript(scripts, i + 1, forcedFlags, anyDeployed, callback);
      return;
    }

    let content = null;
    try { content = decodeBase64Content(body.content); } catch(e) {
      log("ERROR", "Failed to decode " + script.file);
      checkAndDeployScript(scripts, i + 1, forcedFlags, anyDeployed, callback);
      return;
    }

    let remoteVersion = extractVersion(content);

    getDeployedVersion(script.id, function(localVersion) {
      log("INFO", script.name + " local:" + localVersion + " remote:" + remoteVersion + " forced:" + forced);

      if (!forced && localVersion === remoteVersion) {
        checkAndDeployScript(scripts, i + 1, forcedFlags, anyDeployed, callback);
        return;
      }

      let isSelf = (script.name === "watchdog");

      deployScript(script, content, function(ok) {
        if (ok && isSelf) {
          log("INFO", "Watchdog self-updated to " + remoteVersion + " — handing over");
          return;
        }
        checkAndDeployScript(scripts, i + 1, forcedFlags, true, callback);
      });
    });
  });
}

// ================= SCHEDULING =================
function scheduleHealth() {
  healthTimer = Timer.set(cfg.health_interval * 1000, false, function() {
    runHealthCycle();
  });
}

function scheduleNext(seconds) {
  log("INFO", "Next version check in " + seconds + "s");
  checkTimer = Timer.set(seconds * 1000, false, function() {
    runVersionCycle();
  });
}

// ================= BOOT =================
function boot() {
  log("INFO", "Watchdog booting...");

  kvsGet("wd.url", function(url) {
    kvsGet("wd.branch", function(branch) {
      kvsGet("wd.path", function(path) {
        kvsGet("wd.interval", function(interval) {
          kvsGet("wd.next_check", function(next_check) {
            kvsGet("wd.health_interval", function(health_interval) {
              kvsGet("wd.rpc_delay", function(rpc_delay) {

                if (!url || !branch || !path) {
                  log("ERROR", "Missing required KVS config (wd.url, wd.branch, wd.path) — halting");
                  return;
                }

                cfg.url             = url;
                cfg.branch          = branch;
                cfg.path            = path;
                cfg.interval        = interval        ? (interval * 1)        : 604800;
                cfg.next_check      = next_check      ? (next_check * 1)      : 300;
                cfg.health_interval = health_interval ? (health_interval * 1) : 300;
                cfg.rpc_delay       = rpc_delay       ? (rpc_delay * 1)       : 200;

                log("INFO",
                  "Config loaded." +
                  " path:" + cfg.path +
                  " version_interval:" + cfg.interval + "s" +
                  " health_interval:"  + cfg.health_interval + "s" +
                  " rpc_delay:"        + cfg.rpc_delay + "ms"
                );

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
