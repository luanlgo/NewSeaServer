// constants/relics.js — Relíquias, raridades e tempos de cast

// ── RELIC_DEFS ────────────────────────────────────────────────────────────────
// effect:  heal_ship | invincible | lightning | rocket | gold_shield |
//          speed_boost | attract | meteor | teleport | aura
// toggle:  true = liga/desliga (gasta mana na ativação); false = uso único
// targetMouse: true = cliente envia targetX/targetZ junto com use_relic
// castTime: ms de penalidade de velocidade (15%) ao usar; ausente = sem penalidade
const RELIC_DEFS = {
  r1:  { name: 'Âncora Sagrada',    icon: '⚓',  rarity: 'comum',    effect: 'heal_ship',   manaCost: 5, toggle: false, healAmount: 2000 },
  r2:  { name: 'Névoa Espectral',   icon: '🌫️',  rarity: 'épico',    effect: 'invincible',  manaCost: 6, toggle: false, duration: 5000 },
  r3:  { name: 'Raio Divino',       icon: '⚡',  rarity: 'raro',     effect: 'lightning',   manaCost: 5, toggle: false, damage: 2000, targetMouse: true, radius: 45,  castTime: 700 },
  r4:  { name: 'Foguete Naval',     icon: '🚀',  rarity: 'incomum',  effect: 'rocket',      manaCost: 4, toggle: false, damage: 3000, targetMouse: true, radius: 20,  castTime: 500 },
  r5:  { name: 'Escudo de Ouro',    icon: '🛡️',  rarity: 'lendário', effect: 'gold_shield', manaCost: 4, toggle: true,  damageReduction: 0.50, goldCostPct: 0.10 },
  r6:  { name: 'Vento Furioso',     icon: '💨',  rarity: 'comum',    effect: 'speed_boost', manaCost: 4, toggle: false, duration: 5000, speedBonus: 0.50 },
  r7:  { name: 'Corneta do Abismo', icon: '📯',  rarity: 'raro',     effect: 'attract',     manaCost: 5, toggle: false, duration: 6000, range: 900 },
  r8:  { name: 'Meteoro',           icon: '☄️',  rarity: 'épico',    effect: 'meteor',      manaCost: 7, toggle: false, damage: 2400, targetMouse: true, radius: 55,  castTime: 700, count: 1 },
  r9:  { name: 'Teleporte',         icon: '🌀',  rarity: 'raro',     effect: 'teleport',    manaCost: 5, toggle: false, targetMouse: true, maxRange: 150 },
  r10: { name: 'Aura Mortal',       icon: '🔥',  rarity: 'lendário', effect: 'aura',        manaCost: 8, toggle: false, duration: 5000, range: 100, damage: 200, tickInterval: 300 },
};

// ── RELIC_RARITIES — peso de drop por raridade ────────────────────────────────
const RELIC_RARITIES = {
  comum:    { label: 'Comum',    color: '#aaaaaa', dropWeight: 5    },
  incomum:  { label: 'Incomum',  color: '#4adf6a', dropWeight: 1    },
  raro:     { label: 'Raro',     color: '#4a8aff', dropWeight: 0.2  },
  épico:    { label: 'Épico',    color: '#cc55ff', dropWeight: 0.1  },
  lendário: { label: 'Lendário', color: '#ff9900', dropWeight: 0.01 },
};

module.exports = { RELIC_DEFS, RELIC_RARITIES };
