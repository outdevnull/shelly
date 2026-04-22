// version: 2.0.0
// === Shelly Bootstrap - Fan Controller ===
// User-started only. Fetches manifest, deploys all scripts, provisions device, force-writes KVS defaults.

let CFW  = "https://shelly-proxy.ash-b39.workers.dev";
let MFIL = "manifest.json";
let FCHK = 2048;
let PCHK = 1024;
let SLFI = Shelly.getCurrentScriptId();

function lg(lv, ms) { print("[" + lv + "][BS:" + SLFI + "] " + ms); }

// ================= RPC QUEUE =================
let rpcQ = []; let rpcH = 0; let rpcB = false; let rDly = 200;
function scll(m, p, cb) { rpcQ.push({m:m, p:p, cb:cb}); drnQ(); }
function drnQ() {
  if (rpcB || rpcH >= rpcQ.length) return;
  rpcB = true; let it = rpcQ[rpcH]; rpcH++;
  if (rpcH > 20) { let q=[]; for(let j=rpcH;j<rpcQ.length;j++) q.push(rpcQ[j]); rpcQ=q; rpcH=0; }
  Timer.set(rDly, false, function() {
    Shelly.call(it.m, it.p, function(r,e) { rpcB=false; if(it.cb)it.cb(r,e); drnQ(); });
  });
}
function kget(k, cb) { scll("KVS.Get",{key:k},function(r,e){cb((!e&&r)?r.value:null);}); }
function kset(k, v, cb) { scll("KVS.Set",{key:k,value:String(v)},function(r,e){if(cb)cb(!e);}); }

// ================= FETCH MANIFEST =================
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

// ================= DEPLOY SCRIPT SLOT =================
function dpsc(sc, cb) {
  scll("Script.GetStatus",{id:sc.id},function(r,e) {
    function dwr() {
      gfad(sc.file, sc.id, function(ok) {
        if (!ok) { lg("ERR","deploy:"+sc.name); cb(false); return; }
        lg("INFO","deployed:"+sc.name+" id:"+sc.id);
        scll("Script.SetConfig",{id:sc.id,config:{enable:sc.autostart}},null);
        cb(true);
      });
    }
    if (e||!r) {
      scll("Script.Create",{name:sc.name},function(r2,e2) {
        if (e2) { lg("ERR","create:"+sc.name); cb(false); return; }
        sc.id=r2.id; lg("INFO","created slot:"+sc.id+":"+sc.name); dwr();
      });
    } else {
      if (r.running) { scll("Script.Stop",{id:sc.id},function(){dwr();}); }
      else { dwr(); }
    }
  });
}

function dpal(sc, i, cb) {
  if (i>=sc.length) { cb(); return; }
  let s=sc[i]; i++;
  if (!s.file) { dpal(sc,i,cb); return; }
  dpsc(s, function() { dpal(sc,i,cb); });
}

// ================= PROVISION =================
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
      if (gm===sm) { scll(sm,{config:ds},function(r,e){if(e)lg("WARN","fail:"+sm);nx();}); return; }
      scll(gm,{},function(r,e) {
        if (!e&&r&&!cdif(ds,r)) {
          if (ckv) scll("KVS.Set",{key:ky,value:JSON.stringify(ds)},function(){nx();}); else nx(); return;
        }
        scll(sm,{config:ds},function(r2,e2) {
          if (e2) lg("WARN","fail:"+sm);
          else if (r2&&r2.restart_required) lg("WARN",sm+" REBOOT");
          else lg("INFO",sm+" ok");
          if (ckv) scll("KVS.Set",{key:ky,value:JSON.stringify(ds)},function(){nx();}); else nx();
        });
      });
    }
    if (ckv) { scll("KVS.Get",{key:ky},function(r,e){if(!e&&r&&r.value!=="configured"){nx();return;} ap();}); }
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
    scll(gm,{id:c.id},function(r,e) {
      if (!e&&r&&r.name===c.name) { nx(); return; }
      if (!e&&r) {
        scll((c.type==="text")?"Text.SetConfig":"Number.SetConfig",{id:c.id,config:{name:c.name}},function(){nx();}); return;
      }
      scll((c.type==="text")?"Text.Add":"Number.Add",{id:c.id,config:{name:c.name}},function(r2,e2) {
        if (e2) lg("ERR","cre "+c.type+":"+c.id); else lg("INFO","cre "+c.type+":"+c.id); nx();
      });
    });
  }
  nx();
}

// Force-write ALL kvsDefaults (fresh install -- not write-once)
function wkd(mf, cb) {
  let df=mf.kvsDefaults||{}; let dv=mf.kvsDefaultsVersion||"0";
  let ks=Object.keys(df); let i=0;
  function nx() {
    if (i>=ks.length) { kset("wd.kvd_ver",dv,function(){ kset("wd.pv","1",function(){ cb(); }); }); return; }
    let k=ks[i]; let v=df[k]; i++;
    scll("KVS.Set",{key:k,value:String(v)},function(){nx();});
  }
  nx();
}

// ================= BOOT =================
Timer.set(2000, false, function() {
  lg("INFO","bootstrap start");

  function ensureKvs(cb) {
    kget("wd.br",function(br) {
      if (!br) { kset("wd.br","main",function(){ lg("INFO","set wd.br=main"); ensureKvs(cb); }); return; }
      kget("wd.pt",function(pt) {
        if (!pt) { kset("wd.pt","fanController",function(){ lg("INFO","set wd.pt=fanController"); ensureKvs(cb); }); return; }
        cb();
      });
    });
  }

  function done() {
    lg("INFO","bootstrap complete. stopping self.");
    Shelly.call("Script.Stop",{id:SLFI},null);
  }

  ensureKvs(function() {
    lg("INFO","fetching manifest...");
    fgsm(MFIL, function(bd) {
      if (!bd) { lg("ERR","manifest fail"); return; }
      let mf; try { mf=JSON.parse(bd); bd=null; } catch(e) { lg("ERR","manifest parse"); return; }

      lg("INFO","deploying scripts...");
      dpal(mf.scripts||[], 0, function() {
        lg("INFO","provisioning device...");
        prvc(mf.components||[], function() {
          prfx(mf.config||{}, false, function() {
            prfx(mf.kvsConfig||{}, true, function() {
              lg("INFO","writing KVS defaults...");
              wkd(mf, function() {
                mf=null;
                lg("INFO","starting supervisor...");
                scll("Script.GetStatus",{id:2},function(r,e) {
                  if (!e&&r&&r.running) { lg("INFO","supervisor already running"); done(); return; }
                  scll("Script.Start",{id:2},function(r2,e2) {
                    if (e2) lg("ERR","supervisor start fail"); else lg("INFO","supervisor started");
                    done();
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});
