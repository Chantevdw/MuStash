"use strict";
/* Google Drive connection for sync.

   Permission used: "drive.file". The app can only see the one file it created, or a file you choose in
   Google's own file picker. It cannot browse or read the rest of your Drive.
   The file's contents are encrypted before they get here (see sync.js), so Google only ever stores scrambled data.

   Interface (what sync.js needs): read(id) -> {text, modified}   write(id, text) -> {modified}
   Plus the helpers the screen needs: configured, signIn, who, create, pick, signOut. */
const DriveBackend=(()=>{
  const SCOPE="https://www.googleapis.com/auth/drive.file";
  const FILES="https://www.googleapis.com/drive/v3/files",UPLOAD="https://www.googleapis.com/upload/drive/v3/files";
  const cfg=()=>window.OURMONEY_GOOGLE||{};
  const configured=()=>!!(cfg().clientId&&cfg().apiKey&&cfg().appId);
  let tokenClient=null,token=null,tokenExp=0;
  try{const t=JSON.parse(sessionStorage.getItem("ourmoney.token")||"null");if(t&&t.exp>Date.now()){token=t.token;tokenExp=t.exp;}}catch(e){}

  const loadScript=src=>new Promise((res,rej)=>{
    if(document.querySelector(`script[src="${src}"]`))return res();
    const s=document.createElement("script");s.src=src;s.onload=res;s.onerror=()=>rej(new Error("Couldn't reach Google. Check your internet connection."));
    document.head.appendChild(s);});

  // interactive=true opens Google's sign-in popup (must come from a tap); false only succeeds if you already agreed on this device.
  function signIn(interactive){
    if(token&&Date.now()<tokenExp-60000)return Promise.resolve(token);
    if(!configured())return Promise.reject(Object.assign(new Error("Sync is not set up yet."),{code:"not_configured"}));
    return loadScript("https://accounts.google.com/gsi/client").then(()=>new Promise((res,rej)=>{
      const timer=setTimeout(()=>rej(Object.assign(new Error("Sign-in did not finish."),{code:"timeout"})),interactive?120000:15000);
      tokenClient=tokenClient||google.accounts.oauth2.initTokenClient({client_id:cfg().clientId,scope:SCOPE,callback:()=>{}});
      tokenClient.callback=r=>{clearTimeout(timer);
        if(r.error)return rej(Object.assign(new Error(r.error_description||r.error),{code:r.error}));
        token=r.access_token;tokenExp=Date.now()+(+r.expires_in||3600)*1000;
        try{sessionStorage.setItem("ourmoney.token",JSON.stringify({token,exp:tokenExp}));}catch(e){}
        res(token);};
      tokenClient.error_callback=e=>{clearTimeout(timer);rej(Object.assign(new Error(e.message||"Sign-in was cancelled."),{code:e.type||"popup_closed"}));};
      tokenClient.requestAccessToken({prompt:interactive?"":"none"});
    }));
  }
  function signOut(){token=null;tokenExp=0;try{sessionStorage.removeItem("ourmoney.token");}catch(e){}}

  async function call(url,opts={}){
    if(!token||Date.now()>=tokenExp-5000){const e=new Error("Please sign in to Google again.");e.code="auth";throw e;}
    let r;
    try{r=await fetch(url,{...opts,headers:{...(opts.headers||{}),Authorization:"Bearer "+token}});}
    catch(e){const err=new Error("No connection to Google Drive.");err.code="offline";throw err;}
    if(r.status===401){signOut();const e=new Error("Please sign in to Google again.");e.code="auth";throw e;}
    if(r.status===404){const e=new Error("The sync file was not found. It may have been deleted, or it is not shared with this Google account.");e.code="not_found";throw e;}
    if(r.status===403){const e=new Error("This Google account can't change the sync file. Ask for Editor access to it.");e.code="forbidden";throw e;}
    if(!r.ok){const e=new Error("Google Drive said: "+r.status+" "+(await r.text()).slice(0,120));e.code="http_"+r.status;throw e;}
    return r;
  }
  const stamp=m=>m.modifiedTime+"|"+m.version;

  return{
    configured,signIn,signOut,
    isSignedIn:()=>!!token&&Date.now()<tokenExp-5000,
    async who(){try{const r=await call("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)");const u=(await r.json()).user||{};return u.emailAddress||u.displayName||"";}catch(e){return "";}},
    async read(id){
      const meta=await(await call(`${FILES}/${id}?fields=modifiedTime,version`)).json();   // metadata first: if the file changes after this, the stamp is stale and the round is repeated
      const text=await(await call(`${FILES}/${id}?alt=media`)).text();
      return{text,modified:stamp(meta)};
    },
    async write(id,text){
      const meta=await(await call(`${UPLOAD}/${id}?uploadType=media&fields=modifiedTime,version`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:text})).json();
      return{modified:stamp(meta)};
    },
    async create(name,text){
      const boundary="ourmoney"+Date.now().toString(36);
      const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({name,mimeType:"application/json"})}\r\n`+
                 `--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
      const f=await(await call(`${UPLOAD}?uploadType=multipart&fields=id,name`,{method:"POST",headers:{"Content-Type":"multipart/related; boundary="+boundary},body})).json();
      return{id:f.id,name:f.name};
    },
    // Opens Google's file picker so you can choose the sync file that your partner shared with you.
    async pick(){
      await signIn(true);
      await loadScript("https://apis.google.com/js/api.js");
      await new Promise(r=>gapi.load("picker",r));
      return new Promise(res=>{
        const p=google.picker;
        const mine=new p.DocsView().setMimeTypes("application/json").setIncludeFolders(false);
        const shared=new p.DocsView().setMimeTypes("application/json").setIncludeFolders(false).setOwnedByMe(false);
        new p.PickerBuilder().setAppId(cfg().appId).setOAuthToken(token).setDeveloperKey(cfg().apiKey)
          .setTitle("Choose the MuStash sync file").addView(shared).addView(mine)
          .setCallback(d=>{
            if(d[p.Response.ACTION]===p.Action.PICKED){const doc=d[p.Response.DOCUMENTS][0];res({id:doc[p.Document.ID],name:doc[p.Document.NAME]});}
            else if(d[p.Response.ACTION]===p.Action.CANCEL)res(null);
          }).build().setVisible(true);
      });
    }
  };
})();
