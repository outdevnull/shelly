// version: 1.0.0
// === Shelly Watchdog Bootstrapper ===
// One-shot: fetches watchdog.js from GitHub, deploys it to Script 1, then starts it.
// Overwrites itself in the process — runs once and ceases to exist.

let WATCHDOG_FILE = "watchdog.js";
let SCRIPT_ID = 1;
let CHUNK = 1024;

function log(msg) {
  print("[BOOTSTRAP] " + msg);
  Shelly.call("MQTT.Publish", {
    topic: "shelly/bootstrap/INFO",
    message: msg,
    qos: 0,
    retain: false
  }, null);
}

function halt(msg) {
  print("[BOOTSTRAP ERROR] " + msg);
  Shelly.call("MQTT.Publish", {
    topic: "shelly/bootstrap/ERROR",
    message: msg,
    qos: 0,
    retain: false
  }, null);
}

function fetchAndDeploy(pat, url, branch) {
  let fullUrl = url + "/contents/" + WATCHDOG_FILE + "?ref=" + branch;
  log("Fetching " + WATCHDOG_FILE + " from " + fullUrl);

  Shelly.call("HTTP.GET", {
    url: fullUrl,
    headers: {
      "Authorization": "token " + pat,
      "Accept": "application/vnd.github.v3+json"
    }
  }, function(res, err) {
    if (err || !res || res.code !== 200) {
      halt("Failed to fetch watchdog.js — err:" + JSON.stringify(err));
      return;
    }

    let body = null;
    try { body = JSON.parse(res.body); } catch(e) {
      halt("Failed to parse GitHub response");
      return;
    }

    // Decode base64 content
    let encoded = body.content;
    let stripped = "";
    for (let i = 0; i < encoded.length; i++) {
      let c = encoded[i];
      if (c !== "\n" && c !== "\r" && c !== " ") stripped += c;
    }
    let content = atob(stripped);

    log("Fetched watchdog.js (" + content.length + " bytes). Deploying to Script " + SCRIPT_ID + "...");
    deployChunked(content, 0);
  });
}

function deployChunked(content, offset) {
  let chunk = content.slice(offset, offset + CHUNK);
  let isFirst = (offset === 0);
  offset += chunk.length;

  Shelly.call("Script.PutCode", {
    id: SCRIPT_ID,
    code: chunk,
    append: !isFirst
  }, function(res, err) {
    if (err) {
      halt("PutCode failed at offset " + (offset - chunk.length) + " err:" + JSON.stringify(err));
      return;
    }

    if (offset < content.length) {
      // Small delay between chunks to avoid rate limiting
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
        // Script 1 is now running watchdog.js — this code no longer exists.
      });
    }
  });
}

// ================= BOOT =================
Timer.set(2000, false, function() {
  log("Bootstrapper starting...");

  Shelly.call("KVS.Get", { key: "wd.pat" }, function(r1, e1) {
    if (e1 || !r1) { halt("Missing wd.pat in KVS"); return; }
    Shelly.call("KVS.Get", { key: "wd.url" }, function(r2, e2) {
      if (e2 || !r2) { halt("Missing wd.url in KVS"); return; }
      Shelly.call("KVS.Get", { key: "wd.branch" }, function(r3, e3) {
        if (e3 || !r3) { halt("Missing wd.branch in KVS"); return; }
        fetchAndDeploy(r1.value, r2.value, r3.value);
      });
    });
  });
});
