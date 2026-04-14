/**
 * Testes do Fluxo de Masmorra Bônus
 *
 * Cobre o fluxo completo:
 *  1. Entrar no mapa bônus → NPCs spawnam
 *  2. Matar NPCs → fase muda para 'boss'
 *  3. Boss spawna → visível nos snapshots de estado
 *  4. Matar boss → sendBonusDungeonComplete com recompensas corretas
 *  5. Morrer no mapa bônus → perde acesso + retorna ao mapa normal
 *  6. Recompensas: dobrões/ouro/recursos corretos (BONUS_DUNGEON_DEFS, não MAP_DEFS)
 *  7. Drop de navio raro via rollBonusShip (npcDef.shipDropChance)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Inline: BONUS_NPC_DEFS (relevantes para os testes) ───────────────────────

const BONUS_NPC_DEFS = {
  colossal_ghost_pirate_galleon: {
    id:            'colossal_ghost_pirate_galleon',
    name:          'Colossal Ghost Pirate Galleon',
    rarity:        'comum',
    shipDropId:    'colossal_ghost_pirate_galleon',
    shipDropChance: 0.5,   // 50% — valor de produção (não 10.0 do testing)
    stats: { hpMin: 30000, hpMax: 40000, cannonMin: 60, cannonMax: 80 },
  },
  massive_imperial_warship: {
    id:            'massive_imperial_warship',
    name:          'Massive Imperial Warship',
    rarity:        'normal',
    shipDropId:    'massive_imperial_warship',
    shipDropChance: 0.5,
    stats: { hpMin: 30000, hpMax: 40000, cannonMin: 70, cannonMax: 90 },
  },
  gigantic_mechanical_pirate_ship: {
    id:            'gigantic_mechanical_pirate_ship',
    name:          'Gigantic Mechanical Pirate Ship',
    rarity:        'raro',
    shipDropId:    'gigantic_mechanical_pirate_ship',
    shipDropChance: 0.5,
    stats: { hpMin: 35000, hpMax: 50000, cannonMin: 80, cannonMax: 120 },
  },
};

// ── Inline: computeWaveRewards ────────────────────────────────────────────────

const WAVE_REWARD_BASE = {
  dobroes:    20000,
  gold:       300000,
  ironPlates: 50,
  goldDust:   10,
  gunpowder:  15,
};
const WAVE_REWARD_MULT = 1.5;

function computeWaveRewards(waveIndex) {
  const m = Math.pow(WAVE_REWARD_MULT, waveIndex);
  return Object.fromEntries(
    Object.entries(WAVE_REWARD_BASE).map(([k, v]) => [k, Math.round(v * m)])
  );
}

// ── Inline: BONUS_DUNGEON_DEFS ────────────────────────────────────────────────

const BONUS_DUNGEON_DEFS = {
  bonus_map_1: {
    id:             'bonus_map_1',
    name:           'Baía dos Naufragados',
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
    requiredPieces: 50,
    pieceId:        'mapa_abismo',
    npcId:          'gigantic_mechanical_pirate_ship',
    waves: [
      { waveIndex: 0, npcCount: 1, npcId: 'gigantic_mechanical_pirate_ship', rewards: computeWaveRewards(0) },
    ],
  },
};

// ── Inline: MAP_DEFS relevantes ───────────────────────────────────────────────

const MAP_DEFS = {
  1:  { name: 'Mar do Começo',     isBonusMap: false, size: 4000 },
  7:  { name: 'Baía dos Naufragados',  isBonusMap: true, bonusMapId: 'bonus_map_1', size: 1000, npc: { count: 5 } },
  8:  { name: 'Fortaleza do Esquecimento', isBonusMap: true, bonusMapId: 'bonus_map_2', size: 1000, npc: { count: 5 } },
  9:  { name: 'Abismo dos Afundados',  isBonusMap: true, bonusMapId: 'bonus_map_3', size: 1000, npc: { count: 5 } },
};

// ── Inline: rollBonusShip ─────────────────────────────────────────────────────

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
    hpMin,       hpMax,
    cannonMin,   cannonMax,
    modelKey:    npcDef.id,
    obtainedAt:  Date.now(),
  };
}

// ── Inline: NPC Manager stub ──────────────────────────────────────────────────
// Simula o comportamento do NpcManager (phase, npcs Map, spawnWithDef)

function createBonusManager(npcCount = 5) {
  const mgr = {
    npcs: new Map(),
    _phase: 'npcs',
    _initialNpcCount: 0,
    _bossSpawnedAt: 0,
    destroyed: false,
    _nextId: 1,

    spawnNpcs(count) {
      for (let i = 0; i < count; i++) {
        const id = `npc_${this._nextId++}`;
        this.npcs.set(id, { id, hp: 10000, isBoss: false, isDungeonBoss: false });
      }
      this._initialNpcCount = this.npcs.size;
    },

    spawnBoss(npcDef) {
      const id = `boss_${this._nextId++}`;
      this.npcs.set(id, {
        id, hp: 35000, isBoss: true, isDungeonBoss: true,
        name: npcDef.name,
      });
      this._bossSpawnedAt = Date.now();
    },

    killNpc(id) {
      this.npcs.delete(id);
    },

    snapshot() {
      return Array.from(this.npcs.values());
    },

    // Snapshot filtered the same way server.js does
    snapshotFiltered() {
      return this.snapshot().filter(n => !n.isBoss || n.isDungeonBoss);
    },
  };
  mgr.spawnNpcs(npcCount);
  return mgr;
}

// ── Inline: sendBonusDungeonComplete lógica isolada ──────────────────────────
// Extrai a lógica de recompensa SEM depender do server.js (que tem I/O)

function computeBonusRewards(player, mapDef) {
  const dungeonId   = mapDef.bonusMapId;
  const dungeonDef  = dungeonId && BONUS_DUNGEON_DEFS[dungeonId];
  const npcId       = dungeonDef?.npcId;
  const npcDef      = npcId && BONUS_NPC_DEFS[npcId];
  const waveRewards = dungeonDef?.waves?.[0]?.rewards || {};

  const dobraoAmt  = waveRewards.dobroes    || 0;
  const goldAmt    = waveRewards.gold       || 0;
  const ironAmt    = waveRewards.ironPlates || 0;
  const dustAmt    = waveRewards.goldDust   || 0;
  const powderAmt  = waveRewards.gunpowder  || 0;

  player.dobroes    = (player.dobroes    || 0) + dobraoAmt;
  player.gold       = (player.gold       || 0) + goldAmt;
  player.ironPlates = (player.ironPlates || 0) + ironAmt;
  player.goldDust   = (player.goldDust   || 0) + dustAmt;
  player.gunpowder  = (player.gunpowder  || 0) + powderAmt;

  let shipDrop = null;
  if (npcDef && Math.random() < (npcDef.shipDropChance ?? 0.02)) {
    shipDrop = rollBonusShip(npcDef);
    if (!player.bonusShips) player.bonusShips = [];
    player.bonusShips.push(shipDrop);
  }

  return {
    rewards: { dobroes: dobraoAmt, gold: goldAmt, ironPlates: ironAmt, goldDust: dustAmt, gunpowder: powderAmt },
    shipDrop,
    npcDef,
    dungeonDef,
  };
}

// ── Inline: handleRespawnInBonusMap ──────────────────────────────────────────
// Lógica de morte no mapa bônus (extraída do server.js request_respawn)

function handleBonusDeath(player) {
  const mapDef    = MAP_DEFS[player.mapLevel];
  if (!mapDef?.isBonusMap) return null;

  const bonusMapId = mapDef.bonusMapId;
  const bonusDef   = BONUS_DUNGEON_DEFS[bonusMapId];

  // Remove acesso ao mapa bônus
  player.bonusMapsUnlocked = (player.bonusMapsUnlocked || []).filter(id => id !== bonusMapId);

  // Zera peça do mapa
  if (bonusDef && player.mapPieces) {
    player.mapPieces[bonusDef.pieceId] = 0;
  }

  // Retorna ao mapa pré-bônus
  const returnLevel = player.preBonusMapLevel || 1;
  player.mapLevel   = returnLevel;
  player.x          = player.preBonusX || 0;
  player.z          = player.preBonusZ || 0;
  delete player.preBonusMapLevel;
  delete player.preBonusX;
  delete player.preBonusZ;

  return { returnLevel, bonusMapId, bonusDef };
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTES
// ─────────────────────────────────────────────────────────────────────────────

describe('Bonus Dungeon — Estrutura de Definições', () => {
  it('BONUS_DUNGEON_DEFS contém os 3 mapas bônus', () => {
    expect(Object.keys(BONUS_DUNGEON_DEFS)).toEqual(['bonus_map_1', 'bonus_map_2', 'bonus_map_3']);
  });

  it('cada dungeon tem wave rewards corretos (wave 0 = base sem multiplicador)', () => {
    const rewards = BONUS_DUNGEON_DEFS.bonus_map_1.waves[0].rewards;
    expect(rewards.dobroes).toBe(20000);
    expect(rewards.gold).toBe(300000);
    expect(rewards.ironPlates).toBe(50);
    expect(rewards.goldDust).toBe(10);
    expect(rewards.gunpowder).toBe(15);
  });

  it('wave rewards da wave 1 são 1.5× os da wave 0', () => {
    const w0 = computeWaveRewards(0);
    const w1 = computeWaveRewards(1);
    expect(w1.dobroes).toBe(Math.round(w0.dobroes * 1.5));
    expect(w1.gold).toBe(Math.round(w0.gold * 1.5));
  });

  it('cada dungeon aponta para um npcId válido em BONUS_NPC_DEFS', () => {
    for (const [, def] of Object.entries(BONUS_DUNGEON_DEFS)) {
      expect(BONUS_NPC_DEFS[def.npcId]).toBeDefined();
    }
  });

  it('MAP_DEFS[7/8/9] têm bonusMapId correspondendo a BONUS_DUNGEON_DEFS', () => {
    expect(BONUS_DUNGEON_DEFS[MAP_DEFS[7].bonusMapId]).toBeDefined();
    expect(BONUS_DUNGEON_DEFS[MAP_DEFS[8].bonusMapId]).toBeDefined();
    expect(BONUS_DUNGEON_DEFS[MAP_DEFS[9].bonusMapId]).toBeDefined();
  });
});

// ── 1. Entrar no mapa bônus ───────────────────────────────────────────────────

describe('Fase 1 — Entrar no Mapa Bônus', () => {
  it('MAP_DEFS[7] é marcado como isBonusMap', () => {
    expect(MAP_DEFS[7].isBonusMap).toBe(true);
  });

  it('NPCs spawnam ao entrar (5 NPCs iniciais)', () => {
    const mgr = createBonusManager(5);
    expect(mgr.npcs.size).toBe(5);
    expect(mgr._initialNpcCount).toBe(5);
    expect(mgr._phase).toBe('npcs');
  });

  it('NPCs iniciais não são bosses (filtragem de state não os oculta)', () => {
    const mgr = createBonusManager(5);
    const visible = mgr.snapshotFiltered();
    expect(visible).toHaveLength(5);
    expect(visible.every(n => !n.isBoss)).toBe(true);
  });

  it('fase começa em "npcs"', () => {
    const mgr = createBonusManager(5);
    expect(mgr._phase).toBe('npcs');
  });
});

// ── 2. Matar NPCs → boss spawna ───────────────────────────────────────────────

describe('Fase 2 — Matar NPCs → Boss Spawna', () => {
  it('matar todos os NPCs esvazia o Map de npcs', () => {
    const mgr = createBonusManager(5);
    const ids = Array.from(mgr.npcs.keys());
    for (const id of ids) mgr.killNpc(id);
    expect(mgr.npcs.size).toBe(0);
  });

  it('condição de transição "npcs→boss": _initialNpcCount>0 && npcs.size===0', () => {
    const mgr = createBonusManager(5);
    expect(mgr._initialNpcCount).toBeGreaterThan(0);

    // Matar todos
    for (const id of [...mgr.npcs.keys()]) mgr.killNpc(id);

    // Verifica condição
    const shouldTransition = mgr._phase === 'npcs' && mgr._initialNpcCount > 0 && mgr.npcs.size === 0;
    expect(shouldTransition).toBe(true);
  });

  it('transição não dispara antes do último NPC morrer', () => {
    const mgr = createBonusManager(5);
    const ids = Array.from(mgr.npcs.keys());

    // Mata 4 de 5
    for (let i = 0; i < 4; i++) mgr.killNpc(ids[i]);

    const shouldTransition = mgr._phase === 'npcs' && mgr._initialNpcCount > 0 && mgr.npcs.size === 0;
    expect(shouldTransition).toBe(false);
    expect(mgr.npcs.size).toBe(1);
  });

  it('boss spawna e fica visível no snapshot filtrado', () => {
    const mgr = createBonusManager(5);
    const npcDef = BONUS_NPC_DEFS['colossal_ghost_pirate_galleon'];

    // Matar NPCs e simular transição
    for (const id of [...mgr.npcs.keys()]) mgr.killNpc(id);
    mgr._phase = 'boss';
    mgr.spawnBoss(npcDef);

    expect(mgr.npcs.size).toBe(1);

    const visible = mgr.snapshotFiltered();
    expect(visible).toHaveLength(1);
    expect(visible[0].isBoss).toBe(true);
    expect(visible[0].isDungeonBoss).toBe(true);
  });

  it('boss NÃO é filtrado do snapshot (isDungeonBoss=true passa o filtro)', () => {
    const mgr = createBonusManager(0);
    const npcDef = BONUS_NPC_DEFS['colossal_ghost_pirate_galleon'];
    mgr.spawnBoss(npcDef);

    // Filtro: !isBoss || isDungeonBoss
    const all = mgr.snapshot();
    const filtered = all.filter(n => !n.isBoss || n.isDungeonBoss);
    expect(filtered).toHaveLength(1);
  });

  it('boss de zona normal (isBoss=true, isDungeonBoss=false) é OCULTADO do snapshot', () => {
    // Simula um boss de zona que não deve aparecer no snapshot bônus
    const zoneBoss = { id: 'zone_boss_1', hp: 100000, isBoss: true, isDungeonBoss: false };
    const filtered = [zoneBoss].filter(n => !n.isBoss || n.isDungeonBoss);
    expect(filtered).toHaveLength(0);
  });
});

// ── 3. Matar Boss → Recompensas ───────────────────────────────────────────────

describe('Fase 3 — Matar Boss → Recompensas', () => {
  it('condição "boss→complete": _phase=boss && _bossSpawnedAt>0 && npcs.size===0 (com grace 500ms)', () => {
    const mgr = createBonusManager(0);
    const npcDef = BONUS_NPC_DEFS['colossal_ghost_pirate_galleon'];
    mgr._phase = 'boss';
    mgr.spawnBoss(npcDef);
    expect(mgr._bossSpawnedAt).toBeGreaterThan(0);

    // Simula kill do boss
    for (const id of [...mgr.npcs.keys()]) mgr.killNpc(id);

    // Grace period de 500ms — aqui fingimos que passou
    const elapsedMs = 600;
    const shouldComplete = mgr._phase === 'boss'
      && mgr._bossSpawnedAt > 0
      && elapsedMs > 500
      && mgr.npcs.size === 0;
    expect(shouldComplete).toBe(true);
  });

  it('grace period de 500ms previne complete imediato após boss spawnar', () => {
    const mgr = createBonusManager(0);
    const npcDef = BONUS_NPC_DEFS['colossal_ghost_pirate_galleon'];
    mgr._phase = 'boss';
    mgr.spawnBoss(npcDef);
    for (const id of [...mgr.npcs.keys()]) mgr.killNpc(id);

    const elapsedMs = 200; // menos de 500ms
    const shouldComplete = mgr._phase === 'boss'
      && mgr._bossSpawnedAt > 0
      && elapsedMs > 500
      && mgr.npcs.size === 0;
    expect(shouldComplete).toBe(false);
  });

  it('recompensas vêm de BONUS_DUNGEON_DEFS, não de MAP_DEFS', () => {
    const player = { dobroes: 0, gold: 0, ironPlates: 0, goldDust: 0, gunpowder: 0 };
    const mapDef = MAP_DEFS[7]; // isBonusMap, bonusMapId: 'bonus_map_1'

    const { rewards } = computeBonusRewards(player, mapDef);

    // MAP_DEFS[7] não tem dobraoReward/resourceRewards — valores devem vir de BONUS_DUNGEON_DEFS
    expect(rewards.dobroes).toBe(20000);   // WAVE_REWARD_BASE.dobroes
    expect(rewards.gold).toBe(300000);     // WAVE_REWARD_BASE.gold
    expect(rewards.ironPlates).toBe(50);   // WAVE_REWARD_BASE.ironPlates
    expect(rewards.goldDust).toBe(10);     // WAVE_REWARD_BASE.goldDust
    expect(rewards.gunpowder).toBe(15);    // WAVE_REWARD_BASE.gunpowder
  });

  it('recompensas são creditadas ao player corretamente', () => {
    const player = { dobroes: 1000, gold: 5000, ironPlates: 10, goldDust: 2, gunpowder: 5 };
    const mapDef = MAP_DEFS[7];
    computeBonusRewards(player, mapDef);

    expect(player.dobroes).toBe(1000 + 20000);
    expect(player.gold).toBe(5000 + 300000);
    expect(player.ironPlates).toBe(10 + 50);
    expect(player.goldDust).toBe(2 + 10);
    expect(player.gunpowder).toBe(5 + 15);
  });

  it('recompensas são corretas para bonus_map_2 e bonus_map_3 também', () => {
    const wave0 = computeWaveRewards(0);
    for (const mapLevel of [8, 9]) {
      const player = { dobroes: 0, gold: 0 };
      const { rewards } = computeBonusRewards(player, MAP_DEFS[mapLevel]);
      expect(rewards.dobroes).toBe(wave0.dobroes);
      expect(rewards.gold).toBe(wave0.gold);
    }
  });

  it('rewards packet inclui campo "gold" (corrigido vs versão anterior)', () => {
    const player = {};
    const { rewards } = computeBonusRewards(player, MAP_DEFS[7]);
    // Versão antiga não incluía "gold" no objeto rewards — garantir que está presente
    expect('gold' in rewards).toBe(true);
    expect(rewards.gold).toBeGreaterThan(0);
  });
});

// ── 4. Drop de Navio Raro ─────────────────────────────────────────────────────

describe('Fase 3b — Drop de Navio Raro', () => {
  it('rollBonusShip retorna navio com stats dentro do range definido', () => {
    const npcDef = BONUS_NPC_DEFS['colossal_ghost_pirate_galleon'];
    const ship = rollBonusShip(npcDef);

    expect(ship.id).toBe('colossal_ghost_pirate_galleon');
    expect(ship.hp).toBeGreaterThanOrEqual(npcDef.stats.hpMin);
    expect(ship.hp).toBeLessThanOrEqual(npcDef.stats.hpMax);
    expect(ship.cannon).toBeGreaterThanOrEqual(npcDef.stats.cannonMin);
    expect(ship.cannon).toBeLessThanOrEqual(npcDef.stats.cannonMax);
  });

  it('rollBonusShip retorna hp === maxHp', () => {
    const npcDef = BONUS_NPC_DEFS['colossal_ghost_pirate_galleon'];
    const ship = rollBonusShip(npcDef);
    expect(ship.hp).toBe(ship.maxHp);
  });

  it('rollBonusShip inclui instanceId único', () => {
    const npcDef = BONUS_NPC_DEFS['colossal_ghost_pirate_galleon'];
    const ship1 = rollBonusShip(npcDef);
    const ship2 = rollBonusShip(npcDef);
    expect(ship1.instanceId).not.toBe(ship2.instanceId);
  });

  it('com chance 1.0 o drop sempre ocorre e é adicionado a player.bonusShips', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.0); // Math.random() < 1.0 sempre true
    const npcDefFull = { ...BONUS_NPC_DEFS['colossal_ghost_pirate_galleon'], shipDropChance: 1.0 };
    const BONUS_NPC_DEFS_FULL = { colossal_ghost_pirate_galleon: npcDefFull };

    // Simulação manual da lógica de drop
    const player = {};
    const npcDef = npcDefFull;
    if (Math.random() < (npcDef.shipDropChance ?? 0.02)) {
      const ship = rollBonusShip(npcDef);
      if (!player.bonusShips) player.bonusShips = [];
      player.bonusShips.push(ship);
    }

    expect(player.bonusShips).toBeDefined();
    expect(player.bonusShips).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('com chance 0.0 o drop nunca ocorre', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // Math.random() < 0.0 nunca true
    const player = {};
    const npcDef = { ...BONUS_NPC_DEFS['colossal_ghost_pirate_galleon'], shipDropChance: 0.0 };
    if (Math.random() < (npcDef.shipDropChance ?? 0.02)) {
      if (!player.bonusShips) player.bonusShips = [];
      player.bonusShips.push(rollBonusShip(npcDef));
    }

    expect(player.bonusShips).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('tier "lendario" quando stat está no top 25%', () => {
    const npcDef = BONUS_NPC_DEFS['colossal_ghost_pirate_galleon'];
    const { hpMin, hpMax } = npcDef.stats;
    // Top 25% = valor >= hpMin + 0.75 * (hpMax - hpMin)
    const legendaryHp = Math.round(hpMin + 0.80 * (hpMax - hpMin));
    expect(_statTier(legendaryHp, hpMin, hpMax)).toBe('lendario');
  });

  it('tier "normal" quando stat está no bottom 25%', () => {
    const npcDef = BONUS_NPC_DEFS['colossal_ghost_pirate_galleon'];
    const { hpMin, hpMax } = npcDef.stats;
    const normalHp = hpMin; // mínimo absoluto = 0% do range = "normal"
    expect(_statTier(normalHp, hpMin, hpMax)).toBe('normal');
  });
});

// ── 5. Morrer no Mapa Bônus ───────────────────────────────────────────────────

describe('Fase 5 — Morrer no Mapa Bônus', () => {
  function makePlayerInBonus() {
    return {
      name:              'TestPlayer',
      mapLevel:          7,
      preBonusMapLevel:  1,
      preBonusX:         100,
      preBonusZ:         200,
      hp:                0,
      bonusMapsUnlocked: ['bonus_map_1', 'bonus_map_2'],
      mapPieces:         { mapa_naufrago: 30, mapa_fortaleza: 15 },
    };
  }

  it('handleBonusDeath só age quando player está num mapa bônus', () => {
    const player = { mapLevel: 1 };
    const result = handleBonusDeath(player);
    expect(result).toBeNull();
  });

  it('retorna ao mapa pré-bônus (preBonusMapLevel)', () => {
    const player = makePlayerInBonus();
    handleBonusDeath(player);
    expect(player.mapLevel).toBe(1);
  });

  it('retorna às coordenadas pré-bônus', () => {
    const player = makePlayerInBonus();
    handleBonusDeath(player);
    expect(player.x).toBe(100);
    expect(player.z).toBe(200);
  });

  it('remove o mapa bônus de bonusMapsUnlocked', () => {
    const player = makePlayerInBonus();
    handleBonusDeath(player);
    expect(player.bonusMapsUnlocked).not.toContain('bonus_map_1');
    expect(player.bonusMapsUnlocked).toContain('bonus_map_2'); // outros intactos
  });

  it('zera a peça do mapa correspondente', () => {
    const player = makePlayerInBonus();
    handleBonusDeath(player);
    expect(player.mapPieces['mapa_naufrago']).toBe(0);
    expect(player.mapPieces['mapa_fortaleza']).toBe(15); // outras peças intactas
  });

  it('deleta campos preBonusMapLevel/X/Z após retorno', () => {
    const player = makePlayerInBonus();
    handleBonusDeath(player);
    expect('preBonusMapLevel' in player).toBe(false);
    expect('preBonusX' in player).toBe(false);
    expect('preBonusZ' in player).toBe(false);
  });

  it('retorna returnLevel e bonusMapId no resultado', () => {
    const player = makePlayerInBonus();
    const result = handleBonusDeath(player);
    expect(result.returnLevel).toBe(1);
    expect(result.bonusMapId).toBe('bonus_map_1');
  });

  it('preBonusMapLevel não definido → retorna para mapa 1 (fallback)', () => {
    const player = { mapLevel: 7, bonusMapsUnlocked: ['bonus_map_1'], mapPieces: {} };
    handleBonusDeath(player);
    expect(player.mapLevel).toBe(1);
  });
});

// ── 6. Fluxo completo end-to-end ──────────────────────────────────────────────

describe('Fluxo Completo — Enter → Kill NPCs → Boss → Complete → Death', () => {
  it('fluxo completo sem erros e com state correto em cada passo', () => {
    // Passo 1: Player entra no mapa bônus
    const player = {
      name: 'Pirata', mapLevel: 7, preBonusMapLevel: 1,
      preBonusX: 50, preBonusZ: 75,
      dobroes: 5000, gold: 10000, ironPlates: 0, goldDust: 0, gunpowder: 0,
      bonusMapsUnlocked: ['bonus_map_1'],
      mapPieces: { mapa_naufrago: 30 },
    };

    const mgr = createBonusManager(5);
    expect(mgr._phase).toBe('npcs');
    expect(mgr.npcs.size).toBe(5);

    // Passo 2: Matar todos os NPCs
    for (const id of [...mgr.npcs.keys()]) mgr.killNpc(id);
    expect(mgr.npcs.size).toBe(0);

    // Passo 3: Transição npcs→boss
    const npcDef = BONUS_NPC_DEFS[BONUS_DUNGEON_DEFS['bonus_map_1'].npcId];
    expect(npcDef).toBeDefined();
    mgr._phase = 'boss';
    mgr.spawnBoss(npcDef);
    expect(mgr.npcs.size).toBe(1);
    expect(mgr.snapshotFiltered()[0].isDungeonBoss).toBe(true);

    // Passo 4: Matar boss (simula grace period passado)
    for (const id of [...mgr.npcs.keys()]) mgr.killNpc(id);
    mgr._phase = 'complete';
    expect(mgr.npcs.size).toBe(0);

    // Passo 5: Distribuir recompensas
    const mapDef = MAP_DEFS[player.mapLevel];
    const { rewards, shipDrop } = computeBonusRewards(player, mapDef);
    expect(player.dobroes).toBe(5000 + 20000);
    expect(player.gold).toBe(10000 + 300000);
    expect(rewards.dobroes).toBe(20000);

    // Passo 6: Player morre → perde acesso
    player.mapLevel = 7; // voltou a entrar (foi resetado antes)
    player.preBonusMapLevel = 1;
    player.preBonusX = 50;
    player.preBonusZ = 75;
    player.bonusMapsUnlocked = ['bonus_map_1']; // reseta para simular 2ª entrada
    const deathResult = handleBonusDeath(player);
    expect(player.mapLevel).toBe(1);
    expect(player.bonusMapsUnlocked).not.toContain('bonus_map_1');
    expect(player.mapPieces['mapa_naufrago']).toBe(0);
    expect(deathResult.bonusMapId).toBe('bonus_map_1');
  });

  it('player com dobrões zerados recebe recompensa corretamente', () => {
    const player = { dobroes: 0, gold: 0, ironPlates: 0, goldDust: 0, gunpowder: 0 };
    computeBonusRewards(player, MAP_DEFS[7]);
    expect(player.dobroes).toBe(20000);
    expect(player.gold).toBe(300000);
  });

  it('múltiplas completadas acumulam recompensas', () => {
    const player = { dobroes: 0, gold: 0, ironPlates: 0, goldDust: 0, gunpowder: 0 };
    computeBonusRewards(player, MAP_DEFS[7]);
    computeBonusRewards(player, MAP_DEFS[7]);
    expect(player.dobroes).toBe(40000);
    expect(player.gold).toBe(600000);
  });
});

// ── 7. Re-entrada no mapa bônus ───────────────────────────────────────────────

describe('Fase 7 — Re-entrada após Completar Dungeon', () => {
  // Simula a lógica de ensureBonusMapManager + reset em handleEnterBonusMap
  function simulateEnterBonusMap(bonusManagers, level) {
    const prevMgr = bonusManagers.get(level);
    if (prevMgr && prevMgr._phase === 'complete') {
      prevMgr.destroyed = true;
      bonusManagers.delete(level);
    }
    // Cria novo manager (simula ensureBonusMapManager)
    const newMgr = createBonusManager(5);
    bonusManagers.set(level, newMgr);
    return newMgr;
  }

  it('manager em "complete" é destruído ao re-entrar', () => {
    const bonusManagers = new Map();
    const firstMgr = createBonusManager(5);
    firstMgr._phase = 'complete';
    bonusManagers.set(7, firstMgr);

    simulateEnterBonusMap(bonusManagers, 7);

    expect(firstMgr.destroyed).toBe(true);
  });

  it('novo manager começa em fase "npcs" com 5 NPCs', () => {
    const bonusManagers = new Map();
    const firstMgr = createBonusManager(5);
    firstMgr._phase = 'complete';
    for (const id of [...firstMgr.npcs.keys()]) firstMgr.killNpc(id);
    bonusManagers.set(7, firstMgr);

    const newMgr = simulateEnterBonusMap(bonusManagers, 7);

    expect(newMgr._phase).toBe('npcs');
    expect(newMgr.npcs.size).toBe(5);
    expect(newMgr._initialNpcCount).toBe(5);
  });

  it('manager em "boss" (dungeon incompleto) NÃO é resetado ao re-entrar', () => {
    const bonusManagers = new Map();
    const inProgressMgr = createBonusManager(0);
    inProgressMgr._phase = 'boss';
    const npcDef = BONUS_NPC_DEFS['colossal_ghost_pirate_galleon'];
    inProgressMgr.spawnBoss(npcDef);
    bonusManagers.set(7, inProgressMgr);

    // Simula a condição de reset — só reseta se 'complete'
    const prevMgr = bonusManagers.get(7);
    if (prevMgr && prevMgr._phase === 'complete') {
      prevMgr.destroyed = true;
      bonusManagers.delete(7);
    }

    // Manager ainda é o mesmo (boss ainda vivo)
    expect(bonusManagers.get(7)).toBe(inProgressMgr);
    expect(inProgressMgr.destroyed).toBeFalsy();
  });

  it('manager em "npcs" (partida nova) NÃO é resetado ao re-entrar', () => {
    const bonusManagers = new Map();
    const freshMgr = createBonusManager(5);
    bonusManagers.set(7, freshMgr);

    const prevMgr = bonusManagers.get(7);
    if (prevMgr && prevMgr._phase === 'complete') {
      prevMgr.destroyed = true;
      bonusManagers.delete(7);
    }

    expect(bonusManagers.get(7)).toBe(freshMgr);
    expect(freshMgr.destroyed).toBeFalsy();
  });

  it('snapshot enviado ao entrar reflete os novos NPCs (não a lista vazia do dungeon anterior)', () => {
    const bonusManagers = new Map();
    const completedMgr = createBonusManager(5);
    completedMgr._phase = 'complete';
    for (const id of [...completedMgr.npcs.keys()]) completedMgr.killNpc(id);
    bonusManagers.set(7, completedMgr);

    // Snapshot antes do reset → vazio
    expect(completedMgr.snapshot()).toHaveLength(0);

    const newMgr = simulateEnterBonusMap(bonusManagers, 7);

    // Snapshot após o reset → 5 NPCs
    expect(newMgr.snapshot()).toHaveLength(5);
  });
});
