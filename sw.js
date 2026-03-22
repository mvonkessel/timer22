const CACHE_NAME = 'pomodoro-v25';
const ASSETS = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];

// ── Install: cache all assets for offline use ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// ── Activate: clean old caches + check stored timer ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => checkStoredTimer())
  );
  self.clients.claim();
});

// ── Fetch: cache-first for app assets, stale-while-revalidate for fonts & Firebase SDK ──
self.addEventListener('fetch', e => {
  // Piggyback: check stored timer on every fetch (any network activity = SW wakeup)
  checkStoredTimer();

  const url = new URL(e.request.url);

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com' || url.hostname === 'www.gstatic.com') {
    e.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(e.request).then(cached => {
          const fetching = fetch(e.request).then(response => {
            if (response.ok) cache.put(e.request, response.clone());
            return response;
          }).catch(() => cached);
          return cached || fetching;
        })
      )
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

// ── Timer state ──
let alarmTimeout = null;
let checkInterval = null;
let timerState = null;
let alarmActive = false;
let _timerGen = 0; // incremented on every timer lifecycle event to detect stale async reads

// ── IndexedDB persistence ──
// Stores timer state so if SW is killed & restarted, it can recover
const IDB_NAME = 'pomo-sw';
const IDB_STORE = 'timer';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSave(state) {
  try {
    const db = await idbOpen();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(state, 'current');
    db.close();
  } catch (e) {}
}

async function idbClear() {
  try {
    const db = await idbOpen();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete('current');
    db.close();
  } catch (e) {}
}

async function idbLoad() {
  try {
    const db = await idbOpen();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get('current');
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); resolve(null); };
    });
  } catch (e) { return null; }
}

// Check if stored timer has expired (called on any SW wake-up)
let _checking = false;
async function checkStoredTimer() {
  if (alarmActive || _checking) return;
  _checking = true;
  try {
    const gen = _timerGen;
    const state = await idbLoad();
    if (!state || !state.endTime) { _checking = false; return; }
    // If any timer lifecycle event (START/CANCEL/STOP) occurred during our
    // async idbLoad, the data is stale — abort to avoid firing wrong alarm.
    if (_timerGen !== gen || alarmActive) { _checking = false; return; }
    if (Date.now() >= state.endTime) {
      timerState = state;
      _checking = false;
      fireAlarm(state.task, state.duration);
    } else if (!alarmTimeout) {
      timerState = state;
      const ms = state.endTime - Date.now();
      alarmTimeout = setTimeout(() => fireAlarm(state.task, state.duration), ms);
      if (!checkInterval) {
        checkInterval = setInterval(() => {
          if (timerState && Date.now() >= timerState.endTime) {
            clearInterval(checkInterval);
            checkInterval = null;
            fireAlarm(timerState.task, timerState.duration);
          }
        }, 3000);
      }
      _checking = false;
    } else {
      _checking = false;
    }
  } catch (e) {
    _checking = false;
  }
}


function clearTimers() {
  clearTimeout(alarmTimeout);
  clearInterval(checkInterval);
  alarmTimeout = null;
  checkInterval = null;
}


