// version: 1.0.0
// === Shelly Watchdog - GitHub Auto-Deploy & Script Monitor ===

let MANIFEST_FILE = "manifest.json";

// ================= STATE =================
let cfg = {
  pat: "",
  url: "",
  branch: "",
  interval: 3600,
  next_check: 300
};

let manifest = null;
let checkTimer = null;
let deployQueue = [];
let currentDeploy = null;
let deployChunkOffset = 0;
let deployContent = "";

// ================= KVS =================
function kvsGet(key, callback) {
  Shelly.call("KVS.Get", { key: key }, function(res, err) {
    if (err || !res) { callback(null); return; }
    callback(res.value);
  });
}

function kvsSet(key, value, callback) {
  Shelly.call("KVS.Set", { key: key, value: String(value) }, function(res, err) {
    if (callback) callback(!err);
  });
}

// ================= LOGGING =================
function log(level, msg) {
  print("[" + level + "] " + msg);
  Shelly.call("MQTT.Publish", {
    topic: "shelly/watchdog/" + level,
    message: msg,
    qos: 0,
    retain: false
  });
}

// ================= GITHUB =================
function githubGet(path, callback) {
  let url = cfg.url + "/contents/" + path + "?ref=" + cfg.branch;
  Shelly.call("HTTP.GET", {
    url: url,
    headers: {
      "Authorization": "token " + cfg.pat,
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
  // Shelly provides atob()
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

// ================= COMPONENTS =================
function provisionComponents(components, callback) {
  let i = 0;

  function next() {
    if (i >= components.length) { callback(); return; }
    let comp = components[i];
    i++;

    let method = (comp.type === "text") ? "Text.GetConfig" : "Number.GetConfig";
    Shelly.call(method, { id: comp.id }, function(res, err) {
      if (!err && res && res.name === comp.name) {
        // exists and name matches — skip
        next();
        return;
      }
      if (!err && res) {
        // exists but wrong name — rename
        let setMethod = (comp.type === "text") ? "Text.SetConfig" : "Number.SetConfig";
        Shelly.call(setMethod, { id: comp.id, config: { name: comp.name } }, function() {
          log("INFO", "Renamed component " + comp.type + ":" + comp.id + " to " + comp.name);
          next();
        });
        return;
      }
      // doesn't exist — create it
      let addMethod = (comp.type === "text") ? "Text.Add" : "Number.Add";
      Shelly.call(addMethod, { id: comp.id, config: { name: comp.name } }, function(res2, err2) {
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
  Shelly.call("Script.GetCode", { id: scriptId, offset: 0, len: 20 }, function(res, err) {
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
      Shelly.call("Script.GetStatus", { id: script.id }, function(res, err) {
        if (!err && res && res.running) {
          Shelly.call("Script.Stop", { id: script.id }, function() {
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

      Shelly.call("Script.PutCode", {
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
          // Deploy complete
          kvsSet("s." + script.id + ".ok", "1", function() {
            log("INFO", "Deploy complete: " + script.name + " v" + extractVersion(content));
            if (script.autostart) {
              Shelly.call("Script.Start", { id: script.id }, function(res2, err2) {
                if (err2) {
                  log("ERROR", "Failed to start script " + script.id);
                  callback(false);
                  return;
                }
                // Wait 5s then verify it's running
                Timer.set(5000, false, function() {
                  Shelly.call("Script.GetStatus", { id: script.id }, function(res3) {
                    if (!res3 || !res3.running) {
                      log("ERROR", "Script " + script.id + " failed to start after deploy");
                      kvsSet("s." + script.id + ".ok", "0");
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

    Shelly.call("Script.GetStatus", { id: script.id }, function(res, err) {
      if (!err && res && res.running) {
        // healthy — reset fail counter
        kvsSet("s." + script.id + ".fails", "0");
        next();
        return;
      }

      // not running
      kvsGet("s." + script.id + ".fails", function(val) {
        let fails = val ? (val * 1) : 0;
        fails++;

        if (fails >= 3) {
          log("WARN", "Script " + script.id + " failed to stay running 3 times — forcing redeploy");
          kvsSet("s." + script.id + ".ok", "0");
          kvsSet("s." + script.id + ".fails", "0");
          forceRedeploy = true;
          next();
        } else {
          kvsSet("s." + script.id + ".fails", String(fails));
          log("WARN", "Script " + script.id + " not running, attempt restart " + fails + "/3");
          Shelly.call("Script.Start", { id: script.id }, function() { next(); });
        }
      });
    });
  }

  next();
}

// ================= MAIN CYCLE =================
function runCycle() {
  if (checkTimer) { Timer.clear(checkTimer); checkTimer = null; }

  log("INFO", "Watchdog cycle starting");

  // Step 1 — health check all scripts
  if (!manifest) {
    fetchManifestAndDeploy(false);
    return;
  }

  healthCheck(manifest.scripts, function(forceRedeploy) {
    fetchManifestAndDeploy(forceRedeploy);
  });
}

function fetchManifestAndDeploy(forceRedeploy) {
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

    // Step 2 — provision components
    provisionComponents(manifest.components, function() {

      // Step 3 — check for any forced redeployments in KVS
      checkForcedFlags(manifest.scripts, function(flags) {
        let anyForced = forceRedeploy;
        for (let i = 0; i < flags.length; i++) { if (flags[i]) anyForced = true; }

        // Step 4 — check watchdog itself first
        checkAndDeployScript(manifest.scripts, 0, flags, false, function(anyDeployed) {
          if (anyDeployed) {
            scheduleNext(300);
          } else {
            // double interval up to max
            let next = cfg.next_check * 2;
            if (next > cfg.interval) next = cfg.interval;
            cfg.next_check = next;
            kvsSet("wd.next_check", String(next));
            scheduleNext(next);
          }
        });
      });
    });
  });
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

      // Deploy needed
      let isSelf = (script.name === "watchdog");

      deployScript(script, content, function(ok) {
        if (ok && isSelf) {
          // New watchdog is now running — exit, it takes over
          log("INFO", "Watchdog self-updated to " + remoteVersion + " — handing over");
          return;
        }
        checkAndDeployScript(scripts, i + 1, forcedFlags, true, callback);
      });
    });
  });
}

// ================= SCHEDULING =================
function scheduleNext(seconds) {
  log("INFO", "Next check in " + seconds + "s");
  checkTimer = Timer.set(seconds * 1000, false, function() {
    runCycle();
  });
}

// ================= BOOT =================
function boot() {
  log("INFO", "Watchdog booting...");

  kvsGet("wd.pat", function(pat) {
    kvsGet("wd.url", function(url) {
      kvsGet("wd.branch", function(branch) {
        kvsGet("wd.interval", function(interval) {
          kvsGet("wd.next_check", function(next_check) {

            if (!pat || !url || !branch) {
              log("ERROR", "Missing required KVS config (wd.pat, wd.url, wd.branch) — halting");
              return;
            }

            cfg.pat      = pat;
            cfg.url      = url;
            cfg.branch   = branch;
            cfg.interval = interval ? (interval * 1) : 3600;
            cfg.next_check = next_check ? (next_check * 1) : 300;

            log("INFO", "Config loaded. interval:" + cfg.interval + "s next_check:" + cfg.next_check + "s");
            runCycle();
          });
        });
      });
    });
  });
}

// ================= ENTRY =================
Timer.set(2000, false, function() { boot(); });
