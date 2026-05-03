// version: 3.0.0
// === Shelly Bootstrap - Fan Controller ===
// User-started only. Deploys supervisor + updater by name, starts supervisor.
// No manifest fetch, no provisioning -- keeps memory footprint minimal.
// Supervisor triggers updater on first boot which handles full deploy + provisioning.

let CFW  = "https://shelly-proxy.ash-b39.workers.dev";
let FCHK = 512;
let PCHK = 512;
let SLFI = Shelly.getCurrentScriptId();

function lg(ms) { print("[BS:" + SLFI + "] " + ms); }

function kget(k, cb) { Shelly.call("KVS.Get",{key:k},function(r,e){cb((!e&&r)?r.value:null);}); }
function kset(k, v, cb) { Shelly.call("KVS.Set",{key:k,value:String(v)},function(r,e){if(cb)cb();}); }

// ================= FETCH + DEPLOY =================
function gfad(fi, sid, cb) {
  let fof=0; let fpt=true; let br=""; let pt="";
  function dput(da, po, dn) {
    if (po>=da.length) { da=null; dn(true); return; }
    let pc=da.slice(po,po+PCHK); let ap=!fpt; fpt=false;
    Shelly.call("Script.PutCode",{id:sid,code:pc,append:ap},function(r,e) {
      pc=null; r=null;
      if (e) { lg("putcode err"); dn(false); return; }
      Timer.set(0,false,function(){dput(da,po+PCHK,dn);});
    });
  }
  function dftc() {
    Shelly.call("HTTP.GET",{url:CFW+"/?file="+pt+"/"+fi+"&ref="+br+"&offset="+fof+"&len="+FCHK},function(r,e) {
      if (e||!r||r.code!==200) { lg("ftc err:"+fi); cb(false); return; }
      let ck=r.body;
      let lf=(r.headers&&r.headers["X-Left"]!==undefined)?(r.headers["X-Left"]*1):0;
      fof+=ck.length; r=null;
      dput(ck,0,function(ok){ ck=null; if(!ok){cb(false);return;} if(lf>0){Timer.set(200,false,dftc);}else{cb(true);} });
    });
  }
  kget("wd.br",function(b){ br=b; kget("wd.pt",function(p){ pt=p; dftc(); }); });
}

// Find slot by name, create if missing, deploy file, return actual id via cb
function deployScript(name, file, autostart, cb) {
  Shelly.call("Script.List",{},function(r,e) {
    let sid=null;
    if (!e&&r&&r.scripts) {
      for (let i=0;i<r.scripts.length;i++) {
        if (r.scripts[i].name===name) { sid=r.scripts[i].id; break; }
      }
    }
    function deploy(id) {
      gfad(file, id, function(ok) {
        if (!ok) { lg("deploy fail:"+name); cb(-1); return; }
        Shelly.call("Script.SetConfig",{id:id,config:{enable:autostart}},null);
        lg("deployed:"+name+":"+id);
        cb(id);
      });
    }
    if (sid!==null) {
      Shelly.call("Script.GetStatus",{id:sid},function(rs,es) {
        if (!es&&rs&&rs.running) { Shelly.call("Script.Stop",{id:sid},function(){deploy(sid);}); }
        else { deploy(sid); }
      });
    } else {
      Shelly.call("Script.Create",{name:name},function(rc,ec) {
        if (ec||!rc) { lg("create fail:"+name); cb(-1); return; }
        lg("created:"+name+":"+rc.id);
        deploy(rc.id);
      });
    }
  });
}

// ================= BOOT =================
Timer.set(2000, false, function() {
  lg("start");

  function stopRunning(cb) {
    Shelly.call("Script.List",{},function(r,e) {
      if (e||!r||!r.scripts) { cb(); return; }
      let i=0;
      function nx() {
        if (i>=r.scripts.length) { cb(); return; }
        let s=r.scripts[i]; i++;
        if (s.id===SLFI||!s.running) { nx(); return; }
        lg("stopping:"+s.name);
        Shelly.call("Script.Stop",{id:s.id},function(){nx();});
      }
      nx();
    });
  }

  function ensureKvs(cb) {
    kget("wd.br",function(br) {
      if (!br) { kset("wd.br","main",function(){ ensureKvs(cb); }); return; }
      kget("wd.pt",function(pt) {
        if (!pt) { kset("wd.pt","fanController",function(){ ensureKvs(cb); }); return; }
        cb();
      });
    });
  }

  stopRunning(function() {
    ensureKvs(function() {
      deployScript("supervisor","supervisor.js",true,function(supId) {
        if (supId<0) { lg("supervisor failed"); return; }
        deployScript("updater","updater.js",false,function(updId) {
          if (updId<0) { lg("updater failed"); return; }
          lg("starting supervisor:"+supId);
          Shelly.call("Script.Start",{id:supId},function(r,e) {
            if (e) lg("start err"); else lg("done");
            Shelly.call("Script.Stop",{id:SLFI},null);
          });
        });
      });
    });
  });
});
