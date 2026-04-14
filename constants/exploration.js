// constants/exploration.js — Fragmentos, recompensas de exploração, mapas bônus e boss mundial

// ── Fragmentos de mapa ────────────────────────────────────────────────────────
const FRAGMENT_DROP_NPC  = 1;       // fragmentos por NPC morto
const FRAGMENT_DROP_BOSS = {        // fragmentos por boss morto (por raridade)
  normal:   3,
  raro:     6,
  especial: 12,
  infernal: 25,
};
const FRAGMENT_EXPLORE_COST          = 1;   // fragmentos gastos por exploração
const FRAGMENT_EXPLORE_FALLBACK_COST = 500; // dobrões gastos se sem fragmentos

// ── EXPLORATION_REWARDS — tabela de recompensas da Mesa de Exploração ─────────
// type: 'ammo'     → id = chave de AMMO_DEFS, qty = quantidade
// type: 'resource' → id = campo do jogador (ironPlates, goldDust, gunpowder, mapFragments)
// weight: peso relativo (maior = mais frequente)
const EXPLORATION_REWARDS = [
  // Munições
  { type: 'ammo',     id: 'bala_perfurante', qty: 10,  weight: 22 },
  { type: 'ammo',     id: 'bala_gelo',       qty: 10,  weight: 22 },
  { type: 'ammo',     id: 'bala_fogo',       qty: 10,  weight: 16 },
  { type: 'ammo',     id: 'bala_cura',       qty: 10,  weight: 16 },
  { type: 'ammo',     id: 'bala_luz',        qty: 10,  weight: 10 },
  { type: 'ammo',     id: 'bala_sangue',     qty: 10,  weight: 6  },
  { type: 'ammo',     id: 'bala_sangue',     qty: 500, weight: 1  }, // jackpot raro
  // Recursos
  { type: 'resource', id: 'ironPlates',      qty: 5,   weight: 12 },
  { type: 'resource', id: 'goldDust',        qty: 3,   weight: 8  },
  { type: 'resource', id: 'gunpowder',       qty: 8,   weight: 11 },
  { type: 'resource', id: 'mapFragments',    qty: 2,   weight: 5  },
  // Peças de Masmorra Bônus — acumulam em player.mapPieces (separado de mapFragments!)
  // Pesos: 4/120 ≈ 3.3% | 2/120 ≈ 1.7% | 1/120 ≈ 0.8%
  { type: 'mapPiece', id: 'mapa_naufrago',   qty: 1,   weight: 4  }, // Baía dos Naufragados  (30 peças, ~3%)
  { type: 'mapPiece', id: 'mapa_fortaleza',  qty: 1,   weight: 2  }, // Fortaleza do Esquecimento (40 peças, ~2%)
  { type: 'mapPiece', id: 'mapa_abismo',     qty: 1,   weight: 1  }, // Abismo dos Afundados  (50 peças, ~1%)
];

// Alias de compatibilidade para código legado
const FRAGMENT_EXPLORE_DROPS = EXPLORATION_REWARDS;

// ── BONUS_MAPS — mapas bônus desbloqueáveis via fragmentos ────────────────────
const BONUS_MAPS = [
  { id: 'bonus_map_1', name: 'Baía dos Naufragados',      icon: '🏴‍☠️', pieceId: 'mapa_naufrago',  requiredPieces: 30 },
  { id: 'bonus_map_2', name: 'Fortaleza do Esquecimento', icon: '🏰',  pieceId: 'mapa_fortaleza', requiredPieces: 40 },
  { id: 'bonus_map_3', name: 'Abismo dos Afundados',      icon: '🌊',  pieceId: 'mapa_abismo',    requiredPieces: 50 },
];

// ── WORLD_BOSS_DEF — boss mundial que surge após N bosses de zona mortos ──────
const WORLD_BOSS_DEF = [
  {
    name:                'Legendary ghost Pirate Ship',
    icon:                '🦑',
    spawnAfterBossKills:  5,
    spawnChance:          1.0,
    baseHp:               25000,
    baseDamage:           4000,
    hpPerTier:            0.10,
    dmgPerTier:           0.10,
    rewardPerTier:        0.1,
    regenPerSec:          250,
    regenDelay:           20000,
    expireDelay:          600000,
    hitRadius:            16,
    fireInterval:         4000,
    dobraoMin:            500,
    dobraoMax:            600,
    mapFragments:         500,
    hullColor:            0x050505,
    sailColor:            0x220011,
    attacks:              ['cannon_shot', 'cannon_burst', 'poison_spit', 'ghost_soul_pillars'],
    mapLevel:             [1, 2],
    model:               '/models/ships/legendary_ghost_pirate_ship.glb',
    scale:               2.1,
    yOffset:             3,
    rotOffset:           0,
    rarity: { id: 'deus', label: 'DEUS DO MAR', hpMult: 1, rewardMult: 25, chance: 1, color: '#ff2200', bg: 'rgba(80,0,0,0.97)' },
  }
];

module.exports = {
  FRAGMENT_DROP_NPC, FRAGMENT_DROP_BOSS,
  FRAGMENT_EXPLORE_COST, FRAGMENT_EXPLORE_FALLBACK_COST,
  EXPLORATION_REWARDS, FRAGMENT_EXPLORE_DROPS,
  BONUS_MAPS, WORLD_BOSS_DEF,
};
