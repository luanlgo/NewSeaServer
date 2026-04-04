// server.js
require('dotenv').config();
const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');

// Debug flag for server logs (set DEBUG=1 to enable)
const DEBUG = !!process.env.DEBUG;
function debugServer(...args) { if (DEBUG) console.log(...args); }

// ─── Map Definitions ─────────────────────────────────────────────────────────
// Each map defines NPC base stats, XP requirements, and visual hints for the client

const { sendTo } = require('./utils/helpers');
const db = require('./managers/db-manager');
const PlayerManager     = require('./managers/player-manager');
const NPCManager        = require('./managers/npc-manager');
const BossManager       = require('./managers/boss-manager');
const WorldBossManager  = require('./managers/world-boss-manager');
const ProjectileManager = require('./managers/projectile-manager');
const AttackManager     = require('./managers/attack-manager');

let map1EmptySince = null;
let map2EmptySince = null;
let map3EmptySince = null;

const compression = require('compression');
const app    = express();

app.use(compression());
const server = http.createServer(app);
const wss    = new WebSocket.Server({ 
  server,
  perMessageDeflate: {
    zlibDeflateOptions: {
      chunkSize: 1024,
      memLevel: 7,
      level: 6 // mesmo nível do compression HTTP
    }
  },
  zlibDeflateOptions: {
    chunkSize: 10 * 1024
  },
  // Outras opções úteis:
    clientNoContextTakeover: true,  // Economiza memória
    serverNoContextTakeover: true,
    threshold: 1024  // Só comprime mensagens > 1KB
});

// ── Server-side WebSocket heartbeat ─────────────────────────────────────────
// Render's proxy and NAT gateways can silently drop idle TCP connections.
// This pings all clients every 30s and terminates any that don't reply,
// preventing dead connections from accumulating and leaking memory.
const serverHeartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('[WS] Terminating dead connection (no pong)');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on('close', () => clearInterval(serverHeartbeat));

const isProd = process.env.NODE_ENV === 'production';
const publicDir = isProd? 'dist': 'src';

// No-cache para HTML e, em dev, para todos os arquivos estáticos
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache');
    //res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    //res.setHeader('Pragma', 'no-cache');
    //res.setHeader('Expires', '0');
  } else if (isProd) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    // Dev: nunca cachear JS/CSS para que mudanças apareçam imediatamente
    res.setHeader('Cache-Control', 'no-cache');
  }
  next();
});

// Serve SOMENTE a pasta certa
app.use(express.static(publicDir));
app.use(express.json());

// Root sempre vai no index certo
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// server.js
const {
  CANNON_DEFS,
  AMMO_DEFS,
  MAX_CANNON_SLOTS,
  SAIL_DEFS,
  MAP_DEFS,
  SHIP_DEFS,
  PIRATE_DEFS,
  FRAGMENT_EXPLORE_COST,
  FRAGMENT_EXPLORE_FALLBACK_COST,
  EXPLORATION_REWARDS,
  FRAGMENT_DROP_NPC,
  BONUS_MAPS,
  CANNON_RESEARCH_COSTS,
  SHIP_UPGRADE_DEFS,
  RELIC_DEFS,
  SHIP_RELIQC,

  ATTACK_DEFS,
  WORLD_BOSS_DEF,
  TALENT_DEFS,
  TALENT_COST_TIERS,
  TALENT_XP_BASE,
  TALENT_XP_GROWTH,
  BONUS_DUNGEON_DEFS,
  BONUS_NPC_DEFS,
  rollBonusShip,
  BONUS_DUNGEON_MAP_CONFIGS,
  DUNGEON_MAP_DEFS,
} = require('./constants');
const {
  calcXpRequired:     _calcXpRequired,
  getCostTier:        _getCostTier,
  applyTalentBonuses: _applyTalentBonuses,
  recalcMaxHp:        _recalcMaxHp,
  validateBuyTalent:  _validateBuyTalent,
} = require('./utils/talent-logic');
const { calcMaxCannons: _calcMaxCannons, trimCannons: _trimCannons } = require('./utils/combat-calc');
const { stringify } = require('querystring');

// helper to compute map size per-level (default fallback)
function getMapSize(level) {
  return (MAP_DEFS[level] && MAP_DEFS[level].size);
}

// Métricas de performance em tempo real
// Uso: GET /api/metrics  (requer header Authorization: Bearer <METRICS_TOKEN>)
const _serverMetrics = {
  startTime: Date.now(),
  messagesReceived: 0,
  broadcastsSent: 0,
  tickCount: 0,
  slowTicks: 0,         // ticks > 20ms
  lastTickMs: 0,
};
global._serverMetrics = _serverMetrics;

app.get('/api/metrics', (req, res) => {
  const token = process.env.METRICS_TOKEN;
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const mem = process.memoryUsage();
  res.json({
    uptime:            Math.floor((Date.now() - _serverMetrics.startTime) / 1000),
    players:           players ? players.size : 0,
    tickCount:         _serverMetrics.tickCount,
    slowTicks:         _serverMetrics.slowTicks,
    lastTickMs:        _serverMetrics.lastTickMs,
    messagesReceived:  _serverMetrics.messagesReceived,
    broadcastsSent:    _serverMetrics.broadcastsSent,
    memHeapUsedMB:     Math.round(mem.heapUsed / 1024 / 1024),
    memHeapTotalMB:    Math.round(mem.heapTotal / 1024 / 1024),
    memRssMB:          Math.round(mem.rss / 1024 / 1024),
    dbPending:         db._pending ? db._pending.size : 0,
  });
});

// server.js
app.get('/api/test', (req, res) => {
  console.log('✅ Rota de teste acessada!');
  res.json({ 
    status: 'ok', 
    time: Date.now(),
    message: 'Servidor funcionando!'
  });
});

// server.js
app.get('/api/constants', (req, res) => {
  console.log('\n' + '='.repeat(60));
  console.log('🔥 ROTA /api/constants ACESSADA!');
  console.log('📅 Timestamp:', new Date().toISOString());
  console.log('🔧 NODE_ENV:', process.env.NODE_ENV);
  console.log('📍 URL completa:', req.protocol + '://' + req.get('host') + req.originalUrl);
  
  try {
    // Teste 1: Verificar se o módulo de constantes carrega
    console.log('📚 Tentando carregar constants.js...');
    const constantsModule = require('./constants');
    console.log('✅ constants.js carregado. Chaves:', Object.keys(constantsModule));
    
    // Teste 2: Desestruturar cada constante individualmente
    console.log('🔍 Verificando cada constante...');
    
    let allGood = true;
    const required = [
      'CANNON_DEFS', 'AMMO_DEFS', 'MAX_CANNON_SLOTS', 'SAIL_DEFS',
      'MAP_DEFS', 'SHIP_DEFS', 'PIRATE_DEFS', 'WORLD_BOSS_DEF',
      'RELIC_DEFS', 'RELIC_RARITIES', 'SHIP_RELIQC',
      'TALENT_DEFS', 'TALENT_COST_TIERS', 'TALENT_XP_BASE', 'TALENT_XP_GROWTH'
    ];
    
    required.forEach(key => {
      if (constantsModule[key] === undefined) {
        console.log(`❌ ${key}: undefined`);
        allGood = false;
      } else {
        console.log(`✅ ${key}: ${typeof constantsModule[key]}`);
      }
    });
    
    if (!allGood) {
      throw new Error('Constantes faltando!');
    }
    
    // Teste 3: Tentar serializar para JSON
    console.log('📦 Preparando objeto de resposta...');
    const data = {
      CANNON_DEFS: constantsModule.CANNON_DEFS,
      AMMO_DEFS: constantsModule.AMMO_DEFS,
      MAX_CANNON_SLOTS: constantsModule.MAX_CANNON_SLOTS,
      SAIL_DEFS: constantsModule.SAIL_DEFS,
      MAP_DEFS: constantsModule.MAP_DEFS,
      SHIP_DEFS: constantsModule.SHIP_DEFS,
      PIRATE_DEFS: constantsModule.PIRATE_DEFS,
      WORLD_BOSS_DEF: constantsModule.WORLD_BOSS_DEF,
      RELIC_DEFS: constantsModule.RELIC_DEFS,
      RELIC_RARITIES: constantsModule.RELIC_RARITIES,
      SHIP_RELIQC: constantsModule.SHIP_RELIQC,
      TALENT_DEFS: constantsModule.TALENT_DEFS,
      TALENT_COST_TIERS: constantsModule.TALENT_COST_TIERS,
      TALENT_XP_BASE: constantsModule.TALENT_XP_BASE,
      TALENT_XP_GROWTH: constantsModule.TALENT_XP_GROWTH,
      BONUS_MAPS: constantsModule.BONUS_MAPS,
      CANNON_RESEARCH_COSTS: constantsModule.CANNON_RESEARCH_COSTS,
      SHIP_UPGRADE_DEFS: constantsModule.SHIP_UPGRADE_DEFS,
      EXPLORATION_REWARDS: constantsModule.EXPLORATION_REWARDS,
      ATTACK_DEFS: constantsModule.ATTACK_DEFS,
    };
    
    console.log('📏 Tamanho aproximado:', JSON.stringify(data).length, 'bytes');
    
    // Teste 4: Enviar resposta
    console.log('📨 Enviando resposta...');
    res.json(data);
    console.log('✅ Resposta enviada com sucesso!');
    
  } catch (error) {
    console.error('💥 ERRO CATASTRÓFICO:');
    console.error('Nome:', error.name);
    console.error('Mensagem:', error.message);
    console.error('Stack:', error.stack);
    
    res.status(500).json({
      error: 'Erro interno no servidor',
      message: error.message,
      type: error.name,
      time: new Date().toISOString()
    });
  }
});

// ── Save progress endpoint (called on tab close / F5 via fetch keepalive) ────
app.post('/save-progress', async (req, res) => {
  try {
    const { playerId } = req.body || {};
    const player = playerId ? players.get(playerId) : null;
    if (player) {
      await db.save(player, true);
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: 'player not found' });
    }
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// Shared state maps passed by reference to all managers
const players = new Map();
const npcs    = new Map();

// Managers
const playerManager     = new PlayerManager();

// 1. ProjectileManager first (no npcs yet — injected after)
const projectileManager = new ProjectileManager(wss, players, null, null, null, MAP_DEFS);

// 2. AttackManager — gerencia ataques especiais de NPC (telegraph + AoE)
const attackManager = new AttackManager(addEvent, projectileManager);

// 3. NPC managers (need projectileManager + attackManager for broadcasting)
let   npcManager  = new NPCManager(projectileManager, MAP_DEFS, 1, attackManager); // map 1 NPCs (let — pode ser recriado)
let   npcManager2 = new NPCManager(projectileManager, MAP_DEFS, 2, attackManager); // map 2 NPCs (let — pode ser recriado)
let   npcManager3 = null; // will be created when map 3 is entered
let   npcManager4 = null; // will be created when map 4 is entered
let   npcManager6 = null; // will be created when map 6 is entered (npc: null — boss-only map)
let bossManager6 = null; // boss manager for map 6
// ── Dungeon instance managers (one per dungeon zone, created on first entry) ──
let npcManagerDungeon1 = null; // mapLevel 10 — Baía dos Naufragados
let npcManagerDungeon2 = null; // mapLevel 11 — Fortaleza do Esquecimento
let npcManagerDungeon3 = null; // mapLevel 12 — Abismo dos Afundados

// No início do server.js, junto com as outras variáveis globais
const eventBuffer = {
  map1: [], map2: [], map3: [], map4: [], map6: [],
  map10: [], map11: [], map12: [], // dungeon zones
  global: []
};

let lastBroadcastFlush = Date.now();
const BROADCAST_INTERVAL = parseInt(process.env.BROADCAST_INTERVAL || process.env.VITE_BROADCAST_INTERVAL) || 48;

function addEvent(event, mapLevel = null, urgent = false) {
  if (urgent) {
    // Evento urgente: flush imediato só desse evento
    const events = [event];
    players.forEach(player => {
      if (mapLevel === null || (player.mapLevel || 1) === mapLevel) {
        sendTo(player.ws, { type: 'events', events });
      }
    });
    return;
  }

  if (mapLevel === null || mapLevel === undefined) {
    // Evento global - vai para todos
    eventBuffer.global.push(event);
  } else {
    // Evento específico de mapa
    const key = `map${mapLevel}`;
    if (eventBuffer[key]) {
      eventBuffer[key].push(event);
    }
  }
}

function flushEvents() {
  const now = Date.now();
  
  // Só flush se passou o intervalo OU se algum buffer estiver muito grande
  if (now - lastBroadcastFlush < BROADCAST_INTERVAL) {
    // Verifica se algum buffer estourou o limite máximo
    const MAX_BUFFER_SIZE = 50;
    if (Object.values(eventBuffer).every(buf => buf.length < MAX_BUFFER_SIZE)) {
      return;
    }
  }
  
  lastBroadcastFlush = now;
  
  // Agrupa eventos por mapa
  players.forEach(player => {
    const mapLevel = player.mapLevel || 1;
    const events = [
      ...eventBuffer.global,
      ...(eventBuffer[`map${mapLevel}`] || [])
    ];
    
    if (events.length > 0) {
      sendTo(player.ws, { type: 'events', events });
    }
  });
  
  // Limpa buffers
  eventBuffer.map1 = [];
  eventBuffer.map2 = [];
  eventBuffer.map3 = [];
  eventBuffer.map4 = [];
  eventBuffer.map6 = [];
  eventBuffer.global = [];
}

// 3. Proxy that merges both NPC maps (safe now — npcManager exists)
const allNpcs = new Proxy({}, {
  get(_, prop) {
    if (prop === 'get')     return id => npcManager.npcs.get(id) || npcManager2.npcs.get(id) || (npcManager3 && npcManager3.npcs.get(id)) || (npcManager4 && npcManager4.npcs.get(id)) || (npcManager6 && npcManager6.npcs.get(id)) || (npcManagerDungeon1 && npcManagerDungeon1.npcs.get(id)) || (npcManagerDungeon2 && npcManagerDungeon2.npcs.get(id)) || (npcManagerDungeon3 && npcManagerDungeon3.npcs.get(id));
    if (prop === 'has')     return id => npcManager.npcs.has(id) || npcManager2.npcs.has(id) || (npcManager3 && npcManager3.npcs.has(id)) || (npcManager4 && npcManager4.npcs.has(id)) || (npcManager6 && npcManager6.npcs.has(id)) || (npcManagerDungeon1 && npcManagerDungeon1.npcs.has(id)) || (npcManagerDungeon2 && npcManagerDungeon2.npcs.has(id)) || (npcManagerDungeon3 && npcManagerDungeon3.npcs.has(id));
    if (prop === 'values')  return () => {
      const arr = [...npcManager.npcs.values(), ...npcManager2.npcs.values()];
      if (npcManager3 && !npcManager3.destroyed) arr.push(...npcManager3.npcs.values());
      if (npcManager4 && !npcManager4.destroyed) arr.push(...npcManager4.npcs.values());
      if (npcManager6 && !npcManager6.destroyed) arr.push(...npcManager6.npcs.values());
      if (npcManagerDungeon1) arr.push(...npcManagerDungeon1.npcs.values());
      if (npcManagerDungeon2) arr.push(...npcManagerDungeon2.npcs.values());
      if (npcManagerDungeon3) arr.push(...npcManagerDungeon3.npcs.values());
      return arr[Symbol.iterator]();
    };
    if (prop === 'forEach') return cb => { npcManager.npcs.forEach(cb); npcManager2.npcs.forEach(cb); if (npcManager3 && !npcManager3.destroyed) npcManager3.npcs.forEach(cb); if (npcManager4 && !npcManager4.destroyed) npcManager4.npcs.forEach(cb); if (npcManager6 && !npcManager6.destroyed) npcManager6.npcs.forEach(cb); if (npcManagerDungeon1) npcManagerDungeon1.npcs.forEach(cb); if (npcManagerDungeon2) npcManagerDungeon2.npcs.forEach(cb); if (npcManagerDungeon3) npcManagerDungeon3.npcs.forEach(cb); };
    if (prop === 'delete')  return id => npcManager.npcs.delete(id) || npcManager2.npcs.delete(id) || (npcManager3 && npcManager3.npcs.delete(id)) || (npcManager4 && npcManager4.npcs.delete(id)) || (npcManager6 && npcManager6.npcs.delete(id)) || (npcManagerDungeon1 && npcManagerDungeon1.npcs.delete(id)) || (npcManagerDungeon2 && npcManagerDungeon2.npcs.delete(id)) || (npcManagerDungeon3 && npcManagerDungeon3.npcs.delete(id));
    return undefined;
  }
});

// 4. Boss managers (one per map zone)
let   bossManager  = new BossManager(wss, players, npcs, 1); // let — pode ser recriado
let   bossManager2 = new BossManager(wss, players, null, 2); // let — pode ser recriado
let   bossManager3 = null; // will be created when map 3 is entered

// 5. Wire everything into projectileManager
projectileManager.npcs          = allNpcs;
projectileManager.grantSkillXp  = grantSkillXp;
projectileManager.npcManagers   = [npcManager, npcManager2];
projectileManager.bossManager   = bossManager;
projectileManager.bossManager2  = bossManager2;
// Each bossManager uses its own zone's npcs map
bossManager.npcs  = npcManager.npcs;
bossManager2.npcs = npcManager2.npcs;

// 6. World Boss Manager — tracks total zone-boss kills and spawns the World Boss
const worldBossManager = new WorldBossManager(wss, players, [npcManager, npcManager2]);
projectileManager.worldBossManager = worldBossManager;

// 7. Dungeon boss kill callback — dispara handleDungeonComplete quando projétil mata o boss
projectileManager.onDungeonBossKilled = (killer, npc) => {
  if (!killer) return;
  handleDungeonComplete(killer, npc);
  _scheduleDungeonNpcRespawn(npc.dungeonId);
};

// ── Callbacks de Missões Diárias ─────────────────────────────────────────────
// Nomes dos monstros do recife (um por mapa 1-3)
const _REEF_NPC_NAMES = ['Abyssal Stalker', 'Dreadfin Leviathan', 'Gilded Reef Manta'];

function _setupMissionCallbacks(pmgr, bmgr, bmgr2) {
  // Centro e raio de detecção da ilha mercado (mapa 3) para missão marketDefense
  const _marketCenter = MAP_DEFS[3]?.market?.center || { x: 0, z: 0 };
  const _marketRadius = (MAP_DEFS[3]?.market?.securyRadius || 300) * 2;

  // ── NPC morto pelo jogador ─────────────────────────────────────────────────
  pmgr._onNpcKill = (killer, gold, npc) => {
    progressDailyMission(killer, 'npcKills',    1);
    progressDailyMission(killer, 'cannonKills', 1);   // todos os kills são com canhão
    progressDailyMission(killer, 'shipsSunk',   1);   // NPCs também são navios inimigos
    progressDailyMission(killer, 'goldEarned',  gold);

    // perfectKills: matar sem sofrer dano nos últimos 10 segundos
    const _noRecentDmg = !killer._lastDamageTakenAt
      || (Date.now() - killer._lastDamageTakenAt > 10000);
    if (_noRecentDmg) progressDailyMission(killer, 'perfectKills', 1);

    // reefKills: monstros específicos (Abyssal Stalker, Dreadfin Leviathan, Gilded Reef Manta)
    if (npc && _REEF_NPC_NAMES.some(n => (npc.name || '').startsWith(n))) {
      progressDailyMission(killer, 'reefKills', 1);
    }

    // marketDefense: kills perto da ilha mercado no mapa 3
    if (npc && npc.mapLevel === 3) {
      const _dx = (npc.x || 0) - _marketCenter.x;
      const _dz = (npc.z || 0) - _marketCenter.z;
      if (Math.sqrt(_dx * _dx + _dz * _dz) <= _marketRadius) {
        progressDailyMission(killer, 'marketDefense', 1);
      }
    }
  };

  // ── Jogador morto em PvP ───────────────────────────────────────────────────
  pmgr._onPvpKill = (killer, deadPlayer) => {
    progressDailyMission(killer, 'pvpKills', 1);
    progressDailyMission(killer, 'shipsSunk', 1);
    // eliteKills: matar jogador em navio elite
    if (deadPlayer && SHIP_DEFS[deadPlayer.activeShip]?.isElite) {
      progressDailyMission(killer, 'eliteKills', 1);
    }
  };

  pmgr._onPvpLoot = (killer, victim, xpGained, killsGained) => {
    // Notify killer of the loot
    const killerMapDef = MAP_DEFS[killer.mapLevel || 1] || {};
    sendTo(killer.ws, {
      type:       'currency_update',
      gold:        killer.gold,
      dobroes:     killer.dobroes,
      npcKills:    killer.npcKills,
      mapXp:       killer.mapXp,
      mapLevel:    killer.mapLevel || 1,
      mapXpNeeded: killerMapDef.xpToAdvance || 99999,
      mapFragments: killer.mapFragments || 0,
      reward: { type: 'pvp_loot', xp: xpGained, kills: killsGained },
    });
    // Notify victim of the loss
    const victimMapDef = MAP_DEFS[victim.mapLevel || 1] || {};
    sendTo(victim.ws, {
      type:       'currency_update',
      gold:        victim.gold,
      dobroes:     victim.dobroes,
      npcKills:    victim.npcKills,
      mapXp:       victim.mapXp,
      mapLevel:    victim.mapLevel || 1,
      mapXpNeeded: victimMapDef.xpToAdvance || 99999,
      mapFragments: victim.mapFragments || 0,
    });
    db.save(killer).catch(e => console.error('Save error:', e));
    db.save(victim).catch(e => console.error('Save error:', e));
  };

  // ── Jogador recebe dano ────────────────────────────────────────────────────
  pmgr._onPlayerDamaged = (player, dmg) => {
    player._lastDamageTakenAt = Date.now(); // reseta contador do perfectKills
    progressDailyMission(player, 'damageBlocked', dmg);
  };

  // ── Dano causado no boss mundial ───────────────────────────────────────────
  pmgr._onWorldBossDamage = (shooter, dmg) => {
    progressDailyMission(shooter, 'worldBossDamage', dmg);
  };

  // ── Boss regular morto ─────────────────────────────────────────────────────
  const bossCb       = (killer)      => progressDailyMission(killer,      'bossKills',   1);
  const bossAssistCb = (participant) => progressDailyMission(participant, 'bossAssists', 1);
  if (bmgr)  { bmgr._onBossKill  = bossCb; bmgr._onBossAssist  = bossAssistCb; }
  if (bmgr2) { bmgr2._onBossKill = bossCb; bmgr2._onBossAssist = bossAssistCb; }
}
_setupMissionCallbacks(projectileManager, bossManager, bossManager2);

// Recalc sail speed bonus from equipped sails
function _recalcSails(player) {
  let mult = 1.0;
  (player.equippedSails || []).forEach(sid => {
    const def = SAIL_DEFS[sid];
    if (def) mult += def.speedBonus;
  });
  player.sailSpeedMult = mult;
}

// Recalc cannon stats from equipped list (applies per-cannon C6 upgrades)
function recalcCannons(player) {
  if (!player.cannons.length) {
    player.cannonRange       = 80;
    player.cannonCooldownMax = 5000;
    player.cannonLifesteal   = 0;
    player.cannonDamage      = 0;
    player.cannonCooldown    = 0;
    return;
  }

  // Build index: c6 slots in inventory ordered by position
  const invC6Indices = (player.inventory?.cannons || []).reduce((acc, id, i) => {
    if (id === 'c6') acc.push(i);
    return acc;
  }, []);
  const upgData    = player.cannonUpgradesData || [];
  const c6UpgDefs  = (MAP_DEFS[3]?.market?.items?.[0]?.cannonUpgrades) || [];

  let bestRange = 0, sumCd = 0, bestLifesteal = 0, totalDmg = 0;
  let equippedC6Count = 0;

  debugServer(`[server] recalcCannons for player ${player.name || player.id}: cannons=${JSON.stringify(player.cannons)}`);
  player.cannons.forEach(cid => {
    const d = CANNON_DEFS[cid];
    if (!d) {
      debugServer(`[server]   missing CANNON_DEFS for id='${cid}'`);
      return;
    }

    let effectiveRange    = d.range;
    let effectiveCooldown = d.cooldown;
    let effectiveDamage   = d.damage || 0;

    // Apply per-instance C6 upgrades
    if (cid === 'c6') {
      const invIdx = invC6Indices[equippedC6Count];
      const upg    = (invIdx !== undefined) ? (upgData[invIdx] || {}) : {};
      for (const ud of c6UpgDefs) {
        if (!upg[ud.field]) continue;
        if (ud.attackSpeedBonus) effectiveCooldown = Math.max(500, effectiveCooldown + ud.attackSpeedBonus);
        if (ud.rangeBonus)       effectiveRange    += ud.rangeBonus;
        if (ud.damageBonus)      effectiveDamage   = Math.round(effectiveDamage * (1 + ud.damageBonus));
      }
      equippedC6Count++;
    }

    debugServer(`[server]   cannon '${cid}' -> range=${effectiveRange}, cooldown=${effectiveCooldown}`);
    bestRange     = Math.max(bestRange, effectiveRange);
    sumCd        += effectiveCooldown;
    bestLifesteal = Math.max(bestLifesteal, d.lifesteal || 0);
    totalDmg     += effectiveDamage;
  });

  player.cannonRange       = bestRange;
  player.cannonCooldownMax = Math.round(sumCd / player.cannons.length);
  player.cannonLifesteal   = Math.min(bestLifesteal, 0.5);
  player.cannonDamage      = Math.round(totalDmg / player.cannons.length);
  player.cannonCooldown    = 0;
  debugServer(`[server]   -> result: cannonRange=${player.cannonRange}, cooldownMax=${player.cannonCooldownMax}, lifesteal=${player.cannonLifesteal}`);
}

// Total projectiles per salvo
function salvoCount(player) {
  return player.cannons.reduce((sum, cid) => {
    const d = CANNON_DEFS[cid];
    return sum + (d?.doubleShot ? 2 : 1);
  }, 0) || 1;
}

// Game loop
let lastTick = Date.now();
// ── Skill XP helper ─────────────────────────────────────────────────────────
function xpForLevel(n) { return 50 * n * n; }

function grantSkillXp(player, skill, amount, wss) {
  if (!player.skills) return;
  const sk = player.skills[skill];
  if (!sk) return;
  sk.xp += amount;
  let leveled = false;
  while (sk.xp >= xpForLevel(sk.level)) {
    sk.xp -= xpForLevel(sk.level);
    sk.level++;
    leveled = true;
  }
  // Broadcast XP gain to that player
  sendTo(player.ws, { type: 'skill_xp', skill, amount, level: sk.level });
  if (leveled) {
    // Recalculate player multipliers based on new skill level
    applySkillMultipliers(player);
  }
}

function applySkillMultipliers(player) {
  if (!player.skills) return;
  player.skillDamageMult = 1 + (player.skills.ataque.level          - 1) / 100;
  player.skillSpeedMult  = 1 + (player.skills.velocidade.level       - 1) / 100;
  player.skillDefense    =     (player.skills.defesa.level           - 1) / 100; // damage reduction
  player.skillRelicBonus =     ((player.skills.reliquia?.level || 1) - 1) / 100; // +1% por nível de relíquia
  // vida: recalcula maxHp (skill + talent bônus de HP combinados)
  recalcMaxHp(player);
}

// Aplica bônus de talentos nos campos de player usados pelo servidor
function applyTalentBonuses(player) { _applyTalentBonuses(player, TALENT_DEFS); }
function recalcMaxHp(player)        { _recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS); }

