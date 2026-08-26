/**
 * Levas (waves) da masmorra bônus.
 *
 * A masmorra deixou de ser "mata 5 barcos e encara o chefe" e passou a ter
 * levas: 5 na primeira masmorra, 7 na segunda, 9 na terceira — e a ÚLTIMA
 * leva é o chefe. Cada leva vem 5% mais forte que a anterior, composto.
 *
 * O ponto delicado, e a razão principal deste arquivo existir: o crescimento
 * pode encher o chefe de vida para a briga, mas NÃO pode encostar no navio que
 * ele dropa. Os dois números saem do mesmo `npcDef.stats.hpMin/hpMax` — é a
 * armadilha que estes testes guardam. Se alguém um dia "simplificar" mutando o
 * npcDef antes de spawnar, o prêmio da masmorra 3 dobraria em silêncio.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const {
  BONUS_NPC_DEFS,
  DUNGEON_WAVES,
  WAVE_STAT_GROWTH,
  waveStatMult,
  dungeonWaveCount,
  rollBonusShip,
} = require('../../constants/bonus_dungeons');

const NPCManager = require('../../managers/npc-manager');
const { MAP_DEFS } = require('../../constants');

// O manager sobe um setInterval de limpeza a cada 30 s — sem timer falso o
// vitest fica preso esperando o processo esvaziar.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Manager de mapa bônus sem projéteis nem ataques (nada aqui os usa). */
function mgrDaMasmorra(mapLevel) {
  const pm = { npcs: new Map(), players: new Map(), broadcast: () => {} };
  return new NPCManager(pm, MAP_DEFS, mapLevel, null);
}

// ── 1. Quantidade de levas ────────────────────────────────────────────────────

describe('quantas levas cada masmorra tem', () => {
  it('5 / 7 / 9, na ordem das masmorras', () => {
    expect(DUNGEON_WAVES.bonus_map_1).toBe(5);
    expect(DUNGEON_WAVES.bonus_map_2).toBe(7);
    expect(DUNGEON_WAVES.bonus_map_3).toBe(9);
  });

  it('id desconhecido cai em 1 leva (só o chefe), nunca em 0', () => {
    expect(dungeonWaveCount('nao_existe')).toBe(1);
    expect(dungeonWaveCount(undefined)).toBe(1);
  });

  it('a última leva é o CHEFE — as de barcos são as anteriores', () => {
    // O laço do server.js manda a próxima leva enquanto `proxima < _waveTotal`;
    // ao chegar em `_waveTotal` ele spawna o chefe. Logo: N-1 levas de barcos.
    for (const [id, total] of Object.entries(DUNGEON_WAVES)) {
      const levasDeBarco = total - 1;
      expect(levasDeBarco).toBeGreaterThan(0);
      expect(levasDeBarco + 1).toBe(dungeonWaveCount(id));
    }
  });
});

// ── 2. Crescimento por leva ──────────────────────────────────────────────────

describe('crescimento de status por leva', () => {
  it('a primeira leva não cresce', () => {
    expect(waveStatMult(1)).toBe(1);
  });

  it('cada leva soma WAVE_STAT_GROWTH sobre a anterior (composto)', () => {
    for (let w = 2; w <= 15; w++) {
      expect(waveStatMult(w)).toBeCloseTo(waveStatMult(w - 1) * (1 + WAVE_STAT_GROWTH), 10);
    }
  });

  it('onde o crescimento chega na última leva de cada masmorra', () => {
    expect(waveStatMult(5)).toBeCloseTo(1.216, 3);  // masmorra 1
    expect(waveStatMult(7)).toBeCloseTo(1.340, 3);  // masmorra 2
    expect(waveStatMult(9)).toBeCloseTo(1.477, 3);  // masmorra 3
  });

  it('wave 0 ou negativa não encolhe o NPC', () => {
    expect(waveStatMult(0)).toBe(1);
    expect(waveStatMult(-3)).toBe(1);
  });
});

// ── 3. A leva escala os barcos comuns ────────────────────────────────────────

