// version: 1.4.0
// Shelly Updater — Fan Controller
// Started by supervisor (which stops itself first to yield heap).
// On first run fetches provision.json. Always fetches manifest.json for
// version checks, script deploy, KVS defaults. When done, restarts supervisor then stops self.

let CFW  = "https://shelly-proxy.ash-b39.workers.dev";
let MFIL = "manifest.json";
let PFIL = "provision.json";
let FCHK = 512;
let PCHK = 512;
let SLFI = Shelly.getCurrentScriptId();

function lg(lv, ms) { print("[" + lv + "][UPD:" + SLFI + "] " + ms); }
function kget(k, cb) { Shelly.call("KVS.Get",{key:k},function(r,e){cb((!e&&r)?r.value:null);}); }
function kset(k, v, cb) { Shelly.call("KVS.Set",{key:k,value:String(v)},function(r,e){if(cb)cb(!e);}); }

// ================= FETCH FILE =================
function fgsm(fi, cb) {
  let asm=""; let off=0; let br=""; let pt="";
  function go() {
    Shelly.call("HTTP.GET",{url:CFW+"/?file="+pt+"/"+fi+"&ref="+br+"&offset="+off+"&len="+FCHK},function(r,e) {
      if (e||!r||r.code!==200) { lg("ERR","fetch:"+fi); cb(null); return; }
      asm+=r.body;
      let lft=(r.headers&&r.headers["X-Left"]!==undefined)?(r.headers["X-Left"]*1):0;
      off+=r.body.length; r=null;
      if (lft>0) { Timer.set(200,false,go); } else { cb(asm); asm=null; }
    });
  }
  kget("wd.br",function(b){ br=b; kget("wd.pt",function(p){ pt=p; go(); }); });
}

// ================= VERSION =================
function exvr(cd) {
  let en=cd.indexOf("\n"); let fl=en>-1?cd.slice(0,en):cd;
  let mk="// version: "; let ix=fl.indexOf(mk);
  if (ix===-1) return null;
  return fl.slice(ix+mk.length).trim();
}
function gdvr(sid, cb) {
  Shelly.call("Script.GetCode",{id:sid,offset:0,len:20},function(r,e){cb((!e&&r)?exvr(r.data):null);});
}

// ================= FETCH + DEPLOY =================
function gfad(fi, sid, cb) {
  let fof=0; let fpt=true; let br=""; let pt="";
  function dput(da, po, dn) {
    if (po>=da.length) { da=null; dn(true); return; }
    let pc=da.slice(po,po+PCHK); let ap=!fpt; fpt=false;
    Shelly.call("Script.PutCode",{id:sid,code:pc,append:ap},function(r,e) {
      pc=null; r=null;
      if (e) { lg("ERR","putcode:"+sid); dn(false); return; }
      Timer.set(0,false,function(){dput(da,po+PCHK,dn);});
    });
  }
  function dftc() {
    Shelly.call("HTTP.GET",{url:CFW+"/?file="+pt+"/"+fi+"&ref="+br+"&offset="+fof+"&len="+FCHK},function(r,e) {
      if (e||!r||r.code!==200) { lg("ERR","ftc:"+fi); cb(false); return; }
      let ck=r.body;
      let lf=(r.headers&&r.headers["X-Left"]!==undefined)?(r.headers["X-Left"]*1):0;
      fof+=ck.length; r=null;
      dput(ck,0,function(ok){ ck=null; if(!ok){cb(false);return;} if(lf>0){Timer.set(200,false,dftc);}else{cb(true);} });
    });
  }
  kget("wd.br",function(b){ br=b; kget("wd.pt",function(p){ pt=p; dftc(); }); });
}

// ================= DEPLOY SCRIPT =================
function dpsc(sc, cb) {
  kset("s."+sc.id+".ok","0",function() {
    Shelly.call("Script.GetStatus",{id:sc.id},function(r,e) {
      function dwr() {
        gfad(sc.file, sc.id, function(ok) {
          if (!ok) { lg("ERR","deploy:"+sc.name); cb(false); return; }
          kset("s."+sc.id+".ok","1",function() {
            lg("INFO","deployed:"+sc.name+" id:"+sc.id);
            Shelly.call("Script.SetConfig",{id:sc.id,config:{enable:sc.autostart}},null);
            cb(true);
          });
        });
      }
      if (e||!r) {
        Shelly.call("Script.Create",{name:sc.name},function(r2,e2) {
          if (e2) { lg("ERR","create:"+sc.name); cb(false); return; }
          sc.id=r2.id; lg("INFO","new slot:"+sc.id+":"+sc.name); dwr();
        });
      } else {
        if (r.running) { Shelly.call("Script.Stop",{id:sc.id},function(){dwr();}); }
        else { dwr(); }
      }
    });
  });
}