// ── Missões Diárias ──────────────────────────────────────────────────────────
function todayDateStr() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

// Notifica qualquer jogador que esteja caçando `targetPlayer` sobre mudança de mapa
function _notifyWantedHunters(targetPlayer) {
  players.forEach(hunter => {
    if (!hunter.wantedTarget || hunter.wantedTarget.targetId !== targetPlayer.id) return;
    hunter.wantedTarget.targetMapLevel = targetPlayer.mapLevel || 1;
    sendTo(hunter.ws, {
      type:           'wanted_target_moved',
      targetId:       targetPlayer.id,
      targetMapLevel: targetPlayer.mapLevel || 1,
    });
  });
}

// Sorteia N missões do dia (mesmas para todos — seed determinística pela data)
function getDailyMissionPool() {
  const allDefs = (MAP_DEFS[4] && MAP_DEFS[4].dailyMissions) || [];
  const count   = (MAP_DEFS[4] && MAP_DEFS[4].dailyMissionCount) || 5;
  if (allDefs.length <= count) return allDefs;

  const today = todayDateStr();
  let seed = today.replace(/-/g, '').split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7);
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return Math.abs(seed); };

  const arr = [...allDefs];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, count);
}

// Garante que o jogador tem missões do dia; reseta se for outro dia.
function buildDailyMissions(player) {
  const today   = todayDateStr();
  const pool    = getDailyMissionPool();
  const poolIds = pool.map(m => m.id);

  // Força reset se: sem dados, data diferente, pool não definido, ou tamanho do pool errado
  const needsReset = !player.dailyMissions
    || player.dailyMissions.date !== today
    || !player.dailyMissions.pool
    || player.dailyMissions.pool.length !== poolIds.length;

  if (needsReset) {
    player.dailyMissions = {
      date:          today,
      pool:          poolIds,
      activeMission: null,
      progress:      Object.fromEntries(pool.map(m => [m.id, 0])),
      claimed:       Object.fromEntries(pool.map(m => [m.id, false])),
    };
  } else {
    player.dailyMissions.pool = poolIds;
    for (const m of pool) {
      if (!(m.id in player.dailyMissions.progress)) {
        player.dailyMissions.progress[m.id] = 0;
        player.dailyMissions.claimed[m.id]  = false;
      }
    }
    const validIds = new Set(poolIds);
    for (const key of Object.keys(player.dailyMissions.progress)) {
      if (!validIds.has(key)) { delete player.dailyMissions.progress[key]; delete player.dailyMissions.claimed[key]; }
    }
    if (player.dailyMissions.activeMission && !validIds.has(player.dailyMissions.activeMission)) {
      player.dailyMissions.activeMission = null;
    }
  }

  return pool.map(m => ({
    id:       m.id,
    icon:     m.icon,
    label:    m.label,
    target:   m.target,
    reward:   m.reward,
    progress: player.dailyMissions.progress[m.id] || 0,
    claimed:  player.dailyMissions.claimed[m.id]  || false,
    active:   player.dailyMissions.activeMission  === m.id,
  }));
}

// Atualiza progresso APENAS da missão ativa e envia update ao cliente em tempo real
function progressDailyMission(player, stat, amount = 1) {
  if (!player.dailyMissions) buildDailyMissions(player);
  if (player.dailyMissions.date !== todayDateStr()) buildDailyMissions(player);

  const activeId  = player.dailyMissions.activeMission;
  if (!activeId) return;

  const pool      = getDailyMissionPool();
  const activeDef = pool.find(m => m.id === activeId);
  if (!activeDef || activeDef.stat !== stat) return;
  if (player.dailyMissions.claimed[activeId]) return;

  const prev = player.dailyMissions.progress[activeId] || 0;
  if (prev >= activeDef.target) return;
  player.dailyMissions.progress[activeId] = Math.min(activeDef.target, prev + amount);

  sendTo(player.ws, {
    type:     'mission_progress',
    id:       activeId,
    progress: player.dailyMissions.progress[activeId],
    target:   activeDef.target,
  });
}