describe('spawnWave', () => {
  it('multiplica a vida e o dano BASE (é de lá que o rescale de dificuldade parte)', () => {
    const mgr = mgrDaMasmorra(7);
    const base = [...mgr.npcs.values()][0];   // leva 1, nasceu no construtor
    expect(base).toBeTruthy();

    mgr.npcs.clear();
    mgr.spawnWave(waveStatMult(4));
    const leva4 = [...mgr.npcs.values()][0];

    const esperado = Math.round(base.baseHp * waveStatMult(4));
    expect(leva4.baseHp).toBe(esperado);
    expect(leva4.maxHp).toBe(esperado);
    expect(leva4.baseDmg).toBe(Math.round(base.baseDmg * waveStatMult(4)));
    mgr.destroy?.();
  });

  it('mantém o `count` do mapa em toda leva', () => {
    const mgr = mgrDaMasmorra(7);
    const nDaPrimeira = mgr.npcs.size;
    mgr.npcs.clear();
    const n = mgr.spawnWave(waveStatMult(3));
    expect(n).toBe(nDaPrimeira);
    expect(mgr.npcs.size).toBe(nDaPrimeira);
    mgr.destroy?.();
  });

  it('sem multiplicador é idêntico à leva 1', () => {
    const mgr = mgrDaMasmorra(7);
    const base = [...mgr.npcs.values()][0].baseHp;
    mgr.npcs.clear();
    mgr.spawnWave();
    expect([...mgr.npcs.values()][0].baseHp).toBe(base);
    mgr.destroy?.();
  });
});

// ── 4. O chefe cresce, o PRÊMIO não ──────────────────────────────────────────

describe('chefe da última leva', () => {
  const npcDef = BONUS_NPC_DEFS.gigantic_mechanical_pirate_ship;

  it('a vida e o dano do chefe crescem com a leva', () => {
    const mgr  = mgrDaMasmorra(9);
    const mult = waveStatMult(9);

    mgr.spawnWithDef(npcDef, 9, 0, 0);
    const normal = [...mgr.npcs.values()].find(n => n.isDungeonBoss);
    mgr.npcs.delete(normal.id);

    mgr.spawnWithDef(npcDef, 9, 0, 0, mult);
    const forte = [...mgr.npcs.values()].find(n => n.isDungeonBoss);

    expect(forte.maxHp).toBe(Math.round(normal.maxHp * mult));
    expect(forte.cannonDmg).toBe(Math.round(normal.cannonDmg * mult));
    expect(forte.maxHp).toBeGreaterThan(normal.maxHp);
    mgr.destroy?.();
  });

  // ── A trava principal ─────────────────────────────────────────────────────
  it('spawnar o chefe escalado NÃO altera o npcDef (o drop lê ele)', () => {
    const antes = JSON.stringify(npcDef.stats);
    const mgr = mgrDaMasmorra(9);
    mgr.spawnWithDef(npcDef, 9, 0, 0, waveStatMult(9));
    expect(JSON.stringify(npcDef.stats)).toBe(antes);
    mgr.destroy?.();
  });

  it('o navio dropado continua dentro de hpMin..hpMax mesmo na leva 9', () => {
    const mgr = mgrDaMasmorra(9);
    mgr.spawnWithDef(npcDef, 9, 0, 0, waveStatMult(9));
    const { hpMin, hpMax, cannonMin, cannonMax } = npcDef.stats;
    for (let i = 0; i < 200; i++) {
      const navio = rollBonusShip(npcDef);
      expect(navio.hp).toBeGreaterThanOrEqual(hpMin);
      expect(navio.hp).toBeLessThanOrEqual(hpMax);
      expect(navio.cannon).toBeGreaterThanOrEqual(cannonMin);
      expect(navio.cannon).toBeLessThanOrEqual(cannonMax);
    }
    mgr.destroy?.();
  });

  it('o chefe da leva 9 tem MAIS vida que o navio que ele larga', () => {
    // É a leitura de "dificulta a masmorra sem inflar o prêmio": o chefe passa
    // do teto da tabela, o navio não.
    const mgr = mgrDaMasmorra(9);
    mgr.spawnWithDef(npcDef, 9, 0, 0, waveStatMult(9));
    const chefe = [...mgr.npcs.values()].find(n => n.isDungeonBoss);
    expect(chefe.maxHp).toBeGreaterThan(npcDef.stats.hpMax);
    expect(rollBonusShip(npcDef).hp).toBeLessThanOrEqual(npcDef.stats.hpMax);
    mgr.destroy?.();
  });
});
