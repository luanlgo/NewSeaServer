#!/usr/bin/env node
// scripts/bench-broadcast.js — Mede o custo do broadcast de estado sem precisar
// de banco nem de cliente. Compara os três caminhos no MESMO mundo sintético:
//
//   1. legado  — lista completa do mapa, um JSON.stringify POR JOGADOR
//                (o que o servidor fazia antes)
//   2. legado+ — lista completa, mas serializada UMA VEZ por mapa
//                (é o que sobra com AOI_ENABLED=0)
//   3. AOI     — interest management + slim + dirty (utils/state-builder.js)
//
// Uso:
//   node scripts/bench-broadcast.js              # 200 jogadores, mapa 2400
//   node scripts/bench-broadcast.js 300 4800     # jogadores, tamanho do mapa
'use strict';

const stateBuilder = require('../utils/state-builder');

const N_PLAYERS = parseInt(process.argv[2], 10) || 200;
const MAP_SIZE  = parseInt(process.argv[3], 10) || 2400;
const N_NPCS    = 20;
const HZ        = 10;   // frequência do broadcast de estado
const FRAMES    = 100;  // 10 s de simulação

const rnd = (a, b) => Math.random() * (b - a) + a;
const half = MAP_SIZE / 2;

// ── Mundo sintético ───────────────────────────────────────────────────────────
// Mistura de barcos em movimento e parados, que é o que se vê num porto: a
// maioria ancorada e uma fração navegando. A proporção importa muito para o
// caminho 3, que é o único que sabe calar a boca sobre quem não mudou.
const MOVING_PCT = 0.4;

const world = [];
for (let i = 1; i <= N_PLAYERS; i++) {
  world.push({
    kind: 'player', id: i, name: 'Capitao' + i,
    x: rnd(-half, half), z: rnd(-half, half),
    vx: 0, vz: 0, moving: Math.random() < MOVING_PCT,
    hp: 4200, maxHp: 5000, rotation: rnd(-3.14, 3.14),
    cannonCooldown: 0,
  });
}
for (let i = 0; i < N_NPCS; i++) {
  world.push({
    kind: 'npc', id: 9000 + i, name: 'Navio Fantasma',
    x: rnd(-half, half), z: rnd(-half, half),
    vx: 0, vz: 0, moving: true,
    hp: 800, maxHp: 1200, rotation: rnd(-3.14, 3.14),
  });
}

function step() {
  for (const e of world) {
    if (!e.moving) continue;
    if (Math.random() < 0.05) { e.vx = rnd(-1.5, 1.5); e.vz = rnd(-1.5, 1.5); }
    e.x = Math.max(-half, Math.min(half, e.x + e.vx));
    e.z = Math.max(-half, Math.min(half, e.z + e.vz));
    e.rotation += rnd(-0.05, 0.05);
    if (e.kind === 'player' && e.cannonCooldown > 0) e.cannonCooldown -= 100;
  }
}

// Snapshots no formato real de playerManager/npcManager.
const snapPlayer = e => ({
  id: e.id, name: e.name, x: e.x, y: 0, z: e.z, activeShip: 'fragata',
  rotation: e.rotation, hp: e.hp, maxHp: e.maxHp, speed: e.moving ? 1 : 0,
  dead: false, isPlayer: true, mapLevel: 1,
  cannonCooldown: e.cannonCooldown, cannonCooldownMax: 5000, cannonRange: 80,
});
const snapNpc = e => ({
  id: e.id, name: e.name, x: e.x, y: 0, z: e.z, rotation: e.rotation,
  hp: e.hp, maxHp: e.maxHp, speed: 1, dead: false, isNPC: true, isBoss: false,
  isDungeonBoss: false, isWorldBoss: false, isFleetShip: false, rarity: null,
  mapLevel: 1, npcHullColor: '#3a2a1a', npcSailColor: '#eeeeee',
  npcFlagColor: '#aa0000', npcModel: 'ghost_ship', npcScale: 1.2,
  npcYOffset: 0, npcRotOffset: 0, usesCannons: true,
  moveState: 'chase', aggroState: 'aggro',
});
const takeSnapshots = () => world.map(e => (e.kind === 'player' ? snapPlayer(e) : snapNpc(e)));

