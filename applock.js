"use strict";
/* App lock for MuStash: the PIN or password check. Pure functions with no screen code, so it also runs under Node for tests.

   - The PIN itself is never stored. Only a salted hash is kept (PBKDF2-SHA256, 200,000 rounds), on this device only.
     It is not part of the synced data, so each phone has its own PIN.
   - Repeated wrong tries make you wait: 30 seconds after every 5 misses, doubling each time, up to 15 minutes.
   - This stops anyone who picks up an unlocked phone. It is a lock on the app, not a replacement for the phone's own
     screen lock and encryption. */

const LOCK_ITER=200000;
const lockB64=bytes=>{let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s);};
const lockUnb64=str=>Uint8Array.from(atob(str),c=>c.charCodeAt(0));

async function lockHash(pin,salt,iter){
  const base=await crypto.subtle.importKey("raw",new TextEncoder().encode(pin),"PBKDF2",false,["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:iter,hash:"SHA-256"},base,256));
}
// A PIN that is too easy to guess is refused. Returns a message, or "" if it is fine.
function pinProblem(pin){
  if(!pin||pin.length<4)return "Use at least 4 characters.";
  if(/^(.)\1+$/.test(pin))return "That is too easy to guess (the same character repeated).";
  if(/^\d+$/.test(pin)){
    const asc="01234567890123456789",desc="98765432109876543210";
    if(asc.includes(pin)||desc.includes(pin))return "That is too easy to guess (a run of numbers like 1234).";
  }
  return "";
}
async function makeLock(pin,timeoutMin=1){
  const salt=crypto.getRandomValues(new Uint8Array(16));
  return{v:1,salt:lockB64(salt),iter:LOCK_ITER,hash:lockB64(await lockHash(pin,salt,LOCK_ITER)),timeout:timeoutMin,fails:0,until:0};
}
const lockWait=(cfg,now=Date.now())=>Math.max(0,Math.ceil(((cfg.until||0)-now)/1000));
// Returns {ok, cfg, wait}. The returned cfg has the updated miss counter and must be saved.
async function checkPin(cfg,pin,now=Date.now()){
  const wait=lockWait(cfg,now);
  if(wait>0)return{ok:false,cfg,wait};
  const got=await lockHash(pin,lockUnb64(cfg.salt),cfg.iter),want=lockUnb64(cfg.hash);
  let diff=got.length^want.length;for(let i=0;i<want.length;i++)diff|=got[i]^want[i];   // compares every byte, so timing reveals nothing
  if(diff===0)return{ok:true,cfg:{...cfg,fails:0,until:0},wait:0};
  const fails=(cfg.fails||0)+1;let until=0;
  if(fails%5===0)until=now+Math.min(900,30*Math.pow(2,fails/5-1))*1000;
  return{ok:false,cfg:{...cfg,fails,until},wait:until?Math.ceil((until-now)/1000):0};
}

if(typeof module!=="undefined")module.exports={makeLock,checkPin,lockWait,pinProblem,LOCK_ITER};
