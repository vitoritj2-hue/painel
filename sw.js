const CACHE='transformar-v2';
const ASSETS=['/','./index.html','./manifest.json'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>clients.claim())
  );
});

self.addEventListener('fetch',e=>{
  // Nunca interceptar chamadas de API — deixa passar direto para a rede
  if(e.request.url.includes('/api/')){
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
});

// Recebe mensagem do site e dispara notificação
self.addEventListener('message',e=>{
  const{type,title,body,icon}=e.data||{};
  if(type==='NOTIFY'){
    self.registration.showNotification(title||'Transformar',{
      body:body||'',
      icon:icon||'/icons/icon-192.png',
      badge:'/icons/icon-96.png',
      vibrate:[200,100,200],
      tag:'transformar-notif',
      renotify:true,
      requireInteraction:false
    });
  }
});

// Clique na notificação — abre o site
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(clients.matchAll({type:'window'}).then(list=>{
    for(const c of list){if(c.url&&'focus' in c)return c.focus();}
    if(clients.openWindow)return clients.openWindow('/');
  }));
});
