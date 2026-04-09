// constants/bonus_dungeons.js
// Defines bonus dungeon NPCs, wave structure, and rare ship drops.
//
// Flow:
//   1. Player collects map pieces via Mesa de Exploração (mapPieces.{pieceId})
//   2. When pieces >= requiredPieces → "Entrar" button available
//   3. Server: deduct pieces, give wave rewards, roll ship drop
//   4. Future: teleport player to dungeon zone, spawn NPC, fight for real

// ── BONUS NPC DEFINITIONS ──────────────────────────────────────────────────
// NPCs ordered from most common to rarest (colossal → massive → gigantic)
const BONUS_NPC_DEFS = {
  colossal_ghost_pirate_galleon: {
    id:             'colossal_ghost_pirate_galleon',
    name:           'Colossal Ghost Pirate Galleon',
    rarity:         'comum',              // most accessible bonus NPC
    model:          '/models/bonus/colossal_ghost_pirate_galleon.glb',
    scale:          10,
    yOffset:        0,
    rotOffset:      0,
    hitRadius:      18,
    usesCannons:    true,
    cannonRange:    150,
    cannonCount:    2,
    fireInterval:   4000,
    shipDropId:     'colossal_ghost_pirate_galleon',
    //shipDropChance: 0.03,                 // 3% to drop the ship
    shipDropChance: 10.0,                 // 100% for testing
    stats: {
      hpMin:     30000, hpMax:     40000,
      cannonMin: 60,    cannonMax: 80,
    },
  },

  massive_imperial_warship: {
    id:             'massive_imperial_warship',
    name:           'Massive Imperial Warship',
    rarity:         'normal',
    model:          '/models/bonus/massive_imperial_warship.glb',
    scale:          7,
    yOffset:        0,
    rotOffset:      0,
    hitRadius:      16,
    usesCannons:    true,
    cannonRange:    150,
    cannonCount:    2,
    fireInterval:   3800,
    shipDropId:     'massive_imperial_warship',
    //shipDropChance: 0.02,                 // 2% to drop the ship
    shipDropChance: 10.0,                 // 100% for testing
    stats: {
      hpMin:     30000, hpMax:     40000,
      cannonMin: 70,    cannonMax: 90,
    },
  },

  gigantic_mechanical_pirate_ship: {
    id:             'gigantic_mechanical_pirate_ship',
    name:           'Gigantic Mechanical Pirate Ship',
    rarity:         'raro',               // rarest bonus NPC
    model:          '/models/bonus/gigantic_mechanical_pirate_ship.glb',
    scale:          3.0,
    yOffset:        0,
    rotOffset:      0,
    hitRadius:      22,
    usesCannons:    true,
    cannonRange:    150,
    cannonCount:    2,
    fireInterval:   3500,
    shipDropId:     'gigantic_mechanical_pirate_ship',
    //shipDropChance: 0.01,                 // 1% to drop the ship
    shipDropChance: 10.0,                 // 100% for testing
    stats: {
      hpMin:     40000, hpMax:     50000,
      cannonMin: 80,    cannonMax: 100,
    },
  },
};

// ── WAVE REWARD STRUCTURE ──────────────────────────────────────────────────
// Wave 0 base values; each subsequent wave multiplies by WAVE_REWARD_MULT.
const WAVE_REWARD_BASE = {
  dobroes:    20000,
  gold:       300000,
  ironPlates: 50,
  goldDust:   10,
  gunpowder:  15,
  xp:         500,
};
const WAVE_REWARD_MULT = 1.5;  // +50% per wave

function computeWaveRewards(waveIndex) {
  const m = Math.pow(WAVE_REWARD_MULT, waveIndex);
  return Object.fromEntries(
    Object.entries(WAVE_REWARD_BASE).map(([k, v]) => [k, Math.round(v * m)])
  );
}

// ── BONUS DUNGEON DEFINITIONS ──────────────────────────────────────────────
const BONUS_DUNGEON_DEFS = {
  bonus_map_1: {
    id:             'bonus_map_1',
    name:           'Baía dos Naufragados',
    icon:           '🏴‍☠️',
    requiredPieces: 30,
    pieceId:        'mapa_naufrago',
    npcId:          'colossal_ghost_pirate_galleon',
    waves: [
      { waveIndex: 0, npcCount: 1, npcId: 'colossal_ghost_pirate_galleon', rewards: computeWaveRewards(0) },
    ],
  },

  bonus_map_2: {
    id:             'bonus_map_2',
    name:           'Fortaleza do Esquecimento',
    icon:           '🏰',
    requiredPieces: 40,
    pieceId:        'mapa_fortaleza',
    npcId:          'massive_imperial_warship',
    waves: [
      { waveIndex: 0, npcCount: 1, npcId: 'massive_imperial_warship', rewards: computeWaveRewards(0) },
    ],
  },

  bonus_map_3: {
    id:             'bonus_map_3',
    name:           'Abismo dos Afundados',
    icon:           '🌊',
    requiredPieces: 50,
    pieceId:        'mapa_abismo',
    npcId:          'gigantic_mechanical_pirate_ship',
    waves: [
      { waveIndex: 0, npcCount: 1, npcId: 'gigantic_mechanical_pirate_ship', rewards: computeWaveRewards(0) },
    ],
  },
};

// ── SHIP STAT ROLL ─────────────────────────────────────────────────────────
// Stats rolled with Math.pow(random, 3): clusters near minimum, max stats extremely rare.

