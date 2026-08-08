/**
 * Testes dos bichos pacíficos dos mapas de tutorial (1 e 2)
 *
 * Regra pedida: nos mapas 1 e 2 nada é hostil — o bicho só ataca depois de
 * apanhar. E se o jogador MORRE, ele volta a ser ignorado até atacar de novo.
 * Vale para bicho comum e boss.
 *
 * Antes disto `retaliateOnly` existia só para BOSS; os bichos comuns caçavam
 * por proximidade desde o spawn.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const NPCManager = require('../../managers/npc-manager.js');
const { MAP_DEFS } = require('../../constants/index.js');

function makeManager(mapLevel) {
  const attackManager = { tryAttack: vi.fn(), tickAuras: vi.fn() };
  const projectileManager = { spawn: vi.fn() };
  const m = new NPCManager(projectileManager, MAP_DEFS, mapLevel, attackManager);
  return { m, attackManager };
}

/** Põe o jogador colado no bicho e roda um tique. */
function tick(m, npc, player) {
  player.x = npc.x + 20;
  player.z = npc.z;
  m.update(0.1, new Map([[player.id, player]]));
}

/**
 * Provoca o bicho e roda até ele estar de fato engajado.
 * São dois tiques porque a checagem de dano roda DEPOIS da escolha de alvo: o
 * tique que acorda o bicho ainda está sem alvo, e ele engaja no seguinte (~16 ms).
 */
function provocar(m, npc, player) {
  // O carimbo tem que ser ESTRITAMENTE posterior ao último já conferido: o teste
  // inteiro roda dentro do mesmo milissegundo, então `Date.now()` puro repetia o
  // valor do reset e o gatilho (`dmgT > _lastCheckedDmgTime`) não disparava. Um
  // tiro de verdade nunca cai no mesmo ms em que o bicho acabou de dormir.
  npc.lastDamageTime = Math.max(Date.now(), (npc._lastCheckedDmgTime || 0) + 1);
  tick(m, npc, player);      // acorda
  tick(m, npc, player);      // escolhe alvo e engaja
}

function makePlayer(over = {}) {
  return {
    id: 'p1', x: 0, z: 0, hp: 5000, maxHp: 5000, mapLevel: 1,
    dead: false, isPeaceful: false, difficulty: 0, ...over,
  };
}

describe('dado dos mapas', () => {
  it('mapas 1 e 2 marcam os bichos como `retaliateOnly`', () => {
    expect(MAP_DEFS[1].npc.retaliateOnly).toBe(true);
    expect(MAP_DEFS[2].npc.retaliateOnly).toBe(true);
  });

  it('o boss desses mapas já era assim (regra igual para os dois)', () => {
    expect(MAP_DEFS[1].boss.retaliateOnly).toBe(true);
    expect(MAP_DEFS[2].boss.retaliateOnly).toBe(true);
  });

  it('mapa 3 em diante segue hostil', () => {
    expect(MAP_DEFS[3].npc.retaliateOnly).toBeFalsy();
  });
});

describe('bicho de tutorial', () => {
  let m, attackManager, npc, player;

  beforeEach(() => {
    ({ m, attackManager } = makeManager(1));
    npc = [...m.npcs.values()][0];
    player = makePlayer();
  });

  it('nasce dormindo', () => {
    expect(npc.retaliateOnly).toBe(true);
    expect(npc.aggroState).toBe('passive');
    for (const n of m.npcs.values()) expect(n.aggroState).toBe('passive');
  });

  it('passar do lado NÃO inicia combate', () => {
    for (let i = 0; i < 20; i++) tick(m, npc, player);
    expect(attackManager.tryAttack).not.toHaveBeenCalled();
    expect(npc.targetId).toBeNull();
    expect(npc.aggroState).toBe('passive');
  });

  it('acorda ao levar dano e passa a atacar', () => {
    tick(m, npc, player);
    expect(attackManager.tryAttack).not.toHaveBeenCalled();

    npc.lastDamageTime = Date.now();          // o jogador acertou
    tick(m, npc, player);
    expect(npc.aggroState).toBe('aggressive');

    // O engajamento entra no tique SEGUINTE: a checagem de dano roda depois da
    // escolha de alvo, então o tique que acorda o bicho ainda está sem alvo.
    // São ~16 ms — a mesma ordem que o boss já usava.
    tick(m, npc, player);
    expect(attackManager.tryAttack).toHaveBeenCalled();
  });

  it('quando o agressor MORRE, volta a dormir', () => {
    provocar(m, npc, player);
    expect(npc.aggroState).toBe('aggressive');
    expect(npc.targetId).toBe(player.id);

    player.dead = true;
    tick(m, npc, player);

    expect(npc.aggroState).toBe('passive');
    expect(npc.targetId).toBeNull();
  });

  it('depois de renascer, é ignorado até atacar de novo', () => {
    provocar(m, npc, player);
    player.dead = true;
    tick(m, npc, player);

    // Renasceu e voltou a navegar colado no bicho, sem atirar.
    player.dead = false;
    attackManager.tryAttack.mockClear();
    for (let i = 0; i < 20; i++) tick(m, npc, player);

    expect(npc.aggroState).toBe('passive');
    expect(attackManager.tryAttack).not.toHaveBeenCalled();

    // ...e volta a apanhar assim que ele atira de novo.
    provocar(m, npc, player);
    expect(npc.aggroState).toBe('aggressive');
    expect(attackManager.tryAttack).toHaveBeenCalled();
  });

  it('o dano ANTIGO não reacorda o bicho depois do reset', () => {
    provocar(m, npc, player);
    player.dead = true;
    tick(m, npc, player);
    player.dead = false;

    // `lastDamageTime` continua preenchido do combate anterior — o reset
    // sincroniza o relógio, senão o bicho reacordava sozinho no tique seguinte.
    for (let i = 0; i < 10; i++) tick(m, npc, player);
    expect(npc.aggroState).toBe('passive');
  });
});

describe('mapas normais não mudaram', () => {
  it('bicho do mapa 3 nasce hostil e engaja sem apanhar', () => {
    const { m, attackManager } = makeManager(3);
    const npc = [...m.npcs.values()][0];
    const player = makePlayer({ mapLevel: 3 });

    expect(npc.aggroState).toBe('aggressive');
    expect(npc.retaliateOnly).toBe(false);

    for (let i = 0; i < 5; i++) tick(m, npc, player);
    expect(attackManager.tryAttack).toHaveBeenCalled();
  });
});