// ================= CHECK + DEPLOY ALL =================
function cdal(sc, i, cb) {
  if (i>=sc.length) { cb(); return; }
  let s=sc[i]; i++;
  if (!s.file) { cdal(sc,i,cb); return; }

  kget("s."+s.id+".ok",function(ok) {
    if (ok==="0") { dpsc(s,function(){cdal(sc,i,cb);}); return; }
    kget("wd.br",function(br){ kget("wd.pt",function(pt) {
      Shelly.call("HTTP.GET",{url:CFW+"/?file="+pt+"/"+s.file+"&ref="+br+"&offset=0&len=20"},function(r,e) {
        if (e||!r||r.code!==200) { lg("ERR","ver:"+s.file); cdal(sc,i,cb); return; }
        let rv=exvr(r.body); r=null;
        gdvr(s.id,function(lv) {
          lg("INFO",s.name+" l:"+lv+" r:"+rv);
          if (lv===rv) {
            Shelly.call("Script.SetConfig",{id:s.id,config:{enable:s.autostart}},null);
            cdal(sc,i,cb);
          } else {
            dpsc(s,function(){cdal(sc,i,cb);});
          }
        });
      });
    }); });
  });
}

// ================= KVS DEFAULTS VERSION CHECK =================
function chkd(mf, cb) {
  let dv=mf.kvsDefaultsVersion||"0";
  kget("wd.kvd_ver",function(cv) {
    if (cv===dv) { cb(); return; }
    lg("INFO","kvd update v"+dv);
    let ks=Object.keys(mf.kvsDefaults||{}); let i=0;
    function nx() {
      if (i>=ks.length) { kset("wd.kvd_ver",dv,function(){cb();}); return; }
      let k=ks[i]; let v=mf.kvsDefaults[k]; i++;
      Shelly.call("KVS.Set",{key:k,value:String(v)},function(){nx();});
    }
    nx();
  });
}

// ================= PROVISIONING (first run only) =================
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
      if (gm===sm) { Shelly.call(sm,{config:ds},function(r,e){if(e)lg("WARN","fail:"+sm);nx();}); return; }
      Shelly.call(gm,{},function(r,e) {
        if (!e&&r&&!cdif(ds,r)) {
          if (ckv) Shelly.call("KVS.Set",{key:ky,value:JSON.stringify(ds)},function(){nx();}); else nx(); return;
        }
        Shelly.call(sm,{config:ds},function(r2,e2) {
          if (e2) lg("WARN","fail:"+sm);
          else if (r2&&r2.restart_required) lg("WARN",sm+" REBOOT");
          else lg("INFO",sm+" ok");
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
        if (e2) lg("ERR","cre "+c.type+":"+c.id); else lg("INFO","cre "+c.type+":"+c.id); nx();
      });
    });
  }
  nx();
}

function prov(pr, cb) {
  lg("INFO","provisioning device...");
  prvc(pr.components||[], function() {
    prfx(pr.config||{}, false, function() {
      prfx(pr.kvsConfig||{}, true, function() {
        kset("wd.pv","1",function(){ lg("INFO","prov complete"); cb(); });
      });
    });
  });
}

// ================= MAIN =================
Timer.set(1000, false, function() {
  lg("INFO","updater start");

  fgsm(MFIL, function(bd) {
    if (!bd) { lg("ERR","manifest fail"); Shelly.call("Script.Stop",{id:SLFI},null); return; }
    let mf; try{mf=JSON.parse(bd);bd=null;}catch(e){lg("ERR","parse");Shelly.call("Script.Stop",{id:SLFI},null);return;}

    function dvc() {
      mf=null;
      lg("INFO","update complete");
      Shelly.call("Script.List",{},function(r,e) {
        if (!e&&r&&r.scripts) for(let i=0;i<r.scripts.length;i++) {
          if(r.scripts[i].name==="supervisor") {
            Shelly.call("Script.Start",{id:r.scripts[i].id},null);
            break;
          }
        }
        Shelly.call("Script.Stop",{id:SLFI},null);
      });
    }

    function afterProv() {
      let scripts=mf.scripts||[]; mf.scripts=null;
      cdal(scripts, 0, function() {
        scripts=null;
        chkd(mf, function() { dvc(); });
      });
    }

    kget("wd.pv", function(pv) {
      if (pv==="1") {
        afterProv();
      } else {
        fgsm(PFIL, function(pb) {
          let pr=null;
          if (pb) { try{pr=JSON.parse(pb);}catch(e){} pb=null; }
          if (pr) {
            prov(pr, function() { pr=null; afterProv(); });
          } else {
            lg("WARN","provision.json fail, skipping prov");
            afterProv();
          }
        });
      }
    });
  });
});