const TICK_RATE = parseInt(process.env.TICK_RATE || process.env.VITE_TICK_RATE) || 16
setInterval(() => {
  const now = Date.now();
  const dt  = (now - lastTick) / 1000;
  lastTick  = now;

  playerManager.update(dt);

  // ── distanceSailed: rastreia distância percorrida por jogadores ───────────
  players.forEach(p => {
    if (p.dead || p.x === undefined || p.z === undefined) return;
    if (p._lastMissionPos) {
      const _ddx  = p.x - p._lastMissionPos.x;
      const _ddz  = p.z - p._lastMissionPos.z;
      const _dist = Math.sqrt(_ddx * _ddx + _ddz * _ddz);
      // Sanity check: ignora teleports (> 200u) e movimentos mínimos (< 0.5u)
      if (_dist >= 0.5 && _dist < 200) {
        progressDailyMission(p, 'distanceSailed', Math.round(_dist));
      }
    }
    p._lastMissionPos = { x: p.x, z: p.z };
  });

  // ── AFK Training tick — verifica expiração do tempo de treino (60 s) ────────
  if (!global._afkTickTimer) global._afkTickTimer = 0;
  global._afkTickTimer += dt * 1000;
  if (global._afkTickTimer >= 60000) {
    global._afkTickTimer = 0;
    const _afkNow = Date.now();
    players.forEach(p => {
      if (!p.afkTraining) return;
      if (_afkNow >= (p.afkUntil || 0)) {
        // Tempo esgotado → devolver ao mapa de origem automaticamente
        p.afkTraining = false;
        p.afkUntil    = null;
        const _retMap  = p._afkFromMap || 4;
        const _retSize = MAP_DEFS[_retMap]?.size || 1200;
        p.mapLevel = _retMap;
        p.x = (_retMap === 4) ? (_retSize / 2) - 80 : 0;
        p.z = 0;
        if (_retMap === 3) ensureMap3Managers();
        db.save(p, true).catch(e => console.error('Save error:', e));
        sendTo(p.ws, {
          type: 'map_transition', toLevel: _retMap,
          mapDef: MAP_DEFS[_retMap], mapSize: _retSize,
          x: p.x, z: p.z, mapXp: p.mapXp || 0, npcs: [],
          bossProgress: null,
          dailyMissions: _retMap === 4 ? buildDailyMissions(p) : undefined,
        });
        sendTo(p.ws, { type: 'afk_ended', reason: 'expired' });
        return;
      }
      sendTo(p.ws, { type: 'afk_tick', afkUntil: p.afkUntil });
    });
  }

  // ── Torre de treino — dispara no barco a cada fireInterval ───────────────────
  {
    const _tNow    = Date.now();
    const _trDef   = MAP_DEFS[5]?.training;
    if (_trDef) {
      const _tBaseDmg  = _trDef.baseDamage     || 500;
      const _tFireInt  = _trDef.fireInterval    || 3000;
      const _tDetRad   = _trDef.detectionRadius || 250;
      const _tTowerX   = _trDef.dummy?.x ?? 0;
      const _tTowerZ   = _trDef.dummy?.z ?? -120;
      players.forEach(p => {
        if (p.mapLevel !== 5 || p.dead) return; // qualquer player no mapa 5
        const _tdx = p.x - _tTowerX;
        const _tdz = p.z - _tTowerZ;
        if ((_tdx * _tdx + _tdz * _tdz) > _tDetRad * _tDetRad) return;
        if (!p._towerNextShot) p._towerNextShot = _tNow + _tFireInt;
        if (_tNow < p._towerNextShot) return;
        p._towerNextShot = _tNow + _tFireInt;
        // Barco não pode morrer — HP mínimo: 1
        const _tFinalDmg = Math.max(0, Math.min(_tBaseDmg, p.hp - 1));
        if (_tFinalDmg > 0) {
          p.hp -= _tFinalDmg;
          // XP de defesa por levar dano da torre (idêntico ao projétil)
          grantSkillXp(p, 'defesa', Math.max(1, Math.floor(_tFinalDmg / 5)), wss);
        }
        sendTo(p.ws, { type: 'tower_shot', damage: _tFinalDmg, hp: p.hp, maxHp: p.maxHp });
      });
    }
  }

  // ── Data-driven border detection based on sideMap ───────────────────────────
  players.forEach(p => {
    if (p.dead) return;
    if (p.afkTraining || p.mapLevel === 5) return; // AFK: sem transição por borda

    const level = p.mapLevel || 1;
    const mapDef = MAP_DEFS[level];
    if (!mapDef) return;

    const sideMapEntry = mapDef.sideMap?.[0];
    if (!sideMapEntry) return;

    const mapSize = mapDef.size;
    const EDGE = 20;   // detecção dentro de 20 unidades da borda
    const SPAWN = 150; // offset de spawn na borda oposta do mapa destino

    const DIRS = {
      norte: {
        triggered: () => p.z <= -(mapSize / 2) + EDGE,
        block:     () => { p.z = -(mapSize / 2) + EDGE; },
        spawnAxis: 'z',
        spawnValue: (s) => (s / 2) - SPAWN,
      },
      sul: {
        triggered: () => p.z >= (mapSize / 2) - EDGE,
        block:     () => { p.z = (mapSize / 2) - EDGE; },
        spawnAxis: 'z',
        spawnValue: (s) => -(s / 2) + SPAWN,
      },
      left: {
        triggered: () => p.x <= -(mapSize / 2) + EDGE,
        block:     () => { p.x = -(mapSize / 2) + EDGE; },
        spawnAxis: 'x',
        spawnValue: (s) => (s / 2) - 80,
      },
      right: {
        triggered: () => p.x >= (mapSize / 2) - EDGE,
        block:     () => { p.x = (mapSize / 2) - EDGE; },
        spawnAxis: 'x',
        spawnValue: (s) => -(s / 2) + 80,
      },
    };

    let mapChanged = false;
    for (const [dir, targetLevel] of Object.entries(sideMapEntry)) {
      if (mapChanged) break;
      const trans = DIRS[dir];
      if (!trans || !trans.triggered()) continue;

      // Mapa 5 (Treino AFK) é acessível apenas por compra — bloqueia borda
      if (targetLevel === 5) {
        trans.block();
        break;
      }

      const targetDef = MAP_DEFS[targetLevel];
      if (!targetDef) { trans.block(); break; }

      // Gate de XP: apenas em direção 'norte' quando mapDef.xpToAdvance está definido
      if (dir === 'norte' && mapDef.xpToAdvance) {
        const xp = p.mapXp || 0;
        if (xp < mapDef.xpToAdvance) {
          trans.block();
          if (!p._borderMsgCooldown || Date.now() - p._borderMsgCooldown > 4000) {
            p._borderMsgCooldown = Date.now();
            sendTo(p.ws, { type: 'border_blocked', level, xp, needed: mapDef.xpToAdvance, nextMapName: targetDef.name });
          }
          break;
        }
      }

      // Transição confirmada
      console.log(`🗺️ ${p.name}: mapa ${level} → ${targetLevel} (${dir})`);
      const targetSize = targetDef.size;
      if (trans.spawnAxis === 'z') {
        p.z = trans.spawnValue(targetSize);
      } else {
        p.x = trans.spawnValue(targetSize);
      }

      p.mapLevel = targetLevel;
      _notifyWantedHunters(p);

      // islandsVisited — missão diária
      { const _ivToday = todayDateStr();
        if (!p._visitedIslandsDate || p._visitedIslandsDate !== _ivToday) {
          p._visitedIslandsDate = _ivToday; p._visitedIslands = new Set();
        }
        const _ivPrev = p._visitedIslands.size;
        p._visitedIslands.add(targetLevel);
        if (p._visitedIslands.size > _ivPrev) progressDailyMission(p, 'islandsVisited', 1);
      }

      p.input = { w: false, a: false, s: false, d: false };
      p.speed = 0;
      ensureManagersForMap(targetLevel);
      db.save(p, true).catch(e => console.error('Save error:', e));

      const targetMgr = getMapManager(targetLevel);
      const bpKts = targetDef.boss?.killsToSpawn ?? 10;
      const bpTot = getMapKills(targetLevel);
      const bpAlive = getMapBossAlive(targetLevel);
      sendTo(p.ws, {
        type:    'map_transition',
        toLevel: targetLevel,
        mapDef:  targetDef,
        mapSize: targetSize,
        x:       p.x,
        z:       p.z,
        mapXp:   p.mapXp || 0,
        npcs:    targetMgr ? targetMgr.snapshot() : [],
        bossProgress: targetDef.boss
          ? (bpKts === 0
              ? { current: 0, needed: 0, mapLevel: targetLevel, bossAlive: bpAlive }
              : { current: bpTot % bpKts, needed: bpKts, mapLevel: targetLevel, bossAlive: bpAlive })
          : null,
        dailyMissions: targetLevel === 4 ? buildDailyMissions(p) : undefined,
      });
      mapChanged = true;
    }
  });

  // Only update map NPCs that have players in their zone
  const map1Players = new Map([...players].filter(([,p]) => (p.mapLevel||1) === 1));
  const map2Players = new Map([...players].filter(([,p]) => (p.mapLevel||1) === 2));
  const map3Players = new Map([...players].filter(([,p]) => (p.mapLevel||1) === 3));
  if (!npcManager.destroyed)   npcManager.update(dt, map1Players);
  if (!npcManager2.destroyed)  npcManager2.update(dt, map2Players);
  if (npcManager3 && !npcManager3.destroyed) npcManager3.update(dt, map3Players);
  const map4Players = new Map([...players].filter(([,p]) => (p.mapLevel||1) === 4));
  if (npcManager4 && !npcManager4.destroyed) npcManager4.update(dt, map4Players);
  const map6Players = new Map([...players].filter(([,p]) => (p.mapLevel||1) === 6));
  if (npcManager6 && !npcManager6.destroyed) npcManager6.update(dt, map6Players);
  const mapD1Players = new Map([...players].filter(([,p]) => p.mapLevel === 10));
  if (npcManagerDungeon1) npcManagerDungeon1.update(dt, mapD1Players);
  const mapD2Players = new Map([...players].filter(([,p]) => p.mapLevel === 11));
  if (npcManagerDungeon2) npcManagerDungeon2.update(dt, mapD2Players);
  const mapD3Players = new Map([...players].filter(([,p]) => p.mapLevel === 12));
  if (npcManagerDungeon3) npcManagerDungeon3.update(dt, mapD3Players);
  projectileManager.update(dt);

  // ── World Boss: auto-destruição após expireDelay sem tomar dano ──────────
  if (worldBossManager.worldBossAlive && worldBossManager.worldBossId) {
    const wbNpc = projectileManager.npcs.get(worldBossManager.worldBossId);
    if (wbNpc && !wbNpc.dead) {
      const expireDelay = WORLD_BOSS_DEF[0].expireDelay || 600000; // 10min default
      const timeSinceDmg = now - (wbNpc.lastDamageTime || 0);
      if (wbNpc.lastDamageTime > 0 && timeSinceDmg >= expireDelay) {
        // Limpar timer de inatividade antes de expirar (evita vazamento de referência)
        if (wbNpc._inactivityTimer) { clearTimeout(wbNpc._inactivityTimer); wbNpc._inactivityTimer = null; }
        wbNpc.dead = true;
        projectileManager.npcs.delete(wbNpc.id);
        worldBossManager.worldBossAlive = false;
        worldBossManager.worldBossId    = null;
        addEvent({ type: 'entity_dead', id: wbNpc.id, isNPC: true, isBoss: true, isWorldBoss: true }, wbNpc.mapLevel);
        addEvent({ type: 'world_boss_expired', bossId: wbNpc.id }, wbNpc.mapLevel);
      }
    }
  }

  // ── Limpar debuffs expirados ──────────────────────────────────────────────
  if (players.size > 0) {
    const _nowDebuff = Date.now();
    players.forEach(p => {
      if (!p.activeDebuffs?.length) return;
      p.activeDebuffs = p.activeDebuffs.filter(d => d.expiresAt > _nowDebuff);
    });
  }

  // ── Base passive heal — 2 HP every 5s out of combat ─────────────────────
  if (!global._baseHealTimer) global._baseHealTimer = 0;
  global._baseHealTimer += now - (global._lastBaseHeal || now);
  global._lastBaseHeal = now;
  if (global._baseHealTimer >= 5000) {
    global._baseHealTimer = 0;
    players.forEach(p => {
      if (p.dead || p.hp >= p.maxHp) return;
      if (now - (p.lastCombatTime || 0) < 6000) return; // no heal in combat
      p.hp = Math.min(p.maxHp, p.hp + 2);
      sendTo(p.ws, { type: 'heal', amount: 2, hp: p.hp, source: 'passive' });
      grantSkillXp(p, 'vida', 2, wss);
    });
  }

  // ── Healer pirate tick ────────────────────────────────────────────────────
  players.forEach(p => {
    if (p.dead || p.hp >= p.maxHp) return;
    const healerType = p.pirates?.find(pr => pr === 'healer' || pr === 'healer_elite');
    if (!healerType) return;

    const pirateDef = PIRATE_DEFS[healerType];
    if (!pirateDef?.healPct || !pirateDef?.healInterval) return;

    const timeSinceCombat = now - (p.lastCombatTime || 0);
    if (pirateDef.needsIdle && timeSinceCombat < (pirateDef.combatCooldown || 2000)) return;

    if (!p._healerTimer) p._healerTimer = 0;
    p._healerTimer += dt * 1000;

    if (p._healerTimer >= pirateDef.healInterval) {
      p._healerTimer = 0;
      const amount = Math.max(1, Math.round(p.maxHp * pirateDef.healPct));
      const prev = p.hp;
      p.hp = Math.min(p.maxHp, p.hp + amount);
      const healed = p.hp - prev;
      if (healed > 0) {
        sendTo(p.ws, { type: 'heal', amount: healed, hp: p.hp, source: 'healer' });
      }
    }
  });

  // DOT tick — process all entities without creating temporary arrays
  // ── Relic timed effects ──────────────────────────────────────────────────
  players.forEach(p => {
    if (p.dead) return;
    // Speed boost expiry
    if (p.relicSpeedExpires && now >= p.relicSpeedExpires) {
      p.relicSpeedExpires = 0;
      p.relicSpeedBonus   = 0;
      sendTo(p.ws, { type: 'relic_effect_end', effect: 'speed_boost' });
    }
    // Invincibility expiry
      if (p.relicInvincibleExpires && now >= p.relicInvincibleExpires) {
      p.relicInvincibleExpires = 0;
      sendTo(p.ws, { type: 'relic_effect_end', effect: 'invincible' });
    }
    // Attract expiry
    if (p.relicAttractExpires && now >= p.relicAttractExpires) {
      p.relicAttractExpires = 0;
      p.relicAttractRange   = 0;
    }

    // ── Aura Mortal: tick de dano ────────────────────────────────────────────
    if (p.relicAuraExpires) {
        if (now >= p.relicAuraExpires) {
        // Aura expirou
        p.relicAuraExpires      = 0;
        p.relicAuraRange        = 0;
        p.relicAuraDamage       = 0;
        p.relicAuraTickInterval = 0;
        // send end only to players in same map
        sendTo(p.ws, { type: 'aura_end', playerId: p.id });
        const ownerMap = p.mapLevel || 1;
        players.forEach(pl => {
          if ((pl.mapLevel || 1) === ownerMap) sendTo(pl.ws, { type: 'aura_end', playerId: p.id });
        });
      } else if (now - (p.relicAuraLastTick || 0) >= (p.relicAuraTickInterval || 1000)) {
        // Processa tick de dano
        p.relicAuraLastTick = now;
        const aRange  = p.relicAuraRange  || 80;
        const aDamage = Math.round(p.relicAuraDamage * (1 + (p.talentRelicBonus || 0) + (p.skillRelicBonus || 0)));
        const aHits   = [];

        projectileManager.npcs.forEach(npc => {
          if (npc.dead) return;
          if (Math.hypot(npc.x - p.x, npc.z - p.z) > aRange) return;
          npc.hp = Math.max(0, npc.hp - aDamage);
          npc.lastDamageTime = now;
          // Track damage on boss for proportional rewards
          if (npc.isBoss) {
            if (!npc._damageMap) npc._damageMap = new Map();
            npc._damageMap.set(p.id, (npc._damageMap.get(p.id) || 0) + aDamage);
          }
          aHits.push({ id: npc.id, hp: npc.hp, isNPC: true });
          if (npc.hp <= 0 && !npc.dead) {
            npc.dead = true;
            if (npc.isBoss) {
              addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, isBoss: true, killerId: p.id }, npc.mapLevel);
              if (npc.isWorldBoss) {
                worldBossManager.onWorldBossDead(npc, p.id);
              } else {
                const _aBossLvl = npc.mapLevel || 1;
              const aBossMgr = _aBossLvl === 3 ? bossManager3 : _aBossLvl === 2 ? bossManager2 : bossManager;
                aBossMgr.onBossDead(npc, p.id);
                worldBossManager.onZoneBossDead(npc, p.id);
              }
              projectileManager.npcs.delete(npc.id);
            } else if (npc.isDungeonBoss) {
              addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, killerId: p.id, goldDrop: 0 }, npc.mapLevel);
              projectileManager.npcs.delete(npc.id);
              handleDungeonComplete(p, npc);
              _scheduleDungeonNpcRespawn(npc.dungeonId);
            } else {
              const rewards = projectileManager.grantNpcKillRewards(p, npc);
              addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, killerId: p.id, goldDrop: rewards.goldDrop }, npc.mapLevel);
              const _nLvlA = npc.mapLevel || 1;
              const aMgr = _nLvlA === 4 ? npcManager4 : _nLvlA === 3 ? npcManager3 : _nLvlA === 2 ? npcManager2 : npcManager;
              aMgr && aMgr.respawnScaled(npc.id, p.npcKills || 0, _nLvlA);
              // Boss spawn accounting (aura kill)
              { const _bpLvlA = _nLvlA;
                if (_bpLvlA === 3) projectileManager.totalNpcKills3 = (projectileManager.totalNpcKills3||0)+1;
                else if (_bpLvlA === 2) projectileManager.totalNpcKills2 = (projectileManager.totalNpcKills2||0)+1;
                else projectileManager.totalNpcKills = (projectileManager.totalNpcKills||0)+1;
                const _bpKtsA = MAP_DEFS[_bpLvlA]?.boss?.killsToSpawn ?? 10;
                const _bpTotA = _bpLvlA===3 ? projectileManager.totalNpcKills3 : _bpLvlA===2 ? projectileManager.totalNpcKills2 : projectileManager.totalNpcKills;
                const _bpBmgrA = _bpLvlA===3 ? bossManager3 : _bpLvlA===2 ? bossManager2 : bossManager;
                if ((_bpTotA % _bpKtsA) === 0 && _bpBmgrA && !_bpBmgrA.bossAlive) {
                  const rarity = _bpBmgrA.rollPendingRarity();
                  addEvent({ type:'boss_incoming', rarity, mapLevel:_bpLvlA }, npc.mapLevel);
                  setTimeout(() => _bpBmgrA.spawn(p.npcKills||0), 2000);
                }
                addEvent({ type:'boss_progress', current:_bpTotA%_bpKtsA, needed:_bpKtsA, mapLevel:_bpLvlA, bossAlive:!!_bpBmgrA?.bossAlive }, _bpLvlA);
              }
              db.save(p).catch(e => console.error('Save error:', e));
              const curMapDef = MAP_DEFS[p.mapLevel];
              sendTo(p.ws, {
                type: 'currency_update', 
                gold: p.gold, 
                dobroes: p.dobroes,
                reward: { type: 'gold', amount: rewards.finalGold },
                npcKills: p.npcKills, mapXp: p.mapXp,
                mapLevel: p.mapLevel || 1, mapXpNeeded: curMapDef.xpToAdvance || 99999,
                mapFragments: p.mapFragments || 0,
              });
            }
          }
        });

        // ── Aura damages nearby PLAYERS too (bypasses invincibility/gold shield —
        //    attack relics intentionally ignore defensive relics) ─────────────────
        players.forEach(target => {
          if (target.dead || target.id === p.id) return;
          // Zone isolation
          if ((target.mapLevel || 1) !== (p.mapLevel || 1)) return;
          if (Math.hypot(target.x - p.x, target.z - p.z) > aRange) return;
          target.hp = Math.max(0, target.hp - aDamage);
          target.lastCombatTime = now;
          aHits.push({ id: target.id, hp: target.hp, isNPC: false });
          if (target.hp <= 0 && !target.dead) {
            target.dead = true;
            addEvent({ type: 'entity_dead', id: target.id, isNPC: false, killerId: p.id }, target.mapLevel);
          }
        });

        // broadcast aura tick only to players in the same map level
        const auraMsg = { type: 'aura_tick', playerId: p.id, x: p.x, z: p.z, range: aRange, hits: aHits };
        const auraMap = p.mapLevel || 1;
        players.forEach(pl => {
          if ((pl.mapLevel || 1) === auraMap) sendTo(pl.ws, auraMsg);
        });
        // XP de relíquia pela aura (1 XP por hit em NPC)
        const auraRelicHits = aHits.filter(h => h.isNPC).length;
        if (auraRelicHits > 0) grantSkillXp(p, 'reliquia', auraRelicHits * 9, wss);
      }
    }
  });

  // Velocity XP — 1 XP every 2s of combat movement
  playerManager.getAll().forEach(p => {
    if (p.dead) return;
    if (!p.lastCombatTime || now - p.lastCombatTime > 8000) return;
    if (p.speed > 0.1) {
      if (!p._velXpTimer) p._velXpTimer = 0;
      p._velXpTimer += dt * 1000;
      if (p._velXpTimer >= 2000) {
        grantSkillXp(p, 'velocidade', 1, wss);
        p._velXpTimer = 0;
      }
    } else {
      p._velXpTimer = 0;
    }
  });

  // Reusable dot batch collector — reset each tick, no alloc if empty
  if (!global._dotBatch) global._dotBatch = [];
  const dotBatch = global._dotBatch;
  dotBatch.length = 0;

  function processDots(e, isNPC) {
    if (!e.dots || e.dots.length === 0 || e.dead) return;
    e.dots = e.dots.filter(dot => {
      if (now < dot.next) return true;
      e.hp = Math.max(0, e.hp - dot.dmg);
      dot.dur -= dot.tick;
      dot.next = now + dot.tick;
      const effect = dot.effect || 'fire';
      dotBatch.push({ targetId: e.id, targetIsNPC: isNPC, dmg: dot.dmg, effect, x: e.x, z: e.z, mapLevel: e.mapLevel || 1 });
      // DOT kill — handle death if HP reached 0
      if (e.hp <= 0 && !e.dead) {
        e.dead = true;
        if (isNPC) {
          const killer = players.get(dot.ownerId);
          if (e.isBoss) {
            addEvent({ type: 'entity_dead', id: e.id, isNPC: true, isBoss: true, killerId: dot.ownerId }, e.mapLevel);
            const _dotBossLvl = e.mapLevel || 1;
            const dotBossMgr = _dotBossLvl === 3 ? bossManager3 : _dotBossLvl === 2 ? bossManager2 : bossManager;
            dotBossMgr.onBossDead(e, dot.ownerId);
            projectileManager.npcs.delete(e.id);
          } else {
            // Use per-map npc gold values (e.mapLevel for correct zone)
            const dotNpcDef = (MAP_DEFS[e.mapLevel || 1] || MAP_DEFS[1]).npc || {};
            const dotGoldMin = dotNpcDef.goldMin;
            const dotGoldMax = dotNpcDef.goldMax;
            const baseGold  = Math.floor(Math.random() * (dotGoldMax - dotGoldMin + 1) + dotGoldMin);
            if (killer) {
              killer.npcKills = (killer.npcKills || 0) + 1;
              const tier = Math.floor(killer.npcKills / 10);
              const gold = Math.floor(baseGold * (1 + (killer.dropBonus||0)) * (1 + tier*0.01));
              killer.gold += gold;
              // Dobrao drop
              if ((dotNpcDef.dobraoChance || 0) > 0 && Math.random() < dotNpcDef.dobraoChance) {
                const dAmt = Math.floor(Math.random() * (dotNpcDef.dobraoMax - dotNpcDef.dobraoMin + 1) + dotNpcDef.dobraoMin);
                killer.dobroes = (killer.dobroes || 0) + dAmt;
              }
              // XP grant on DOT kill — use e.mapLevel (NPC zone), not killer.mapLevel
              const dotXpMapDef = MAP_DEFS[e.mapLevel || 1] || MAP_DEFS[1];
              const xpGained = Math.floor((dotXpMapDef.npc?.xpPerKill || 12) * (1 + tier * 0.01));
              killer.mapXp = (killer.mapXp || 0) + xpGained;
              // XP is lifetime total — never reset, mapLevel only changes at border
              const xpNeeded = (MAP_DEFS[killer.mapLevel || 1] || MAP_DEFS[1]).xpToAdvance || 99999;
              if (xpNeeded && killer.mapXp >= xpNeeded && MAP_DEFS[(killer.mapLevel||1) + 1]) {
                if (!killer._mapUnlockNotified) {
                  killer._mapUnlockNotified = true;
                  sendTo(killer.ws, { type: 'map_level_up', level: (killer.mapLevel||1) + 1, xpNeeded });
                }
              } else {
                killer._mapUnlockNotified = false;
              }
              // Fragment drop (DOT kill path)
              killer.mapFragments = (killer.mapFragments || 0) + FRAGMENT_DROP_NPC;
              db.save(killer).catch(e => console.error('Save error:', e));
              const curXpNeeded = (MAP_DEFS[killer.mapLevel || 1] || MAP_DEFS[1]).xpToAdvance || 99999;
              sendTo(killer.ws, { type: 'currency_update', gold: killer.gold, dobroes: killer.dobroes, reward: { type:'gold', amount: gold }, npcKills: killer.npcKills, mapXp: killer.mapXp, mapLevel: killer.mapLevel || 1, mapXpNeeded: curXpNeeded, mapFragments: killer.mapFragments });
            }
            addEvent({ type: 'entity_dead', id: e.id, isNPC: true, goldDrop: baseGold, killerId: dot.ownerId }, e.mapLevel);
            const dotNpcLevel = e.mapLevel || 1;
            if (dotNpcLevel === 3) {
              if (!npcManager3 || npcManager3.destroyed) ensureMap3Managers();
            }
            let dotMgr;
            if (dotNpcLevel === 4) dotMgr = npcManager4;
            else if (dotNpcLevel === 3) dotMgr = npcManager3;
            else if (dotNpcLevel === 2) dotMgr = npcManager2;
            else dotMgr = npcManager;
            dotMgr && dotMgr.respawnScaled(e.id, killer ? (killer.npcKills||0) : 0, dotNpcLevel);
            // Boss spawn trigger — works for all map zones
            if (dotNpcLevel === 3) {
              projectileManager.totalNpcKills3 = (projectileManager.totalNpcKills3 || 0) + 1;
              const kts3 = MAP_DEFS[dotNpcLevel]?.boss?.killsToSpawn ?? 10;
              console.log(`[boss-debug] map3 kill=${projectileManager.totalNpcKills3} kts=${kts3} bossAlive=${!!bossManager3?.bossAlive}`);
              if ((projectileManager.totalNpcKills3 % kts3) === 0 && !bossManager3.bossAlive) {
                const rarity = bossManager3.rollPendingRarity();
                addEvent({ type: 'boss_incoming', rarity, mapLevel: 3 }, dotNpcLevel);
                const dotKills3 = killer ? (killer.npcKills || 0) : 0;
                const timerId3 = setTimeout(() => bossManager3.spawn(dotKills3), 2000);
                console.log(`[boss-debug] scheduled spawn timer=${timerId3} for map=3 (dotKills=${dotKills3})`);
              }
            } else if (dotNpcLevel === 2) {
              projectileManager.totalNpcKills2 = (projectileManager.totalNpcKills2 || 0) + 1;
              const kts2 = MAP_DEFS[dotNpcLevel]?.boss?.killsToSpawn ?? 10;
              console.log(`[boss-debug] map2 kill=${projectileManager.totalNpcKills2} kts=${kts2} bossAlive=${!!bossManager2?.bossAlive}`);
              if ((projectileManager.totalNpcKills2 % kts2) === 0 && !bossManager2.bossAlive) {
                const rarity = bossManager2.rollPendingRarity();
                addEvent({ type: 'boss_incoming', rarity, mapLevel: 2 }, dotNpcLevel);
                const dotKills2 = killer ? (killer.npcKills || 0) : 0;
                const timerId2 = setTimeout(() => bossManager2.spawn(dotKills2), 2000);
                console.log(`[boss-debug] scheduled spawn timer=${timerId2} for map=2 (dotKills=${dotKills2})`);
              }
            } else {
              projectileManager.totalNpcKills++;
              const kts1 = MAP_DEFS[dotNpcLevel]?.boss?.killsToSpawn ?? 10;
              console.log(`[boss-debug] map1 kill=${projectileManager.totalNpcKills} kts=${kts1} bossAlive=${!!bossManager?.bossAlive}`);
              if ((projectileManager.totalNpcKills % kts1) === 0 && !bossManager.bossAlive) {
                const rarity = bossManager.rollPendingRarity();
                addEvent({ type: 'boss_incoming', rarity, mapLevel: 1 }, dotNpcLevel);
                const dotKills1 = killer ? (killer.npcKills || 0) : 0;
                const timerId1 = setTimeout(() => bossManager.spawn(dotKills1), 2000);
                console.log(`[boss-debug] scheduled spawn timer=${timerId1} for map=1 (dotKills=${dotKills1})`);
              }
            }
            // Broadcast boss kill progress (DOT path) — client filters by mapLevel
            {
              const _bpKts = (MAP_DEFS[dotNpcLevel]?.boss?.killsToSpawn) ?? 10;
              const _bpTot = dotNpcLevel === 3 ? projectileManager.totalNpcKills3
                           : dotNpcLevel === 2 ? projectileManager.totalNpcKills2
                           : projectileManager.totalNpcKills;
              const _bpAlive = dotNpcLevel === 3 ? !!bossManager3?.bossAlive
                             : dotNpcLevel === 2 ? !!bossManager2?.bossAlive
                             : !!bossManager?.bossAlive;
              
              addEvent({ type: 'boss_progress', current: _bpTot % _bpKts, needed: _bpKts, mapLevel: dotNpcLevel, bossAlive: _bpAlive }, dotNpcLevel);
            }
          }
        } else {
          addEvent({ type: 'entity_dead', id: e.id, isNPC: false }, e.mapLevel || 1);
          // Player respawn is manual — client sends request_respawn
        }
      }
      return dot.dur > 0 && e.hp > 0;
    }); // end filter
  } // end processDots

  playerManager.getAll().forEach(p => processDots(p, false));
  projectileManager.npcs?.forEach(e => processDots(e, true));

  // Broadcast dot events as a single batch message
  if (dotBatch.length > 0) {
    // Group dot events by mapLevel and send only to players in each map
    const perMap = new Map();
    dotBatch.forEach(ev => {
      const m = ev.mapLevel || 1;
      if (!perMap.has(m)) perMap.set(m, []);
      perMap.get(m).push(ev);
    });
    players.forEach(pl => {
      const m = pl.mapLevel || 1;
      sendTo(pl.ws, { type: 'dot_batch', events: perMap.get(m) || [] });
    });
  }

  // State broadcast throttled to STATE_RATE (100ms) — logic still runs every tick
  if (!global._lastStateBroadcast) global._lastStateBroadcast = 0;
  if (players.size > 0 && now - global._lastStateBroadcast >= 100) {
    global._lastStateBroadcast = now;
    // Send per-player: only NPCs and boss from their zone
    // Exclude zone bosses from NPC snapshots (sent via bossSnap), mas mantém world boss
    // pois ele vive no npcManager e precisa de todos os campos (isWorldBoss, npcScale, etc.)
    const allNpcSnap1  = npcManager.destroyed  ? [] : npcManager.snapshot().filter(n => !n.isBoss || n.isWorldBoss);
    const allNpcSnap2  = npcManager2.destroyed ? [] : npcManager2.snapshot().filter(n => !n.isBoss || n.isWorldBoss);
    const allNpcSnap3  = npcManager3 && !npcManager3.destroyed ? npcManager3.snapshot().filter(n => !n.isBoss || n.isWorldBoss) : [];
    const allNpcSnap4  = npcManager4 && !npcManager4.destroyed ? npcManager4.snapshot().filter(n => !n.isBoss || n.isWorldBoss) : [];
    const allNpcSnapD1 = npcManagerDungeon1 ? npcManagerDungeon1.snapshot() : [];
    const allNpcSnapD2 = npcManagerDungeon2 ? npcManagerDungeon2.snapshot() : [];
    const allNpcSnapD3 = npcManagerDungeon3 ? npcManagerDungeon3.snapshot() : [];
    const playerSnap   = playerManager.snapshot();

    // Boss snapshot includes mapLevel for client-side filtering (both zones)
    const bossSnap = [];
    [bossManager, bossManager2, bossManager3, bossManager6].forEach(mgr => {
      if (!mgr || !mgr.npcs) return; // Verificação segura
      
      mgr.npcs.forEach(b => {
        if (!b || !b.isBoss) return; // skip regular NPCs accidentally in the map
        bossSnap.push({
          id: b.id,
          name: b.name,
          x: b.x,
          y: b.y,
          z: b.z,
          rotation: b.rotation,
          hp: b.hp,
          maxHp: b.maxHp,
          speed: b.speed,
          dead: b.dead,
          isNPC: true,
          isBoss: true,
          mapLevel:     b.mapLevel || 1,
          npcModel:     b.npcModel     || null,
          npcHullColor: b.npcHullColor || null,
          npcSailColor: b.npcSailColor || null,
          npcScale:     b.npcScale     || null,
          npcYOffset:   b.npcYOffset   || null,
          npcRotOffset: b.npcRotOffset ?? null,
          auras:        b.auras        || null,
          auraRadius:   (b.auras || []).reduce((max, id) => {
            const a = ATTACK_DEFS[id]; return (a?.shape === 'aura' && a.radius > max) ? a.radius : max;
          }, 0) || null,
        });
      });
    });

    // Pre-group by zone once (O(n)) to avoid repeated .filter() per player (O(n²))
    const playersByZone = new Map();
    const bossesByZone  = new Map();
    for (const ps of playerSnap) {
      const z = ps.mapLevel || 1;
      if (!playersByZone.has(z)) playersByZone.set(z, []);
      playersByZone.get(z).push(ps);
    }
    for (const b of bossSnap) {
      const z = b.mapLevel || 1;
      if (!bossesByZone.has(z)) bossesByZone.set(z, []);
      bossesByZone.get(z).push(b);
    }

    const allNpcSnap6 = npcManager6 && !npcManager6.destroyed ? npcManager6.snapshot().filter(n => !n.isBoss || n.isWorldBoss) : [];
    const npcSnapByZone = [null, allNpcSnap1, allNpcSnap2, allNpcSnap3, allNpcSnap4, null, allNpcSnap6];
    npcSnapByZone[10] = allNpcSnapD1;
    npcSnapByZone[11] = allNpcSnapD2;
    npcSnapByZone[12] = allNpcSnapD3;

    players.forEach(p => {
      const zone    = p.mapLevel || 1;
      const myNpcs  = npcSnapByZone[zone] || [];
      const myBoss  = bossesByZone.get(zone) || [];
      const myPlayers = playersByZone.get(zone) || [];
      sendTo(p.ws, {
        type:    'state',
        players: myPlayers,
        npcs:    [...myNpcs, ...myBoss],
      });
    });
  }

  // ── Limpeza de mapas vazios (a cada minuto) ────────────────────────────
  if (!global._lastMapCleanup || now - global._lastMapCleanup > 60000) {
    global._lastMapCleanup = now;
    
    const playersInMap1 = [...players.values()].filter(p => (p.mapLevel || 1) === 1).length;
    const playersInMap2 = [...players.values()].filter(p => (p.mapLevel || 1) === 2).length;
    const playersInMap3 = [...players.values()].filter(p => (p.mapLevel || 1) === 3).length;
    
    // Mapa 2 vazio há mais de 5 minutos
    if (playersInMap2 === 0) {
      if (!map2EmptySince) map2EmptySince = now;
      if (now - map2EmptySince > 300000) { // 5 minutos
        console.log('🗑️ Destruindo managers do Mapa 2 (vazio)');
        if (npcManager2 && !npcManager2.destroyed) {
          npcManager2.destroy();
          npcManager2.destroyed = true;
        }
        if (bossManager2 && !bossManager2.destroyed) {
          bossManager2.destroy();
          bossManager2.destroyed = true;
        }
        map2EmptySince = null;
      }
    } else {
      map2EmptySince = null;
    }
    
    // Mapa 1 vazio (só destruir se houver jogadores no mapa 2)
    if (playersInMap1 === 0 && playersInMap2 > 0) {
      if (!map1EmptySince) map1EmptySince = now;
      if (now - map1EmptySince > 300000) {
        console.log('🗑️ Destruindo managers do Mapa 1 (vazio)');
        if (npcManager && !npcManager.destroyed) {
          npcManager.destroy();
          npcManager.destroyed = true;
        }
        if (bossManager && !bossManager.destroyed) {
          bossManager.destroy();
          bossManager.destroyed = true;
        }
        map1EmptySince = null;
      }
    } else {
      map1EmptySince = null;
    }
    
    // Mapa 3 vazio (sem dependência de 1/2)
    if (playersInMap3 === 0) {
      if (!map3EmptySince) map3EmptySince = now;
      if (now - map3EmptySince > 300000) {
        console.log('🗑️ Destruindo managers do Mapa 3 (vazio)');
        if (npcManager3 && !npcManager3.destroyed) {
          npcManager3.destroy();
          npcManager3.destroyed = true;
        }
        if (bossManager3 && !bossManager3.destroyed) {
          bossManager3.destroy();
          bossManager3.destroyed = true;
        }
        map3EmptySince = null;
      }
    } else {
      map3EmptySince = null;
    }
  }

  flushEvents();
}, TICK_RATE);

