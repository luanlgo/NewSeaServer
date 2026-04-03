// utils/helpers.js
let nextId = 1;
let nextProjId = 1;

module.exports = {
  uid: () => nextId++,
  projUid: () => nextProjId++,
  
  rand: (min, max) => Math.random() * (max - min) + min,
  
  dist2D: (a, b) => Math.hypot(a.x - b.x, a.z - b.z),
  
  clamp: (v, min, max) => Math.max(min, Math.min(max, v)),
  
  broadcast: (wss, data, excludeId = null) => {
    const msg = JSON.stringify(data);
    const MAX_BUFFER = parseInt(process.env.MAX_BUFFER_TO_BROADCST) || 500_000; // 500KB limite

    wss.clients.forEach(ws => {
      if (
        ws.readyState === 1 &&
        ws._playerId !== excludeId &&
        ws.bufferedAmount < MAX_BUFFER
      ) {
        ws.send(msg);
      }
    });
  },
  
  sendTo: (ws, data) => {
    const MAX_BUFFER = parseInt(process.env.MAX_BUFFER) || 1_000_000; // 1MB default
    if (ws.readyState === ws.OPEN && ws.bufferedAmount < MAX_BUFFER) {
      ws.send(JSON.stringify(data));
    }
  }
};