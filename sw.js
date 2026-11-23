"use strict";
/* Offline support for MuStash. Keeps a copy of the app's own files so it opens without a connection.
   It only ever handles files from this app's own address: requests to Google (sign-in, Drive) and
   anything else are left alone and never stored. Change CACHE when you publish a new version. */
const CACHE="mustash-v3";
const FILES=["./","index.html","statement-parser.js","sync.js","sync-config.js","sync-drive.js","applock.js","pdf.min.js","pdf.worker.min.js","manifest.json","icon-192.png","icon-512.png","icon-maskable-512.png","apple-touch-icon.png","favicon-64.png","mark.png"];

self.addEventListener("install",e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()));
});
self.addEventListener("activate",e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
// Online: always fetch the latest and refresh the copy. Offline: use the copy.
self.addEventListener("fetch",e=>{
  const req=e.request;
  if(req.method!=="GET"||new URL(req.url).origin!==self.location.origin)return;
  e.respondWith(
    fetch(req).then(res=>{if(res.ok){const copy=res.clone();caches.open(CACHE).then(c=>c.put(req,copy));}return res;})
      .catch(()=>caches.match(req).then(hit=>hit||caches.match("index.html")))
  );
});
