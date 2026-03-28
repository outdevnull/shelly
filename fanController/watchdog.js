// version: 1.1.7
// === Shelly Watchdog ===

let MFIL = "manifest.json";
let CFW  = "https://shelly-proxy.ash-b39.workers.dev";
let FCHK = 4096;
let PCHK = 1024;
let WDSL = 2;
let SLFI = Shelly.getCurrentScriptId();

// ================= RPC QUEUE =================
let rpcQ = [];
let rpcH = 0;
let rpcB = false;
let rDly = 200;

function scll(m, p, cb) {
  rpcQ.push({ m: m, p: p, cb: cb });
  drnQ();
}

function drnQ() {
  if (rpcB || rpcH >= rpcQ.length) return;
  rpcB = true;
  let it = rpcQ[rpcH];
  rpcH++;
  if (rpcH > 20) {
    let q = [];
    for (let j = rpcH; j < rpcQ.length; j++) q.push(rpcQ[j]);
    rpcQ = q; rpcH = 0;
  }
  Timer.set(rDly, false, function() {
    Shelly.call(it.m, it.p, function(r, e) {
      rpcB = false;
      if (it.cb) it.cb(r, e);
      drnQ();
    });
  });
}

// ================= KVS =================
function kget(k, cb) {
  scll("KVS.Get", { key: k }, function(r, e) {
    cb((!e && r) ? r.value : null);
  });
}

function kset(k, v, cb) {
  scll("KVS.Set", { key: k, value: String(v) }, function(r, e) {
    if (cb) cb(!e);
  });
}

// ================= LOG =================
function lg(lv, ms) {
  print("[" + lv + "][" + SLFI + "] " + ms);
  /* dont log the watchdog to disk!
  if (MQTT.isConnected()) {
    scll("MQTT.Publish", { topic: "shelly/watchdog/" + lv, message: ms, qos: 0, retain: false }, null);
  }
  */
}

// ================= FETCH SMALL =================
function fgsm(fi, cb) {
  let asm = "";
  let off = 0;
  function go() {
    let br, pt;
    kget("wd.br", function(b) { br = b;
    kget("wd.pt", function(p) { pt = p;
      let url = CFW + "/?file=" + pt + "/" + fi + "&ref=" + br + "&offset=" + off + "&len=" + FCHK;
      Shelly.call("HTTP.GET", { url: url }, function(r, e) {
        if (e || !r || r.code !== 200) { lg("ERR", "fetch:" + fi); cb(null); return; }
        asm += r.body;
        let lft = (r.headers && r.headers["X-Left"] !== undefined) ? (r.headers["X-Left"] * 1) : 0;
        off += r.body.length;
        r = null;
        if (lft > 0) { Timer.set(200, false, go); } else { cb(asm); asm = null; }
      });
    }); });
  }
  go();
}

// ================= FETCH+DEPLOY =================
function gfad(fi, sid, cb) {
  let fof = 0;
  let fpt = true;
  let br, pt;

  function dput(da, po, lf, dn) {
    if (po >= da.length) { da = null; dn(true); return; }
    let pc = da.slice(po, po + PCHK);
    let ap = !fpt;
    fpt = false;
    Shelly.call("Script.PutCode", { id: sid, code: pc, append: ap }, function(r, e) {
      pc = null; r = null;
      if (e) { lg("ERR", "putcode:" + sid); dn(false); return; }
      Timer.set(0, false, function() { dput(da, po + PCHK, lf, dn); });
    });
  }

  function dftc() {
    let url = CFW + "/?file=" + pt + "/" + fi + "&ref=" + br + "&offset=" + fof + "&len=" + FCHK;
    Shelly.call("HTTP.GET", { url: url }, function(r, e) {
      if (e || !r || r.code !== 200) { lg("ERR", "ftc:" + fi + ":" + fof); cb(false); return; }
      let ck = r.body;
      let lf = (r.headers && r.headers["X-Left"] !== undefined) ? (r.headers["X-Left"] * 1) : 0;
      fof += ck.length;
      r = null;
      dput(ck, 0, lf, function(ok) {
        ck = null;
        if (!ok) { cb(false); return; }
        if (lf > 0) { Timer.set(200, false, dftc); } else { cb(true); }
      });
    });
  }

  kget("wd.br", function(b) { br = b;
  kget("wd.pt", function(p) { pt = p;
    dftc();
  }); });
}

