// version: 2.0.0
// Supervisor — boot, health, update scheduling. Minimal heap footprint.
// Removed RPC queue to reduce jsvar AST usage; direct Shelly.call throughout.
// Health check: sfan() every 300s (hardcoded). 2am daily update + wd.force_upd trigger.

let F=-1, U=-1, upd=false, ret=0, ldx=-1, tz=36000;
function p(m) { print("[SUP] "+m); }
function kg(k,cb) { Shelly.call("KVS.Get",{key:k},function(r,e){cb((!e&&r)?r.value:null);}); }
function ks(k,v,cb) { Shelly.call("KVS.Set",{key:k,value:String(v)},function(r,e){if(cb)cb();}); }

function disc(cb) {
  Shelly.call("Script.List",{},function(r,e) {
    F=-1; U=-1;
    if (!e&&r&&r.scripts) for (let i=0;i<r.scripts.length;i++) {
      let s=r.scripts[i];
      if (s.name==="fancontroller") F=s.id;
      if (s.name==="updater") U=s.id;
    }
    p("F:"+F+" U:"+U); if (cb) cb();
  });
}

function sfan() {
  if (F<0||upd) return;
  Shelly.call("Script.GetStatus",{id:F},function(r,e) {
    if (!e&&r&&r.running) return;
    p("restart fan"); Shelly.call("Script.Start",{id:F},null);
  });
}

function poll() {
  Timer.set(10000,false,function() {
    Shelly.call("Script.GetStatus",{id:U},function(r,e) {
      if (!e&&r&&r.running) { poll(); return; }
      p("upd done"); upd=false;
      disc(function() {
        if (F<0&&ret<3) { ret++; p("retry "+ret); Timer.set(5000,false,go); }
        else { ret=0; sfan(); }
      });
    });
  });
}

function go() {
  if (upd||U<0) return;
  upd=true; p("update");
  function st() {
    Shelly.call("Script.Start",{id:U},function(r,e) {
      if (e) { p("upd err"); upd=false; sfan(); return; }
      poll();
    });
  }
  if (F>=0) Shelly.call("Script.Stop",{id:F},function(){st();}); else st();
}

function tick() {
  kg("wd.force_upd",function(fu) {
    if (fu==="1") { ks("wd.force_upd","0",function(){go();}); return; }
    let now=Shelly.getComponentStatus("sys").unixtime;
    let hr=Math.floor(((now+tz)%86400)/3600), day=Math.floor((now+tz)/86400);
    if (hr===2&&day!==ldx) {
      ldx=day;
      kg("wd.last_upd",function(lu) {
        if (String(lu)===String(day)) return;
        ks("wd.last_upd",String(day),function() { p("2am"); go(); });
      });
    }
  });
}

Timer.set(2000,false,function() {
  p("boot");
  kg("wd.tz_offset",function(t) { if (t!==null) tz=t*1; });
  disc(function() {
    Timer.set(300000,true,sfan);
    Timer.set(60000,true,tick);
    if (F<0) { p("install"); go(); } else sfan();
  });
});
