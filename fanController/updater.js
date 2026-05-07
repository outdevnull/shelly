// version: 1.5.0
// No provisioning — bootstrap handles first-run setup.
// Fetches manifest.json, deploys/updates scripts, writes KVS defaults, restarts supervisor.

let CFW ="https://shelly-proxy.ash-b39.workers.dev";
let SLFI=Shelly.getCurrentScriptId();
function lg(lv,ms){print("["+lv+"][UPD]"+ms);}
function kget(k,cb){Shelly.call("KVS.Get",{key:k},function(r,e){cb((!e&&r)?r.value:null);});}
function kset(k,v,cb){Shelly.call("KVS.Set",{key:k,value:String(v)},function(r,e){if(cb)cb();});}
function exvr(cd){let mk="// version: ",ix=cd.indexOf(mk);if(ix===-1)return null;let en=cd.indexOf("\n",ix);return(en>-1?cd.slice(ix+mk.length,en):cd.slice(ix+mk.length)).trim();}

function fgsm(fi,cb){
  let asm="",off=0,br,pt;
  function go(){
    Shelly.call("HTTP.GET",{url:CFW+"/?file="+pt+"/"+fi+"&ref="+br+"&offset="+off+"&len=512"},function(r,e){
      if(e||!r||r.code!==200){cb(null);return;}
      asm+=r.body;
      let lft=(r.headers&&r.headers["X-Left"]!==undefined)?(r.headers["X-Left"]*1):0;
      off+=r.body.length;r=null;
      if(lft>0)Timer.set(200,false,go);else{cb(asm);asm=null;}
    });
  }
  kget("wd.br",function(b){br=b;kget("wd.pt",function(p){pt=p;go();});});
}

function gfad(fi,sid,cb){
  let fof=0,fpt=true,br,pt;
  function dput(da,po,dn){
    if(po>=da.length){da=null;dn(true);return;}
    let pc=da.slice(po,po+512),ap=!fpt;fpt=false;
    Shelly.call("Script.PutCode",{id:sid,code:pc,append:ap},function(r,e){
      pc=null;r=null;
      if(e){dn(false);return;}
      Timer.set(0,false,function(){dput(da,po+512,dn);});
    });
  }
  function dftc(){
    Shelly.call("HTTP.GET",{url:CFW+"/?file="+pt+"/"+fi+"&ref="+br+"&offset="+fof+"&len=512"},function(r,e){
      if(e||!r||r.code!==200){cb(false);return;}
      let ck=r.body,lf=(r.headers&&r.headers["X-Left"]!==undefined)?(r.headers["X-Left"]*1):0;
      fof+=ck.length;r=null;
      dput(ck,0,function(ok){ck=null;if(!ok){cb(false);return;}if(lf>0)Timer.set(200,false,dftc);else cb(true);});
    });
  }
  kget("wd.br",function(b){br=b;kget("wd.pt",function(p){pt=p;dftc();});});
}

function dpsc(sc,cb){
  kset("s."+sc.id+".ok","0",function(){
    Shelly.call("Script.GetStatus",{id:sc.id},function(r,e){
      function dwr(){
        gfad(sc.file,sc.id,function(ok){
          if(!ok){cb(false);return;}
          kset("s."+sc.id+".ok","1",function(){
            Shelly.call("Script.SetConfig",{id:sc.id,config:{enable:sc.autostart}},null);
            cb(true);
          });
        });
      }
      if(e||!r){
        Shelly.call("Script.Create",{name:sc.name},function(r2,e2){
          if(e2){cb(false);return;}
          sc.id=r2.id;dwr();
        });
      }else{
        if(r.running)Shelly.call("Script.Stop",{id:sc.id},function(){dwr();});else dwr();
      }
    });
  });
}

function cdal(sc,i,cb){
  if(i>=sc.length){cb();return;}
  let s=sc[i];i++;
  if(!s.file){cdal(sc,i,cb);return;}
  kget("s."+s.id+".ok",function(ok){
    if(ok==="0"){dpsc(s,function(){cdal(sc,i,cb);});return;}
    kget("wd.br",function(br){kget("wd.pt",function(pt){
      Shelly.call("HTTP.GET",{url:CFW+"/?file="+pt+"/"+s.file+"&ref="+br+"&offset=0&len=20"},function(r,e){
        if(e||!r||r.code!==200){cdal(sc,i,cb);return;}
        let rv=exvr(r.body);r=null;
        Shelly.call("Script.GetCode",{id:s.id,offset:0,len:20},function(r2,e2){
          let lv=(!e2&&r2)?exvr(r2.data):null;
          if(lv!==rv)dpsc(s,function(){cdal(sc,i,cb);});
          else{Shelly.call("Script.SetConfig",{id:s.id,config:{enable:s.autostart}},null);cdal(sc,i,cb);}
        });
      });
    });});
  });
}

function chkd(mf,cb){
  let dv=mf.kvsDefaultsVersion||"0";
  kget("wd.kvd_ver",function(cv){
    if(cv===dv){cb();return;}
    lg("INFO","kvd v"+dv);
    let ks=Object.keys(mf.kvsDefaults||{}),i=0;
    function nx(){
      if(i>=ks.length){kset("wd.kvd_ver",dv,function(){cb();});return;}
      let k=ks[i],v=mf.kvsDefaults[k];i++;
      Shelly.call("KVS.Set",{key:k,value:String(v)},function(){nx();});
    }
    nx();
  });
}

Timer.set(1000,false,function(){
  lg("INFO","start");
  fgsm("manifest.json",function(bd){
    if(!bd){Shelly.call("Script.Stop",{id:SLFI},null);return;}
    let mf;try{mf=JSON.parse(bd);bd=null;}catch(ex){Shelly.call("Script.Stop",{id:SLFI},null);return;}
    let sc=mf.scripts||[];mf.scripts=null;
    cdal(sc,0,function(){
      sc=null;
      chkd(mf,function(){
        mf=null;
        lg("INFO","done");
        Shelly.call("Script.List",{},function(r,e){
          if(!e&&r&&r.scripts)for(let i=0;i<r.scripts.length;i++){
            if(r.scripts[i].name==="supervisor"){Shelly.call("Script.Start",{id:r.scripts[i].id},null);break;}
          }
          Shelly.call("Script.Stop",{id:SLFI},null);
        });
      });
    });
  });
});