// ================= VERSION =================
function exvr(cd) {
  let en = cd.indexOf("\n");
  let fl = en > -1 ? cd.slice(0, en) : cd;
  let mk = "// version: ";
  let ix = fl.indexOf(mk);
  if (ix === -1) return null;
  return fl.slice(ix + mk.length).trim();
}

function gdvr(sid, cb) {
  scll("Script.GetCode", { id: sid, offset: 0, len: 20 }, function(r, e) {
    cb((!e && r) ? exvr(r.data) : null);
  });
}

// ================= SELF UPDATE =================
function hsup(rv) {
  if (SLFI === WDSL) {
    lg("INFO", "new v" + rv + " spawning temp");
    scll("Script.Stop", { id: 3 }, function() {
      scll("Script.List", {}, function(r, e) {
        let oldId = null;
        if (!e && r && r.scripts) {
          for (let i = 0; i < r.scripts.length; i++) {
            if (r.scripts[i].name === "wdup") { oldId = r.scripts[i].id; break; }
          }
        }
        function doCreate() {
          scll("Script.Create", { name: "wdup" }, function(r2, e2) {
            if (e2 || !r2) { lg("ERR", "create temp"); scll("Script.Start", { id: 3 }, null); return; }
            let tid = r2.id;
            gfad("watchdog.js", tid, function(ok) {
              if (!ok) { scll("Script.Delete", { id: tid }, null); return; }
              kset("s." + tid + ".ok", "1", function() {
                scll("Script.Start", { id: tid }, function(r3, e3) {
                  if (e3) { scll("Script.Delete", { id: tid }, null); }
                  else { lg("INFO", "temp " + tid + " started"); }
                });
              });
            });
          });
        }
        if (oldId) {
          scll("Script.Stop", { id: oldId }, function() {
            scll("Script.Delete", { id: oldId }, function() { doCreate(); });
          });
        } else {
          doCreate();
        }
      });
    });
  } else {
    lg("INFO", "temp " + SLFI + " -> slot " + WDSL);
    scll("Script.Stop", { id: WDSL }, function() {
      gfad("watchdog.js", WDSL, function(ok) {
        if (!ok) { lg("ERR", "redeploy fail"); return; }
        scll("Script.Start", { id: WDSL }, function(r2, e2) {
          if (e2) { lg("ERR", "start slot " + WDSL); return; }
          scll("Script.Start", { id: 3 }, function() {
            lg("INFO", "slot " + WDSL + " updated -- deleting temp " + SLFI);
            Shelly.call("Script.Delete", { id: SLFI }, null);
          });
        });
      });
    });
  }
}

// ================= DEPLOY SCRIPT =================
function dpsc(sc, cb) {
  kset("s." + sc.id + ".ok", "0", function() {
    scll("Script.GetStatus", { id: sc.id }, function(r, e) {
      let rn = (!e && r && r.running);
      function dwr() {
        gfad(sc.file, sc.id, function(ok) {
          if (!ok) { lg("ERR", "deploy:" + sc.name); cb(false); return; }
          kset("s." + sc.id + ".ok", "1", function() {
            lg("INFO", "deployed:" + sc.name);
            // Enable autostart for this script
            scll("Script.SetConfig", { id: sc.id, config: { enable: sc.autostart } }, null);
            if (!sc.autostart) { cb(true); return; }
            scll("Script.Start", { id: sc.id }, function(r2, e2) {
              if (e2) { kset("s." + sc.id + ".ok", "0", null); cb(false); return; }
              Timer.set(5000, false, function() {
                scll("Script.GetStatus", { id: sc.id }, function(r3) {
                  if (!r3 || !r3.running) { kset("s." + sc.id + ".ok", "0", null); cb(false); }
                  else { cb(true); }
                });
              });
            });
          });
        });
      }
      function doStop() {
        if (rn) { scll("Script.Stop", { id: sc.id }, function() { dwr(); }); }
        else { dwr(); }
      }
      if (e || !r) {
        scll("Script.Create", { name: sc.name }, function(r2, e2) {
          if (e2) { lg("ERR", "create:" + sc.name); cb(false); return; }
          let nid = r2.id;
          lg("INFO", "created slot " + nid + " for:" + sc.name);
          sc.id = nid;
          dwr();
        });
      } else {
        doStop();
      }
    });
  });
}