// Save all players every 15s — uses a single batch query instead of N individual saves
setInterval(() => {
  db.batchSave(players).catch(e => console.error('Periodic batch save error:', e));
}, 15000);

// ── Mana regen: +1 por segundo por jogador ────────────────────────────────
setInterval(() => {
  players.forEach(p => {
    if (!p || !p.name || !p._dbLoaded) return;
    if (p.mana < p.maxMana) {
      p.mana = Math.min(p.maxMana, p.mana + 1);
      sendTo(p.ws, { type: 'mana_update', mana: p.mana, maxMana: p.maxMana });
    }
  });
}, 1000);

// ── Helpers para gerenciamento dinâmico de mapas ──────────────────────────────
function getMapManager(level) {
  if (level === 12) return npcManagerDungeon3;
  if (level === 11) return npcManagerDungeon2;
  if (level === 10) return npcManagerDungeon1;
  if (level === 6) return npcManager6;
  if (level === 4) return npcManager4;
  if (level === 3) return npcManager3;
  if (level === 2) return npcManager2;
  return npcManager;
}

function getMapKills(level) {
  if (level === 3) return projectileManager.totalNpcKills3 || 0;
  if (level === 2) return projectileManager.totalNpcKills2 || 0;
  return projectileManager.totalNpcKills || 0;
}

function getMapBossAlive(level) {
  if (level === 6) return !!bossManager6?.bossAlive;
  if (level === 3) return !!bossManager3?.bossAlive;
  if (level === 2) return !!bossManager2?.bossAlive;
  return !!bossManager?.bossAlive;
}

function ensureManagersForMap(level) {
  if (level === 1) ensureMap1Managers();
  else if (level === 2) ensureMap2Managers();
  else if (level === 3) ensureMap3Managers();
  else if (level === 4) ensureMap4Managers();
  else if (level === 6) ensureMap6Managers();
  else if (level === 10) _ensureDungeonManager(10, 'bonus_map_1');
  else if (level === 11) _ensureDungeonManager(11, 'bonus_map_2');
  else if (level === 12) _ensureDungeonManager(12, 'bonus_map_3');
}

function _ensureDungeonManager(level, dungeonId) {
  const varName = level === 10 ? 'npcManagerDungeon1' : level === 11 ? 'npcManagerDungeon2' : 'npcManagerDungeon3';
  let mgr = level === 10 ? npcManagerDungeon1 : level === 11 ? npcManagerDungeon2 : npcManagerDungeon3;
  if (mgr) return;
  console.log(`[DUNGEON] Creating NPC manager for dungeon level ${level} (${dungeonId})`);
  mgr = new NPCManager(projectileManager, DUNGEON_MAP_DEFS, level, attackManager);
  // Mark all spawned NPCs as dungeon bosses
  mgr.npcs.forEach(npc => { npc.isDungeonBoss = true; npc.dungeonId = dungeonId; });
  if (level === 10) npcManagerDungeon1 = mgr;
  else if (level === 11) npcManagerDungeon2 = mgr;
  else npcManagerDungeon3 = mgr;
}

// Função para recriar managers do mapa 2
function ensureMap2Managers() {
  if (!npcManager2 || npcManager2.destroyed) {
    console.log('🔄 Recriando managers do Mapa 2');
    npcManager2 = new NPCManager(projectileManager, MAP_DEFS, 2, attackManager);
    npcManager2.destroyed = false;

    bossManager2 = new BossManager(wss, players, npcManager2.npcs, 2);
    bossManager2.destroyed = false;

    // Reconfigurar referências — usar proxy completo se mapa 3 ainda ativo
    projectileManager.bossManager2 = bossManager2;
    if (npcManager3 && !npcManager3.destroyed) {
      // Mapa 3 ainda tem jogadores — manter proxy com 3 managers para não tornar
      // os NPCs do mapa 3 intangíveis para o sistema de colisão de projéteis
      projectileManager.npcs = allNpcs;
      projectileManager.npcManagers = [npcManager, npcManager2, npcManager3];
      worldBossManager.npcManagers = [npcManager, npcManager2, npcManager3];
    } else {
      projectileManager.npcManagers = [npcManager, npcManager2];
      projectileManager.npcs = new Proxy({}, {
        get: (_, prop) => {
          if (prop === 'get') return id => npcManager.npcs.get(id) || npcManager2.npcs.get(id);
          if (prop === 'has') return id => npcManager.npcs.has(id) || npcManager2.npcs.has(id);
          if (prop === 'values') return () => [...npcManager.npcs.values(), ...npcManager2.npcs.values()][Symbol.iterator]();
          if (prop === 'forEach') return cb => { npcManager.npcs.forEach(cb); npcManager2.npcs.forEach(cb); };
          if (prop === 'delete') return id => npcManager.npcs.delete(id) || npcManager2.npcs.delete(id);
          return undefined;
        }
      });
      worldBossManager.npcManagers = [npcManager, npcManager2];
    }
  }
  return npcManager2;
}

// Função para recriar managers do mapa 3
function ensureMap3Managers() {
  if (!npcManager3 || npcManager3.destroyed) {
    console.log('🔄 Recriando managers do Mapa 3');
    npcManager3 = new NPCManager(projectileManager, MAP_DEFS, 3, attackManager);
    npcManager3.destroyed = false;

    bossManager3 = new BossManager(wss, players, npcManager3.npcs, 3);
    bossManager3.destroyed = false;
    bossManager3._onBossKill    = (killer)      => progressDailyMission(killer,      'bossKills',   1);
    bossManager3._onBossAssist  = (participant) => progressDailyMission(participant, 'bossAssists', 1);
  }
  // SEMPRE restaurar o Proxy completo e as referências — ensureMap1/2Managers pode ter substituído
  // projectileManager.npcs por um proxy sem mapa 3, mesmo que npcManager3 ainda esteja vivo.
  projectileManager.npcs = allNpcs;
  projectileManager.npcManagers = [npcManager, npcManager2, npcManager3];
  projectileManager.bossManager2 = bossManager2;
  projectileManager.bossManager3 = bossManager3;
  worldBossManager.npcManagers = [npcManager, npcManager2, npcManager3];
  return npcManager3;
}

function ensureMap4Managers() {
  if (!npcManager4 || npcManager4.destroyed) {
    console.log('🔄 Recriando managers do Mapa 4');
    npcManager4 = new NPCManager(projectileManager, MAP_DEFS, 4, attackManager);
    npcManager4.destroyed = false;
  }
  // Wire npcManager4 into the allNpcs proxy and projectileManager
  projectileManager.npcs = allNpcs;
  projectileManager.npcManagers = [npcManager, npcManager2, npcManager3, npcManager4].filter(Boolean);
  worldBossManager.npcManagers  = [npcManager, npcManager2, npcManager3, npcManager4].filter(Boolean);
  return npcManager4;
}

// Mapa 6: npc:null — boss-only map (NPCManager criado mas não spawna NPCs regulares)
function ensureMap6Managers() {
  if (!npcManager6 || npcManager6.destroyed) {
    console.log('🔄 Criando managers do Mapa 6 (boss-only)');
    npcManager6 = new NPCManager(projectileManager, MAP_DEFS, 6, attackManager);
    npcManager6.destroyed = false;

    bossManager6 = new BossManager(wss, players, npcManager6.npcs, 6);
    bossManager6.destroyed = false;
    bossManager6._onBossKill = (killer) => {
      progressDailyMission(killer, 'bossKills', 1);
      // Agendar respawn após respawnDelay (padrão 1 hora)
      if (bossManager6._respawnTimer) clearTimeout(bossManager6._respawnTimer);
      const delay     = MAP_DEFS[6].boss.respawnDelay || 3600000;
      const respawnAt = Date.now() + delay;
      const mins      = Math.round(delay / 60000);
      addEvent({ type: 'boss_respawn_scheduled', mapLevel: 6, respawnAt, delayMs: delay }, 6);
      console.log(`👻 The Drowned Widow morta — respawn em ${mins} min`);
      bossManager6._respawnTimer = setTimeout(() => {
        bossManager6._respawnTimer = null;
        if (bossManager6 && !bossManager6.destroyed && !bossManager6.bossAlive) {
          addEvent({ type: 'boss_incoming', rarity: null, mapLevel: 6 }, 6);
          setTimeout(() => { if (bossManager6 && !bossManager6.bossAlive) bossManager6.spawn(0); }, 5000);
        }
      }, delay);
    };
    bossManager6._onBossAssist  = (participant) => progressDailyMission(participant, 'bossAssists', 1);
  }

  // Wire into global proxy
  projectileManager.npcs = allNpcs;
  projectileManager.npcManagers = [npcManager, npcManager2, npcManager3, npcManager4, npcManager6].filter(Boolean);
  projectileManager.bossManager6 = bossManager6;
  worldBossManager.npcManagers  = [npcManager, npcManager2, npcManager3, npcManager4, npcManager6].filter(Boolean);

  // Spawn boss se ainda não está vivo (timer-based, não kill-based)
  if (!bossManager6.bossAlive) {
    addEvent({ type: 'boss_incoming', rarity: null, mapLevel: 6 }, 6);
    setTimeout(() => { if (bossManager6 && !bossManager6.bossAlive) bossManager6.spawn(0); }, 5000);
  }

  return npcManager6;
}

// Função para recriar managers do mapa 1 (analógica à do 2)
function ensureMap1Managers() {
  if (!npcManager || npcManager.destroyed) {
    console.log('🔄 Recriando managers do Mapa 1');
    npcManager = new NPCManager(projectileManager, MAP_DEFS, 1, attackManager);
    npcManager.destroyed = false;

    bossManager = new BossManager(wss, players, npcManager.npcs, 1);
    bossManager.destroyed = false;

    // Reconfigurar referências — usar proxy completo se mapas superiores ainda ativos
    projectileManager.bossManager = bossManager;
    if (npcManager3 && !npcManager3.destroyed) {
      projectileManager.npcs = allNpcs;
      projectileManager.npcManagers = [npcManager, npcManager2, npcManager3];
      worldBossManager.npcManagers = [npcManager, npcManager2, npcManager3];
    } else {
      projectileManager.npcManagers = [npcManager, npcManager2];
      projectileManager.npcs = new Proxy({}, {
        get: (_, prop) => {
          if (prop === 'get') return id => npcManager.npcs.get(id) || npcManager2.npcs.get(id);
          if (prop === 'has') return id => npcManager.npcs.has(id) || npcManager2.npcs.has(id);
          if (prop === 'values') return () => [...npcManager.npcs.values(), ...npcManager2.npcs.values()][Symbol.iterator]();
          if (prop === 'forEach') return cb => { npcManager.npcs.forEach(cb); npcManager2.npcs.forEach(cb); };
          if (prop === 'delete') return id => npcManager.npcs.delete(id) || npcManager2.npcs.delete(id);
          return undefined;
        }
      });
      worldBossManager.npcManagers = [npcManager, npcManager2];
    }
  }
  return npcManager;
}

// WebSocket
wss.on('connection', (ws) => {
  console.log('Client connected');
  let player = null;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (!player && msg.type !== 'login') return;

      switch (msg.type) {

        case 'login': {
          const result = await handleLogin(ws, msg);
          if (result) player = result; // null = DB load falhou, cliente recebeu erro
          break;
        }

        case 'speed_buff': {
          if (!player) break;
          handleSpeedBuff(player, msg);
          break;
        }

        case 'gold_shield_cost': {
          if (!player) break;
          handleGoldShieldCost(player, msg);
          break;
        }

        case 'ping': {
          sendTo(ws, { type: 'pong' });
          break;
        }

        case 'input': {
          player.input = { w: !!msg.w, a: !!msg.a, s: !!msg.s, d: !!msg.d };
          // Any WASD key press cancels a pending click-to-move target
          if (msg.w || msg.a || msg.s || msg.d) player.moveTarget = null;
          break;
        }

        case 'move_to': {
          if (player.dead || player.afkTraining) break;
          const mx = typeof msg.targetX === 'number' ? msg.targetX : null;
          const mz = typeof msg.targetZ === 'number' ? msg.targetZ : null;
          player.moveTarget = (mx !== null && mz !== null) ? { x: mx, z: mz } : null;
          break;
        }

        case 'shoot': {
          if (player.dead) break;
          if (player.cannonCooldown > 0) break;
          if (player.stunExpires && Date.now() < player.stunExpires) break;
          if (!player.cannons.length) break;
          handleShoot(player, msg);
          break;
        }

        case 'buy_cannon': {
          if (!player) break;
          handleBuyCannon(player, msg, ws);
          break;
        }

        case 'equip_cannon': {
          if (!player) break;
          handleEquipCannon(player, msg, ws);
          break;
        }

        case 'equip_cannon_sync': {
          if (!player) break;
          handleEquipCannonSync(player, msg, ws);
          break;
        }

        case 'equip_pirate_sync': {
          if (!player) break;
          handleEquipPirateSync(player, msg, ws);
          break;
        }

        case 'save_progress': {
          if (player) db.save(player, true).catch(e => console.error('Save error:', e));
          break;
        }

        case 'cancel_active_mission': {
          if (!player) break;
          handleCancelActiveMission(player);
          break;
        }

        case 'accept_daily_mission': {
          if (!player) break;
          handleAcceptDailyMission(player, msg);
          break;
        }

        case 'claim_daily_mission': {
          if (!player) break;
          handleClaimDailyMission(player, msg);
          break;
        }

        case 'request_daily_missions': {
          if (!player) break;
          progressDailyMission(player, 'lighthouseVisit', 1);
          sendTo(player.ws, { type: 'daily_missions', missions: buildDailyMissions(player) });
          break;
        }

        // ── Sistema de Procurado (Wanted) ───────────────────────────────────
        case 'request_wanted': {
          if (!player) break;
          handleRequestWanted(player);
          break;
        }

        case 'accept_wanted': {
          if (!player) break;
          handleAcceptWanted(player, msg);
          break;
        }

        case 'cancel_wanted': {
          if (!player) break;
          player.wantedTarget = null;
          sendTo(player.ws, { type: 'wanted_cancelled' });
          break;
        }

        case 'request_respawn': {
          if (player && player.dead) {
            // use map-specific bounds when respawning after death
            const mapSize = getMapSize(player.mapLevel || 1);
            player.hp             = player.maxHp || 100;
            player.dead           = false;
            player.x              = (Math.random() - 0.5) * mapSize * 0.8;
            player.z              = (Math.random() - 0.5) * mapSize * 0.8;
            player.rotation       = Math.random() * Math.PI * 2;
            // Clear all debuffs so player doesn't respawn stunned/slowed
            player.activeDebuffs  = [];
            player.slowMult       = 1;
            player.slowExpires    = 0;
            player.stunExpires    = 0;
            player.dot            = null;
            // Reset cannon so player can fire immediately
            player.cannonCooldown = 0;
            const totalCharges    = playerManager.getSalvoCount(player.cannons) || 1;
            player.cannonCharges  = totalCharges;
            sendTo(ws, { type: 'respawn', x: player.x, z: player.z, hp: player.hp, maxHp: player.maxHp });
            sendTo(ws, { type: 'cannon_state', charges: totalCharges, maxCharges: totalCharges, cooldown: 0, cooldownMax: player.cannonCooldownMax, homingCharges: 0 });
          }
          break;
        }

        case 'chat': {
          // broadcast chat message to all connected players (global chat)
          const text = (msg.text || '').toString().substring(0, 200);
          if (text && player) {
            addEvent({ type: 'chat', from: player.name || 'Anon', text });
          }
          break;
        }

        case 'equip_ammo': {
          const { ammoId } = msg;
          if (!AMMO_DEFS[ammoId]) break;
          if (ammoId !== 'bala_ferro' && !(player.inventory.ammo[ammoId] > 0)) break;
          player.currentAmmo = ammoId;
          sendTo(ws, { type:'ammo_confirm', ammoId });
          break;
        }

        case 'buy_pirate': {
          if (!player) break;
          handleBuyPirate(player, msg, ws);
          break;
        }

        case 'buy_ammo': {
          if (!player) break;
          handleBuyAmmo(player, msg, ws);
          break;
        }

        case 'buy_navio': {
          if (!player) break;
          handleBuyNavio(player, msg, ws);
          break;
        }

        case 'buy_vela': {
          if (!player) break;
          handleBuyVela(player, msg, ws);
          break;
        }

        // ── Comprar navio elite (Mapa 3 — Ilha do Comércio) ──────────────────
        case 'buy_elite_ship': {
          if (!player) break;
          handleBuyEliteShip(player, msg, ws);
          break;
        }

        // ── Upgrade de navio (HP / Defesa) ───────────────────────────────────
        case 'buy_ship_upgrade': {
          if (!player) break;
          handleBuyShipUpgrade(player, msg, ws);
          break;
        }

        // ── Treino AFK: comprar horas de treino ──────────────────────────────
        case 'buy_afk_time': {
          if (!player) break;
          handleBuyAfkTime(player, msg);
          break;
        }

        // ── Treino AFK: sair do mapa de treino ───────────────────────────────
        case 'leave_afk_training': {
          if (!player) break;
          handleLeaveAfkTraining(player);
          break;
        }

        // ── Upgrade de canhão C6 (por instância no inventário) ───────────────
        case 'buy_cannon_upgrade': {
          if (!player) break;
          handleBuyCannonUpgrade(player, msg, ws);
          break;
        }

        // ── Câmbio: Ouro → Dobrões (Mercado Ilha, Mapa 3) ───────────────────
        case 'exchange_gold': {
          if (!player) break;
          handleExchangeGold(player, msg, ws);
          break;
        }

        case 'equip_vela': {
          if (!player) break;
          handleEquipVela(player, msg, ws);
          break;
        }

        case 'unequip_vela': {
          if (!player) break;
          player.equippedSails = player.equippedSails.filter(id => id !== msg.sailId);
          _recalcSails(player);
          db.save(player, true).catch(e => console.error('Save error:', e));
          sendTo(ws, {
            type: 'sail_update',
            equippedSails:  player.equippedSails,
            sailSpeedMult:  player.sailSpeedMult,
            inventory:      player.inventory,
          });
          break;
        }

        case 'explore_map': {
          if (!player) break;
          handleExploreMap(player, msg, ws);
          break;
        }

        case 'enter_bonus_dungeon': {
          if (!player) break;
          handleEnterBonusDungeon(player, msg, ws);
          break;
        }

        case 'leave_dungeon': {
          if (!player) break;
          if ((player.mapLevel || 0) >= 10) _dungeonLeave(player);
          break;
        }

        case 'unlock_bonus_map': {
          if (!player) break;
          handleUnlockBonusMap(player, msg, ws);
          break;
        }

        case 'cannon_research': {
          if (!player) break;
          handleCannonResearch(player, msg, ws);
          break;
        }

        // ── RELIC: equip a relic instance into a deck position ─────────────
        case 'equip_relic': {
          if (!player) break;
          handleEquipRelic(player, msg);
          break;
        }

        // ── RELIC: unequip from deck position ─────────────────────────────
        case 'unequip_relic': {
          if (!player) break;
          handleUnequipRelic(player, msg);
          break;
        }

        // ── RELIC: use (activate ability) ────────────────────────────────────
        case 'use_relic': {
          if (!player) break;
          handleUseRelic(player, msg);
          break;
        }

        // ── TALENT: comprar um nível de talento ───────────────────────────────
        case 'buy_talent': {
          if (!player) break;
          handleBuyTalent(player, msg);
          break;
        }

        // ── TALENT: resetar todos os talentos e devolver pontos ─────────────
        case 'reset_talents': {
          if (!player) break;
          handleResetTalents(player);
          break;
        }

        case 'equip_navio': {
          if (!player) break;
          handleEquipNavio(player, msg, ws);
          break;
        }

      }
    } catch (e) {
      console.error('Message error:', e);
    }
  });

  ws.on('close', () => {
    if (player) {
      if (player._dbLoaded) {
        db.save(player, true).catch(e => console.error('Save error:', e)); // persist on disconnect
      }
      addEvent({ type: 'player_leave', id: player.id });
      playerManager.remove(player.id);
      players.delete(player.id);
      console.log(`[-] ${player.name} left`);
    }
  });
});

