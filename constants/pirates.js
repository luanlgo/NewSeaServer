// constants/pirates.js — Tripulação de piratas e seus efeitos

// ── Curandeiros ──────────────────────────────────────────────────────────────
// A cura é um valor FIXO por tique, não uma fração da vida máxima. Em
// percentual o curandeiro valia exatamente a mesma coisa na fragata de 200 de
// vida e no Fancy de 70.000 — e agora que dá para equipar vários, o percentual
// multiplicado por 10 encheria a barra em meio segundo em qualquer navio.
//
// `needsIdle` + `combatCooldown`: só cura depois de 10s fora de combate.
const PIRATE_DEFS = {
  healer:        { healAmount: 100, healInterval: 500, needsIdle: true, combatCooldown: 10000, homingRadius: 0, homingStrength: 0, critChance: 0 },
  healer_elite:  { healAmount: 300, healInterval: 500, needsIdle: true, combatCooldown: 10000, homingRadius: 0, homingStrength: 0, critChance: 0 },
};

module.exports = { PIRATE_DEFS };
