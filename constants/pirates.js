// constants/pirates.js — Tripulação de piratas e seus efeitos

const PIRATE_DEFS = {
  healer:        { healPct: 0.01, healInterval: 500, needsIdle: true, combatCooldown: 10000, homingRadius: 0, homingStrength: 0, critChance: 0 },
  healer_elite:  { healPct: 0.02, healInterval: 500, needsIdle: true, combatCooldown: 10000, homingRadius: 0, homingStrength: 0, critChance: 0 },
};

module.exports = { PIRATE_DEFS };
