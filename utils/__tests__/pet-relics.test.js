/**
 * As 20 relíquias do bestiário liberadas para o PET (2026-09-04).
 *
 * O que faz elas caberem num branch só: todas compartilham `effect:
 * 'monster_skill'` e rodam no MonsterSkillManager, o mesmo motor da mão do
 * jogador. O que faz o critério ser duro é o contrário — o servidor NÃO SABE
 * ONDE O PET ESTÁ (a posição é do cliente), então nada que nasça no lançador
 * pode entrar: sairia do NAVIO em vez do bicho.
 *
 * E o dano do pet virou dano de SUPORTE (decisão do Luang: "não é para sair
 * explodindo todo mundo"). Antes um lendário nível 10 batia ×1,74 — mais forte
 * que o próprio dono com a mesma relíquia.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const MonsterSkillManager = require('../../managers/monster-skill-manager.js');
const { RELIC_DEFS } = require('../../constants/relics.js');
const { MONSTER_RELIC_DEFS, PET_RELIC_IDS } = require('../../constants/monster_skills.js');

const MAP = 1;

function fazerJogador(x = 0, z = 0) {
  return { id: 'p1', x, z, hp: 1e5, maxHp: 1e5, mapLevel: MAP, dead: false,
           rotation: 0, cannonDamage: 100, cannonCount: 4, cannonRange: 120 };
}
function fazerNpc(id, x, z) {
  return { id, x, z, hp: 1e9, maxHp: 1e9, mapLevel: MAP, dead: false };
}
function fazerMotor(npcs = []) {
  const eventos = [];
  const msm = new MonsterSkillManager({
    projectileManager: { npcs: new Map(npcs.map(n => [n.id, n])) },
    players: new Map(),
    wallManager: { addWall: () => {} },
    addEvent: (e) => eventos.push(e),
    sendTo: () => {},
    // Poder de fogo fixo: 1 ponto por `damagePct`, para o dano sair legível.
    relicDamageFor: (_p, d) => Math.max(1, Math.round((d.damagePct || 0) * 1000)),
    relicCanHitPlayer: () => false,
    grantSkillXp: () => {},
    getMapManagerFor: () => null,
    onNpcDamaged: () => {},
    clampToMap: () => {},
  });
  return { msm, eventos };
}
const dano = (ev) => ev.filter(e => e.type === 'monster_skill_strike')
  .flatMap(e => e.hits || []).reduce((s, h) => s + (h.dmg || 0), 0);

/** Cópia do `petScaledRelic` do server.js — as três frações que o motor lê. */
function petScaledRelic(def, mult) {
  const out = { ...def };
  if (out.damagePct) out.damagePct *= mult;
  if (out.burstPct)  out.burstPct  *= mult;
  if (out.ticks && out.ticks.pct != null) {
    out.ticks = { ...out.ticks, pct: out.ticks.pct * mult };
  }
  return out;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// ═════════════════════════════════════════════════════════════════════════════
describe('quais entram', () => {
  it('são 19, e todas existem', () => {
    // Eram 20 até 2026-09-06, quando a Bocarra Torácica saiu: ela resolve em
    // volta do lançador (`atCaster`), e o teste logo abaixo é justamente o que
    // proíbe isso — ela só passava porque o dado não declarava a marca.
    expect(PET_RELIC_IDS.size).toBe(19);
    for (const id of PET_RELIC_IDS) {
      expect(MONSTER_RELIC_DEFS[id], `${id} não existe`).toBeDefined();
    }
  });

  it('nenhuma delas nasce no lançador — o servidor não sabe onde o pet está', () => {
    for (const id of PET_RELIC_IDS) {
      const d = MONSTER_RELIC_DEFS[id];
      const porque = [];
      if (d.follow) porque.push('canalizada');
      if (d.atCaster) porque.push('atCaster');
      if (d.dash) porque.push('dash');
      if (['cone', 'line', 'rays'].includes(d.shape)) porque.push(`shape ${d.shape}`);
      if (d.targetMode) porque.push('targetMode');
      if (d.summonMode === 'escort') porque.push('escolta (usa o dano do DONO)');
      expect(porque, `${id} (${d.name}) sairia do NAVIO: ${porque.join(', ')}`)
        .toEqual([]);
    }
  });

  it('todas machucam — relíquia de pet sem dano não teria o que decidir', () => {
    for (const id of PET_RELIC_IDS) {
      const d = MONSTER_RELIC_DEFS[id];
      const temDano = (d.damagePct || 0) > 0 || (d.ticks && d.ticks.pct > 0);
      expect(temDano, `${id} (${d.name}) não causa dano`).toBe(true);
    }
  });

  it('a marca chega no RELIC_DEFS final, com alvo e alcance', () => {
    // Sem os TRÊS campos o cliente cai no default e o pet mira errado — e o
    // `relic_stats.gd` (gerado) é a única fonte que ele tem.
    for (const id of PET_RELIC_IDS) {
      const d = RELIC_DEFS[id];
      expect(d.petUsable, `${id} sem petUsable`).toBe(true);
      expect(d.petTarget, `${id} sem petTarget`).toBe('inimigo');
      expect(d.petRange, `${id} sem petRange`).toBeTruthy();
    }
  });

  it('toda relíquia petUsable do jogo tem alvo e alcance', () => {
    for (const [id, d] of Object.entries(RELIC_DEFS)) {
      if (!d.petUsable) continue;
      expect(d.petTarget, `${id} sem petTarget`).toBeTruthy();
      expect(d.petRange, `${id} sem petRange`).toBeTruthy();
    }
  });

  it('as desativadas ficam de fora', () => {
    for (const id of PET_RELIC_IDS) {
      expect(MONSTER_RELIC_DEFS[id].disabled, `${id} está desativada`).toBe(false);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('o dano do pet é de SUPORTE', () => {
  it('a escala derruba as três frações que o motor lê', () => {
    const cru = { damagePct: 1.0, burstPct: 0.5, ticks: { count: 3, pct: 0.2 } };
    const pet = petScaledRelic(cru, 0.4);
    expect(pet.damagePct).toBeCloseTo(0.4);
    expect(pet.burstPct).toBeCloseTo(0.2);
    expect(pet.ticks.pct).toBeCloseTo(0.08);
    // E não estraga o original — o dono continua com o dano dele.
    expect(cru.damagePct).toBe(1.0);
    expect(cru.ticks.pct).toBe(0.2);
  });

  it('o dano SAI menor de verdade, não só no dado', () => {
    // Rugido Dilacerante: anel com MIOLO SEGURO, entao o alvo tem de ficar entre
    // o safeRadius (20) e o radius (90) — em cima do 20 o teste mediria zero.
    const def = RELIC_DEFS.r21;
    const alvo1 = fazerNpc('a', 0, 40);
    const m1 = fazerMotor([alvo1]);
    m1.msm.cast(fazerJogador(), def, 0, 0, {});
    vi.runAllTimers();

    const alvo2 = fazerNpc('a', 0, 40);
    const m2 = fazerMotor([alvo2]);
    m2.msm.cast(fazerJogador(), petScaledRelic(def, 0.4), 0, 0, {});
    vi.runAllTimers();

    expect(dano(m1.eventos)).toBeGreaterThan(0);
    expect(dano(m2.eventos) / dano(m1.eventos)).toBeCloseTo(0.4, 1);
  });

  it('vale também nas de LEVAS, onde o pct mora dentro de ticks', () => {
    // Vortice da Bocarra: circulo com levas, e o `ticks.pct` SUBSTITUI o
    // damagePct em todas elas. As `multi` nao servem aqui — as sub-areas sao
    // sorteadas num anel e deixam um buraco no meio, entao o alvo do teste
    // ficaria fora por acidente.
    const def = RELIC_DEFS.r27;
    expect(def.ticks.pct).toBeGreaterThan(0);
    const alvo1 = fazerNpc('a', 0, 10);
    const m1 = fazerMotor([alvo1]);
    m1.msm.cast(fazerJogador(), def, 0, 0, {});
    vi.runAllTimers();

    const alvo2 = fazerNpc('a', 0, 10);
    const m2 = fazerMotor([alvo2]);
    m2.msm.cast(fazerJogador(), petScaledRelic(def, 0.4), 0, 0, {});
    vi.runAllTimers();

    expect(dano(m1.eventos)).toBeGreaterThan(0);
    expect(dano(m2.eventos) / dano(m1.eventos)).toBeCloseTo(0.4, 1);
  });

  it('o teto do pet fica abaixo do dono', () => {
    // Lendário (0.50) no nível 10 com +2%/nível = 0.59. Se algum dia passar de
    // 1.0, o pet volta a bater mais forte que quem o equipou — que é o que a
    // decisão de 2026-09-04 saiu para impedir.
    const RARITY_DMG_MULT = { 0: 0.25, 1: 0.32, 2: 0.40, 3: 0.50 };
    const LEVEL_DMG_BONUS = 0.02;
    const teto = RARITY_DMG_MULT[3] * (1 + (10 - 1) * LEVEL_DMG_BONUS);
    expect(teto).toBeLessThan(1.0);
    expect(teto).toBeCloseTo(0.59, 2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('o motor aceita as 19 sem tratamento especial', () => {
  it.each([...PET_RELIC_IDS])('%s roda até o fim e não explode', (id) => {
    const alvo = fazerNpc('alvo', 0, 20);
    const { msm, eventos } = fazerMotor([alvo]);
    // Do jeito que o pet manda: alvo no ponto do bicho, payload vazio.
    expect(() => {
      msm.cast(fazerJogador(), petScaledRelic(RELIC_DEFS[id], 0.4), alvo.x, alvo.z, {});
      vi.runAllTimers();
    }).not.toThrow();
    expect(eventos.length, `${id} não emitiu evento nenhum`).toBeGreaterThan(0);
  });
});