// ================= HEALTH CHECK =================
function hlth(sc, cb) {
  let i = 0; let frc = false;
  function nx() {
    if (i >= sc.length) { cb(frc); return; }
    let s = sc[i]; i++;
    if (!s.autostart || s.id === WDSL) { nx(); return; }
    scll("Script.GetStatus", { id: s.id }, function(r, e) {
      if (!e && r && r.running) { kset("s." + s.id + ".fails", "0", null); nx(); return; }
      kget("s." + s.id + ".fails", function(v) {
        let fl = v ? (v * 1) : 0; fl++;
        if (fl >= 3) {
          lg("WARN", "s:" + s.id + " fail3 redeploy");
          kset("s." + s.id + ".ok", "0", null);
          kset("s." + s.id + ".fails", "0", null);
          frc = true; nx();
        } else {
          kset("s." + s.id + ".fails", String(fl), function() {
            lg("WARN", "s:" + s.id + " restart " + fl + "/3");
            scll("Script.Start", { id: s.id }, function() { nx(); });
          });
        }
      });
    });
  }
  nx();
}

// ================= VERSION CYCLE =================
function chkf(sc, cb) {
  let fl = []; let i = 0;
  function nx() {
    if (i >= sc.length) { cb(fl); return; }
    let s = sc[i]; i++;
    kget("s." + s.id + ".ok", function(v) { fl.push(v === "0"); nx(); });
  }
  nx();
}

function cads(sc, i, ff, ad, cb) {
  if (i >= sc.length) { cb(ad); return; }
  let s = sc[i]; let fc = ff[i];
  if (s.id === WDSL) { cads(sc, i + 1, ff, ad, cb); return; }

  kget("wd.br", function(br) {
  kget("wd.pt", function(pt) {
    let vu = CFW + "/?file=" + pt + "/" + s.file + "&ref=" + br + "&offset=0&len=20";
    Shelly.call("HTTP.GET", { url: vu }, function(r, e) {
      if (e || !r || r.code !== 200) {
        lg("ERR", "ver chk:" + s.file);
        cads(sc, i + 1, ff, ad, cb); return;
      }
      let rv = exvr(r.body); r = null;
      gdvr(s.id, function(lv) {
        lg("INFO", s.name + " l:" + lv + " r:" + rv);
        if (!fc && lv === rv) {
          // Version matches -- just ensure enable is set correctly
          scll("Script.SetConfig", { id: s.id, config: { enable: s.autostart } }, null);
          cads(sc, i + 1, ff, ad, cb); return;
        }
        dpsc(s, function(ok) { cads(sc, i + 1, ff, true, cb); });
      });
    });
  }); });
}

function cwup(cb) {
  kget("wd.br", function(br) {
  kget("wd.pt", function(pt) {
    let u = CFW + "/?file=" + pt + "/watchdog.js&ref=" + br + "&offset=0&len=20";
    Shelly.call("HTTP.GET", { url: u }, function(r, e) {
      if (e || !r || r.code !== 200) { lg("WARN", "wd ver chk fail"); cb(false); return; }
      let rv = exvr(r.body); r = null;
      gdvr(WDSL, function(lv) {
        lg("INFO", "wd l:" + lv + " r:" + rv);
        if (rv && lv !== rv) { hsup(rv); kset("wd.nc", "300", null); cb("upd"); }
        else { cb(false); }
      });
    });
  }); });
}

