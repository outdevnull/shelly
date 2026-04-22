// version: 1.0.0
// === Shelly Updater - Fan Controller ===
// Started by supervisor. Checks versions, deploys changed scripts, updates KVS defaults,
// regenerates kvs_restore. Supervisor manages fan start/stop around this. Stops self when done.

let CFW    = "https://shelly-proxy.ash-b39.workers.dev";
let MFIL   = "manifest.json";
let FCHK   = 1024;
let PCHK   = 1024;
let SLFI   = Shelly.getCurrentScriptId();
let SUP_ID = 2; // supervisor -- always skip, never redeploy while running

function lg(lv, ms) { print("[" + lv + "][UPD:" + SLFI + "] " + ms); }

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

// ================= VERSION =================
function exvr(cd) {
  let en=cd.indexOf("\n"); let fl=en>-1?cd.slice(0,en):cd;
  let mk="// version: "; let ix=fl.indexOf(mk);
  if (ix===-1) return null;
  return fl.slice(ix+mk.length).trim();
}
function gdvr(sid, cb) {
  scll("Script.GetCode",{id:sid,offset:0,len:20},function(r,e){cb((!e&&r)?exvr(r.data):null);});
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
    scll("Script.GetStatus",{id:sc.id},function(r,e) {
      function dwr() {
        gfad(sc.file, sc.id, function(ok) {
          if (!ok) { lg("ERR","deploy:"+sc.name); cb(false); return; }
          kset("s."+sc.id+".ok","1",function() {
            lg("INFO","deployed:"+sc.name+" id:"+sc.id);
            scll("Script.SetConfig",{id:sc.id,config:{enable:sc.autostart}},null);
            cb(true);
          });
        });
      }
      if (e||!r) {
        scll("Script.Create",{name:sc.name},function(r2,e2) {
          if (e2) { lg("ERR","create:"+sc.name); cb(false); return; }
          sc.id=r2.id; lg("INFO","new slot:"+sc.id+":"+sc.name); dwr();
        });
      } else {
        if (r.running) { scll("Script.Stop",{id:sc.id},function(){dwr();}); }
        else { dwr(); }
      }
    });
  });
}

// ================= CHECK + DEPLOY ALL =================
function cdal(sc, i, cb) {
  if (i>=sc.length) { cb(); return; }
  let s=sc[i]; i++;
  // Skip entries with no file (kvs_restore) and supervisor (running, redeploys on next reboot)
  if (!s.file||s.id===SUP_ID) { cdal(sc,i,cb); return; }

  kget("s."+s.id+".ok",function(ok) {
    if (ok==="0") { dpsc(s,function(){cdal(sc,i,cb);}); return; }
    kget("wd.br",function(br){ kget("wd.pt",function(pt) {
      Shelly.call("HTTP.GET",{url:CFW+"/?file="+pt+"/"+s.file+"&ref="+br+"&offset=0&len=20"},function(r,e) {
        if (e||!r||r.code!==200) { lg("ERR","ver:"+s.file); cdal(sc,i,cb); return; }
        let rv=exvr(r.body); r=null;
        gdvr(s.id,function(lv) {
          lg("INFO",s.name+" l:"+lv+" r:"+rv);
          if (lv===rv) {
            scll("Script.SetConfig",{id:s.id,config:{enable:s.autostart}},null);
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
      scll("KVS.Set",{key:k,value:String(v)},function(){nx();});
    }
    nx();
  });
}

// ================= KVS RESTORE =================
function gkrs(kl, cb) {
  Shelly.call("Script.List",{},function(r,e) {
    let sid=null;
    if (!e&&r&&r.scripts) {
      for (let i=0;i<r.scripts.length;i++) {
        if (r.scripts[i].name==="kvs_restore") { sid=r.scripts[i].id; break; }
      }
    }
    function gotSlot(id) {
      function writeHdr() {
        let hdr="// kvs_restore auto-generated\nlet keys = [];\n";
        Shelly.call("Script.PutCode",{id:id,code:hdr,append:false},function(r,e) {
          hdr=null;
          if (e) { lg("ERR","kvs_restore hdr"); cb(); return; }
          writeKeys(0);
        });
      }
      function writeKeys(ki) {
        if (ki>=kl.length) { writeFtr(); return; }
        let k=kl[ki];
        Shelly.call("KVS.Get",{key:k},function(rk,ek) {
          if (ek||!rk) { writeKeys(ki+1); return; }
          let v=String(rk.value).split("\\").join("\\\\").split('"').join('\\"').split("\n").join("\\n");
          let line='keys.push(["'+k+'","'+v+'"]);\n';
          Shelly.call("Script.PutCode",{id:id,code:line,append:true},function(r2,e2) {
            line=null;
            if (e2) { lg("ERR","kvs_restore line"); cb(); return; }
            Timer.set(0,false,function(){writeKeys(ki+1);});
          });
        });
      }
      function writeFtr() {
        let ftr = "let i = 0;\nfunction nx() {\n" +
          "  if (i >= keys.length) { print(\"kvs_restore done\"); Shelly.call(\"Script.Stop\", { id: Shelly.getCurrentScriptId() }, null); return; }\n" +
          "  let k = keys[i][0]; let v = keys[i][1]; i++;\n" +
          "  Shelly.call(\"KVS.Set\", { key: k, value: v }, function() { nx(); });\n" +
          "}\nnx();";
        Shelly.call("Script.PutCode",{id:id,code:ftr,append:true},function(r,e) {
          ftr=null;
          if (e) { lg("ERR","kvs_restore ftr"); cb(); return; }
          Shelly.call("Script.SetConfig",{id:id,config:{enable:false}},null);
          lg("INFO","kvs_restore deployed id:"+id); cb();
        });
      }
      Shelly.call("Script.GetStatus",{id:id},function(rs,es) {
        if (!es&&rs&&rs.running) { Shelly.call("Script.Stop",{id:id},function(){writeHdr();}); }
        else { writeHdr(); }
      });
    }
    if (sid===null) {
      Shelly.call("Script.Create",{name:"kvs_restore"},function(rc,ec) {
        if (ec||!rc) { lg("ERR","kvs_restore create"); cb(); return; }
        lg("INFO","kvs_restore created:"+rc.id); gotSlot(rc.id);
      });
    } else {
      gotSlot(sid);
    }
  });
}

// ================= MAIN =================
Timer.set(1000, false, function() {
  lg("INFO","updater start");
  kget("wd.rpc_delay",function(rd){ if(rd!==null) rDly=(rd*1); });

  fgsm(MFIL, function(bd) {
    if (!bd) { lg("ERR","manifest fail"); Shelly.call("Script.Stop",{id:SLFI},null); return; }
    let mf; try{mf=JSON.parse(bd);bd=null;}catch(e){lg("ERR","parse");Shelly.call("Script.Stop",{id:SLFI},null);return;}

    cdal(mf.scripts||[], 0, function() {
      chkd(mf, function() {
        let kl=["wd.br","wd.pt","wd.pv","wd.kvd_ver","wd.last_upd","wd.tz_offset","wd.force_upd"];
        let dk=Object.keys(mf.kvsDefaults||{});
        let ck=Object.keys(mf.kvsConfig||{});
        for (let j=0;j<dk.length;j++) kl.push(dk[j]);
        for (let j=0;j<ck.length;j++) kl.push(ck[j]);
        mf=null;
        gkrs(kl, function() {
          lg("INFO","update complete");
          Shelly.call("Script.Stop",{id:SLFI},null);
        });
      });
    });
  });
});