// ── Message handling ──
self.addEventListener('message', e => {
  const data = e.data;

  if (data.type === 'START_TIMER') {
    clearTimers();
    alarmActive = false;
    _timerGen++;
    timerState = { task: data.task, duration: data.duration, endTime: data.endTime };
    idbSave(timerState);
    const ms = data.endTime - Date.now();
    if (ms > 0) {
      alarmTimeout = setTimeout(() => fireAlarm(data.task, data.duration), ms);
      // Adaptive check: faster near end, slower otherwise
      checkInterval = setInterval(() => {
        if (timerState && Date.now() >= timerState.endTime) {
          clearInterval(checkInterval);
          checkInterval = null;
          fireAlarm(timerState.task, timerState.duration);
        }
      }, ms < 30000 ? 1000 : 3000);
    } else {
      fireAlarm(data.task, data.duration);
    }
  }

  if (data.type === 'CANCEL_TIMER') {
    clearTimers();
    alarmActive = false;
    _timerGen++;
    timerState = null;
    idbClear();
    self.registration.getNotifications().then(notifs => notifs.forEach(n => {
      if (n.tag === 'pomodoro-alarm') n.close();
    }));
  }

  if (data.type === 'STOP_ALARM') {
    clearTimers();
    clearInterval(self._alarmRepeat);
    alarmActive = false;
    _timerGen++;
    timerState = null;
    idbClear();
    self.registration.getNotifications().then(notifs => notifs.forEach(n => {
      if (n.tag === 'pomodoro-alarm') n.close();
    }));
  }

  if (data.type === 'HEARTBEAT') {
    if (data.endTime && data.isRunning) {
      const remaining = data.endTime - Date.now();
      if (remaining <= 0) {
        fireAlarm(data.task, data.duration);
      } else if (!alarmTimeout) {
        timerState = { task: data.task, duration: data.duration, endTime: data.endTime };
        idbSave(timerState);
        alarmTimeout = setTimeout(() => fireAlarm(data.task, data.duration), remaining);
        if (!checkInterval) {
          checkInterval = setInterval(() => {
            if (timerState && Date.now() >= timerState.endTime) {
              clearInterval(checkInterval);
              checkInterval = null;
              fireAlarm(timerState.task, timerState.duration);
            }
          }, 5000);
        }
      }
    }
  }


  if (data.type === 'PING') {
    e.source && e.source.postMessage({ type: 'PONG' });
  }
});

async function fireAlarm(task, duration) {
  if (alarmActive) return; // guard against race conditions
  clearTimers();
  clearInterval(self._alarmRepeat); // prevent interval leak from previous call
  self._alarmRepeat = null;
  timerState = null;
  alarmActive = true;
  idbClear();

  try {
    await self.registration.showNotification('Pomodoro fertig!', {
      body: task + ' — ' + duration + ' min abgeschlossen',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'pomodoro-alarm',
      renotify: true,
      requireInteraction: true,
      vibrate: [500,200,500,200,500,200,500,200,500,200,500],
      actions: [{ action: 'stop', title: 'Ausschalten' }],
      silent: false,
      urgency: 'high'
    });
  } catch (err) {
    console.error('Notification error:', err);
  }

  self._alarmRepeat = setInterval(async () => {
    try {
      await self.registration.showNotification('🔔 Pomodoro fertig!', {
        body: task + ' — Zeit ist um!',
        icon: './icon-192.png',
        tag: 'pomodoro-alarm',
        renotify: true,
        requireInteraction: true,
        vibrate: [500,200,500,200,500,200,500],
        actions: [{ action: 'stop', title: 'Ausschalten' }],
        silent: false,
        urgency: 'high'
      });
    } catch (err) {}
  }, 8000);

  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(client => client.postMessage({ type: 'ALARM_FIRED' }));
}


self.addEventListener('notificationclick', e => {
  const tag = e.notification.tag;
  e.notification.close();

  if (tag === 'pomodoro-alarm') {
    clearInterval(self._alarmRepeat);
    alarmActive = false;
    timerState = null;

    e.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'ALARM_STOPPED' }));
        if (clients.length > 0) {
          clients[0].focus();
        } else {
          self.clients.openWindow('./index.html');
        }
      })
    );
  }

  // Location tracking or idle nag notification — just focus the app
  if (tag === 'loc-tracking' || tag === 'idle-nag') {
    e.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients => {
        if (clients.length > 0) {
          clients[0].focus();
        } else {
          self.clients.openWindow('./index.html');
        }
      })
    );
  }

});

self.addEventListener('notificationclose', e => {
  const tag = e.notification.tag;

  if (tag === 'pomodoro-alarm') {
    if (!alarmActive) return;

    setTimeout(() => {
      if (!alarmActive) return;
      if (!self._alarmRepeat) return;

      clearInterval(self._alarmRepeat);
      self._alarmRepeat = null;
      alarmActive = false;
      timerState = null;

      self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'ALARM_STOPPED' }));
      });
    }, 500);
  }
});