// ================= FIND KVS RESTORE SLOT =================
function fksl(cb) {
  Shelly.call("Script.List", {}, function(r, e) {
    if (e || !r || !r.scripts) { cb(null); return; }
    for (let i = 0; i < r.scripts.length; i++) {
      if (r.scripts[i].name === "kvs_restore") { cb(r.scripts[i].id); return; }
    }
    cb(null);
  });
}

// ================= GEN KVS RESTORE =================
// Streams one KVS.Get + one Script.PutCode per key to avoid building
// the full script string in memory. Generated script uses array pushes
// so there's no trailing-comma issue.
function gkrs(kl, cb) {
  fksl(function(sid) {
    function gotSlot(id) {
      Shelly.call("Script.GetStatus", { id: id }, function(rs, es) {
        if (!es && rs && rs.running) {
          Shelly.call("Script.Stop", { id: id }, function() { writeHdr(id); });
        } else {
          writeHdr(id);
        }
      });
    }
    if (sid === null) {
      Shelly.call("Script.Create", { name: "kvs_restore" }, function(rc, ec) {
        if (ec || !rc) { lg("ERR", "kvs_restore create"); cb(); return; }
        lg("INFO", "kvs_restore created id:" + rc.id);
        gotSlot(rc.id);
      });
    } else {
      gotSlot(sid);
    }
  });

  function writeHdr(id) {
    let hdr = "// kvs_restore auto-generated by watchdog\nlet keys = [];\n";
    Shelly.call("Script.PutCode", { id: id, code: hdr, append: false }, function(r, e) {
      hdr = null;
      if (e) { lg("ERR", "kvs_restore hdr"); cb(); return; }
      writeKeys(id, 0);
    });
  }

  function writeKeys(id, ki) {
    if (ki >= kl.length) { writeFtr(id); return; }
    let k = kl[ki];
    Shelly.call("KVS.Get", { key: k }, function(r, e) {
      if (e || !r) { writeKeys(id, ki + 1); return; } // key not set, skip
      let v = String(r.value).split("\\").join("\\\\").split('"').join('\\"').split("\n").join("\\n");
      let line = 'keys.push(["' + k + '","' + v + '"]);\n';
      Shelly.call("Script.PutCode", { id: id, code: line, append: true }, function(r2, e2) {
        line = null;
        if (e2) { lg("ERR", "kvs_restore line"); cb(); return; }
        Timer.set(0, false, function() { writeKeys(id, ki + 1); });
      });
    });
  }

  function writeFtr(id) {
    let ftr = "let i = 0;\nfunction nx() {\n" +
      "  if (i >= keys.length) { print(\"kvs_restore complete\"); Shelly.call(\"Script.Stop\", { id: Shelly.getCurrentScriptId() }, null); return; }\n" +
      "  let k = keys[i][0]; let v = keys[i][1]; i++;\n" +
      "  Shelly.call(\"KVS.Set\", { key: k, value: v }, function() { nx(); });\n" +
      "}\nnx();";
    Shelly.call("Script.PutCode", { id: id, code: ftr, append: true }, function(r, e) {
      ftr = null;
      if (e) { lg("ERR", "kvs_restore ftr"); cb(); return; }
      Shelly.call("Script.SetConfig", { id: id, config: { enable: false } }, null);
      lg("INFO", "kvs_restore deployed id:" + id);
      cb();
    });
  }
}

// ================= CYCLES =================
let ctmr = null;
let htmr = null;
let mfst = null;

function rhcy() {
  if (!mfst) { shcy(); return; }
  hlth(mfst.scripts, function(frc) {
    if (frc) {
      if (ctmr) { Timer.clear(ctmr); ctmr = null; }
      lg("INFO", "hlth->ver cycle");
      rvcl();
    }
    shcy();
  });
}