// ── WebSocket handler functions ──────────────────────────────────────────────

async function handleLogin(ws, msg) {
  const player = playerManager.create(ws, msg.name || 'Sailor');
  player._dbLoaded = false;
  players.set(player.id, player);

  // Load saved progress from DB — limpa o player se falhar
  let saved;
  try {
    saved = await db.loadOrCreate(player.name);
  } catch (err) {
    console.error(`[login] DB load failed for ${player.name}:`, err);
    players.delete(player.id);
    playerManager.remove(player.id);
    sendTo(ws, { type: 'error', message: 'Erro ao carregar dados. Tente reconectar.' });
    return null;
  }
  // Se o jogador for pro mapa 2, garantir que os managers existam
  if (saved.mapLevel === 2) {
    ensureMap2Managers();
  }
  if (saved.mapLevel === 3) {
    ensureMap3Managers();
  }
  if (saved.mapLevel === 4) {
    ensureMap4Managers();
  }
  // Se o jogador estiver voltando pro mapa 1 após limpeza, refaz managers
  if (saved.mapLevel === 1 && (npcManager.destroyed || bossManager.destroyed)) {
    ensureMap1Managers();
  }

  player.gold              = saved.gold;
  player.dobroes           = saved.dobroes;
  // If the DB has no cannons saved, give new players 3 starter c1 cannons
  player.inventory.cannons = (saved.inventory && Array.isArray(saved.inventory.cannons) && saved.inventory.cannons.length > 0)
    ? saved.inventory.cannons
    : ['c1','c1','c1'];
  player.inventory.pirates = saved.inventory.pirates || [];
  // Merge saved ammo with defaults (bala_ferro always Infinity)
  player.inventory.ammo = {
    bala_ferro:      Infinity,
    bala_perfurante: 0,
    bala_gelo:       0,
    bala_fogo:       0,
    bala_luz:        0,
    bala_sangue:     0,
    ...saved.inventory.ammo
  };
  // Restore ships (|| doesn't work for empty arrays since [] is truthy)
  player.inventory.ships = (saved.inventory.ships?.length > 0) ? saved.inventory.ships : ['fragata'];
  player.inventory.sails = saved.inventory.sails || [];
  // Restore equipped sails and recalc speed bonus
  player.equippedSails   = saved.equipped?.sails || [];
  _recalcSails(player);
  const { SHIP_DEFS } = require('./constants');
  const savedShipId = saved.equipped?.ship || player.inventory.ships[0] || 'fragata';
  const savedShip   = SHIP_DEFS[savedShipId] || SHIP_DEFS.sloop;
  player.activeShip    = savedShipId;
  player.maxHp         = savedShip.hp;
  // Load skills from DB (garante que vida existe mesmo em saves antigos)
  player.skills        = saved.skills || { ataque:{level:1,xp:0}, velocidade:{level:1,xp:0}, defesa:{level:1,xp:0}, vida:{level:1,xp:0}, reliquia:{level:1,xp:0} };
  if (!player.skills.vida)     player.skills.vida     = { level:1, xp:0 }; // compatibilidade
  if (!player.skills.reliquia) player.skills.reliquia = { level:1, xp:0 }; // compatibilidade
  // Talentos
  player.talents       = saved.talents || { hp:0, defesa:0, canhoes:0, dano:0, dano_relic:0, riqueza:0, ganancioso:0, mestre:0, slot_reliquia:0, totalSpent:0 };
  player.npcKills      = saved.npcKills      || 0;
  player.mapXp         = saved.mapXp         || 0;
  player.mapLevel      = saved.mapLevel      || 1;
  player.mapFragments  = saved.mapFragments  || 0;
  // Aplica bônus de talentos e recalcula maxHp (skill vida + talento HP)
  applyTalentBonuses(player);
  recalcMaxHp(player);
  player.hp            = Math.min(player.maxHp, player.hp);
  player.maxCannons    = _calcMaxCannons(savedShip, player.talentCannonBonus || 0, MAX_CANNON_SLOTS);
  console.log("maxCannons", player.maxCannons, savedShip.maxCannons, player.talentCannonBonus);
  // Relics
  player.inventory.relics = saved.inventory.relics || [];
  const shipReliqC = SHIP_RELIQC[savedShipId] || {};
  player.relicDeck = (saved.equipped.relics || []).filter(Boolean).slice(0, shipReliqC.maxHelic ?? 8);
  player.maxMana   = shipReliqC.maxMana ?? 8;
  player.maxRelics = shipReliqC.maxHelic ?? 4;
  player.mana = player.maxMana;
  player.relicGoldShieldActive = false;
  player.relicInvincibleExpires = 0;
  player.relicSpeedExpires = 0;
  player.shipSpeedMult = savedShip.speedMult || 1.0;
  player.dropBonus     = savedShip.dropBonus || 0;
  // Island upgrades & new resources
  // Migrate old { hpBonus, defenseBonus } format → new { hp, defense, damage } levels
  const rawUpg = saved.shipIslandUpgrades;
  player.shipIslandUpgrades = (rawUpg?.hp !== undefined)
    ? rawUpg
    : { hp: 0, defense: 0, damage: 0 };
  player.cannonUpgradesData = saved.cannonUpgradesData || [];
  player.ironPlates          = saved.ironPlates          || 0;
  player.goldDust            = saved.goldDust            || 0;
  player.gunpowder           = saved.gunpowder           || 0;
  player.bonusMapsUnlocked   = saved.bonusMapsUnlocked   || [];
  player.mapPieces           = saved.mapPieces           || {};
  player.rareShips           = saved.rareShips           || [];
  player.cannonResearchLevel = saved.cannonResearchLevel || 0;
  player.shipMaterialLevel   = saved.shipMaterialLevel   || 0;
  // Pad cannonUpgradesData to match inventory.cannons length
  while (player.cannonUpgradesData.length < player.inventory.cannons.length) {
    player.cannonUpgradesData.push({ as: 0, rn: 0, dm: 0 });
  }

  // Restore equipped cannons from DB (what was equipped last session)
  const savedEquipped = saved.equipped?.cannons || [];
  player.cannons = savedEquipped.filter(cid => player.inventory.cannons.includes(cid));
  // If nothing equipped, equip up to 3 starter cannons from inventory (respect ship limit later)
  if (player.cannons.length === 0) {
    player.cannons = (player.inventory.cannons || []).slice(0, 3);
  }
  // Enforce ship cannon limit
  player.cannons = _trimCannons(player.cannons, player.maxCannons).cannons;
  player.pirates = saved.equipped?.pirates || [];
  recalcCannons(player);
  applySkillMultipliers(player); // also calls recalcMaxHp internally

  // All DB data is now applied — safe for periodic saves
  player._dbLoaded = true;

  const initShots = salvoCount(player);
  const initZone    = player.mapLevel || 1;
  ensureManagersForMap(initZone); // garante managers ativos para o mapa inicial do jogador
  const initPlayers = playerManager.snapshot()
    .filter(ps => (ps.mapLevel || 1) === initZone);

  sendTo(ws, {
    type:             'init',
    serverNow:        Date.now(),   // client uses this to compensate clock skew
    id:               player.id,
    hp:               player.hp,
    maxHp:            player.maxHp,
    x:                player.x,
    z:                player.z,
    mapSize:          (MAP_DEFS[initZone] && MAP_DEFS[initZone].size),
    npcs:             initZone === 5 ? [] : (getMapManager(initZone) || npcManager).snapshot(),
    players:          initPlayers,
    gold:             player.gold,
    dobroes:          player.dobroes,
    cannonCooldown:   player.cannonCooldown,
    cannonCooldownMax: player.cannonCooldownMax,
    cannonRange:      player.cannonRange,
    cannonCharges:    initShots,
    maxCharges:       initShots,
    cannons:          player.cannons,
    maxCannons:       player.maxCannons,
    inventory:        player.inventory,
    skills:   player.skills,
    npcKills:   player.npcKills || 0,
    mapXp:      player.mapXp    || 0,
    mapLevel:   player.mapLevel || 1,
    mapXpNeeded: (MAP_DEFS[player.mapLevel || 1] || MAP_DEFS[1]).xpToAdvance || 99999,
    mapDef:       MAP_DEFS[player.mapLevel || 1] || MAP_DEFS[1],
    mapFragments: player.mapFragments || 0,
    equipped: {
      ship:    player.activeShip,
      cannons: player.cannons,
      pirates: player.pirates,
      ammo:    player.currentAmmo,
      sails:   player.equippedSails || [],
      relics:  player.relicDeck || [],
    },
    relicInventory:      player.inventory.relics || [],
    relicDeck:           player.relicDeck || [],
    mana:                player.mana,
    maxMana:             player.maxMana,
    maxRelics:           player.maxRelics || 4,
    talents:             player.talents || {},
    talentPoints:        player.talentPoints || 0,
    shipIslandUpgrades:  player.shipIslandUpgrades || { hp: 0, defense: 0, damage: 0 },
    cannonUpgradesData:  player.cannonUpgradesData || [],
    ironPlates:          player.ironPlates          || 0,
    goldDust:            player.goldDust            || 0,
    gunpowder:           player.gunpowder           || 0,
    bonusMapsUnlocked:   player.bonusMapsUnlocked   || [],
    mapPieces:           player.mapPieces           || {},
    rareShips:           player.rareShips           || [],
    cannonResearchLevel: player.cannonResearchLevel || 0,
    shipMaterialLevel:   player.shipMaterialLevel   || 0,
    bossProgress: (() => {
      if (initZone === 5) return null; // mapa de treino: sem boss
      const kts = MAP_DEFS[initZone]?.boss?.killsToSpawn ?? 10;
      if (kts === 0) return { current: 0, needed: 0, mapLevel: initZone, bossAlive: getMapBossAlive(initZone) };
      const tot = initZone === 3 ? projectileManager.totalNpcKills3
                : initZone === 2 ? projectileManager.totalNpcKills2
                : projectileManager.totalNpcKills;
      const alive = initZone === 3 ? !!bossManager3?.bossAlive
                  : initZone === 2 ? !!bossManager2?.bossAlive
                  : !!bossManager?.bossAlive;
      return { current: tot % kts, needed: kts, mapLevel: initZone, bossAlive: alive };
    })(),
  });

  // Reconexão com sessão AFK ativa → notificar cliente
  if (player.afkTraining && player.afkUntil > Date.now()) {
    sendTo(player.ws, {
      type: 'afk_started',
      afkUntil: player.afkUntil,
      gold:     player.gold,
      training: MAP_DEFS[5]?.training,
    });
  }

  addEvent({
    type: 'player_join',
    id:   player.id,
    name: player.name,
    x:    player.x,
    z:    player.z,
  }, initZone);

  console.log(`[+] ${player.name} joined`);
  return player;
}

function handleSpeedBuff(player, msg) {
  const { targetId, bonus, duration } = msg;

  // Aplica buff de velocidade
  const target = players.get(targetId) || players.get(Number(targetId));
  if (target) {
    // Salva velocidade original se não tiver
    if (!target._originalSpeed) {
      target._originalSpeed = target.speed || 1.0;
    }

    // Aplica buff
    target.speed = target._originalSpeed * (1 + bonus);
    target._speedBuffUntil = Date.now() + duration;

    // Notifica o cliente
    sendTo(target.ws, {
      type: 'speed_buff_applied',
      bonus: bonus,
      duration: duration
    });
  }
}

function handleGoldShieldCost(player, msg) {
  const amount = msg.amount || 0;

  // Gasta ouro do jogador
  if (player.gold >= amount) {
    player.gold -= amount;

    // Notifica o cliente
    sendTo(player.ws, {
      type: 'currency_update',
      gold: player.gold,
      dobroes: player.dobroes
    });

    // Salva no banco
    db.save(player).catch(e => console.error('Save error:', e));
  } else {
    // Se não tem ouro suficiente, o escudo falha
    // Aqui você pode aplicar dano total ou desativar o escudo
    sendTo(player.ws, {
      type: 'gold_shield_failed',
      message: 'Ouro insuficiente!'
    });
  }
}

function handleShoot(player, msg) {
  // Clamp target to cannon range — shoot in direction of click, max range
  let tX = msg.targetX, tZ = msg.targetZ;
  const shootDist = Math.hypot(tX - player.x, tZ - player.z);
  if (shootDist > player.cannonRange) {
    const ratio = player.cannonRange / shootDist;
    tX = player.x + (tX - player.x) * ratio;
    tZ = player.z + (tZ - player.z) * ratio;
  }
  // Replace msg values with clamped coords
  msg.targetX = tX; msg.targetZ = tZ;

  projectileManager.spawnSalvo(player, msg.targetX, msg.targetZ);
  player.castExpires = Date.now() + 350; // 350ms cast penalty — player slows to 15% speed
  // Treino: concede XP de ataque por atirar na torre (sem NPCs para acertar)
  if (player.mapLevel === 5) {
    grantSkillXp(player, 'ataque', Math.max(1, Math.floor((player.cannonDamage || 10) / 5)), wss);
  }
}

function handleBuyCannon(player, msg, ws) {
  const def = CANNON_DEFS[msg.cannonId];
  if (!def) return;
  if (def.currency === 'gold') {
    if (player.gold < def.price) { sendTo(ws, { type:'error', message:'Ouro insuficiente' }); return; }
    player.gold -= def.price;
  } else {
    if (player.dobroes < def.price) { sendTo(ws, { type:'error', message:'Dobrões insuficientes' }); return; }
    player.dobroes -= def.price;
  }
  player.inventory.cannons.push(msg.cannonId);
  // Keep cannonUpgradesData in sync with inventory
  if (!player.cannonUpgradesData) player.cannonUpgradesData = [];
  player.cannonUpgradesData.push({ as: 0, rn: 0, dm: 0 });
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(ws, {
    type: 'inventory_update', inventory: player.inventory,
    gold: player.gold, dobroes: player.dobroes,
    cannonUpgradesData: player.cannonUpgradesData,
  });
}

function handleEquipCannon(player, msg, ws) {
  const { cannonId, action } = msg;
  const def = CANNON_DEFS[cannonId];
  if (!def) return;

  if (action === 'add') {
    if (player.cannons.length < (player.maxCannons || MAX_CANNON_SLOTS)) player.cannons.push(cannonId);
  } else {
    const idx = player.cannons.lastIndexOf(cannonId);
    if (idx !== -1) player.cannons.splice(idx, 1);
  }

  debugServer(`[server] equip_cannon: player=${player.name}, action=${action}, cannonId=${cannonId}, cannons(before recalc)=${JSON.stringify(player.cannons)}`);
  recalcCannons(player);
  const shots = salvoCount(player);
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(ws, {
    type:        'cannon_state',
    cannons:     player.cannons,
    charges:     shots,
    maxCharges:  shots,
    cooldown:    0,
    cooldownMax: player.cannonCooldownMax,
    range:       player.cannonRange,
    lifesteal:   player.cannonLifesteal,
  });
}

function handleEquipCannonSync(player, msg, ws) {
  const incoming = (msg.cannons || [])
    .slice(0, MAX_CANNON_SLOTS)
    .filter(cid => CANNON_DEFS[cid]);

  // Only allow cannons that are actually in inventory
  player.cannons = incoming.filter(cid => player.inventory.cannons.includes(cid));
  recalcCannons(player);
  const shots = salvoCount(player);
  db.save(player, true).catch(e => console.error('Save error:', e));
  debugServer(`[server] Sending cannon_state to ${player.name} (equip_cannon_sync) range=${player.cannonRange}`);
  sendTo(ws, {
    type:        'cannon_state',
    cannons:     player.cannons,
    charges:     shots,
    maxCharges:  shots,
    cooldown:    0,
    cooldownMax: player.cannonCooldownMax,
    range:       player.cannonRange,
    lifesteal:   player.cannonLifesteal,
  });
}

function handleEquipPirateSync(player, msg, ws) {
  const incoming = msg.pirates || [];
  const healers  = incoming.filter(p => p === 'healer' || p === 'healer_elite');

  player.pirates          = healers.slice(0, 1);
  player.homingCharges    = 0;
  player.damageMultiplier = 1.0;

  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(ws, { type:'pirate_state', pirates: player.pirates, homingCharges: player.homingCharges });
}

function handleCancelActiveMission(player) {
  buildDailyMissions(player);
  const cancelId = player.dailyMissions.activeMission;
  if (!cancelId) return;
  // Cancela a missão ativa e reseta seu progresso
  player.dailyMissions.progress[cancelId] = 0;
  player.dailyMissions.activeMission = null;
  db.save(player).catch(e => console.error('Save error:', e));
  sendTo(player.ws, {
    type:     'mission_cancelled',
    id:       cancelId,
    missions: buildDailyMissions(player),
  });
}

function handleAcceptDailyMission(player, msg) {
  const acceptId = msg.id;
  buildDailyMissions(player);
  const pool2   = getDailyMissionPool();
  const accDef  = pool2.find(m => m.id === acceptId);
  if (!accDef) { sendTo(player.ws, { type: 'daily_mission_error', id: acceptId, reason: 'not_found' }); return; }
  if (player.dailyMissions.claimed[acceptId]) { sendTo(player.ws, { type: 'daily_mission_error', id: acceptId, reason: 'already_claimed' }); return; }
  player.dailyMissions.activeMission = acceptId;
  db.save(player).catch(e => console.error('Save error:', e));
  sendTo(player.ws, {
    type:     'mission_accepted',
    id:       acceptId,
    icon:     accDef.icon,
    label:    accDef.label,
    target:   accDef.target,
    reward:   accDef.reward,
    progress: player.dailyMissions.progress[acceptId] || 0,
    missions: buildDailyMissions(player),
  });
}

function handleClaimDailyMission(player, msg) {
  const missionId = msg.id;
  buildDailyMissions(player);
  const pool3  = getDailyMissionPool();
  const def    = pool3.find(m => m.id === missionId);
  if (!def) return;
  const curProg = player.dailyMissions.progress[missionId] || 0;
  const curClaim = player.dailyMissions.claimed[missionId];
  if (curClaim || curProg < def.target) {
    sendTo(player.ws, { type: 'daily_mission_error', id: missionId, reason: curClaim ? 'already_claimed' : 'not_complete' });
    return;
  }
  player.dailyMissions.claimed[missionId] = true;
  // Limpar missão ativa após coletar
  if (player.dailyMissions.activeMission === missionId) player.dailyMissions.activeMission = null;
  if (def.reward.gold)   player.gold    = (player.gold    || 0) + def.reward.gold;
  if (def.reward.dobrao) player.dobroes = (player.dobroes || 0) + def.reward.dobrao;
  // lighthouseQuest: completar OUTRA missão do farol enquanto lighthouse_keeper está ativa
  if (missionId !== 'lighthouse_keeper') progressDailyMission(player, 'lighthouseQuest', 1);
  db.save(player).catch(e => console.error('Save error:', e));
  sendTo(player.ws, {
    type:     'daily_mission_claimed',
    id:       missionId,
    reward:   def.reward,
    gold:     player.gold,
    dobroes:  player.dobroes,
    missions: buildDailyMissions(player),
  });
}

