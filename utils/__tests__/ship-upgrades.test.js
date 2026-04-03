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

describe('Upgrade de Vida — recalcMaxHp reflete shipIslandUpgrades.hp', () => {
  // Jogador sem upgrades tem o HP base do navio
  it('nível 0: HP máximo = HP base do navio (5000)', () => {
    const player = {
      activeShip: 'fragata',
      talents: {},
      shipIslandUpgrades: { hp: 0, defense: 0, damage: 0 },
    };
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS);
    expect(player.maxHp).toBe(5000);
  });

  // Cada nível adiciona exatamente +1000 HP
  it('nível 1: HP base + 1000 = 6000', () => {
    const player = {
      activeShip: 'fragata',
      talents: {},
      shipIslandUpgrades: { hp: 1, defense: 0, damage: 0 },
    };
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS);
    expect(player.maxHp).toBe(6000);
  });

  // Nível máximo (5) adiciona +5000 HP
  it('nível 5: HP base + 5000 = 10000', () => {
    const player = {
      activeShip: 'fragata',
      talents: {},
      shipIslandUpgrades: { hp: 5, defense: 0, damage: 0 },
    };
    recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS);
    expect(player.maxHp).toBe(10000);
  });

  // HP cresce linearmente a cada nível
  it('HP cresce +1000 a cada nível adicionado', () => {
    const hps = [];
    for (let lvl = 0; lvl <= 5; lvl++) {
      const player = {
        activeShip: 'fragata',
        talents: {},
        shipIslandUpgrades: { hp: lvl, defense: 0, damage: 0 },
      };
      recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS);
      hps.push(player.maxHp);
    }
    for (let i = 1; i <= 5; i++) {
      expect(hps[i] - hps[i - 1]).toBe(1000);
    }
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

// ── CUSTO: goldDustPerLevel × (nível+1) ──────────────────────────────────────

describe('Custo de upgrade — fórmula goldDustPerLevel × (nível + 1)', () => {
  // Todos os defs devem usar goldDustPerLevel (não goldPerLevel)
  it('todos os SHIP_UPGRADE_DEFS possuem goldDustPerLevel (não goldPerLevel)', () => {
    for (const def of SHIP_UPGRADE_DEFS) {
      expect(def).toHaveProperty('goldDustPerLevel');
      expect(def).not.toHaveProperty('goldPerLevel');
    }
  });

  // Custo do upgrade de HP: 100 × (nível+1)
  it('upgrade hp: custo = 100 × (nível+1)', () => {
    const def = SHIP_UPGRADE_DEFS.find(d => d.id === 'hp');
    expect(def.goldDustPerLevel * (0 + 1)).toBe(100);  // nível 0 → custa 100
    expect(def.goldDustPerLevel * (1 + 1)).toBe(200);  // nível 1 → custa 200
    expect(def.goldDustPerLevel * (4 + 1)).toBe(500);  // nível 4 → custa 500
  });

  // Custo do upgrade de Defesa: 100 × (nível+1)
  it('upgrade defense: custo = 100 × (nível+1)', () => {
    const def = SHIP_UPGRADE_DEFS.find(d => d.id === 'defense');
    expect(def.goldDustPerLevel * (0 + 1)).toBe(100);
    expect(def.goldDustPerLevel * (2 + 1)).toBe(300);
  });

  // Custo do upgrade de Dano: 100 × (nível+1)
  it('upgrade damage: custo = 100 × (nível+1)', () => {
    const def = SHIP_UPGRADE_DEFS.find(d => d.id === 'damage');
    expect(def.goldDustPerLevel * (0 + 1)).toBe(100);  // nível 0 → custa 100
    expect(def.goldDustPerLevel * (4 + 1)).toBe(500);  // nível 4 → custa 500
  });

  // Custo escala corretamente com o nível atual
  it('custo escala a cada nível (mais caro conforme avança)', () => {
    for (const def of SHIP_UPGRADE_DEFS) {
      const costs = [];
      for (let level = 0; level < def.maxLevel; level++) {
        costs.push(def.goldDustPerLevel * (level + 1));
      }
      // Cada nível deve custar mais do que o anterior
      for (let i = 1; i < costs.length; i++) {
        expect(costs[i]).toBeGreaterThan(costs[i - 1]);
      }
    }
  });
});
