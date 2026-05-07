// version: 1.8.0
// Looks up scripts by name (not manifest id) before deploying.
// Sets name in SetConfig so slots are always correctly identified.
// Chkd before cdal so mf freed before sc; no slice() in gfad.

let CFW ="https://shelly-proxy.ash-b39.workers.dev";
let SLFI=Shelly.getCurrentScriptId();
function kget(k,cb){Shelly.call("KVS.Get",{key:k},function(r,e){cb((!e&&r)?r.value:null);});}
function kset(k,v,cb){Shelly.call("KVS.Set",{key:k,value:String(v)},function(r,e){if(cb)cb();});}

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
  function dftc(){
    Shelly.call("HTTP.GET",{url:CFW+"/?file="+pt+"/"+fi+"&ref="+br+"&offset="+fof+"&len=512"},function(r,e){
      if(e||!r||r.code!==200){cb(false);return;}
      let ck=r.body,lf=(r.headers&&r.headers["X-Left"]!==undefined)?(r.headers["X-Left"]*1):0;
      fof+=ck.length;r=null;
      let ap=!fpt;fpt=false;
      Shelly.call("Script.PutCode",{id:sid,code:ck,append:ap},function(r2,e2){
        ck=null;r2=null;
        if(e2){cb(false);return;}
        if(lf>0)Timer.set(200,false,dftc);else cb(true);
      });
    });
  }
  kget("wd.br",function(b){br=b;kget("wd.pt",function(p){pt=p;dftc();});});
}

function dpsc(sc,did,cb){
  function dwr(id){
    gfad(sc.file,id,function(ok){
      Shelly.call("Script.SetConfig",{id:id,config:{name:sc.name,enable:sc.autostart}},null);
      cb(ok);
    });
  }
  if(did!==null){
    Shelly.call("Script.GetStatus",{id:did},function(r,e){
      if(!e&&r&&r.running)Shelly.call("Script.Stop",{id:did},function(){dwr(did);});
      else dwr(did);
    });
  }else{
    Shelly.call("Script.Create",{name:sc.name},function(r2,e2){
      if(e2){cb(false);return;}
      dwr(r2.id);
    });
  }
}

function cdal(sc,i,sl,cb){
  if(i>=sc.length){cb();return;}
  let s=sc[i];i++;
  if(!s.file){cdal(sc,i,sl,cb);return;}
  let did=null;
  for(let j=0;j<sl.length;j++){if(sl[j].name===s.name){did=sl[j].id;break;}}
  if(did===SLFI){cdal(sc,i,sl,cb);return;}
  dpsc(s,did,function(){cdal(sc,i,sl,cb);});
}

function chkd(mf,cb){
  let dv=mf.kvsDefaultsVersion||"0";
  kget("wd.kvd_ver",function(cv){
    if(cv===dv){cb();return;}
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
  fgsm("manifest.json",function(bd){
    if(!bd){Shelly.call("Script.Stop",{id:SLFI},null);return;}
    let mf;try{mf=JSON.parse(bd);bd=null;}catch(ex){Shelly.call("Script.Stop",{id:SLFI},null);return;}
    chkd(mf,function(){
      let sc=mf.scripts||[];mf=null;
      Shelly.call("Script.List",{},function(rl,el){
        let sl=(!el&&rl&&rl.scripts)?rl.scripts:[];rl=null;
        let supId=null;
        for(let j=0;j<sl.length;j++){if(sl[j].name==="supervisor"){supId=sl[j].id;break;}}
        cdal(sc,0,sl,function(){
          sc=null;sl=null;
          if(supId)Shelly.call("Script.Start",{id:supId},null);
          Shelly.call("Script.Stop",{id:SLFI},null);
        });
      });
    });
  });
});