function rvcl() {
  if (ctmr) { Timer.clear(ctmr); ctmr = null; }
  lg("INFO", "ver cycle");
  cwup(function(rs) {
    if (rs === "upd") return;
    fgsm(MFIL, function(bd) {
      if (!bd) { lg("ERR", "manifest fail"); snxt(300); return; }
      try { mfst = JSON.parse(bd); bd = null; } catch(e) { lg("ERR", "manifest parse"); snxt(300); return; }

      function dvc() {
        chkf(mfst.scripts, function(fl) {
          cads(mfst.scripts, 0, fl, false, function(ad) {
            let kl = ["wd.br", "wd.pt", "wd.pv"];
            let dk = Object.keys(mfst.kvsDefaults || {});
            let ck = Object.keys(mfst.kvsConfig || {});
            for (let j = 0; j < dk.length; j++) kl.push(dk[j]);
            for (let j = 0; j < ck.length; j++) kl.push(ck[j]);
            mfst = null;
            gkrs(kl, function() {
              kget("wd.nc", function(nc) {
                kget("wd.iv", function(iv) {
                  let mxiv = iv ? (iv * 1) : 604800;
                  if (ad) {
                    kset("wd.nc", "300", null); snxt(300);
                  } else {
                    let n = (nc ? (nc * 1) : 300) * 2;
                    if (n > mxiv) n = mxiv;
                    kset("wd.nc", String(n), null); snxt(n);
                  }
                });
              });
            });
          });
        });
      }

      Shelly.call("KVS.Get", { key: "wd.pv" }, function(r, e) {
        if (!e && r && r.value === "1") { lg("INFO", "prov skip"); dvc(); }
        else { prov(mfst, function() { dvc(); }); }
      });
    });
  });
}

// ================= PROVISION =================
function prov(mf, cb) {
  lg("INFO", "provisioning...");
  prvc(mf.components || [], function() {
    prfx(mf.config || {}, false, function() {
      prvd(mf.kvsDefaults || {}, function() {
        prfx(mf.kvsConfig || {}, true, function() {
          cb();
        });
      });
    });
  });
}

function cdif(ds, ac) {
  if (ac === null || ac === undefined) return true;
  let ks = Object.keys(ds);
  for (let i = 0; i < ks.length; i++) {
    let k = ks[i];
    if (typeof ds[k] === "object" && ds[k] !== null) { if (cdif(ds[k], ac[k])) return true; }
    else { if (ds[k] !== ac[k]) return true; }
  }
  return false;
}

function prfx(cf, ckv, cb) {
  let ks = Object.keys(cf); let i = 0;
  function nx() {
    if (i >= ks.length) { cb(); return; }
    let ky = ks[i]; let en = ckv ? cf[ky] : null; i++;
    let sm = ckv ? en.method : ky;
    let ds = ckv ? en.config : cf[ky].config;

    function ap() {
      let gm = sm.replace("SetConfig", "GetConfig");
      if (gm === sm) { scll(sm, { config: ds }, function(r, e) { if (e) lg("WARN", "fail:" + sm); nx(); }); return; }
      scll(gm, {}, function(r, e) {
        if (!e && r && !cdif(ds, r)) {
          if (ckv) scll("KVS.Set", { key: ky, value: "configured" }, function() { nx(); });
          else nx();
          return;
        }
        scll(sm, { config: ds }, function(r2, e2) {
          if (e2) lg("WARN", "fail:" + sm);
          else if (r2 && r2.restart_required) lg("WARN", sm + " REBOOT");
          else lg("INFO", sm + " ok");
          if (ckv) scll("KVS.Set", { key: ky, value: "configured" }, function() { nx(); });
          else nx();
        });
      });
    }

    if (ckv) {
      scll("KVS.Get", { key: ky }, function(r, e) { if (!e && r) { nx(); return; } ap(); });
    } else { ap(); }
  }
  nx();
}

function prvd(df, cb) {
  let ks = Object.keys(df); let i = 0;
  function nx() {
    if (i >= ks.length) {
      Shelly.call("KVS.Set", { key: "wd.pv", value: "1" }, function() { cb(); });
      return;
    }
    let k = ks[i]; let v = df[k]; i++;
    Shelly.call("KVS.Get", { key: k }, function(r, e) {
      if (!e && r) { nx(); return; }
      Shelly.call("KVS.Set", { key: k, value: String(v) }, function() { nx(); });
    });
  }
  nx();
}

