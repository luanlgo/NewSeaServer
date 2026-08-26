// utils/helpers.js
let nextId = 1;
let nextProjId = 1;

// ── Guarda de frame gigante ─────────────────────────────────────────────────
// O cliente Godot fecha a conexão com 1009 "Message too big" quando UM frame
// passa do `inbound_buffer_size` do WebSocketPeer. O default do engine é 65535 B
// e o fecho é MUDO: o Godot não imprime erro e aqui só chega um `close` seco —
// a queda fica invisível nos dois logs (medido, reproduzido com harness).
//
// O cliente já sobe o teto para 1 MB (scripts/network.gd::_do_connect), então
// este aviso existe para pegar a mensagem culpada ANTES de ela chegar perto do
// novo limite, e para não deixar builds antigas caírem sem deixar rastro.
const WS_FRAME_WARN = parseInt(process.env.WS_FRAME_WARN) || 60 * 1024;
const _frameWarned = new Set();

function guardFrame(str, hint) {
  // `str.length` é UTF-16; o frame vai em UTF-8. Só paga o byteLength exato
  // quando já está perto do limite — no caso comum isto é uma comparação de int.
  if (str.length < WS_FRAME_WARN) return str;
  const bytes = Buffer.byteLength(str, 'utf8');
  if (bytes < WS_FRAME_WARN) return str;
  const type = hint || (str.match(/"type"\s*:\s*"([^"]{1,40})"/) || [])[1] || '?';
  // Um balde por tipo e faixa de 64 KB: avisa a cada salto de tamanho sem
  // repetir a mesma linha 10x por segundo.
  const key = type + ':' + (bytes >> 16);
  if (_frameWarned.has(key)) return str;
  _frameWarned.add(key);
  console.warn(`[WS] ⚠ frame gigante: type="${type}" ${bytes} bytes `
    + `(limite de aviso ${WS_FRAME_WARN}). Cliente com inbound_buffer_size menor `
    + `que isso FECHA a conexão com 1009 e sem log.`);
  return str;
}

module.exports = {
  guardFrame,

  /**
   * Marca ouro GANHO EM ABATE para a varredura da guilda.
   *
   * O cofre da guilda recebe uma fatia do ouro que os membros caçam, do mesmo
   * jeito que recebe a fatia do XP (ver GUILD_GOLD_SHARE em constants/guilds.js).
   * Só que ouro, ao contrário de XP, SOBE E DESCE: `player.gold` é saldo, não
   * ganho, e amostrá-lo daria crédito a quem sacou do banco e nada a quem
   * gastou tudo. Este acumulador é a fonte monotônica que faltava — quem paga
   * ouro de abate soma aqui, e o GuildManager LÊ E ZERA na varredura.
   *
   * Um contador solto em vez de uma chamada ao GuildManager de propósito: o
   * projectile-manager e os managers de chefe não precisam conhecer guilda
   * nenhuma para pagar um abate, e um jogador sem guilda só faz um número
   * crescer e ser descartado.
   */
  noteKillGold: (player, gold) => {
    const g = Math.round(Number(gold) || 0);
    if (!player || g <= 0) return;
    player._killGold = (player._killGold || 0) + g;
  },

  uid: () => nextId++,
  projUid: () => nextProjId++,
  
  rand: (min, max) => Math.random() * (max - min) + min,
  
  dist2D: (a, b) => Math.hypot(a.x - b.x, a.z - b.z),
  
  clamp: (v, min, max) => Math.max(min, Math.min(max, v)),
  
  broadcast: (wss, data, excludeId = null) => {
    const msg = guardFrame(JSON.stringify(data), data && data.type);
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
      ws.send(guardFrame(JSON.stringify(data), data && data.type));
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
      ws.send(guardFrame(str));
    }
  }
};