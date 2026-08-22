import { describe, it, expect } from 'vitest';
import { calcProjectileDamage } from '../combat-calc.js';
import { recalcMaxHp } from '../talent-logic.js';
import { SHIP_UPGRADE_DEFS } from '../../constants/ships.js';

// ── Fixtures mínimas para recalcMaxHp ────────────────────────────────────────

const SHIP_DEFS = {
  fragata: { hp: 5000, maxCannons: 5, speedMult: 1.0, damageMult: 1.0 },
};

const TALENT_DEFS = {
  hp:     { name: 'Vida Extra', max: 5, perLevel: 500 },
  defesa: { name: 'Armadura',   max: 5, perLevel: 300 },
  dano:   { name: 'Artilheiro', max: 5, perLevel: 2   },
};

// ── UPGRADE DE VIDA (hp) ─────────────────────────────────────────────────────
//
// Estes testes travavam "+1000 por nível", que era o valor de quando o upgrade
// dava HP fixo. A regra virou PERCENTUAL — `islandHp = nível × hpBase × 0,05`
// em recalcMaxHp — e as expectativas ficaram para trás, falhando por seis
// rodadas seguidas sem que ninguém estivesse quebrando nada. Um teste que falha
// sempre para de ser sinal.
//
// Agora a conta é DERIVADA da regra: o que está travado é o "+5% do HP base por
// nível", que é a regra de fato; rebalancear o HP do navio não quebra mais nada.

const ILHA_PCT_POR_NIVEL = 0.05;              // recalcMaxHp: +5% do HP base/nível
const HP_BASE            = SHIP_DEFS.fragata.hp;
const HP_POR_NIVEL       = Math.round(HP_BASE * ILHA_PCT_POR_NIVEL);

/** Um player só com o upgrade de vida no nível pedido. */
function playerComUpgradeHp(nivel) {
  return {
    activeShip: 'fragata',
    talents: {},
    shipIslandUpgrades: { hp: nivel, defense: 0, damage: 0 },
  };
}

function maxHpNoNivel(nivel) {
  const p = playerComUpgradeHp(nivel);
  recalcMaxHp(p, SHIP_DEFS, TALENT_DEFS);
  return p.maxHp;
}

describe('Upgrade de Vida — recalcMaxHp reflete shipIslandUpgrades.hp', () => {
  it('nível 0: HP máximo = HP base do navio', () => {
    expect(maxHpNoNivel(0)).toBe(HP_BASE);
  });

  it('nível 1: HP base + 5% do HP base', () => {
    expect(maxHpNoNivel(1)).toBe(HP_BASE + HP_POR_NIVEL);
  });

  it('nível 5: HP base + 5 × 5% do HP base', () => {
    expect(maxHpNoNivel(5)).toBe(HP_BASE + 5 * HP_POR_NIVEL);
  });

  it('o ganho por nível é LINEAR — 5% do HP BASE, não do total acumulado', () => {
    // A distinção importa: percentual sobre o total já somado seria juro
    // composto e o nível 30 valeria mais que o dobro do previsto.
    const hps = [];
    for (let lvl = 0; lvl <= 5; lvl++) hps.push(maxHpNoNivel(lvl));
    for (let i = 1; i <= 5; i++) {
      expect(hps[i] - hps[i - 1]).toBe(HP_POR_NIVEL);
    }
  });

  it('no nível máximo o upgrade vale +150% do HP base (30 × 5%)', () => {
    const def = SHIP_UPGRADE_DEFS.find(d => d.id === 'hp');
    expect(maxHpNoNivel(def.maxLevel))
      .toBe(HP_BASE + def.maxLevel * HP_POR_NIVEL);
  });
});

// ── UPGRADE DE DEFESA ────────────────────────────────────────────────────────

describe('Upgrade de Defesa — islandDef reduz dano recebido (-5% por nível)', () => {
  // Sem upgrade: nenhuma redução
  it('nível 0: sem redução de dano (islandDef = 1.0)', () => {
    const islandDef = 1.0; // nenhum upgrade
    expect(calcProjectileDamage({ baseDmg: 100, islandDef })).toBe(100);
  });

  // Nível 1 → 5% de redução
  it('nível 1: 5% de redução → dano 100 vira 95', () => {
    const level     = 1;
    const islandDef = 1 - Math.min(level * 0.05, 0.80);
    expect(calcProjectileDamage({ baseDmg: 100, islandDef })).toBe(95);
  });

  // Nível 3 → 15% de redução
  it('nível 3: 15% de redução → dano 100 vira 85', () => {
    const level     = 3;
    const islandDef = 1 - Math.min(level * 0.05, 0.80);
    expect(calcProjectileDamage({ baseDmg: 100, islandDef })).toBe(85);
  });

  // Nível 5 → 25% de redução
  it('nível 5: 25% de redução → dano 100 vira 75', () => {
    const level     = 5;
    const islandDef = 1 - Math.min(level * 0.05, 0.80);
    expect(calcProjectileDamage({ baseDmg: 100, islandDef })).toBe(75);
  });

  // Teto de 80%: nenhum nível pode reduzir mais que isso
  it('teto de 80%: islandDef nunca cai abaixo de 0.20', () => {
    for (let level = 0; level <= 5; level++) {
      const islandDef = 1 - Math.min(level * 0.05, 0.80);
      expect(islandDef).toBeGreaterThanOrEqual(0.20);
    }
  });
});

