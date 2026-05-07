// version: 3.1.0
// User-started only. Provisions device on first run (wd.pv != "1"), then deploys
// supervisor + updater. Supervisor triggers updater on first boot for full script deploy.

let CFW  = "https://shelly-proxy.ash-b39.workers.dev";
let FCHK = 512;
let PCHK = 512;
let SLFI = Shelly.getCurrentScriptId();

function lg(ms) { print("[BS:" + SLFI + "] " + ms); }
function kget(k, cb) { Shelly.call("KVS.Get",{key:k},function(r,e){cb((!e&&r)?r.value:null);}); }
function kset(k, v, cb) { Shelly.call("KVS.Set",{key:k,value:String(v)},function(r,e){if(cb)cb();}); }

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

function fgsm(fi, cb) {
  let asm=""; let off=0; let br=""; let pt="";
  function go() {
    Shelly.call("HTTP.GET",{url:CFW+"/?file="+pt+"/"+fi+"&ref="+br+"&offset="+off+"&len="+FCHK},function(r,e) {
      if (e||!r||r.code!==200) { cb(null); return; }
      asm+=r.body;
      let lft=(r.headers&&r.headers["X-Left"]!==undefined)?(r.headers["X-Left"]*1):0;
      off+=r.body.length; r=null;
      if (lft>0) { Timer.set(200,false,go); } else { cb(asm); asm=null; }
    });
  }
  kget("wd.br",function(b){ br=b; kget("wd.pt",function(p){ pt=p; go(); }); });
}

function cdif(ds, ac) {
  if (ac===null||ac===undefined) return true;
  let ks=Object.keys(ds);
  for (let i=0;i<ks.length;i++) {
    let k=ks[i];
    if (typeof ds[k]==="object"&&ds[k]!==null) { if (cdif(ds[k],ac[k])) return true; }
    else { if (ds[k]!==ac[k]) return true; }
  }
  return false;
}

function prfx(cf, ckv, cb) {
  let ks=Object.keys(cf); let i=0;
  function nx() {
    if (i>=ks.length) { cb(); return; }
    let ky=ks[i]; let en=ckv?cf[ky]:null; i++;
    let sm=ckv?en.method:ky; let ds=ckv?en.config:cf[ky].config;
    function ap() {
      let gm=sm.replace("SetConfig","GetConfig");
      if (gm===sm) { Shelly.call(sm,{config:ds},function(r,e){if(e)lg("fail:"+sm);nx();}); return; }
      Shelly.call(gm,{},function(r,e) {
        if (!e&&r&&!cdif(ds,r)) {
          if (ckv) Shelly.call("KVS.Set",{key:ky,value:JSON.stringify(ds)},function(){nx();}); else nx(); return;
        }
        Shelly.call(sm,{config:ds},function(r2,e2) {
          if (!e2) lg(sm+" ok");
          if (ckv) Shelly.call("KVS.Set",{key:ky,value:JSON.stringify(ds)},function(){nx();}); else nx();
        });
      });
    }
    if (ckv) { Shelly.call("KVS.Get",{key:ky},function(r,e){if(!e&&r&&r.value!=="configured"){nx();return;} ap();}); }
    else { ap(); }
  }
  nx();
}

function prvc(cp, cb) {
  let i=0;
  function nx() {
    if (i>=cp.length) { cb(); return; }
    let c=cp[i]; i++;
    let gm=(c.type==="text")?"Text.GetConfig":"Number.GetConfig";
    Shelly.call(gm,{id:c.id},function(r,e) {
      if (!e&&r&&r.name===c.name) { nx(); return; }
      if (!e&&r) {
        Shelly.call((c.type==="text")?"Text.SetConfig":"Number.SetConfig",{id:c.id,config:{name:c.name}},function(){nx();}); return;
      }
      Shelly.call((c.type==="text")?"Text.Add":"Number.Add",{id:c.id,config:{name:c.name}},function(r2,e2) {
        lg((e2?"ERR":"OK")+" "+c.type+":"+c.id); nx();
      });
    });
  }
  nx();
}

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

  function doInstall() {
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
  }

  stopRunning(function() {
    ensureKvs(function() {
      kget("wd.pv",function(pv) {
        if (pv==="1") { doInstall(); return; }
        fgsm("provision.json",function(pb) {
          if (!pb) { lg("no provision.json, skipping"); doInstall(); return; }
          let pr=null; try{pr=JSON.parse(pb);}catch(e){} pb=null;
          if (!pr) { lg("provision parse err"); doInstall(); return; }
          lg("provisioning...");
          prvc(pr.components||[], function() {
            prfx(pr.config||{}, false, function() {
              prfx(pr.kvsConfig||{}, true, function() {
                kset("wd.pv","1",function(){ lg("prov done"); pr=null; doInstall(); });
              });
            });
          });
        });
      });
    });
  });
});
