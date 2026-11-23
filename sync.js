"use strict";
/* Sync engine for MuStash. No DOM and no network code here, so it runs in the browser and under Node for tests.

   How two phones stay in step:
   - The whole data set lives in one file that is encrypted with a passphrase before it leaves the phone.
   - Each phone downloads that file, merges it with its own data, and uploads the result.
   - Merging never loses a transaction: it keeps everything either phone has, and when both changed the
     same transaction it keeps the newest edit. Deleted transactions are remembered ("tombstones") so a
     deletion on one phone is not undone by the other.
   - Settings (rules, categories, owners, budgets...) are taken from whichever phone changed them last. */

const SYNC_SETTINGS_KEYS=["categories","rules","owners","bankMaps","budgets","catClass","catGroup","groups","coach","fair"];
const SYNC_KDF_ITERATIONS=250000;

/* ---------- encryption (AES-GCM, key from the passphrase with PBKDF2) ---------- */
const b64=bytes=>{let s="";const a=new Uint8Array(bytes);for(let i=0;i<a.length;i+=0x8000)s+=String.fromCharCode.apply(null,a.subarray(i,i+0x8000));return btoa(s);};
const unb64=str=>Uint8Array.from(atob(str),c=>c.charCodeAt(0));
async function deriveKey(pass,salt,iterations){
  const base=await crypto.subtle.importKey("raw",new TextEncoder().encode(pass),"PBKDF2",false,["deriveKey"]);
  return crypto.subtle.deriveKey({name:"PBKDF2",salt,iterations,hash:"SHA-256"},base,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
}
async function encryptState(state,pass){
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await deriveKey(pass,salt,SYNC_KDF_ITERATIONS);
  const data=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(JSON.stringify(state)));
  return JSON.stringify({app:"our-money-sync",v:1,kdf:"PBKDF2-SHA256",iter:SYNC_KDF_ITERATIONS,salt:b64(salt),iv:b64(iv),data:b64(data)});
}
async function decryptState(text,pass){
  let box;try{box=JSON.parse(text);}catch(e){throw new Error("The sync file is not readable.");}
  if(box.app!=="our-money-sync")throw new Error("That file is not a MuStash sync file.");
  try{
    const key=await deriveKey(pass,unb64(box.salt),box.iter||SYNC_KDF_ITERATIONS);
    const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(box.iv)},key,unb64(box.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }catch(e){throw new Error("Wrong passphrase, or the sync file is damaged.");}
}

/* ---------- merging ---------- */
const txMod=t=>t.mod||0;
// Returns {state, stats}. Does not change its inputs.
function mergeStates(local,remote){
  const deleted={};
  for(const src of [local.deleted||{},remote.deleted||{}])for(const [id,ts] of Object.entries(src))deleted[id]=Math.max(deleted[id]||0,ts);
  const localById=new Map((local.transactions||[]).map(t=>[t.id,t]));
  const byId=new Map(localById),order=[...localById.keys()];
  for(const r of remote.transactions||[]){
    const l=byId.get(r.id);
    if(!l){byId.set(r.id,r);order.push(r.id);}
    else if(txMod(r)>txMod(l))byId.set(r.id,r);          // both phones have it: the newest edit wins
  }
  const transactions=[];
  for(const id of order){
    const t=byId.get(id);
    if(deleted[id]!==undefined&&deleted[id]>=txMod(t))continue;   // deleted after its last edit
    transactions.push(t);
  }
  const kept=new Set(transactions.map(t=>t.id));
  const stats={
    added:transactions.filter(t=>!localById.has(t.id)).length,
    updated:transactions.filter(t=>localById.has(t.id)&&byId.get(t.id)!==localById.get(t.id)).length,
    removed:[...localById.keys()].filter(id=>!kept.has(id)).length,
    settingsFromRemote:false};
  const useRemote=(remote.setMod||0)>(local.setMod||0);
  const base=useRemote?remote:local;
  const state=Object.assign({},local,{transactions,deleted,version:Math.max(local.version||0,remote.version||0),setMod:Math.max(local.setMod||0,remote.setMod||0)});
  for(const k of SYNC_SETTINGS_KEYS)if(base[k]!==undefined)state[k]=JSON.parse(JSON.stringify(base[k]));
  // categories follow the newest settings, so a rename or delete on one phone is not undone by the other;
  // but a category that any kept transaction still uses is never dropped
  const cats=[...(state.categories||[])];
  for(const t of transactions)if(t.cat&&!cats.includes(t.cat))cats.push(t.cat);
  state.categories=cats;
  stats.settingsFromRemote=useRemote;
  return{state,stats};
}
// True when `a` holds something that `b` does not (so `b` needs updating).
function hasNewerThan(a,b){
  const bt=new Map((b.transactions||[]).map(t=>[t.id,t]));
  for(const t of a.transactions||[]){const o=bt.get(t.id);if(!o||txMod(t)>txMod(o))return true;}
  const bd=b.deleted||{};
  for(const [id,ts] of Object.entries(a.deleted||{}))if((bd[id]||0)<ts)return true;
  return (a.setMod||0)>(b.setMod||0);
}

/* ---------- one sync round ---------- */
// backend: {read(id)->{text,modified}, write(id,text)->{modified}}
// io: {getState(), applyState(state), pass}
async function syncOnce(backend,fileId,io,attempt=0){
  const rem=await backend.read(fileId);
  const local=io.getState();
  let merged=local,remoteState=null,stats={added:0,updated:0,removed:0,settingsFromRemote:false};
  if(rem.text&&rem.text.trim()){
    remoteState=await decryptState(rem.text,io.pass);
    ({state:merged,stats}=mergeStates(local,remoteState));
  }
  const changedLocally=stats.added+stats.updated+stats.removed>0||stats.settingsFromRemote;
  if(changedLocally)await io.applyState(merged);
  const needsUpload=!remoteState||hasNewerThan(merged,remoteState);
  let uploaded=false;
  if(needsUpload){
    // if someone else wrote while we were merging, start again (once) so their changes are not overwritten
    const now=await backend.read(fileId);
    if(now.modified!==rem.modified&&attempt<2)return syncOnce(backend,fileId,io,attempt+1);
    await backend.write(fileId,await encryptState(merged,io.pass));
    uploaded=true;
  }
  return{...stats,uploaded,at:Date.now()};
}

if(typeof module!=="undefined")module.exports={encryptState,decryptState,mergeStates,hasNewerThan,syncOnce,SYNC_SETTINGS_KEYS};