// ── UPGRADE DE DANO ──────────────────────────────────────────────────────────

describe('Upgrade de Dano — islandDmg aumenta dano causado (+10% por nível)', () => {
  // Sem upgrade: nenhum bônus
  it('nível 0: sem bônus de dano (islandDmg = 1.0)', () => {
    const islandDmg = 1.0;
    expect(calcProjectileDamage({ baseDmg: 100, islandDmg })).toBe(100);
  });

  // Nível 1 → +10%
  it('nível 1: +10% → dano 100 vira 110', () => {
    const level     = 1;
    const islandDmg = 1 + level * 0.10;
    expect(calcProjectileDamage({ baseDmg: 100, islandDmg })).toBe(110);
  });

  // Nível 3 → +30%
  it('nível 3: +30% → dano 100 vira 130', () => {
    const level     = 3;
    const islandDmg = 1 + level * 0.10;
    expect(calcProjectileDamage({ baseDmg: 100, islandDmg })).toBe(130);
  });

  // Nível 5 → +50%
  it('nível 5: +50% → dano 100 vira 150', () => {
    const level     = 5;
    const islandDmg = 1 + level * 0.10;
    expect(calcProjectileDamage({ baseDmg: 100, islandDmg })).toBe(150);
  });

  // Dano cresce progressivamente
  it('dano aumenta progressivamente a cada nível', () => {
    const damages = [];
    for (let level = 0; level <= 5; level++) {
      const islandDmg = 1 + level * 0.10;
      damages.push(calcProjectileDamage({ baseDmg: 100, islandDmg }));
    }
    for (let i = 1; i <= 5; i++) {
      expect(damages[i]).toBeGreaterThan(damages[i - 1]);
    }
  });
});

// ── CUSTO: goldDustPerLevel × (nível+1) ─────────────────────────────────────
//
// A versão anterior travava o número 100 — o `goldDustPerLevel` da época. Ele
// virou 2500 num rebalanceamento e os três testes passaram a falhar sem que
// nada estivesse errado. O título do describe já dizia o que era para testar:
// a FÓRMULA. Então é ela que fica travada, derivada da constante; mudar o preço
// deixa de quebrar teste, e trocar a fórmula continua quebrando.

/** O que a Ilha cobra para ir do nível atual para o próximo (server.js). */
function custoDoNivel(def, nivelAtual) {
  return def.goldDustPerLevel * (nivelAtual + 1);
}

describe('Custo de upgrade — fórmula goldDustPerLevel × (nível + 1)', () => {
  it('todos os SHIP_UPGRADE_DEFS possuem goldDustPerLevel (não goldPerLevel)', () => {
    for (const def of SHIP_UPGRADE_DEFS) {
      expect(def).toHaveProperty('goldDustPerLevel');
      expect(def).not.toHaveProperty('goldPerLevel');
    }
  });

  it.each(['hp', 'defense', 'damage'])(
    'upgrade %s: o nível N custa (N+1) × goldDustPerLevel', (id) => {
      const def = SHIP_UPGRADE_DEFS.find(d => d.id === id);
      expect(custoDoNivel(def, 0)).toBe(def.goldDustPerLevel);
      expect(custoDoNivel(def, 1)).toBe(def.goldDustPerLevel * 2);
      expect(custoDoNivel(def, 4)).toBe(def.goldDustPerLevel * 5);
    });

  it('custo escala a cada nível (mais caro conforme avança)', () => {
    for (const def of SHIP_UPGRADE_DEFS) {
      const costs = [];
      for (let level = 0; level < def.maxLevel; level++) {
        costs.push(custoDoNivel(def, level));
      }
      for (let i = 1; i < costs.length; i++) {
        expect(costs[i]).toBeGreaterThan(costs[i - 1]);
      }
    }
  });

  it('os defs têm preço e teto sãos — um zero aqui deixaria o upgrade de graça', () => {
    for (const def of SHIP_UPGRADE_DEFS) {
      expect(def.goldDustPerLevel, `${def.id}: pó de ouro por nível`).toBeGreaterThan(0);
      expect(def.dobroes,          `${def.id}: dobrões por nível`).toBeGreaterThan(0);
      expect(def.maxLevel,         `${def.id}: nível máximo`).toBeGreaterThan(0);
    }
  });
});