function handleRequestWanted(player) {
  // Verificar se o limite diário já foi usado
  const _wReqToday = todayDateStr();
  if (!player.dailyWanted || player.dailyWanted.date !== _wReqToday) {
    player.dailyWanted = { date: _wReqToday, used: false };
  }
  const candidates = [...players.values()].filter(p => p.id !== player.id && !p.dead && p.name);
  // Embaralha e pega até 5
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const wantedList = candidates.slice(0, 5).map(p => ({
    id:          p.id,
    name:        p.name,
    mapLevel:    p.mapLevel || 1,
    npcKills:    p.npcKills || 0,
    rewardGold:  1000 * (p.npcKills || 0),
    rewardDobrao: 10  * (p.npcKills || 0),
  }));
  sendTo(player.ws, {
    type:           'wanted_list',
    players:        wantedList,
    dailyLimitUsed: player.dailyWanted.used,
  });
}

function handleAcceptWanted(player, msg) {
  // ── Limite diário: apenas 1 caçada por dia ────────────────────────
  const _wantedToday = todayDateStr();
  if (!player.dailyWanted || player.dailyWanted.date !== _wantedToday) {
    player.dailyWanted = { date: _wantedToday, used: false };
  }
  if (player.dailyWanted.used) {
    sendTo(player.ws, { type: 'wanted_error', reason: 'daily_limit' });
    return;
  }
  // msg.targetId vem do atributo HTML data-target-id (sempre string),
  // mas players Map usa chaves numéricas (uid() retorna number) — converter antes do lookup
  const wTarget = players.get(Number(msg.targetId)) || players.get(msg.targetId);
  if (!wTarget) { sendTo(player.ws, { type: 'wanted_error', reason: 'player_offline' }); return; }
  if (wTarget.id === player.id) { sendTo(player.ws, { type: 'wanted_error', reason: 'cannot_hunt_self' }); return; }
  player.dailyWanted.used = true; // marca como usado para hoje
  player.wantedTarget = {
    targetId:     wTarget.id,
    targetName:   wTarget.name,
    targetMapLevel: wTarget.mapLevel || 1,
    rewardGold:   1000 * (wTarget.npcKills || 0),
    rewardDobrao: 10   * (wTarget.npcKills || 0),
  };
  sendTo(player.ws, {
    type:         'wanted_accepted',
    targetId:     wTarget.id,
    targetName:   wTarget.name,
    targetMapLevel: wTarget.mapLevel || 1,
    rewardGold:   player.wantedTarget.rewardGold,
    rewardDobrao: player.wantedTarget.rewardDobrao,
  });
}

function handleBuyPirate(player, msg, ws) {
  const { SHOP } = require('./constants');
  const item = SHOP.piratasMap[msg.pirateId];
  if (!item) { sendTo(ws, { type:'error', message:'Pirata não encontrado: ' + msg.pirateId }); return; }
  if (item.currency === 'gold') {
    if (player.gold < item.price) { sendTo(ws, { type:'error', message:'Ouro insuficiente' }); return; }
    player.gold -= item.price;
  } else {
    if (player.dobroes < item.price) { sendTo(ws, { type:'error', message:'Dobrões insuficientes' }); return; }
    player.dobroes -= item.price;
  }
  player.inventory.pirates.push(msg.pirateId);
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(ws, { type:'inventory_update', inventory: player.inventory, gold: player.gold, dobroes: player.dobroes });
}

function handleBuyAmmo(player, msg, ws) {
  const { SHOP } = require('./constants');
  const item = SHOP.ammo[msg.ammoId];
  if (!item) return;
  const packs     = Math.max(1, Math.min(100, parseInt(msg.packs) || 1)); // how many packs (1 pack = item.qty)
  const totalCost = item.price * packs;
  if (item.currency === 'gold') {
    if (player.gold < totalCost) { sendTo(ws, { type:'error', message:'Ouro insuficiente' }); return; }
    player.gold -= totalCost;
  } else {
    if (player.dobroes < totalCost) { sendTo(ws, { type:'error', message:'Dobrões insuficientes' }); return; }
    player.dobroes -= totalCost;
  }
  const gained = (item.qty || 30) * packs;
  player.inventory.ammo[msg.ammoId] = (player.inventory.ammo[msg.ammoId] || 0) + gained;
  progressDailyMission(player, 'itemsBought', 1);
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(ws, { type:'inventory_update', inventory: player.inventory, gold: player.gold, dobroes: player.dobroes });
}

function handleBuyNavio(player, msg, ws) {
  const { SHIP_DEFS } = require('./constants');
  const ship = SHIP_DEFS[msg.shipId];
  if (!ship) return;
  if (player.inventory.ships.includes(msg.shipId)) { sendTo(ws, { type:'error', message:'Já possui este navio' }); return; }
  if (ship.currency === 'gold') {
    if (player.gold < ship.price) { sendTo(ws, { type:'error', message:'Ouro insuficiente' }); return; }
    player.gold -= ship.price;
  } else if (ship.currency === 'dobrao') {
    if (player.dobroes < ship.price) { sendTo(ws, { type:'error', message:'Dobrões insuficientes' }); return; }
    player.dobroes -= ship.price;
  }
  player.inventory.ships.push(msg.shipId);
  progressDailyMission(player, 'itemsBought', 1);
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(ws, { type:'inventory_update', inventory: player.inventory, gold: player.gold, dobroes: player.dobroes });
}

function handleBuyVela(player, msg, ws) {
  const sail = SAIL_DEFS[msg.sailId];
  if (!sail) return;
  if (sail.currency === 'gold') {
    if (player.gold < sail.price) { sendTo(ws, { type:'error', message:'Ouro insuficiente' }); return; }
    player.gold -= sail.price;
  } else if (sail.currency === 'dobrao') {
    if (player.dobroes < sail.price) { sendTo(ws, { type:'error', message:'Dobrões insuficientes' }); return; }
    player.dobroes -= sail.price;
  }
  player.inventory.sails.push(msg.sailId);
  progressDailyMission(player, 'itemsBought', 1);
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(ws, { type:'inventory_update', inventory: player.inventory, gold: player.gold, dobroes: player.dobroes });
}

function handleBuyEliteShip(player, msg, ws) {
  const { SHIP_DEFS } = require('./constants');
  const shipDef = SHIP_DEFS[msg.shipId];
  if (!shipDef || !shipDef.isElite) { sendTo(ws, { type:'error', message:'Navio elite não encontrado' }); return; }
  if (player.inventory.ships.includes(msg.shipId)) { sendTo(ws, { type:'error', message:'Já possui este navio' }); return; }
  if (shipDef.currency === 'dobrao') {
    if (player.dobroes < shipDef.price) { sendTo(ws, { type:'error', message:'Dobrões insuficientes' }); return; }
    player.dobroes -= shipDef.price;
  } else {
    if (player.gold < shipDef.price) { sendTo(ws, { type:'error', message:'Ouro insuficiente' }); return; }
    player.gold -= shipDef.price;
  }
  player.inventory.ships.push(msg.shipId);
  progressDailyMission(player, 'itemsBought', 1);
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(ws, {
    type: 'inventory_update',
    inventory: player.inventory,
    gold: player.gold,
    dobroes: player.dobroes,
    shipIslandUpgrades: player.shipIslandUpgrades,
    cannonUpgradesData: player.cannonUpgradesData,
  });
}

function handleBuyShipUpgrade(player, msg, ws) {
  const upgradeType = msg.upgradeType || msg.upgradeId; // 'hp' | 'defense' | 'damage'
  const def = SHIP_UPGRADE_DEFS.find(d => d.id === upgradeType);
  if (!def) { sendTo(ws, { type: 'error', message: 'Upgrade inválido' }); return; }

  if (!player.shipIslandUpgrades || player.shipIslandUpgrades.hp === undefined) {
    player.shipIslandUpgrades = { hp: 0, defense: 0, damage: 0 };
  }
  const level = player.shipIslandUpgrades[upgradeType] || 0;
  if (level >= def.maxLevel) {
    sendTo(ws, { type: 'error', message: 'Upgrade já está no nível máximo' }); return;
  }

  const dustCost = def.goldDustPerLevel * (level + 1);
  if ((player.dobroes || 0) < def.dobroes) {
    sendTo(ws, { type: 'error', message: `Dobrões insuficientes! Necessário: ${def.dobroes.toLocaleString()}` }); return;
  }
  if ((player.goldDust || 0) < dustCost) {
    sendTo(ws, { type: 'error', message: `Pó de Ouro insuficiente! Necessário: ${dustCost}` }); return;
  }

  player.dobroes  -= def.dobroes;
  player.goldDust -= dustCost;
  player.shipIslandUpgrades[upgradeType] = level + 1;

  if (upgradeType === 'hp') {
    recalcMaxHp(player);
    player.hp = Math.min(player.hp + 1000, player.maxHp);
  }

  progressDailyMission(player, 'itemsBought', 1);
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(ws, {
    type: 'inventory_update',
    gold:               player.gold,
    goldDust:           player.goldDust,
    dobroes:            player.dobroes,
    shipIslandUpgrades: player.shipIslandUpgrades,
    hp:                 player.hp,
    maxHp:              player.maxHp,
  });
}

function handleBuyAfkTime(player, msg) {
  const _afkTr = MAP_DEFS[5]?.training;
  if (!_afkTr) return;
  const _afkHours = Math.max(1, Math.min(_afkTr.maxHours, parseInt(msg.hours) || 1));
  const _afkCost  = _afkHours * _afkTr.goldPerHour;
  if (player.gold < _afkCost) {
    sendTo(player.ws, { type: 'afk_error', reason: 'insufficient_gold',
      message: `Ouro insuficiente (precisa de ${_afkCost.toLocaleString()})` });
    return;
  }
  player.gold -= _afkCost;
  const _afkNow2  = Date.now();
  const _afkExtra = player.afkTraining ? Math.max(0, (player.afkUntil || _afkNow2) - _afkNow2) : 0;
  player.afkUntil    = _afkNow2 + _afkExtra + _afkHours * 3600000;
  player.afkTraining = true;
  player._afkFromMap = player.mapLevel || 4;
  player.mapLevel    = 5;
  player.x = 0; player.z = 50;
  player.input = { w: false, a: false, s: false, d: false };
  player.speed = 0;
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(player.ws, {
    type: 'map_transition', toLevel: 5,
    mapDef: MAP_DEFS[5], mapSize: MAP_DEFS[5].size,
    x: player.x, z: player.z, mapXp: player.mapXp || 0,
    npcs: [], bossProgress: null,
  });
  sendTo(player.ws, {
    type: 'afk_started',
    afkUntil: player.afkUntil,
    gold: player.gold,
    training: MAP_DEFS[5].training,
  });
}

function handleLeaveAfkTraining(player) {
  if (player.mapLevel !== 5) return;
  player.afkTraining   = false;
  player.afkUntil      = null;
  player._towerNextShot = null;
  const _retMap  = player._afkFromMap || 4;
  const _retSize = MAP_DEFS[_retMap]?.size || 1200;
  player.mapLevel = _retMap;
  player.x = (_retMap === 4) ? (_retSize / 2) - 80 : 0;
  player.z = 0;
  player.input = { w: false, a: false, s: false, d: false };
  player.speed = 0;
  if (_retMap === 3) ensureMap3Managers();
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(player.ws, {
    type: 'map_transition', toLevel: _retMap,
    mapDef: MAP_DEFS[_retMap], mapSize: _retSize,
    x: player.x, z: player.z, mapXp: player.mapXp || 0,
    npcs: _retMap === 3 && npcManager3 ? npcManager3.snapshot() : [],
    bossProgress: null,
    dailyMissions: _retMap === 4 ? buildDailyMissions(player) : undefined,
  });
  sendTo(player.ws, { type: 'afk_ended' });
}

function handleBuyCannonUpgrade(player, msg, ws) {
  // Usa MAP_DEFS já importado no topo — evita require cacheado desatualizado
  const cupgList = (MAP_DEFS[3]?.market?.items?.[0]?.cannonUpgrades) || [];
  const cupgDef  = cupgList.find(u => u.id === msg.upgradeId);
  if (!cupgDef) { sendTo(ws, { type:'error', message:'Upgrade de canhão não encontrado' }); return; }
  const idx = parseInt(msg.cannonIdx);
  if (isNaN(idx) || idx < 0 || idx >= player.inventory.cannons.length) {
    sendTo(ws, { type:'error', message:'Índice de canhão inválido' }); return;
  }
  if (player.inventory.cannons[idx] !== 'c6') {
    sendTo(ws, { type:'error', message:'Apenas canhões C6 podem ser melhorados' }); return;
  }
  if (!player.cannonUpgradesData) player.cannonUpgradesData = [];
  while (player.cannonUpgradesData.length <= idx) {
    player.cannonUpgradesData.push({ as: 0, rn: 0, dm: 0 });
  }
  const upg = player.cannonUpgradesData[idx];
  const field = cupgDef.field; // 'as', 'rn', or 'dm'
  if (upg[field]) { sendTo(ws, { type:'error', message:'Upgrade já aplicado neste canhão' }); return; }
  // ── Custo primário (gold ou dobrao) ─────────────────────────────────────
  if (cupgDef.currency === 'gold') {
    if ((player.gold || 0) < cupgDef.price) { sendTo(ws, { type:'error', message:`Ouro insuficiente! Necessário: ${cupgDef.price.toLocaleString()}` }); return; }
    player.gold -= cupgDef.price;
  } else {
    if ((player.dobroes || 0) < cupgDef.price) { sendTo(ws, { type:'error', message:`Dobrões insuficientes! Necessário: ${cupgDef.price.toLocaleString()}` }); return; }
    player.dobroes -= cupgDef.price;
  }
  // ── Custo em chapas (sempre exigido quando ironPlatesPrice > 0) ──────────
  const platesNeeded = cupgDef.ironPlatesPrice || 0;
  if (platesNeeded > 0) {
    if ((player.ironPlates || 0) < platesNeeded) {
      // Devolver o custo primário já deduzido antes de retornar erro
      if (cupgDef.currency === 'gold') player.gold += cupgDef.price;
      else player.dobroes += cupgDef.price;
      sendTo(ws, { type:'error', message:`Chapas insuficientes! Necessário: ${platesNeeded}` }); return;
    }
    player.ironPlates -= platesNeeded;
  }
  upg[field] = 1;
  recalcCannons(player);
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(ws, {
    type: 'inventory_update',
    inventory: player.inventory,
    gold: player.gold,
    dobroes: player.dobroes,
    ironPlates: player.ironPlates,
    shipIslandUpgrades: player.shipIslandUpgrades,
    cannonUpgradesData: player.cannonUpgradesData,
  });
  sendTo(ws, {
    type:        'cannon_state',
    cannons:     player.cannons,
    charges:     salvoCount(player),
    maxCharges:  salvoCount(player),
    cooldown:    0,
    cooldownMax: player.cannonCooldownMax,
    range:       player.cannonRange,
    lifesteal:   player.cannonLifesteal,
  });
}

function handleExchangeGold(player, msg, ws) {
  const times      = Math.max(1, Math.floor(Number(msg.times) || 1));
  const goldCost   = times * 10000;
  const dobraoGain = times * 100;
  if (player.gold < goldCost) {
    sendTo(ws, { type: 'toast', msg: 'Ouro insuficiente!' });
    return;
  }
  player.gold    -= goldCost;
  player.dobroes  = (player.dobroes || 0) + dobraoGain;
  db.save(player, true).catch(e => console.error('exchange_gold save error:', e));
  sendTo(ws, {
    type:    'currency_update',
    gold:    player.gold,
    dobroes: player.dobroes,
    reward:  { type: 'exchange', dobrao: dobraoGain },
  });
}

function handleEquipVela(player, msg, ws) {
  const { SHIP_DEFS } = require('./constants');
  const activeSail = SAIL_DEFS[msg.sailId];
  if (!activeSail) return;
  if (!player.inventory.sails.includes(msg.sailId)) return;
  // Sail slot limit from active ship
  const shipDef   = SHIP_DEFS[player.activeShip] || SHIP_DEFS['fragata'];
  const maxSlots  = shipDef.sails || 1;
  if (player.equippedSails.length >= maxSlots) {
    // Shift out oldest equipped sail (FIFO)
    player.equippedSails.shift();
  }
  player.equippedSails.push(msg.sailId);
  _recalcSails(player);
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(ws, {
    type: 'sail_update',
    equippedSails:  player.equippedSails,
    sailSpeedMult:  player.sailSpeedMult,
    inventory:      player.inventory,
  });
}

function handleExploreMap(player, msg, ws) {
  const rawQty    = Math.max(1, Math.min(Math.floor(msg.qty || 1), 10000));
  const fragments = player.mapFragments || 0;
  const dobroes   = player.dobroes      || 0;

  // Use fragments first, then dobrões for the remainder
  const canDoFrags   = Math.floor(fragments / FRAGMENT_EXPLORE_COST);
  const canDoDobroes = Math.floor(dobroes   / FRAGMENT_EXPLORE_FALLBACK_COST);
  const timesFrags   = Math.min(rawQty, canDoFrags);
  const timesDobroes = Math.min(rawQty - timesFrags, canDoDobroes);
  const times        = timesFrags + timesDobroes;

  if (times === 0) {
    sendTo(ws, { type: 'error', message: 'Fragmentos ou dobrões insuficientes!' });
    return;
  }

  // Pre-compute weight sum
  const totalWeight = EXPLORATION_REWARDS.reduce((s, r) => s + r.weight, 0);

  // Accumulate all rewards
  const ammoResults     = {}; // { ammoId: qty }
  const resourceResults = {}; // { resourceId: qty }

  for (let i = 0; i < times; i++) {
    // Use fragments first, then dobrões for the remainder
    if (i < timesFrags) {
      player.mapFragments -= FRAGMENT_EXPLORE_COST;
    } else {
      player.dobroes -= FRAGMENT_EXPLORE_FALLBACK_COST;
    }

    // Weighted random pick
    let roll = Math.random() * totalWeight;
    let reward = EXPLORATION_REWARDS[0];
    for (const entry of EXPLORATION_REWARDS) { roll -= entry.weight; if (roll <= 0) { reward = entry; break; } }

    if (reward.type === 'ammo') {
      ammoResults[reward.id] = (ammoResults[reward.id] || 0) + reward.qty;
      player.inventory.ammo[reward.id] = (player.inventory.ammo[reward.id] || 0) + reward.qty;
    } else if (reward.type === 'mapPiece') {
      // mapPiece: accumulates per bonus-map in player.mapPieces
      if (!player.mapPieces) player.mapPieces = {};
      player.mapPieces[reward.id] = (player.mapPieces[reward.id] || 0) + reward.qty;
      resourceResults[reward.id] = (resourceResults[reward.id] || 0) + reward.qty;
    } else {
      // resource: ironPlates | goldDust | gunpowder | mapFragments
      resourceResults[reward.id] = (resourceResults[reward.id] || 0) + reward.qty;
      player[reward.id] = (player[reward.id] || 0) + reward.qty;
    }
  }

  progressDailyMission(player, 'fragmentUse', times);
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(ws, {
    type:          'explore_result',
    ammoResults,
    resourceResults,
    times,
    timesFrags,
    timesDobroes,
    usingFallback: timesDobroes > 0,
    mapFragments:  player.mapFragments,
    dobroes:       player.dobroes,
    ironPlates:    player.ironPlates    || 0,
    goldDust:      player.goldDust      || 0,
    gunpowder:     player.gunpowder     || 0,
    mapPieces:     player.mapPieces     || {},
    inventory:     player.inventory,
  });
}

function handleEnterBonusDungeon(player, msg, ws) {
  const dungeonId = msg.dungeonId;
  const dungeon   = BONUS_DUNGEON_DEFS[dungeonId];
  const config    = BONUS_DUNGEON_MAP_CONFIGS[dungeonId];
  if (!dungeon || !config) { sendTo(ws, { type: 'error', message: 'Masmorra inválida.' }); return; }

  const pieceId  = dungeon.pieceId;
  const required = dungeon.requiredPieces;
  if (!player.mapPieces) player.mapPieces = {};
  const current  = player.mapPieces[pieceId] || 0;
  if (current < required) {
    sendTo(ws, { type: 'error', message: `Peças insuficientes! ${current}/${required}` });
    return;
  }

  // Deduct pieces
  player.mapPieces[pieceId] = current - required;

  // Store return location
  player._prevMapLevel = player.mapLevel || 1;
  player._prevX = player.x || 0;
  player._prevZ = player.z || 0;

  // Teleport to dungeon zone
  const dungeonLevel = config.mapLevel;
  player.mapLevel = dungeonLevel;
  player.x = 0;
  player.z = config.playerSpawnZ || 150;
  player.input = { w: false, a: false, s: false, d: false };
  player.speed = 0;

  // Ensure dungeon NPC manager exists (creates & spawns 1 NPC if needed)
  ensureManagersForMap(dungeonLevel);
  const dungeonMgr = getMapManager(dungeonLevel);

  db.save(player, true).catch(e => console.error('Save error:', e));

  sendTo(ws, {
    type:     'map_transition',
    toLevel:  dungeonLevel,
    mapDef:   DUNGEON_MAP_DEFS[dungeonLevel] || {},
    mapSize:  config.size,
    x:        player.x,
    z:        player.z,
    npcs:     dungeonMgr ? dungeonMgr.snapshot() : [],
    bossProgress: null,
    mapPieces: player.mapPieces,
  });
}

