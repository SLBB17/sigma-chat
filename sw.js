const C='sigma-social-v1';
self.addEventListener('install',e=>e.waitUntil(caches.open(C).then(c=>c.addAll(['./','./index.html','./manifest.json']))));
self.addEventListener('fetch',e=>{ if(e.request.method!=='GET'||e.request.url.includes('/api/')||e.request.url.includes('/socket.io/')) return;
  e.respondWith(fetch(e.request).catch(()=>caches.match(e.request))); });