// ── Execução ──────────────────────────────────────────────────────────────────

function run(label, fn) {
  // Estado limpo entre os caminhos — o dirty-check é global por módulo.
  stateBuilder._baseline.clear();
  const viewers = world
    .filter(e => e.kind === 'player')
    .map(e => ({ id: e.id, x: e.x, z: e.z, mapLevel: 1 }));

  let bytes = 0, msgs = 0;
  const t0 = process.hrtime.bigint();
  for (let f = 0; f < FRAMES; f++) {
    step();
    const snaps = takeSnapshots();
    // Viewers acompanham a posição do próprio barco
    for (const v of viewers) {
      const e = world.find(w => w.id === v.id);
      v.x = e.x; v.z = e.z;
    }
    const res = fn(snaps, viewers);
    bytes += res.bytes;
    msgs  += res.msgs;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const perBroadcast = bytes / FRAMES;
  const cpuPct = (ms / FRAMES) * HZ / 10; // ms por broadcast × 10/s → % de 1 core
  console.log(
    `  ${label.padEnd(9)} ` +
    `${(perBroadcast / 1024).toFixed(0).padStart(6)} KB/broadcast  ` +
    `${(perBroadcast * HZ / 1024 / 1024).toFixed(1).padStart(6)} MB/s  ` +
    `${String(Math.round(msgs / FRAMES)).padStart(4)} msgs  ` +
    `${(bytes / Math.max(1, msgs)).toFixed(0).padStart(6)} B/msg  ` +
    `${cpuPct.toFixed(1).padStart(5)}% CPU`
  );
  return { perBroadcast, cpuPct };
}

console.log(`\n⚓ Broadcast — ${N_PLAYERS} jogadores + ${N_NPCS} NPCs num mapa ${MAP_SIZE}x${MAP_SIZE}`);
console.log(`   ${(MOVING_PCT * 100).toFixed(0)}% em movimento, ${HZ} Hz, raio de AOI ${stateBuilder.AOI_RADIUS}u\n`);

// 1. Legado: mesma mensagem, um stringify por jogador.
const legacy = run('legado', (snaps, viewers) => {
  const msg = { type: 'state', players: snaps.filter(s => s.isPlayer), npcs: snaps.filter(s => s.isNPC), weather: 'clear' };
  let bytes = 0;
  for (let i = 0; i < viewers.length; i++) bytes += Buffer.byteLength(JSON.stringify(msg));
  return { bytes, msgs: viewers.length };
});

// 2. Legado com serialização única por mapa.
const legacyPlus = run('legado+', (snaps, viewers) => {
  const msg = { type: 'state', players: snaps.filter(s => s.isPlayer), npcs: snaps.filter(s => s.isNPC), weather: 'clear' };
  const raw = JSON.stringify(msg);
  const len = Buffer.byteLength(raw);
  return { bytes: len * viewers.length, msgs: viewers.length };
});

// 3. AOI + slim + dirty.
const aoi = run('AOI', (snaps, viewers) => {
  const zone = stateBuilder.buildZone(snaps, 1);
  let bytes = 0, msgs = 0;
  for (const v of viewers) {
    const m = stateBuilder.buildFor(v, zone);
    if (!m) continue;
    m.weather = 'clear';
    bytes += Buffer.byteLength(JSON.stringify(m));
    msgs++;
  }
  return { bytes, msgs };
});

const netGain = legacy.perBroadcast / aoi.perBroadcast;
console.log(`\n  → AOI usa ${netGain.toFixed(0)}x menos rede que o legado` +
            ` (${(100 / netGain).toFixed(1)}% do tráfego original)`);
console.log(`  → ${(aoi.perBroadcast * HZ * 8 / 1e6).toFixed(0)} Mbit/s de upload` +
            ` contra ${(legacy.perBroadcast * HZ * 8 / 1e6).toFixed(0)} Mbit/s\n`);
