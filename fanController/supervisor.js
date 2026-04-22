// version: 1.0.0
// === Shelly Supervisor - Fan Controller ===
// Permanent. Starts managed scripts on boot, monitors health, triggers updates at 2am or on demand.
// "Update now": set KVS key wd.force_upd=1 (e.g. POST /rpc/KVS.Set?key=wd.force_upd&value=1)

let SLFI = Shelly.getCurrentScriptId();
let FAN_ID = -1;
let UPD_ID = -1;

function lg(lv, ms) { print("[" + lv + "][SUP:" + SLFI + "] " + ms); }

// ================= RPC QUEUE =================
let rpcQ=[]; let rpcH=0; let rpcB=false; let rDly=200;
function scll(m, p, cb) { rpcQ.push({m:m, p:p, cb:cb}); drnQ(); }
function drnQ() {
  if (rpcB||rpcH>=rpcQ.length) return;
  rpcB=true; let it=rpcQ[rpcH]; rpcH++;
  if (rpcH>20) { let q=[]; for(let j=rpcH;j<rpcQ.length;j++) q.push(rpcQ[j]); rpcQ=q; rpcH=0; }
  Timer.set(rDly, false, function() {
    Shelly.call(it.m, it.p, function(r,e){rpcB=false; if(it.cb)it.cb(r,e); drnQ();});
  });
}
function kget(k, cb) { scll("KVS.Get",{key:k},function(r,e){cb((!e&&r)?r.value:null);}); }
function kset(k, v, cb) { scll("KVS.Set",{key:k,value:String(v)},function(r,e){if(cb)cb(!e);}); }

// ================= FAN LIFECYCLE =================
let updRunning = false;
let fanFailCount = 0;

function ensureFan(cb) {
  if (FAN_ID<0||updRunning) { if(cb)cb(); return; }
  scll("Script.GetStatus",{id:FAN_ID},function(r,e) {
    if (!e&&r&&r.running) { if(cb)cb(); return; }
    lg("INFO","starting fan:"+FAN_ID);
    scll("Script.Start",{id:FAN_ID},function(r2,e2) {
      if (e2) lg("ERR","fan start fail"); else lg("INFO","fan started");
      if (cb) cb();
    });
  });
}

// ================= HEALTH CHECK =================
function healthCheck() {
  if (FAN_ID<0||updRunning) return;
  scll("Script.GetStatus",{id:FAN_ID},function(r,e) {
    if (!e&&r&&r.running) { fanFailCount=0; return; }
    fanFailCount++;
    lg("WARN","fan not running "+fanFailCount+"/3");
    if (fanFailCount>=3) { lg("WARN","fan fail3 restart"); fanFailCount=0; }
    scll("Script.Start",{id:FAN_ID},null);
  });
}

// ================= UPDATE CYCLE =================
function runUpdate() {
  if (updRunning) { lg("INFO","upd already running"); return; }
  if (UPD_ID<0) { lg("WARN","no updater found"); return; }
  updRunning=true;
  lg("INFO","update cycle start");

  function startUpdater() {
    scll("Script.Start",{id:UPD_ID},function(r,e) {
      if (e) { lg("ERR","updater start fail"); updRunning=false; ensureFan(null); return; }
      lg("INFO","updater started");
      pollUpdater();
    });
  }

  if (FAN_ID>=0) {
    scll("Script.Stop",{id:FAN_ID},function() {
      lg("INFO","fan stopped for update");
      startUpdater();
    });
  } else {
    startUpdater();
  }
}

function pollUpdater() {
  Timer.set(10000, false, function() {
    scll("Script.GetStatus",{id:UPD_ID},function(r,e) {
      if (!e&&r&&r.running) { pollUpdater(); return; }
      lg("INFO","updater done");
      updRunning=false;
      ensureFan(null);
    });
  });
}

// ================= SCHEDULING =================
let lastUpdDay = -1;
let tzOffset = 36000;

function scheduleTick() {
  let now = Shelly.getComponentStatus("sys").unixtime;
  let localHour = Math.floor(((now+tzOffset)%86400)/3600);
  let today = Math.floor((now+tzOffset)/86400);

  kget("wd.force_upd",function(fu) {
    if (fu==="1") {
      kset("wd.force_upd","0",function() { lg("INFO","force update triggered"); runUpdate(); });
      return;
    }
    if (localHour===2&&today!==lastUpdDay) {
      kget("wd.last_upd",function(lu) {
        if (String(lu)===String(today)) { lastUpdDay=today; return; }
        lastUpdDay=today;
        kset("wd.last_upd",String(today),function() { lg("INFO","2am update"); runUpdate(); });
      });
    }
  });
}

// ================= BOOT =================
Timer.set(2000, false, function() {
  lg("INFO","supervisor boot");

  kget("wd.rpc_delay",function(rd){ if(rd!==null) rDly=(rd*1); });
  kget("wd.tz_offset",function(tz){ if(tz!==null) tzOffset=(tz*1); });

  // Discover managed script IDs by name
  Shelly.call("Script.List",{},function(r,e) {
    if (!e&&r&&r.scripts) {
      for (let i=0;i<r.scripts.length;i++) {
        let s=r.scripts[i];
        if (s.name==="fancontroller"||s.name==="bathroom-fan") FAN_ID=s.id;
        if (s.name==="updater") UPD_ID=s.id;
      }
    }
    lg("INFO","fan:"+FAN_ID+" upd:"+UPD_ID);

    ensureFan(function() {
      kget("wd.health_interval",function(hi) {
        Timer.set((hi?(hi*1):300)*1000, true, function(){healthCheck();});
      });
      Timer.set(60000, true, function(){scheduleTick();});
      lg("INFO","supervisor ready");
    });
  });
});
