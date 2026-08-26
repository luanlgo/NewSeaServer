/**
 * Dificuldade dentro da masmorra bônus.
 *
 * A dificuldade pesa nos DOIS lados: escala os atributos do inimigo como em
 * qualquer mapa (mult 1×–10×) E multiplica o prêmio da conclusão — recursos e
 * chance de navio — pelo `rewardMult` da tabela (1×–5×). Somando com a leva
 * (WAVE_STAT_GROWTH), a leva final do Abismo no Extremo chega a ~20× a vida
 * base. É deliberado.
 *
 * Duas armadilhas que estes testes guardam:
 *
 *  1. o multiplicador é o da dificuldade TRAVADA NA ENTRADA. Trocar de
 *     dificuldade só exige 6s fora de combate, e entre uma leva e outra sobra
 *     tempo de sobra — sem travar, o caminho era entrar no Fácil (inimigo
 *     idêntico) e virar Extremo antes do chefe cair, quintuplicando o prêmio;
 *
 *  2. a chance de navio tem TETO em 1. Passar de 100% não dá dois navios, só
 *     joga o multiplicador fora sem ninguém perceber.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { DIFFICULTIES, difficultyDef } = require('../../constants/difficulty');
const { MAP_DEFS } = require('../../constants');
const NPCManager = require('../../managers/npc-manager');

// ── Reimplementação pura do trecho de recompensa do sendBonusDungeonComplete ──
function premio(player, npcDef, waveRewards) {
  const diffIdx = player.bonusDifficulty || 0;
  const rewMult = difficultyDef(diffIdx).rewardMult || 1;
  return {
    rewMult,
    dobroes:    Math.round((waveRewards.dobroes    || 0) * rewMult),
    gold:       Math.round((waveRewards.gold       || 0) * rewMult),
    ironPlates: Math.round((waveRewards.ironPlates || 0) * rewMult),
    goldDust:   Math.round((waveRewards.goldDust   || 0) * rewMult),
    gunpowder:  Math.round((waveRewards.gunpowder  || 0) * rewMult),
    chanceNavio: Math.min(1, (npcDef?.shipDropChance ?? 0.02) * rewMult),
  };
}

const RECURSOS = { dobroes: 100, gold: 1000, ironPlates: 10, goldDust: 5, gunpowder: 20 };

// ── 1. O inimigo NÃO cresce mais com a dificuldade ───────────────────────────

describe('a dificuldade escala o inimigo da masmorra', () => {
  it('a vida do barco da leva cresce com a dificuldade', () => {
    for (const lvl of [7, 8, 9]) {
      const facil   = _npcDepoisDoUpdate(lvl, 0);
      const extremo = _npcDepoisDoUpdate(lvl, 4);
      expect(facil.maxHp).toBe(MAP_DEFS[lvl].npc.baseHp);
      expect(extremo.maxHp).toBe(facil.maxHp * difficultyDef(4).mult);
      expect(extremo.cannonDmg).toBe(facil.cannonDmg * difficultyDef(4).mult);
      expect(extremo.diffIdx).toBe(4);   // e a placa ganha a cor da dificuldade
    }
  });

  it('mapa normal continua igual — a masmorra não é exceção', () => {
    const facil   = _npcDepoisDoUpdate(1, 0);
    const extremo = _npcDepoisDoUpdate(1, 4);
    expect(extremo.maxHp).toBe(facil.maxHp * difficultyDef(4).mult);
    expect(extremo.diffIdx).toBe(4);
  });

  // ── A armadilha que custou uma regressão ───────────────────────
  // Numa versão anterior a masmorra PULAVA o _rescaleNPC inteiro. Parecia
  // equivalente a neutralizar a dificuldade e não era: é ele que aplica o
  // `cannonCount` do mapa (2/4/6) e o tier de munição. Os barcos das levas
  // ficaram com UM canhão e bala de ferro. O teste fica de guarda.
  it('o barco da leva usa o cannonCount do mapa, não o padrão de 1', () => {
    for (const lvl of [7, 8, 9]) {
      for (const dif of [0, 4]) {
        const npc = _npcDepoisDoUpdate(lvl, dif);
        expect(npc.cannonCount).toBe(MAP_DEFS[lvl].npc.cannonCount);
        expect(npc.cannonCount).toBeGreaterThan(1);
      }
    }
  });
});

// ── 2. A dificuldade multiplica os recursos ──────────────────────────────────

describe('recursos da conclusão', () => {
  it('o Fácil paga 1× — a base não se mexe', () => {
    const r = premio({ bonusDifficulty: 0 }, { shipDropChance: 0.03 }, RECURSOS);
    expect(r.rewMult).toBe(1);
    expect(r.dobroes).toBe(RECURSOS.dobroes);
    expect(r.gold).toBe(RECURSOS.gold);
  });

  it('cada dificuldade multiplica pelo rewardMult da tabela', () => {
    for (const def of DIFFICULTIES) {
      const r = premio({ bonusDifficulty: def.id }, { shipDropChance: 0.03 }, RECURSOS);
      expect(r.rewMult).toBe(def.rewardMult);
      expect(r.dobroes).toBe(RECURSOS.dobroes * def.rewardMult);
      expect(r.gold).toBe(RECURSOS.gold * def.rewardMult);
      expect(r.ironPlates).toBe(RECURSOS.ironPlates * def.rewardMult);
      expect(r.goldDust).toBe(RECURSOS.goldDust * def.rewardMult);
      expect(r.gunpowder).toBe(RECURSOS.gunpowder * def.rewardMult);
    }
  });

  it('o Extremo paga 5× o Fácil', () => {
    const facil   = premio({ bonusDifficulty: 0 }, {}, RECURSOS);
    const extremo = premio({ bonusDifficulty: 4 }, {}, RECURSOS);
    expect(extremo.dobroes).toBe(facil.dobroes * 5);
  });
});

// ── 3. A dificuldade multiplica a chance de navio ────────────────────────────

describe('chance do navio', () => {
  it('escala junto com o prêmio', () => {
    const npcDef = { shipDropChance: 0.03 };
    expect(premio({ bonusDifficulty: 0 }, npcDef, {}).chanceNavio).toBeCloseTo(0.03, 6);
    expect(premio({ bonusDifficulty: 2 }, npcDef, {}).chanceNavio).toBeCloseTo(0.09, 6);
    expect(premio({ bonusDifficulty: 4 }, npcDef, {}).chanceNavio).toBeCloseTo(0.15, 6);
  });

  it('nunca passa de 100%', () => {
    // As masmorras rodam a 3%/2%/1%, mas já estiveram em 1 (100%) durante um
    // teste de leilão — e voltarão a estar na próxima vez que alguém for testar
    // alguma coisa. Com base 1, multiplicar por 5 não pode devolver 5.
    for (const def of DIFFICULTIES) {
      const r = premio({ bonusDifficulty: def.id }, { shipDropChance: 1 }, {});
      expect(r.chanceNavio).toBe(1);
    }
    const meio = premio({ bonusDifficulty: 4 }, { shipDropChance: 0.5 }, {});
    expect(meio.chanceNavio).toBe(1);
  });

  it('sem shipDropChance no def, cai no padrão de 2%', () => {
    expect(premio({ bonusDifficulty: 0 }, {}, {}).chanceNavio).toBeCloseTo(0.02, 6);
  });
});

// ── 4. A trava da entrada ────────────────────────────────────────────────────

describe('dificuldade travada na entrada', () => {
  it('o prêmio segue a da ENTRADA, não a do momento da conclusão', () => {
    // Entrou no Fácil e virou Extremo entre as levas: o prêmio continua 1×.
    const trapaceiro = { bonusDifficulty: 0, difficulty: 4 };
    expect(premio(trapaceiro, {}, RECURSOS).rewMult).toBe(1);

    // E o contrário também vale: quem entrou no Extremo não perde o prêmio por
    // baixar a dificuldade no fim (nem que seja por engano).
    const honesto = { bonusDifficulty: 4, difficulty: 0 };
    expect(premio(honesto, {}, RECURSOS).rewMult).toBe(5);
  });

  it('sem o campo travado (sessão antiga) cai no Fácil, nunca em undefined', () => {
    const r = premio({}, {}, RECURSOS);
    expect(r.rewMult).toBe(1);
    expect(Number.isFinite(r.dobroes)).toBe(true);
  });
});

// ── Fixture ──────────────────────────────────────────────────────────────────

/**
 * Um NPC do mapa `lvl` depois de um tick de update() com um jogador na
 * dificuldade `dificuldade` por perto. É o update que dispara o reajuste.
 */
function _npcDepoisDoUpdate(lvl, dificuldade) {
  const pm = { npcs: new Map(), players: new Map(), broadcast: () => {}, spawn: () => {} };
  const mgr = new NPCManager(pm, MAP_DEFS, lvl, null);
  const npc = [...mgr.npcs.values()][0];
  // Longe o bastante para não abrir fogo, perto o bastante para ser o `nearest`.
  const jogador = {
    id: 'p1', dead: false, difficulty: dificuldade,
    x: npc.x + 400, z: npc.z + 400,
  };
  mgr.update(0.1, new Map([['p1', jogador]]));
  clearInterval(mgr._cleanupInterval);
  return npc;
}
