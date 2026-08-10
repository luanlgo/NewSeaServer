// constants/relics.js — Relíquias, raridades e tempos de cast

// ── RELIC_DEFS ────────────────────────────────────────────────────────────────
// effect:  heal_ship | invincible | lightning | rocket | gold_shield |
//          speed_boost | attract | meteor | teleport | aura | ice_zone | stone_wall | harpoon
// toggle:  true = liga/desliga (gasta mana na ativação); false = uso único
// targetMouse: true = cliente envia targetX/targetZ junto com use_relic
// castTime: ms de penalidade de velocidade (15%) ao usar; ausente = sem penalidade
//
// ── Campos de PET (relíquia equipada num pet — ver pet-manager.js) ────────────
// petUsable: pode ser equipada em pets
// petTarget: 'dono' (defensiva, usada no dono) | 'inimigo' (ofensiva, no alvo)
// petRange:  'curto' | 'medio' | 'longo' — distância máx do pet ao alvo para usar
// CD quando usada pelo pet: definido pela RARIDADE DO PET (não da relíquia) —
// comum 20s, raro 18s, épico 15s, lendário 10s (RARITY_CD_MS no pet-manager.js)
const RELIC_DEFS = {
  // Relíquias de dano/cura escalam com o PODER DE FOGO do barco (dano de uma salva
  // = dano médio por canhão × nº de canhões). Ver relicDamageFor() no server.js.
  //   damagePct: fração da salva por acerto (aura = por tick)
  //   healPct:   fração do HP máximo curado
  // Os campos damage/healAmount ficam como fallback caso o pct seja removido.
  r1:  { name: 'Âncora Sagrada',    icon: '⚓',  rarity: 'comum',    effect: 'heal_ship',   manaCost: 5, toggle: false, healAmount: 2000, healPct: 0.30,
         petUsable: true, petTarget: 'dono',    petRange: 'curto' },
  r2:  { name: 'Névoa Espectral',   icon: '🌫️',  rarity: 'épico',    effect: 'invincible',  manaCost: 6, toggle: false, duration: 5000,
         petUsable: true, petTarget: 'dono',    petRange: 'curto' },
  r3:  { name: 'Raio Divino',       icon: '⚡',  rarity: 'raro',     effect: 'lightning',   manaCost: 5, toggle: false, damage: 2000, damagePct: 0.80, targetMouse: true, radius: 45,  castTime: 700,
         petUsable: true, petTarget: 'inimigo', petRange: 'medio' },
  r4:  { name: 'Foguete Naval',     icon: '🚀',  rarity: 'incomum',  effect: 'rocket',      manaCost: 4, toggle: false, damage: 3000, damagePct: 1.10, targetMouse: true, radius: 20,  castTime: 500,
         petUsable: true, petTarget: 'inimigo', petRange: 'longo' },
  r5:  { name: 'Escudo de Ouro',    icon: '🛡️',  rarity: 'lendário', effect: 'gold_shield', manaCost: 4, toggle: true,  damageReduction: 0.50, goldCostPct: 0.10 },
  r6:  { name: 'Vento Furioso',     icon: '💨',  rarity: 'comum',    effect: 'speed_boost', manaCost: 4, toggle: false, duration: 5000, speedBonus: 0.50,
         petUsable: true, petTarget: 'dono',    petRange: 'curto' },
  // `pullSpeed`: sucção radial em unidades/segundo, POR CIMA da navegação que a
  // atração já provoca. 12 contra os ~45 un/s do barco é o "buraco negro fraco"
  // — o bicho vem visivelmente arrastado, mas ainda manobra.
  r7:  { name: 'Corneta do Abismo', icon: '📯',  rarity: 'raro',     effect: 'attract',     manaCost: 5, toggle: false, duration: 6000, range: 900, pullSpeed: 12 },
  r8:  { name: 'Meteoro',           icon: '☄️',  rarity: 'épico',    effect: 'meteor',      manaCost: 7, toggle: false, damage: 2400, damagePct: 1.30, targetMouse: true, radius: 55,  castTime: 700, count: 1,
         petUsable: true, petTarget: 'inimigo', petRange: 'longo' },
  r9:  { name: 'Teleporte',         icon: '🌀',  rarity: 'raro',     effect: 'teleport',    manaCost: 5, toggle: false, targetMouse: true, maxRange: 150 },
  r10: { name: 'Aura Mortal',       icon: '🔥',  rarity: 'lendário', effect: 'aura',        manaCost: 8, toggle: false, duration: 5000, range: 100, damage: 200, damagePct: 0.12, tickInterval: 300 },
  // CC puro (sem dano): slow instantâneo na zona; quem ficar dentro até o fim leva stun.
  r11: { name: 'Prisão de Gelo',    icon: '❄️',  rarity: 'raro',     effect: 'ice_zone',    manaCost: 6, toggle: false, targetMouse: true, radius: 40, slowPct: 0.50, zoneMs: 2000, stunMs: 2000 },
  // Mecânica NOVA: bloqueio físico real de movimento (não é dano nem slow/stun via
  // stat) — ver managers/wall-manager.js + utils/collision.js pushOutOfWalls().
  // wallLength/wallThickness em unidades de mundo (mesmas unidades de x/z do jogador).
  r12: { name: 'Muro de Pedra',     icon: '🧱',  rarity: 'raro',     effect: 'stone_wall',  manaCost: 5, toggle: false, targetMouse: true,
         wallLength: 100, wallThickness: 20, zoneMs: 1200, wallMs: 6000 },
  // Grab (Q do Nautilus): skillshot em linha; 1º inimigo no corredor é puxado até
  // perto do caster + stun curto. Boss leva o dano mas NÃO é puxado.
  r13: { name: 'Arpão do Leviatã',  icon: '🪝',  rarity: 'épico',    effect: 'harpoon',     manaCost: 6, toggle: false, targetMouse: true,
         damage: 1500, damagePct: 0.50, range: 130, hitRadius: 14, travelMs: 500, pullStopDist: 30, stunMs: 800, castTime: 300 },
};

// ── Relíquias do bestiário (r14..r47) ────────────────────────────────────────
// As 34 skills dos 9 bichos novos. Todas usam o MESMO branch genérico
// `effect: 'monster_skill'` no handleUseRelic() — a forma do acerto, o dano e o
// CC vêm dos dados (shape/ticks/cc/special), não de código por relíquia.
// Fonte única: constants/monster_skills.js, que também alimenta o ATTACK_DEFS
// usado pelo próprio bicho. Drop: cada bicho só solta as SUAS (SKILLS_BY_SOURCE).
const { MONSTER_RELIC_DEFS } = require('./monster_skills');
Object.assign(RELIC_DEFS, MONSTER_RELIC_DEFS);

// ── RELIC_RARITIES — peso de drop por raridade ────────────────────────────────
const RELIC_RARITIES = {
  comum:    { label: 'Comum',    color: '#aaaaaa', dropWeight: 5    },
  incomum:  { label: 'Incomum',  color: '#4adf6a', dropWeight: 1    },
  raro:     { label: 'Raro',     color: '#4a8aff', dropWeight: 0.2  },
  épico:    { label: 'Épico',    color: '#cc55ff', dropWeight: 0.1  },
  lendário: { label: 'Lendário', color: '#ff9900', dropWeight: 0.01 },
};

module.exports = { RELIC_DEFS, RELIC_RARITIES };
