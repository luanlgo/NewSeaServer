// constants/cannons.js — Canhões, munições, velas e custos de pesquisa

// ── CANNON_DEFS ───────────────────────────────────────────────────────────────
const CANNON_DEFS = {
  c1: { name: 'Canhão enferrujado',                  price: 59,   currency: 'gold',   damage: 10, range: 80,  cooldown: 5000, lifesteal: 0,   doubleShot: false },
  c2: { name: 'Canhão do marinheiro',                price: 150,  currency: 'gold',   damage: 14, range: 100, cooldown: 4500, lifesteal: 0,   doubleShot: false },
  c3: { name: 'Canhão da tempestade de ferro',       price: 500,  currency: 'gold',   damage: 18, range: 120, cooldown: 4000, lifesteal: 0,   doubleShot: false },
  c4: { name: 'Quebrador de Leviatãs',               price: 1000, currency: 'gold',   damage: 20, range: 120, cooldown: 3200, lifesteal: 0.1, doubleShot: false },
  // Elite — vendidos apenas na Ilha do Comércio (Mapa 3)
  c5: { name: 'Canhão Duplo do fogo abissal', price: 300,  currency: 'dobrao', damage: 10, range: 120, cooldown: 3000, lifesteal: 0.2, doubleShot: true, isElite: true },
  c6: { name: 'Ruína dos Sete Mares Duplo',   price: 2000, currency: 'dobrao', damage: 20, range: 150, cooldown: 3000, lifesteal: 0.3, doubleShot: true, isElite: true },
};

// ── AMMO_DEFS ─────────────────────────────────────────────────────────────────
const AMMO_DEFS = {
  bala_ferro:      { damage: 5,  slow: 0,    slowDur: 0,    dotDmg: 0, dotTick: 0,   dotDur: 0,    stunChance: 0, stunDur: 0 },
  bala_perfurante: { damage: 8,  slow: 0,    slowDur: 0,    dotDmg: 0, dotTick: 0,   dotDur: 0,    stunChance: 0, stunDur: 0, piercing: true },
  bala_gelo:       { damage: 12, slow: 0.40, slowDur: 2000, dotDmg: 0, dotTick: 0,   dotDur: 0,    stunChance: 0, stunDur: 0 },
  bala_fogo:       { damage: 15, slow: 0,    slowDur: 0,    dotDmg: 1, dotTick: 500, dotDur: 3000, stunChance: 0, stunDur: 0 },
  bala_luz:        { damage: 15, slow: 0,    slowDur: 0,    dotDmg: 0, dotTick: 0,   dotDur: 0,    stunChance: 3, stunDur: 3000 },
  bala_sangue:     { damage: 17, slow: 0,    slowDur: 0,    dotDmg: 2, dotTick: 500, dotDur: 3000, stunChance: 0, stunDur: 0 },
  bala_cura:       { damage: 0,  slow: 0,    slowDur: 0,    dotDmg: 0, dotTick: 0,   dotDur: 0,    stunChance: 0, stunDur: 0, isHeal: true, healAmount: 5 },
};

// ── SAIL_DEFS ─────────────────────────────────────────────────────────────────
const SAIL_DEFS = {
  vela_quadrada: { name: 'Vela Quadrada', price: 200,  currency: 'gold',   speedBonus: 0.1, accelBonus: 0.005 },
  vela_estai:    { name: 'Vela de Estai', price: 400,  currency: 'gold',   speedBonus: 0.2, accelBonus: 0.010 },
  vela_latina:   { name: 'Vela Latina',   price: 150,  currency: 'dobrao', speedBonus: 0.3, accelBonus: 0.015 },
};

// ── CANNON_RESEARCH_COSTS — custo por nível de pesquisa ──────────────────────
const CANNON_RESEARCH_COSTS = [
  { ironPlates: 10, gold:    100000 }, // nível 1
  { ironPlates: 20, dobroes:   5000 }, // nível 2
  { ironPlates: 30, dobroes:  10000 }, // nível 3
];

module.exports = { CANNON_DEFS, AMMO_DEFS, SAIL_DEFS, CANNON_RESEARCH_COSTS };