// Quality tiers based on where a stat falls in its min-max range (0–100 %):
//   0–25 %  → normal | 25–50 % → raro | 50–75 % → epico | 75–100 % → lendario
function _statTier(value, min, max) {
  if (max <= min) return 'normal';
  const t = (value - min) / (max - min);
  if (t >= 0.75) return 'lendario';
  if (t >= 0.50) return 'epico';
  if (t >= 0.25) return 'raro';
  return 'normal';
}

function rollBonusShip(npcDef) {
  const { hpMin, hpMax, cannonMin, cannonMax } = npcDef.stats;
  const t_hp     = Math.pow(Math.random(), 3);
  const t_cannon = Math.pow(Math.random(), 3);
  const hp       = Math.round(hpMin + (hpMax     - hpMin)     * t_hp);
  const cannon   = Math.round(cannonMin + (cannonMax - cannonMin) * t_cannon);
  return {
    instanceId:  `${npcDef.shipDropId}_${Date.now()}_${Math.floor(Math.random() * 9999)}`,
    id:          npcDef.shipDropId,
    name:        npcDef.name,
    rarity:      npcDef.rarity,
    hp,
    maxHp:       hp,
    cannon,
    hpTier:      _statTier(hp,     hpMin,     hpMax),
    cannonTier:  _statTier(cannon, cannonMin, cannonMax),
    hpMin,  hpMax,
    cannonMin, cannonMax,
    modelKey:    npcDef.id,
    obtainedAt:  Date.now(),
    tradeable:   true,
    equipped:    false,
  };
}

// ── DUNGEON MAP LEVEL ASSIGNMENTS ──────────────────────────────────────────
// Map level IDs used for dungeon zones on the server and client.
// Change these if you need to shift dungeon levels away from other maps.
const DUNGEON_MAP_LEVEL = {
  bonus_map_1: 10,
  bonus_map_2: 11,
  bonus_map_3: 12,
};

// ── BONUS_DUNGEON_MAP_CONFIGS ──────────────────────────────────────────────
// Visual / spatial config sent to the client via map_transition.mapDef.
// All numeric values here are designed to be tuned for balance / atmosphere.
const BONUS_DUNGEON_MAP_CONFIGS = {
  bonus_map_1: {
    id: 'bonus_map_1', mapLevel: 10, name: 'Baía dos Naufragados', icon: '🏴‍☠️',
    size:            1000,   // zone radius in world units
    playerSpawnZ:    150,   // player Z on entry (NPC spawns at 0,0)
    // Respawn: delay (ms) before a new dungeon NPC appears after one is killed.
    // 0 = NPC only respawns when a new player enters.
    npcRespawnDelay: 30000,
  },
  bonus_map_2: {
    id: 'bonus_map_2', mapLevel: 11, name: 'Fortaleza do Esquecimento', icon: '🏰',
    size:            1000,
    playerSpawnZ:    150,
    npcRespawnDelay: 30000,
  },
  bonus_map_3: {
    id: 'bonus_map_3', mapLevel: 12, name: 'Abismo dos Afundados', icon: '🌊',
    size:            1000,
    playerSpawnZ:    150,
    npcRespawnDelay: 45000,
  },
};

// ── DUNGEON_MAP_DEFS ────────────────────────────────────────────────────────
// MAP_DEFS-compatible entries (keyed by mapLevel) for use with NPCManager.
// NPC stats use the average of min/max from BONUS_NPC_DEFS for consistent
// fight difficulty. Adjust hpMin/hpMax/cannonMin/cannonMax in BONUS_NPC_DEFS
// to balance the fight.
const DUNGEON_MAP_DEFS = {};
Object.entries(BONUS_DUNGEON_MAP_CONFIGS).forEach(([dungeonId, config]) => {
  const dungeonDef = BONUS_DUNGEON_DEFS[dungeonId];
  const npcDef     = BONUS_NPC_DEFS[dungeonDef.npcId];
  const avgHp  = Math.round((npcDef.stats.hpMin  + npcDef.stats.hpMax)  / 2);
  const avgDmg = Math.round((npcDef.stats.cannonMin + npcDef.stats.cannonMax) / 2);
  DUNGEON_MAP_DEFS[config.mapLevel] = {
    size:      config.size,
    isDungeon: true,
    dungeonId,
    npc: {
      count:        1,              // single boss NPC per dungeon
      names:        [npcDef.name],
      baseHp:       avgHp,
      baseDamage:   avgDmg,
      hitRadius:    npcDef.hitRadius,
      // Canhões reais (como c6, sem lifesteal) — ignora ATTACK_DEFS
      usesCannons:  true,
      cannonRange:  npcDef.cannonRange  || 150,
      cannonCount:  npcDef.cannonCount  || 2,
      fireInterval: npcDef.fireInterval || 3500,
      model:        npcDef.model,
      scale:        npcDef.scale,
      yOffset:      npcDef.yOffset,
      rotOffset:    npcDef.rotOffset,
      hullColor:    0x111111,
      sailColor:    0x440022,
      flagColor:    0x220011,
    },
  };
});

module.exports = {
  BONUS_NPC_DEFS,
  BONUS_DUNGEON_DEFS,
  WAVE_REWARD_BASE,
  WAVE_REWARD_MULT,
  computeWaveRewards,
  rollBonusShip,
  DUNGEON_MAP_LEVEL,
  BONUS_DUNGEON_MAP_CONFIGS,
  DUNGEON_MAP_DEFS,
};
