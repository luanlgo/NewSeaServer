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
    if (!ws) return;
    const MAX_BUFFER = parseInt(process.env.MAX_BUFFER) || 1_000_000; // 1MB default
    if (ws.readyState === ws.OPEN && ws.bufferedAmount < MAX_BUFFER) {
      ws.send(JSON.stringify(data));
    }
  },

  // Envia uma string JÁ serializada. Existe para o broadcast de estado: quando a
  // mesma mensagem vai para N jogadores, serializar uma vez e reusar economiza
  // N-1 JSON.stringify. Com 200 jogadores num mapa isso media 51% de um core
  // contra 0,3% — é a diferença entre o servidor rodar e não rodar.
  sendRaw: (ws, str) => {
    if (!ws) return;
    const MAX_BUFFER = parseInt(process.env.MAX_BUFFER) || 1_000_000;
    if (ws.readyState === ws.OPEN && ws.bufferedAmount < MAX_BUFFER) {
      ws.send(str);
    }
  }
};