function handleDungeonComplete(player, npc) {
  const dungeonId = npc.dungeonId;
  const dungeon   = BONUS_DUNGEON_DEFS[dungeonId];
  if (!dungeon) return;

  // Wave 0 rewards
  const wave    = dungeon.waves[0];
  const rewards = wave.rewards;
  player.dobroes    = (player.dobroes    || 0) + (rewards.dobroes    || 0);
  player.gold       = (player.gold       || 0) + (rewards.gold       || 0);
  player.ironPlates = (player.ironPlates || 0) + (rewards.ironPlates || 0);
  player.goldDust   = (player.goldDust   || 0) + (rewards.goldDust   || 0);
  player.gunpowder  = (player.gunpowder  || 0) + (rewards.gunpowder  || 0);
  if (rewards.xp) player.mapXp = (player.mapXp || 0) + rewards.xp;

  // Roll rare ship drop
  const npcDef = BONUS_NPC_DEFS[dungeon.npcId];
  let shipDrop = null;
  if (npcDef && Math.random() < npcDef.shipDropChance) {
    shipDrop = rollBonusShip(npcDef);
    if (!player.rareShips) player.rareShips = [];
    player.rareShips.push(shipDrop);
  }

  db.save(player, true).catch(e => console.error('Save error:', e));

  sendTo(player.ws, {
    type:       'bonus_dungeon_complete',
    dungeonId,
    rewards,
    shipDrop,
    autoLeaveMs: 10000,   // client auto-teleports after this delay
    mapPieces:  player.mapPieces  || {},
    rareShips:  player.rareShips  || [],
    dobroes:    player.dobroes,
    gold:       player.gold,
    ironPlates: player.ironPlates || 0,
    goldDust:   player.goldDust   || 0,
    gunpowder:  player.gunpowder  || 0,
  });

  // Auto-teleport back after autoLeaveMs
  setTimeout(() => {
    if (player.ws && (player.mapLevel || 0) >= 10) _dungeonLeave(player);
  }, 10000);
}

function _dungeonLeave(player) {
  const returnLevel = player._prevMapLevel || 1;
  const returnX = player._prevX || 0;
  const returnZ = player._prevZ || 0;

  player.mapLevel = returnLevel;
  player.x = returnX;
  player.z = returnZ;
  player._prevMapLevel = null;
  player._prevX = null;
  player._prevZ = null;
  player.input = { w: false, a: false, s: false, d: false };
  player.speed = 0;

  ensureManagersForMap(returnLevel);
  const returnMgr = getMapManager(returnLevel);
  const returnDef = MAP_DEFS[returnLevel] || MAP_DEFS[1];
  const returnSize = returnDef.size || 1200;
  const bpKts = returnDef.boss?.killsToSpawn ?? 10;

  db.save(player, true).catch(e => console.error('Save error:', e));

  sendTo(player.ws, {
    type:     'map_transition',
    toLevel:  returnLevel,
    mapDef:   returnDef,
    mapSize:  returnSize,
    x:        returnX,
    z:        returnZ,
    npcs:     returnMgr ? returnMgr.snapshot() : [],
    mapXp:    player.mapXp || 0,
    bossProgress: returnDef.boss
      ? { current: getMapKills(returnLevel) % bpKts, needed: bpKts, mapLevel: returnLevel, bossAlive: getMapBossAlive(returnLevel) }
      : null,
  });
}

function _scheduleDungeonNpcRespawn(dungeonId) {
  const config = BONUS_DUNGEON_MAP_CONFIGS[dungeonId];
  if (!config || !config.npcRespawnDelay) return;
  setTimeout(() => {
    const mgr = getMapManager(config.mapLevel);
    if (!mgr) return;
    if (mgr.npcs.size > 0) return; // already has an NPC
    const npc = mgr.spawn(config.mapLevel);
    npc.isDungeonBoss = true;
    npc.dungeonId     = dungeonId;
    addEvent({ type: 'entity_add', entity: mgr.snapshot([npc])[0] }, config.mapLevel, true);
  }, config.npcRespawnDelay);
}

function handleUnlockBonusMap(player, msg, ws) {
  const mapId = msg.mapId;
  const mapDef = BONUS_MAPS.find(m => m.id === mapId);
  if (!mapDef) { sendTo(ws, { type: 'error', message: 'Mapa bônus inválido.' }); return; }

  const already = (player.bonusMapsUnlocked || []).includes(mapId);
  if (already) { sendTo(ws, { type: 'error', message: 'Mapa já desbloqueado!' }); return; }

  if ((player.mapFragments || 0) < mapDef.requiredFragments) {
    sendTo(ws, { type: 'error', message: `Fragmentos insuficientes! Necessário: ${mapDef.requiredFragments}` });
    return;
  }

  player.mapFragments       -= mapDef.requiredFragments;
  player.bonusMapsUnlocked   = [...(player.bonusMapsUnlocked || []), mapId];
  db.save(player).catch(e => console.error('Save error:', e));

  sendTo(ws, {
    type:              'bonus_map_unlocked',
    mapId,
    mapFragments:      player.mapFragments,
    bonusMapsUnlocked: player.bonusMapsUnlocked,
  });
}

function handleCannonResearch(player, msg, ws) {
  const cannonIdx = msg.cannonIdx ?? 0;
  const cannons   = player.inventory?.cannons || [];
  if (cannonIdx < 0 || cannonIdx >= cannons.length) {
    sendTo(ws, { type: 'error', message: 'Canhão inválido.' });
    return;
  }

  // Garante que upgData tem entrada para este slot
  const upgData = player.cannonUpgradesData;
  while (upgData.length <= cannonIdx) upgData.push({});
  const upg      = upgData[cannonIdx];
  const resLevel = upg.rl || 0;

  if (resLevel >= CANNON_RESEARCH_COSTS.length) {
    sendTo(ws, { type: 'error', message: 'Pesquisa deste canhão já está no nível máximo!' });
    return;
  }
  const costDef = CANNON_RESEARCH_COSTS[resLevel];
  if ((player.ironPlates || 0) < costDef.ironPlates) {
    sendTo(ws, { type: 'error', message: `Chapas de Ferro insuficientes! Necessário: ${costDef.ironPlates}` });
    return;
  }
  if (costDef.gold && (player.gold || 0) < costDef.gold) {
    sendTo(ws, { type: 'error', message: `Ouro insuficiente! Necessário: ${costDef.gold.toLocaleString()}` });
    return;
  }
  if (costDef.dobroes && (player.dobroes || 0) < costDef.dobroes) {
    sendTo(ws, { type: 'error', message: `Dobrões insuficientes! Necessário: ${costDef.dobroes.toLocaleString()}` });
    return;
  }

  player.ironPlates -= costDef.ironPlates;
  if (costDef.gold)   player.gold   -= costDef.gold;
  if (costDef.dobroes) player.dobroes -= costDef.dobroes;
  upg.rl = resLevel + 1;
  db.save(player, true).catch(e => console.error('Save error:', e));

  sendTo(ws, {
    type:               'cannon_research_result',
    cannonIdx,
    cannonResearchLevel: upg.rl,
    cannonUpgradesData:  player.cannonUpgradesData,
    ironPlates:          player.ironPlates,
    gold:                player.gold,
    dobroes:             player.dobroes,
  });
}


function handleEquipRelic(player, msg) {
  const { instanceId, deckPosition } = msg;
  const maxRel = player.maxRelics || 4;
  if (deckPosition == null || deckPosition < 0 || deckPosition >= maxRel) return;
  // Verify player owns the relic
  const relicInv = player.inventory.relics || [];
  const instance = relicInv.find(r => r.instanceId === instanceId);
  if (!instance) return;
  if (!player.relicDeck) player.relicDeck = [];
  // Remove from current deck position if already equipped
  player.relicDeck = player.relicDeck.filter(id => id !== instanceId);
  player.relicDeck.splice(deckPosition, 0, instanceId);
  if (player.relicDeck.length > maxRel) player.relicDeck = player.relicDeck.slice(0, maxRel);
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(player.ws, {
    type:           'relic_state',
    relicDeck:      player.relicDeck,
    relicInventory: player.inventory.relics,
    mana:           player.mana,
    maxMana:        player.maxMana,
  });
}

function handleUnequipRelic(player, msg) {
  const { deckPosition: uPos } = msg;
  if (!player.relicDeck) return;
  if (uPos == null || uPos < 0 || uPos >= player.relicDeck.length) return;
  // Deactivate gold shield if it was equipped
  const uInstanceId = player.relicDeck[uPos];
  if (uInstanceId) {
    const uInst = (player.inventory.relics || []).find(r => r.instanceId === uInstanceId);
    if (uInst) {
      const uDef = RELIC_DEFS[uInst.relicId];
      if (uDef?.effect === 'gold_shield') player.relicGoldShieldActive = false;
    }
  }
  player.relicDeck.splice(uPos, 1);
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(player.ws, {
    type:           'relic_state',
    relicDeck:      player.relicDeck,
    relicInventory: player.inventory.relics,
    mana:           player.mana,
    maxMana:        player.maxMana,
  });
}

function handleUseRelic(player, msg) {
  const { instanceId: useInstanceId, targetX: rTx, targetZ: rTz } = msg;
  if (!useInstanceId) return;
  // Verify relic is in player's deck
  if (!player.relicDeck || !player.relicDeck.includes(useInstanceId)) return;
  const relicInstance = (player.inventory.relics || []).find(r => r.instanceId === useInstanceId);
  if (!relicInstance) return;
  const relicDef = RELIC_DEFS[relicInstance.relicId];
  if (!relicDef) return;
  const instanceId2 = useInstanceId;

  const now2 = Date.now();
  const manaCost = relicDef.manaCost || 0;

  // Toggle relics (gold shield) — mana cost on activation only
  if (relicDef.toggle) {
    if (relicDef.effect === 'gold_shield') {
      // Deactivation is free; activation costs mana
      if (!player.relicGoldShieldActive && player.mana < manaCost) {
        sendTo(player.ws, { type: 'relic_no_mana', mana: player.mana, maxMana: player.maxMana, needed: manaCost });
        return;
      }
      if (!player.relicGoldShieldActive) {
        player.mana = Math.max(0, player.mana - manaCost);
      }
      player.relicGoldShieldActive = !player.relicGoldShieldActive;
      sendTo(player.ws, {
        type:        'relic_used',
        instanceId:  instanceId2,
        effect:      'gold_shield',
        active:      player.relicGoldShieldActive,
        mana:        player.mana,
        maxMana:     player.maxMana,
      });
    }
    return;
  }

  // Mana check for non-toggle relics
  if (player.mana < manaCost) {
    sendTo(player.ws, { type: 'relic_no_mana', mana: player.mana, maxMana: player.maxMana, needed: manaCost });
    return;
  }
  player.mana = Math.max(0, player.mana - manaCost);
  if (relicDef.castTime) player.castExpires = Date.now() + relicDef.castTime; // cast penalty

  // Apply effect
  let effectPayload = { type: 'relic_used', instanceId: instanceId2, effect: relicDef.effect, mana: player.mana, maxMana: player.maxMana };

  if (relicDef.effect === 'heal_ship') {
    const healed = Math.min(relicDef.healAmount, player.maxHp - player.hp);
    player.hp = Math.min(player.maxHp, player.hp + relicDef.healAmount);
    effectPayload.hp    = player.hp;
    effectPayload.maxHp = player.maxHp;
    effectPayload.healed = healed;
    if (healed > 0) grantSkillXp(player, 'vida', Math.floor(healed / 10), wss);

  } else if (relicDef.effect === 'invincible') {
    player.relicInvincibleExpires = now2 + relicDef.duration;
    effectPayload.duration = relicDef.duration;

  } else if (relicDef.effect === 'lightning') {
    const LIGHTNING_RADIUS = relicDef.radius || 20;
    const castMs = relicDef.castTime || 1000;
    const lx = rTx != null ? rTx : player.x;
    const lz = rTz != null ? rTz : player.z;

    // 1. Avisa TODOS os clientes imediatamente para mostrar o indicador visual
    addEvent({
      type:     'lightning_cast',
      casterId: player.id,
      targetX:  lx,
      targetZ:  lz,
      radius:   LIGHTNING_RADIUS,
      castMs,
    });

    // 1b. Notifica o NPC manager do mapa do jogador para que NPCs tentem desviar
    {
      const _pLvl = player.mapLevel || 1;
      const _lMgr = _pLvl === 6 ? npcManager6
                  : _pLvl === 4 ? npcManager4
                  : _pLvl === 3 ? npcManager3
                  : _pLvl === 2 ? npcManager2
                  : npcManager;
      _lMgr?.notifyDangerZone(lx, lz, LIGHTNING_RADIUS, castMs);
    }

    // 2. Aplica dano após o cast time (permite desviar)
    setTimeout(() => {
      if (player.dead) return; // caster morreu durante o cast
      const relicDamage = Math.round(relicDef.damage * (1 + (player.talentRelicBonus || 0) + (player.skillRelicBonus || 0)));
      const hits2 = [];
      projectileManager.npcs.forEach(npc => {
        if (npc.dead) return;
        const d = Math.hypot(npc.x - lx, npc.z - lz);
        if (d <= LIGHTNING_RADIUS) {
          npc.hp = Math.max(0, npc.hp - relicDamage);
          npc.lastDamageTime = Date.now();
          hits2.push({ id: npc.id, hp: npc.hp, isNPC: true, dmg: relicDamage });
          // Registrar dano no boss para distribuição de recompensa proporcional
          if (npc.isBoss) {
            if (!npc._damageMap) npc._damageMap = new Map();
            npc._damageMap.set(player.id, (npc._damageMap.get(player.id) || 0) + relicDamage);
          }
          if (npc.hp <= 0 && !npc.dead) {
            npc.dead = true;
            if (npc.isBoss) {
              addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, isBoss: true, killerId: player.id }, npc.mapLevel);
              if (npc.isWorldBoss) {
                worldBossManager.onWorldBossDead(npc, player.id);
              } else {
                const _lBossLvl = npc.mapLevel || 1;
                const lBossMgr = _lBossLvl === 3 ? bossManager3 : _lBossLvl === 2 ? bossManager2 : bossManager;
                lBossMgr.onBossDead(npc, player.id);
                worldBossManager.onZoneBossDead(npc, player.id);
              }
              projectileManager.npcs.delete(npc.id);
            } else if (npc.isDungeonBoss) {
              addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, killerId: player.id, goldDrop: 0 }, npc.mapLevel);
              projectileManager.npcs.delete(npc.id);
              handleDungeonComplete(player, npc);
              _scheduleDungeonNpcRespawn(npc.dungeonId);
            } else {
              const rewards = projectileManager.grantNpcKillRewards(player, npc);
              addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, killerId: player.id, goldDrop: rewards.goldDrop }, npc.mapLevel);
              const _nLvlL = npc.mapLevel || 1;
              const lmgr = _nLvlL === 4 ? npcManager4 : _nLvlL === 3 ? npcManager3 : _nLvlL === 2 ? npcManager2 : npcManager;
              lmgr && lmgr.respawnScaled(npc.id, player.npcKills || 0, _nLvlL);
              // Boss spawn accounting (lightning kill)
              { const _bpLvlL = _nLvlL;
                if (_bpLvlL === 3) projectileManager.totalNpcKills3 = (projectileManager.totalNpcKills3||0)+1;
                else if (_bpLvlL === 2) projectileManager.totalNpcKills2 = (projectileManager.totalNpcKills2||0)+1;
                else projectileManager.totalNpcKills = (projectileManager.totalNpcKills||0)+1;
                const _bpKtsL = MAP_DEFS[_bpLvlL]?.boss?.killsToSpawn ?? 10;
                const _bpTotL = _bpLvlL===3 ? projectileManager.totalNpcKills3 : _bpLvlL===2 ? projectileManager.totalNpcKills2 : projectileManager.totalNpcKills;
                const _bpBmgrL = _bpLvlL===3 ? bossManager3 : _bpLvlL===2 ? bossManager2 : bossManager;
                if ((_bpTotL % _bpKtsL) === 0 && _bpBmgrL && !_bpBmgrL.bossAlive) {
                  const rarity = _bpBmgrL.rollPendingRarity();
                  addEvent({ type:'boss_incoming', rarity, mapLevel:_bpLvlL }, _bpLvlL);
                  setTimeout(() => _bpBmgrL.spawn(player.npcKills||0), 2000);
                }
                addEvent({ type:'boss_progress', current:_bpTotL%_bpKtsL, needed:_bpKtsL, mapLevel:_bpLvlL, bossAlive:!!_bpBmgrL?.bossAlive }, _bpLvlL);
              }
              db.save(player).catch(e => console.error('Save error:', e));
              const curMapDef = MAP_DEFS[player.mapLevel || 1] || {};
              sendTo(player.ws, {
                type: 'currency_update', gold: player.gold, dobroes: player.dobroes,
                reward: { type: 'gold', amount: rewards.finalGold },
                npcKills: player.npcKills, mapXp: player.mapXp,
                mapLevel: player.mapLevel || 1, mapXpNeeded: curMapDef.xpToAdvance || 99999,
                mapFragments: player.mapFragments || 0,
              });
            }
          }
        }
      });
      players.forEach(p => {
        if (p.dead || p.id === player.id) return;
        const d = Math.hypot(p.x - lx, p.z - lz);
        if (d <= LIGHTNING_RADIUS) {
          p.hp = Math.max(0, p.hp - relicDamage);
          p.lastCombatTime = Date.now();
          hits2.push({ id: p.id, hp: p.hp, isNPC: false, dmg: relicDamage });
        }
      });
      // Envia o resultado (dano real) para todos após o impacto
      addEvent({
        type:     'lightning_strike',
        casterId: player.id,
        targetX:  lx,
        targetZ:  lz,
        hits:     hits2,
      }, player.mapLevel || 1);
      // XP de relíquia pelo raio
      const lightningNpcHits = hits2.filter(h => h.isNPC).length;
      if (lightningNpcHits > 0) grantSkillXp(player, 'reliquia', lightningNpcHits * 18, wss);
      // Atualiza HP do caster visualmente
      sendTo(player.ws, { type: 'heal', amount: 0, hp: player.hp, source: 'relic_sync' });
    }, castMs);

    // effectPayload sem hits (chegam depois via lightning_strike)
    effectPayload.targetX = lx;
    effectPayload.targetZ = lz;
    effectPayload.castMs  = castMs;

  } else if (relicDef.effect === 'rocket') {
    const castMs      = relicDef.castTime || 600;
    const ROCKET_RADIUS = relicDef.radius || 8;
    const rkTx = rTx != null ? rTx : player.x + Math.sin(player.rotation || 0) * 80;
    const rkTz = rTz != null ? rTz : player.z + Math.cos(player.rotation || 0) * 80;

    // 1. Avisa TODOS os clientes imediatamente para mostrar o arco visual
    addEvent({
      type:     'rocket_cast',
      casterId: player.id,
      fromX:    player.x,
      fromZ:    player.z,
      targetX:  rkTx,
      targetZ:  rkTz,
      radius:   ROCKET_RADIUS,
      castMs,
    });

    // 2. Aplica dano após o cast time (permite desviar)
    setTimeout(() => {
      if (player.dead) return;
      const relicDamage = Math.round(relicDef.damage * (1 + (player.talentRelicBonus || 0) + (player.skillRelicBonus || 0)));
      const hitsRkt = [];
      projectileManager.npcs.forEach(npc => {
        if (npc.dead) return;
        if (Math.hypot(npc.x - rkTx, npc.z - rkTz) <= ROCKET_RADIUS) {
          npc.hp = Math.max(0, npc.hp - relicDamage);
          npc.lastDamageTime = Date.now();
          hitsRkt.push({ id: npc.id, hp: npc.hp, isNPC: true, dmg: relicDamage });
          // Registrar dano no boss para distribuição de recompensa proporcional
          if (npc.isBoss) {
            if (!npc._damageMap) npc._damageMap = new Map();
            npc._damageMap.set(player.id, (npc._damageMap.get(player.id) || 0) + relicDamage);
          }
          if (npc.hp <= 0 && !npc.dead) {
            npc.dead = true;
            if (npc.isBoss) {
              addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, isBoss: true, killerId: player.id }, npc.mapLevel);
              if (npc.isWorldBoss) {
                worldBossManager.onWorldBossDead(npc, player.id);
              } else {
                const _rkBossLvl = npc.mapLevel || 1;
                const rkBossMgr = _rkBossLvl === 3 ? bossManager3 : _rkBossLvl === 2 ? bossManager2 : bossManager;
                rkBossMgr.onBossDead(npc, player.id);
                worldBossManager.onZoneBossDead(npc, player.id);
              }
              projectileManager.npcs.delete(npc.id);
            } else if (npc.isDungeonBoss) {
              addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, killerId: player.id, goldDrop: 0 }, npc.mapLevel);
              projectileManager.npcs.delete(npc.id);
              handleDungeonComplete(player, npc);
              _scheduleDungeonNpcRespawn(npc.dungeonId);
            } else {
              const rewards = projectileManager.grantNpcKillRewards(player, npc);
              addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, killerId: player.id, goldDrop: rewards.goldDrop }, npc.mapLevel);
              const _nLvlR = npc.mapLevel || 1;
              const rkMgr = _nLvlR === 4 ? npcManager4 : _nLvlR === 3 ? npcManager3 : _nLvlR === 2 ? npcManager2 : npcManager;
              rkMgr && rkMgr.respawnScaled(npc.id, player.npcKills || 0, _nLvlR);
              // Boss spawn accounting (rocket kill)
              { const _bpLvlR = _nLvlR;
                if (_bpLvlR === 3) projectileManager.totalNpcKills3 = (projectileManager.totalNpcKills3||0)+1;
                else if (_bpLvlR === 2) projectileManager.totalNpcKills2 = (projectileManager.totalNpcKills2||0)+1;
                else projectileManager.totalNpcKills = (projectileManager.totalNpcKills||0)+1;
                const _bpKtsR = MAP_DEFS[_bpLvlR]?.boss?.killsToSpawn ?? 10;
                const _bpTotR = _bpLvlR===3 ? projectileManager.totalNpcKills3 : _bpLvlR===2 ? projectileManager.totalNpcKills2 : projectileManager.totalNpcKills;
                const _bpBmgrR = _bpLvlR===3 ? bossManager3 : _bpLvlR===2 ? bossManager2 : bossManager;
                if ((_bpTotR % _bpKtsR) === 0 && _bpBmgrR && !_bpBmgrR.bossAlive) {
                  const rarity = _bpBmgrR.rollPendingRarity();
                  addEvent({ type:'boss_incoming', rarity, mapLevel:_bpLvlR }, _bpLvlR);
                  setTimeout(() => _bpBmgrR.spawn(player.npcKills||0), 2000);
                }
                addEvent({ type:'boss_progress', current:_bpTotR%_bpKtsR, needed:_bpKtsR, mapLevel:_bpLvlR, bossAlive:!!_bpBmgrR?.bossAlive }, npc.mapLevel);
              }
              db.save(player).catch(e => console.error('Save error:', e));
              const curMapDef = MAP_DEFS[player.mapLevel || 1] || {};
              sendTo(player.ws, {
                type: 'currency_update', gold: player.gold, dobroes: player.dobroes,
                reward: { type: 'gold', amount: rewards.finalGold },
                npcKills: player.npcKills, mapXp: player.mapXp,
                mapLevel: player.mapLevel || 1, mapXpNeeded: curMapDef.xpToAdvance || 99999,
                mapFragments: player.mapFragments || 0,
              });
            }
          }
        }
      });
      players.forEach(p => {
        if (p.dead || p.id === player.id) return;
        if (Math.hypot(p.x - rkTx, p.z - rkTz) <= ROCKET_RADIUS) {
          p.hp = Math.max(0, p.hp - relicDamage);
          p.lastCombatTime = Date.now();
          hitsRkt.push({ id: p.id, hp: p.hp, isNPC: false, dmg: relicDamage });
        }
      });
      addEvent({
        type:     'rocket_strike',
        casterId: player.id,
        targetX:  rkTx,
        targetZ:  rkTz,
        hits:     hitsRkt,
      }, player.mapLevel || 1);
      // XP de relíquia pelo foguete
      const rocketNpcHits = hitsRkt.filter(h => h.isNPC).length;
      if (rocketNpcHits > 0) grantSkillXp(player, 'reliquia', rocketNpcHits * 18, wss);
    }, castMs);

    effectPayload.targetX = rkTx;
    effectPayload.targetZ = rkTz;
    effectPayload.castMs  = castMs;

  } else if (relicDef.effect === 'speed_boost') {
    player.relicSpeedExpires = now2 + relicDef.duration;
    player.relicSpeedBonus   = relicDef.speedBonus;
    effectPayload.duration   = relicDef.duration;

  } else if (relicDef.effect === 'attract') {
    // Attract all NPCs within range toward this player for `duration` ms
    player.relicAttractExpires = now2 + relicDef.duration;
    player.relicAttractRange   = relicDef.range;
    effectPayload.duration     = relicDef.duration;
    effectPayload.range        = relicDef.range;
    // Broadcast attract event só para clientes do mesmo mapa
    addEvent({
      type:     'attract_cast',
      casterId: player.id,
      x:        player.x,
      z:        player.z,
      range:    relicDef.range,
      duration: relicDef.duration,
    }, player.mapLevel || 1);

  } else if (relicDef.effect === 'meteor') {
    // ── Chuva de Meteoros ─────────────────────────────────────────────
    // 3 meteors fall sequentially near the target; last one = double dmg + radius
    const castMs     = relicDef.castTime || 1000;
    const baseRadius = relicDef.radius  || 15;
    const scatter    = relicDef.scatter  || 25;
    const mtTx       = rTx != null ? rTx : player.x;
    const mtTz       = rTz != null ? rTz : player.z;

    // Generate 3 random impact positions near the target
    const positions = [
      { x: mtTx, z: mtTz }, // first one: dead centre
      { x: mtTx + (Math.random() - 0.5) * scatter * 2, z: mtTz + (Math.random() - 0.5) * scatter * 2 },
      { x: mtTx + (Math.random() - 0.5) * scatter * 2, z: mtTz + (Math.random() - 0.5) * scatter * 2 },
    ];

    // Helper: apply meteor AOE damage and grant rewards
    const applyMeteorHit = (pos, radius, dmg) => {
      const hitsM = [];
      projectileManager.npcs.forEach(npc => {
        if (npc.dead) return;
        if (Math.hypot(npc.x - pos.x, npc.z - pos.z) > radius) return;
        npc.hp = Math.max(0, npc.hp - dmg);
        npc.lastDamageTime = Date.now();
        hitsM.push({ id: npc.id, hp: npc.hp, isNPC: true, dmg });
        // Registrar dano no boss para distribuição de recompensa proporcional
        if (npc.isBoss) {
          if (!npc._damageMap) npc._damageMap = new Map();
          npc._damageMap.set(player.id, (npc._damageMap.get(player.id) || 0) + dmg);
        }
        if (npc.hp <= 0 && !npc.dead) {
          npc.dead = true;
          if (npc.isBoss) {
            addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, isBoss: true, killerId: player.id }, npc.mapLevel);
            if (npc.isWorldBoss) {
              worldBossManager.onWorldBossDead(npc, player.id);
            } else {
              const _mtBossLvl = npc.mapLevel || 1;
              const mtBossMgr = _mtBossLvl === 3 ? bossManager3 : _mtBossLvl === 2 ? bossManager2 : bossManager;
              mtBossMgr.onBossDead(npc, player.id);
              worldBossManager.onZoneBossDead(npc, player.id);
            }
            projectileManager.npcs.delete(npc.id);
          } else if (npc.isDungeonBoss) {
              addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, killerId: player.id, goldDrop: 0 }, npc.mapLevel);
              projectileManager.npcs.delete(npc.id);
              handleDungeonComplete(player, npc);
              _scheduleDungeonNpcRespawn(npc.dungeonId);
          } else {
            const rewards = projectileManager.grantNpcKillRewards(player, npc);
            addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, killerId: player.id, goldDrop: rewards.goldDrop }, npc.mapLevel);
            const _nLvlM = npc.mapLevel || 1;
            const mtMgr = _nLvlM === 4 ? npcManager4 : _nLvlM === 3 ? npcManager3 : _nLvlM === 2 ? npcManager2 : npcManager;
            mtMgr && mtMgr.respawnScaled(npc.id, player.npcKills || 0, _nLvlM);
            // Boss spawn accounting (meteor kill)
            { const _bpLvlM = _nLvlM;
              if (_bpLvlM === 3) projectileManager.totalNpcKills3 = (projectileManager.totalNpcKills3||0)+1;
              else if (_bpLvlM === 2) projectileManager.totalNpcKills2 = (projectileManager.totalNpcKills2||0)+1;
              else projectileManager.totalNpcKills = (projectileManager.totalNpcKills||0)+1;
              const _bpKtsM = MAP_DEFS[_bpLvlM]?.boss?.killsToSpawn ?? 10;
              const _bpTotM = _bpLvlM===3 ? projectileManager.totalNpcKills3 : _bpLvlM===2 ? projectileManager.totalNpcKills2 : projectileManager.totalNpcKills;
              const _bpBmgrM = _bpLvlM===3 ? bossManager3 : _bpLvlM===2 ? bossManager2 : bossManager;
              if ((_bpTotM % _bpKtsM) === 0 && _bpBmgrM && !_bpBmgrM.bossAlive) {
                const rarity = _bpBmgrM.rollPendingRarity();
                addEvent({ type:'boss_incoming', rarity, mapLevel:_bpLvlM }, _bpLvlM);
                setTimeout(() => _bpBmgrM.spawn(player.npcKills||0), 2000);
              }
              addEvent({ type:'boss_progress', current:_bpTotM%_bpKtsM, needed:_bpKtsM, mapLevel:_bpLvlM, bossAlive:!!_bpBmgrM?.bossAlive }, _bpLvlM);
            }
            db.save(player).catch(e => console.error('Save error:', e));
            const curMapDef = MAP_DEFS[player.mapLevel || 1] || {};
            sendTo(player.ws, {
              type: 'currency_update', gold: player.gold, dobroes: player.dobroes,
              reward: { type: 'gold', amount: rewards.finalGold },
              npcKills: player.npcKills, mapXp: player.mapXp,
              mapLevel: player.mapLevel || 1, mapXpNeeded: curMapDef.xpToAdvance || 99999,
              mapFragments: player.mapFragments || 0,
            });
          }
        }
      });
      players.forEach(p => {
        if (p.dead || p.id === player.id) return;
        if (Math.hypot(p.x - pos.x, p.z - pos.z) <= radius) {
          p.hp = Math.max(0, p.hp - dmg);
          p.lastCombatTime = Date.now();
          hitsM.push({ id: p.id, hp: p.hp, isNPC: false, dmg });
        }
      });
      return hitsM;
    };

    const relicDmg = Math.round(relicDef.damage * (1 + (player.talentRelicBonus || 0) + (player.skillRelicBonus || 0)));

    // Meteor 1 — show indicator immediately, land after castMs
    addEvent({ type: 'meteor_incoming', x: positions[0].x, z: positions[0].z, radius: baseRadius, castMs }, player.mapLevel);
    setTimeout(() => {
      if (player.dead) return;
      const h1 = applyMeteorHit(positions[0], baseRadius, relicDmg);
      addEvent({ type: 'meteor_strike', x: positions[0].x, z: positions[0].z, radius: baseRadius, hits: h1 }, player.mapLevel);
      const m1NpcHits = h1.filter(h => h.isNPC).length;
      if (m1NpcHits > 0) grantSkillXp(player, 'reliquia', m1NpcHits * 18, wss);

      // Meteor 2
      addEvent({ type: 'meteor_incoming', x: positions[1].x, z: positions[1].z, radius: baseRadius, castMs }, player.mapLevel);
      setTimeout(() => {
        if (player.dead) return;
        const h2 = applyMeteorHit(positions[1], baseRadius, relicDmg);
        addEvent({ type: 'meteor_strike', x: positions[1].x, z: positions[1].z, radius: baseRadius, hits: h2 }, player.mapLevel);
        const m2NpcHits = h2.filter(h => h.isNPC).length;
        if (m2NpcHits > 0) grantSkillXp(player, 'reliquia', m2NpcHits * 18, wss);

        // Meteor 3 — DOUBLE damage and radius
        const bigRadius = baseRadius * 2;
        addEvent({ type: 'meteor_incoming', x: positions[2].x, z: positions[2].z, radius: bigRadius, castMs, isLast: true }, player.mapLevel);
        setTimeout(() => {
          if (player.dead) return;
          const h3 = applyMeteorHit(positions[2], bigRadius, relicDmg * 2);
          addEvent({ type: 'meteor_strike', x: positions[2].x, z: positions[2].z, radius: bigRadius, hits: h3, isLast: true }, player.mapLevel);
          const m3NpcHits = h3.filter(h => h.isNPC).length;
          if (m3NpcHits > 0) grantSkillXp(player, 'reliquia', m3NpcHits * 27, wss);
        }, castMs);
      }, castMs);
    }, castMs);

    effectPayload.targetX    = mtTx;
    effectPayload.targetZ    = mtTz;
    effectPayload.castMs     = castMs;
    effectPayload.positions  = positions;

  } else if (relicDef.effect === 'teleport') {
    // ── Teleporte ─────────────────────────────────────────────────────
    // Teleporta o jogador até a posição do mouse respeitando range máximo
    const maxRange = relicDef.maxRange || 150;

    // Calcula posição alvo (clampada ao range máximo)
    let tpTx = rTx != null ? rTx : player.x;
    let tpTz = rTz != null ? rTz : player.z;
    const tpDx = tpTx - player.x;
    const tpDz = tpTz - player.z;
    const tpDist = Math.hypot(tpDx, tpDz);
    if (tpDist > maxRange) {
      // Clamp to maxRange in the direction of target
      const ratio = maxRange / tpDist;
      tpTx = player.x + tpDx * ratio;
      tpTz = player.z + tpDz * ratio;
    }

    // Clamp to map bounds (using current map's size)
    const mapLvl = player.mapLevel || 1;
    const mapSize = (MAP_DEFS[mapLvl] && MAP_DEFS[mapLvl].size);
    const halfMap = mapSize / 2;
    tpTx = Math.max(-halfMap, Math.min(halfMap, tpTx));
    tpTz = Math.max(-halfMap, Math.min(halfMap, tpTz));

    // Update player position
    player.x = tpTx;
    player.z = tpTz;
    player.lastActionTime = Date.now();

    // Broadcast to all so other clients snap the player to new position
    addEvent({
      type: 'player_teleport',
      id:   player.id,
      x:    tpTx,
      z:    tpTz,
    }, player.mapLevel);

    effectPayload.x = tpTx;
    effectPayload.z = tpTz;

  } else if (relicDef.effect === 'aura') {
    // ── Aura Mortal ───────────────────────────────────────────────────
    // Activa uma aura ao redor do barco que pulsa dano em NPCs próximos
    player.relicAuraExpires     = now2 + (relicDef.duration || 20000);
    player.relicAuraRange       = relicDef.range        || 80;
    player.relicAuraDamage      = relicDef.damage       || 30;
    player.relicAuraTickInterval= relicDef.tickInterval || 1000;
    player.relicAuraLastTick    = now2;   // tick imediato na ativação
    effectPayload.duration      = relicDef.duration;
    effectPayload.range         = relicDef.range;
    effectPayload.damage        = relicDef.damage;
    effectPayload.tickInterval  = relicDef.tickInterval;
    // Broadcast para todos verem a aura no barco desse jogador
    addEvent({
      type:     'aura_start',
      playerId: player.id,
      range:    player.relicAuraRange,
      duration: relicDef.duration,
    }, player.mapLevel);
  }

  // Treino: concede XP de relíquia por usar (sem NPCs para acertar)
  if (player.mapLevel === 5) {
    grantSkillXp(player, 'reliquia', 30, wss);
  }

  sendTo(player.ws, effectPayload);
}