function prvc(cp, cb) {
  let i = 0;
  function nx() {
    if (i >= cp.length) { cb(); return; }
    let c = cp[i]; i++;
    let gm = (c.type === "text") ? "Text.GetConfig" : "Number.GetConfig";
    scll(gm, { id: c.id }, function(r, e) {
      if (!e && r && r.name === c.name) { nx(); return; }
      if (!e && r) {
        let sm = (c.type === "text") ? "Text.SetConfig" : "Number.SetConfig";
        scll(sm, { id: c.id, config: { name: c.name } }, function() { lg("INFO", "ren " + c.type + ":" + c.id); nx(); });
        return;
      }
      let am = (c.type === "text") ? "Text.Add" : "Number.Add";
      scll(am, { id: c.id, config: { name: c.name } }, function(r2, e2) {
        if (e2) lg("ERR", "cre " + c.type + ":" + c.id); else lg("INFO", "cre " + c.type + ":" + c.id);
        nx();
      });
    });
  }
  nx();
}

function shcy() {
  kget("wd.hi", function(hi) {
    htmr = Timer.set((hi ? (hi * 1) : 300) * 1000, false, function() { rhcy(); });
  });
}

function snxt(s) {
  lg("INFO", "nxt:" + s + "s");
  ctmr = Timer.set(s * 1000, false, function() { rvcl(); });
}

// ================= WAIT KVS RESTORE =================
// Find kvs_restore by name, then poll until it stops running.
// There is a window between device boot and kvs_restore completing where KVS
// may be empty -- this function bridges that window before normal boot proceeds.
function wkr(cb) {
  fksl(function(sid) {
    if (sid === null) { cb(); return; } // not yet created, nothing to wait for
    function poll() {
      Shelly.call("Script.GetStatus", { id: sid }, function(r, e) {
        if (!e && r && r.running) {
          lg("INFO", "wait kvs_restore...");
          Timer.set(1000, false, poll);
        } else {
          cb();
        }
      });
    }
    poll();
  });
}

// ================= BOOT =================
function boot() {
  lg("INFO", "boot slfi:" + SLFI);

  if (SLFI !== WDSL) {
    lg("INFO", "temp " + SLFI + " -> " + WDSL);
    kget("wd.br", function(br) {
      kget("wd.pt", function(pt) {
        if (!br || !pt) { lg("ERR", "no br/pt"); return; }
        hsup(null);
      });
    });
    return;
  }

  kget("wd.rd", function(rd) {
    rDly = rd ? (rd * 1) : 200;
    // Check KVS health: wd.br must exist before we can fetch anything from GitHub.
    // If it's missing (KVS wiped by config change), wait for kvs_restore to finish.
    kget("wd.br", function(br) {
      function proceed() {
        kset("wd.nc", "300", null);
        // Ensure watchdog and bootstrapper are enabled for autostart
        Shelly.call("Script.SetConfig", { id: WDSL, config: { enable: true } }, null);
        Shelly.call("Script.SetConfig", { id: 1,    config: { enable: false } }, null);
        Shelly.call("Script.GetStatus", { id: 1 }, function(sr, se) {
          if (!se && sr && sr.running) {
            Shelly.call("Script.Stop", { id: 1 }, function() {
              lg("INFO", "bstp stopped");
              rvcl(); shcy();
            });
          } else {
            rvcl(); shcy();
          }
        });
      }
      if (!br) {
        // KVS wiped -- start kvs_restore explicitly and wait for it to finish
        lg("WARN", "KVS empty, starting kvs_restore");
        fksl(function(sid) {
          if (sid === null) { lg("WARN", "no kvs_restore slot"); proceed(); return; }
          Shelly.call("Script.Start", { id: sid }, function() {
            wkr(function() {
              // Re-read wd.rd in case it was restored with a non-default value
              kget("wd.rd", function(rd2) {
                rDly = rd2 ? (rd2 * 1) : 200;
                proceed();
              });
            });
          });
        });
      } else {
        proceed();
      }
    });
  });
}

Timer.set(2000, false, function() { boot(); });