function handleBuyTalent(player, msg) {
  const { talentId } = msg;
  const tDef = TALENT_DEFS[talentId];
  if (!tDef) return;
  if (!player.talents) player.talents = { hp:0, defesa:0, canhoes:0, dano:0, dano_relic:0, riqueza:0, ganancioso:0, mestre:0, slot_reliquia:0, totalSpent:0 };
  const curLevel    = player.talents[talentId] || 0;
  const totalSpent  = player.talents.totalSpent || 0;

  // Nível máximo
  if (curLevel >= tDef.max) {
    sendTo(player.ws, { type: 'error', message: `${tDef.name} já está no nível máximo!` });
    return;
  }

  // Requisito de XP (não gasta XP, apenas verifica o mínimo)
  const xpReq = Math.floor(TALENT_XP_BASE * Math.pow(TALENT_XP_GROWTH, totalSpent));
  if ((player.mapXp || 0) < xpReq) {
    sendTo(player.ws, { type: 'error', message: `XP insuficiente! Necessário: ${xpReq.toLocaleString()} XP de mapa` });
    return;
  }

  // Custo em moeda (talentPoints gratuitos têm prioridade)
  let costTier = TALENT_COST_TIERS[TALENT_COST_TIERS.length - 1];
  for (const tier of TALENT_COST_TIERS) { if (totalSpent < tier.upTo) { costTier = tier; break; } }

  if ((player.talentPoints || 0) > 0) {
    // Usa um ponto gratuito do reset — sem custo de moeda
    player.talentPoints -= 1;
  } else if (costTier.currency === 'gold') {
    if ((player.gold || 0) < costTier.cost) { sendTo(player.ws, { type: 'error', message: `Ouro insuficiente! Necessário: ${costTier.cost}` }); return; }
    player.gold -= costTier.cost;
  } else {
    if ((player.dobroes || 0) < costTier.cost) { sendTo(player.ws, { type: 'error', message: `Dobrões insuficientes! Necessário: ${costTier.cost}` }); return; }
    player.dobroes -= costTier.cost;
  }

  // Aplica o nível
  player.talents[talentId] = curLevel + 1;
  player.talents.totalSpent = totalSpent + 1;
  applyTalentBonuses(player);

  // Efeitos imediatos de certos talentos
  if (tDef.stat === 'hp') {
    recalcMaxHp(player);
    player.hp = Math.min(player.hp, player.maxHp);
  }
  if (tDef.stat === 'cannon_slots') {
    const activeSh = SHIP_DEFS[player.activeShip] || SHIP_DEFS.fragata;
    player.maxCannons = _calcMaxCannons(activeSh, player.talentCannonBonus || 0, MAX_CANNON_SLOTS);
  }

  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(player.ws, {
    type:         'talent_update',
    talents:      player.talents,
    talentPoints: player.talentPoints || 0,
    gold:         player.gold,
    dobroes:      player.dobroes,
    maxHp:        player.maxHp,
    hp:           player.hp,
    maxCannons:   player.maxCannons,
  });
}

function handleResetTalents(player) {
  if (!player?.talents) return;
  const total = player.talents.totalSpent || 0;
  if (total === 0) { sendTo(player.ws, { type: 'error', message: 'Nenhum talento para resetar.' }); return; }
  // Resetar talentos e devolver os pontos gastos como talentPoints
  for (const key of Object.keys(TALENT_DEFS)) player.talents[key] = 0;
  player.talents.totalSpent = 0;
  player.talentPoints = (player.talentPoints || 0) + total;
  applyTalentBonuses(player);
  recalcMaxHp(player);
  player.hp = Math.min(player.hp, player.maxHp);
  const activeSh2 = SHIP_DEFS[player.activeShip] || SHIP_DEFS.fragata;
  player.maxCannons = _calcMaxCannons(activeSh2, player.talentCannonBonus || 0, MAX_CANNON_SLOTS);
  const trimResult2 = _trimCannons(player.cannons, player.maxCannons);
  if (trimResult2.removed > 0) { player.cannons = trimResult2.cannons; recalcCannons(player); }
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(player.ws, {
    type:         'talent_update',
    talents:      player.talents,
    talentPoints: player.talentPoints,
    gold:         player.gold,
    dobroes:      player.dobroes,
    maxHp:        player.maxHp,
    hp:           player.hp,
    maxCannons:   player.maxCannons,
    resetMsg:     `Resetado! +${total} ponto${total !== 1 ? 's' : ''} de talento para usar livremente.`,
  });
}

function handleEquipNavio(player, msg, ws) {
  const { SHIP_DEFS } = require('./constants');
  const ship = SHIP_DEFS[msg.shipId];
  if (!ship) return;
  if (!player.inventory.ships.includes(msg.shipId)) return;
  player.activeShip    = msg.shipId;
  recalcMaxHp(player);
  player.hp            = Math.min(player.hp, player.maxHp);
  player.damageMult    = ship.damageMult ?? 1.0;
  player.dropBonus     = ship.dropBonus || 0;
  player.shipSpeedMult = ship.speedMult || 1.0;
  player.maxCannons    = _calcMaxCannons(ship, player.talentCannonBonus || 0, MAX_CANNON_SLOTS);
  // Trim equipped cannons if over new limit
  const trimResult3 = _trimCannons(player.cannons, player.maxCannons);
  if (trimResult3.removed > 0) { player.cannons = trimResult3.cannons; recalcCannons(player); }
  // Update mana/relic slots for new ship
  const newShipReliqC = SHIP_RELIQC[msg.shipId] || {};
  player.maxMana   = newShipReliqC.maxMana   ?? 8;
  player.maxRelics = newShipReliqC.maxHelic  ?? 4;
  player.mana = Math.min(player.mana, player.maxMana);
  player.relicDeck = (player.relicDeck || []).slice(0, player.maxRelics);
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(ws, {
    type:      'ship_update',
    shipId:    msg.shipId,
    maxHp:     player.maxHp,
    hp:        player.hp,
    maxCannons: player.maxCannons,
    maxMana:   player.maxMana,
    mana:      player.mana,
    relicDeck: player.relicDeck || [],
  });
}

async function shutdown() {
  console.log('💾 Salvando todos os jogadores...');
  
  const savePromises = [];
  players.forEach(player => {
    if (player && player.name) {
      savePromises.push(db.save(player, true).catch(e => 
        console.error(`Erro ao salvar ${player.name}:`, e)
      ));
    }
  });
  await Promise.all(savePromises);
  console.log(`💾 ${savePromises.length} jogadores salvos`);

  console.log('🗑️ Destruindo managers...');
  
  if (projectileManager) projectileManager.destroy();
  if (npcManager) npcManager.destroy();
  if (npcManager2) npcManager2.destroy();
  if (bossManager) bossManager.destroy();
  if (bossManager2) bossManager2.destroy();
  if (worldBossManager) worldBossManager.destroy();
  if (playerManager) playerManager.destroy();
  
  // Destroi managers opcionais se existirem
  if (npcManager3)   npcManager3.destroy();
  if (npcManager4)   npcManager4.destroy();
  if (npcManager6)   npcManager6.destroy();
  if (bossManager3)  bossManager3.destroy();
  if (bossManager6)  bossManager6.destroy();

  console.log('🔌 Fechando WebSocket server...');
  // Termina conexões ativas — wss.close() callback só dispara quando não há clientes
  wss.clients.forEach(ws => ws.terminate());
  wss.close(() => {
    console.log('✅ WebSocket server fechado');

    console.log('🔌 Fechando HTTP server...');
    server.close(() => {
      console.log('✅ HTTP server fechado');
      if (db && db._shutdown) db._shutdown();
      console.log('👋 Servidor encerrado com sucesso');
      process.exit(0);
    });
  });
  
  setTimeout(() => {
    console.error('⚠️ Timeout no shutdown, forçando saída');
    process.exit(1);
  }, 10000);
}

// Registrar handlers de shutdown
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const PORT = process.env.PORT || process.env.VITE_PORT || 3001;
const HOST = process.env.HOST || process.env.VITE_HOST_URL || '0.0.0.0';

// Sobe o servidor imediatamente — /api/constants não precisa de banco
server.listen(PORT, HOST, () => console.log(`\n⚓  Sea of Code on http://${HOST}:${PORT}\n`));

// Conecta ao banco em background (WebSocket/jogo só funcionam depois)
db.init().then(() => {
  console.log('✅ DB pronto — jogo totalmente operacional');
}).catch(err => {
  console.error('❌ Falha ao conectar ao banco:', err.message);
  process.exit(1);
});