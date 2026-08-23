// server.js
require('dotenv').config();
const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');

// Debug flag for server logs (set DEBUG=1 to enable)
const DEBUG = !!process.env.DEBUG;
function debugServer(...args) { if (DEBUG) console.log(...args); }

// Cheat/debug game commands (spawn pet, give food, level pet) — OFF by default.
// Enable only in dev with ALLOW_DEBUG_CMDS=1; never in production.
const ALLOW_DEBUG_CMDS = process.env.ALLOW_DEBUG_CMDS === '1';

// WebSocket anti-flood (token bucket por conexão). Cliente legítimo manda ~10-20
// msg/s (input a 10 Hz + ações esporádicas); estes limites são bem folgados e só
// atingem floods reais. Ajustável por env.
const WS_MSG_BUCKET_CAP    = parseInt(process.env.WS_MSG_BUCKET_CAP)   || 120; // rajada máxima
const WS_MSG_REFILL_RATE   = parseInt(process.env.WS_MSG_REFILL_RATE)  || 60;  // msgs/s sustentado
const WS_MSG_MAX_VIOLATIONS = parseInt(process.env.WS_MSG_MAX_VIOLATIONS) || 300; // descartes seguidos antes de derrubar
const WS_MAX_PAYLOAD       = parseInt(process.env.WS_MAX_PAYLOAD)      || 32 * 1024; // 32 KB — msgs legítimas têm < 2 KB

// Server-side secret for hashing device tokens (defense in depth). Optional.
const crypto = require('crypto');
const AUTH_PEPPER = process.env.AUTH_PEPPER || '';
function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret) + AUTH_PEPPER).digest('hex');
}

// ── Contas: senha (scrypt) + recuperação por e-mail ──────────────────────────
const { hashPassword, verifyPassword } = require('./utils/password');
const { sendRecoveryCode } = require('./utils/mailer');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RESET_CODE_TTL_MS   = 15 * 60_000; // validade do código de recuperação
const RESET_MAX_ATTEMPTS  = 5;           // tentativas de código antes de invalidar
const _recoveryCooldown = new Map();     // email → epoch ms do último envio
const _resetAttempts    = new Map();     // email → tentativas erradas de código

// ─── Map Definitions ─────────────────────────────────────────────────────────
// Each map defines NPC base stats, XP requirements, and visual hints for the client

const { sendTo, sendRaw } = require('./utils/helpers');
const stateBuilder = require('./utils/state-builder');
const { isInvincible } = require('./utils/invincibility');
const { applyAuraBurn } = require('./utils/aura-burn');
// Tradução dos 120 talentos em multiplicadores — ver utils/talent-effects.js.
const fx = require('./utils/talent-effects');

// Interest management do broadcast de estado. Ligado por padrão; AOI_ENABLED=0
// volta para o broadcast completo (rota de fuga se algo aparecer em produção).
// Requer cliente >= v0.1.19, que entende o formato f/s/r do `state`.
const AOI_ENABLED = process.env.AOI_ENABLED !== '0';
const db = require('./managers/db-manager');
const PlayerManager     = require('./managers/player-manager');
const NPCManager        = require('./managers/npc-manager');
const BossManager       = require('./managers/boss-manager');
const WorldBossManager  = require('./managers/world-boss-manager');
const ProjectileManager = require('./managers/projectile-manager');
const AttackManager     = require('./managers/attack-manager');
const PartyManager      = require('./managers/party-manager');
const { partyRewardMult } = require('./managers/party-manager');
const PetManager        = require('./managers/pet-manager');
const WallManager       = require('./managers/wall-manager');
const MonsterSkillManager = require('./managers/monster-skill-manager');
const MissionBoatManager = require('./managers/mission-boat-manager');
const FleetEventManager  = require('./managers/fleet-event-manager');
const WeatherManager     = require('./managers/weather-manager');
const { pushOutOfIslands, pushOutOfWalls } = require('./utils/collision');
// Deck de relíquia é POSICIONAL (índice = tecla, null = vazia) — ver o arquivo.
const { normalizeDeck: _normalizeDeck, firstFreeSlot: _firstFreeSlot,
        equipAt, unequipAt } = require('./utils/relic-deck');


const compression = require('compression');
const app    = express();

app.use(compression());
const server = http.createServer(app);
// ── Compressão do WebSocket ──────────────────────────────────────────────────
// DESLIGADA por padrão. Antes daqui o `state` tinha ~69 KB com 200 jogadores e
// era deflatado UMA VEZ POR CLIENTE: medido, o nível 6 custava ~186% de um core
// a 10 Hz — e o deflate do `ws` roda na threadpool do libuv (4 threads), então
// isso virava fila de latência, não só CPU.
//
// Com AOI + slim (utils/state-builder.js) o `state` caiu para ~1 KB, que é o
// próprio `threshold` do ws: não haveria o que comprimir de qualquer forma.
//
// Se precisar religar (WS_COMPRESS=1), agora as opções estão no lugar certo:
// `clientNoContextTakeover`/`serverNoContextTakeover`/`threshold` moravam FORA
// do objeto `perMessageDeflate` e eram silenciosamente ignoradas pelo ws — cada
// conexão mantinha um contexto zlib próprio (~300 KB pelos docs do ws, ~60 MB
// com 200 jogadores) sem nenhum dos limites que o código pedia.
const WS_COMPRESS = process.env.WS_COMPRESS === '1';

const wss    = new WebSocket.Server({
  server,
  maxPayload: WS_MAX_PAYLOAD, // rejeita frames gigantes (anti-DoS de memória)
  perMessageDeflate: WS_COMPRESS ? {
    zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 1 },
    clientNoContextTakeover: true,  // economiza memória por conexão
    serverNoContextTakeover: true,
    threshold: 1024,                // só comprime mensagens > 1 KB
  } : false,
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
  getPvpZone,
  SHIP_DEFS,
  maxHealersFor,
  PIRATE_DEFS,
  SHOP,
  FRAGMENT_EXPLORE_COST,
  FRAGMENT_EXPLORE_FALLBACK_COST,
  EXPLORATION_REWARDS,
  FRAGMENT_DROP_NPC,
  BONUS_MAPS,
  BONUS_MAP_LEVELS,
  ARCH_PORTALS,
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
  TALENT_XP_CAP,
  RING_GATE,
  LEGACY_TALENT_MAP,
  DIFFICULTIES,
  difficultyDef,
  difficultyRewardMult,
  isDifficultyUnlocked,
  DAILY_MISSIONS,
  DAILY_MISSION_COUNT,
} = require('./constants');
const {
  calcXpRequired:       _calcXpRequired,
  applyTalentBonuses:   _applyTalentBonuses,
  recalcMaxHp:          _recalcMaxHp,
  countTreeSpent:       _countTreeSpent,
  migrateLegacyTalents: _migrateLegacyTalents,
  refundRemovedTalents: _refundRemovedTalents,
  validateRefundTalent: _validateRefundTalent,
  validateBuild:        _validateBuild,
  applyBuild:           _applyBuild,
  snapshotBuild:        _snapshotBuild,
} = require('./utils/talent-logic');
const fxTal = require('./utils/talent-effects');
const { calcMaxCannons: _calcMaxCannons, trimCannons: _trimCannons } = require('./utils/combat-calc');
const worldState = require('./utils/world-state');
const { BONUS_DUNGEON_DEFS, BONUS_NPC_DEFS, rollBonusShip } = require('./constants/bonus_dungeons');

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
  maxTickMs: 0,
  tickMsSum: 0,         // p/ média — tick isolado é ruidoso demais p/ decidir
  stateBytesSent: 0,
};
global._serverMetrics = _serverMetrics;

// Atraso do event loop: o melhor sinal único de "o servidor está dando conta".
// O tick é agendado a cada 16 ms; se o loop atrasa mais que isso, a simulação
// já está andando devagar e TODO mundo sente, mesmo com a rede sobrando.
// O histograma do perf_hooks é amostrado pelo runtime e custa ~nada.
const { monitorEventLoopDelay } = require('perf_hooks');
const _loopLag = monitorEventLoopDelay({ resolution: 10 });
_loopLag.enable();

app.get('/api/metrics', (req, res) => {
  const token = process.env.METRICS_TOKEN;
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const mem  = process.memoryUsage();
  const upS  = Math.max(1, (Date.now() - _serverMetrics.startTime) / 1000);
  const ms   = ns => Math.round(ns / 1e5) / 10; // ns → ms com 1 casa
  res.json({
    uptime:            Math.floor(upS),
    players:           players ? players.size : 0,

    // ── Tick (alvo: TICK_RATE = 16 ms) ────────────────────────────────────
    tickCount:         _serverMetrics.tickCount,
    slowTicks:         _serverMetrics.slowTicks,     // > 20 ms
    slowTickPct:       _serverMetrics.tickCount
      ? +(100 * _serverMetrics.slowTicks / _serverMetrics.tickCount).toFixed(2) : 0,
    lastTickMs:        +_serverMetrics.lastTickMs.toFixed(2),
    avgTickMs:         _serverMetrics.tickCount
      ? +(_serverMetrics.tickMsSum / _serverMetrics.tickCount).toFixed(2) : 0,
    maxTickMs:         +_serverMetrics.maxTickMs.toFixed(2),
    // Fração do tempo real gasta simulando. Acima de ~70% não há folga para
    // picos (boss, frota, muita gente entrando junto).
    tickLoadPct:       +(100 * _serverMetrics.tickMsSum / (upS * 1000)).toFixed(1),

    // ── Event loop ────────────────────────────────────────────────────────
    loopLagMeanMs:     ms(_loopLag.mean),
    loopLagP99Ms:      ms(_loopLag.percentile(99)),
    loopLagMaxMs:      ms(_loopLag.max),

    // ── Rede ──────────────────────────────────────────────────────────────
    messagesReceived:  _serverMetrics.messagesReceived,
    broadcastsSent:    _serverMetrics.broadcastsSent,
    stateKBsOut:       +(_serverMetrics.stateBytesSent / 1024 / upS).toFixed(1),

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

// ── Launcher manifest ─────────────────────────────────────────────────────────
// GET /launcher/manifest — retorna versão atual + lista de arquivos para download.
// Edite launcher-manifest.json (ou rode scripts/publish.js) para atualizar.
app.get('/launcher/manifest', (req, res) => {
  try {
    // re-require para capturar edições sem reiniciar o servidor
    delete require.cache[require.resolve('./launcher-manifest.json')];
    const manifest = require('./launcher-manifest.json');
    res.json(manifest);
  } catch (e) {
    res.status(404).json({ error: 'launcher-manifest.json não encontrado', detail: e.message });
  }
});

// Shared state maps passed by reference to all managers
const players = new Map();
const npcs    = new Map();

// Managers
const playerManager     = new PlayerManager();
const partyManager      = new PartyManager();
const petManager        = new PetManager(wss, players, db);
// Barco de Missões — NPC não-combatente que navega entre os mapas 1–4
const missionBoatManager = new MissionBoatManager(players, MAP_DEFS);
// Clima dinâmico sincronizado por mapa — o servidor cicla e envia no `state`
const weatherManager     = new WeatherManager(MAP_DEFS);
// Obstáculos temporários (ex.: Muro de Pedra) — único registro pra TODOS os
// mapas, injetado em playerManager e em cada NPCManager (mesmo padrão do
// partyManager); ver managers/wall-manager.js e utils/collision.js.
const wallManager        = new WallManager();
playerManager.wallManager = wallManager;
// Vento de Esquadra (res_esquadra) precisa saber quem está no grupo de quem.
playerManager.partyManager = partyManager;

// Motor das 34 relíquias do bestiário (r14..r47) — forma/ritmo/CC vêm dos dados
// em constants/monster_skills.js, então é UM branch em handleUseRelic() para as
// 34. O ctx é montado depois (logo abaixo da criação dos managers), porque o
// motor precisa do projectileManager e dos NPC managers por mapa.
const monsterSkillManager = new MonsterSkillManager({});

// 1. ProjectileManager first (no npcs yet — injected after)
const projectileManager = new ProjectileManager(wss, players, null, null, null, MAP_DEFS);
projectileManager.partyManager = partyManager;
// Livro-caixa: o abate de NPC é a maior fonte de ouro e XP do jogo, e entra no
// Diário AGREGADO (ver accrue no journal-manager) — uma linha por minuto, não
// uma por abate. A injeção acontece mais abaixo, junto do journalManager.

// 2. AttackManager — gerencia ataques especiais de NPC (telegraph + AoE)
const attackManager = new AttackManager(addEvent, projectileManager);
// Barragem Rolante do BICHO ergue pedra de verdade a cada passo (wallPerStep) —
// mesmo registro que a versão de relíquia usa. Sem esta injeção o bloqueio
// simplesmente não acontece no cast de bicho, silenciosamente.
attackManager.wallManager = wallManager;

// 2b. WreckManager — ruínas saqueáveis da Zona Vermelha (mapa 11).
// Não é mais injetado nos managers: quem chama o onPlayerDeath dele agora é o
// resolvePlayerDeath, por onde passa TODA morte de jogador.
const { WreckManager } = require('./managers/wreck-manager');
const wreckManager = new WreckManager(sendTo, addEvent);

// 2b-bis. Piratas, Diário e Espólio.
//
// A ordem importa: o SpoilManager depende dos outros dois — ele enterra piratas
// pelo PirateManager e escreve no Diário pelo JournalManager.
const JournalManager = require('./managers/journal-manager');
const PirateManager  = require('./managers/pirate-manager');
const SpoilManager   = require('./managers/spoil-manager');
const AuctionManager = require('./managers/auction-manager');
const JOURNAL_KINDS  = JournalManager.KINDS;
const JOURNAL_SRC    = JournalManager.SRC;
const journalManager = new JournalManager(db);
const pirateManager  = new PirateManager(players, db);
const spoilManager   = new SpoilManager(sendTo, addEvent, players, db, journalManager, pirateManager);
// A casa de leilões só fica utilizável depois do `init()` lá embaixo, que
// depende do banco — até lá a vitrine responde vazia, e é por isso que ele é
// aguardado antes do log de "DB pronto".
const auctionManager = new AuctionManager(sendTo, players, db, journalManager, JOURNAL_SRC);
projectileManager.journal = journalManager;
attackManager.journal     = journalManager;
wreckManager.journal      = journalManager;

// 2c. Morte de jogador — um caminho só (ver resolvePlayerDeath). Quem causa o
// dano não precisa saber o que uma morte desencadeia, só avisar que aconteceu.
projectileManager.onPlayerKilled = resolvePlayerDeath;
attackManager.onPlayerKilled     = resolvePlayerDeath;

// 3. NPC managers (need projectileManager + attackManager for broadcasting)
let   npcManager  = new NPCManager(projectileManager, MAP_DEFS, 1, attackManager); // map 1 NPCs (let — pode ser recriado)
let   npcManager2 = new NPCManager(projectileManager, MAP_DEFS, 2, attackManager); // map 2 NPCs (let — pode ser recriado)
npcManager.wallManager  = wallManager;
npcManager2.wallManager = wallManager;
// ── ctx do motor de skills do bestiário ──────────────────────────────────────
// Montado aqui (e não na construção) porque depende do projectileManager. As
// funções referenciadas são `function` declarations — hoisted, então podem
// morar mais abaixo no arquivo.
monsterSkillManager.ctx = {
  projectileManager,
  players,
  wallManager,
  addEvent,
  sendTo,
  relicDamageFor:   (p, d) => relicDamageFor(p, d),
  relicCanHitPlayer: (c, t) => relicCanHitPlayer(c, t),
  grantSkillXp:     (p, skill, amt) => grantSkillXp(p, skill, amt, wss),
  getMapManagerFor: (lvl) => (lvl === 1 ? npcManager : lvl === 2 ? npcManager2 : getMapManager(lvl)),
  onNpcDamaged:     (killer, npc) => _monsterSkillNpcKill(killer, npc),
  onPlayerKilled:   (victim, killerId) => resolvePlayerDeath(victim, killerId),
  clampToMap:       (ent) => {
    // Mesma proteção do arrasto do Arpão: nunca empurrar/puxar pra fora do
    // mapa nem pra dentro de ilha/muro.
    const lvl = ent.mapLevel || 1;
    const size = (MAP_DEFS[lvl] && MAP_DEFS[lvl].size) || 2000;
    ent.x = Math.max(-size / 2, Math.min(size / 2, ent.x));
    ent.z = Math.max(-size / 2, Math.min(size / 2, ent.z));
    pushOutOfIslands(ent, MAP_DEFS[lvl], 8);
    pushOutOfWalls(ent, wallManager.getActive(lvl), 8);
  },
};

/**
 * Morte de NPC causada por uma relíquia do bestiário. Mesma contabilidade dos
 * branches de raio/foguete/meteoro (boss vs comum, recompensa, respawn, save),
 * num lugar só — as 34 skills compartilham esta função em vez de cada uma
 * carregar a própria cópia do bloco.
 */
function _monsterSkillNpcKill(killer, npc) {
  npc.dead = true;
  if (npc.isBoss) {
    addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, isBoss: true, killerId: killer.id }, npc.mapLevel);
    if (npc.isWorldBoss) {
      worldBossManager.onWorldBossDead(npc, killer.id);
    } else {
      const lvl = npc.mapLevel || 1;
      const mgr = projectileManager.bossManagers.get(lvl) || (lvl === 2 ? bossManager2 : bossManager);
      mgr && mgr.onBossDead(npc, killer.id);
      worldBossManager.onZoneBossDead(npc, killer.id);
    }
    projectileManager.npcs.delete(npc.id);
    return;
  }
  const rewards = projectileManager.grantNpcKillRewards(killer, npc);
  addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, killerId: killer.id, goldDrop: rewards.goldDrop }, npc.mapLevel);
  const lvl = npc.mapLevel || 1;
  const mgr = lvl === 1 ? npcManager : lvl === 2 ? npcManager2 : getMapManager(lvl);
  mgr && mgr.respawnScaled(npc.id, killer.npcKills || 0, lvl);
  _npcKillBossAccounting(lvl, killer.npcKills || 0);
  db.save(killer).catch(e => console.error('Save error:', e));
  const mapDef = MAP_DEFS[killer.mapLevel || 1] || {};
  sendTo(killer.ws, {
    type: 'currency_update', gold: killer.gold, dobroes: killer.dobroes,
    reward: { type: 'gold', amount: rewards.finalGold },
    npcKills: killer.npcKills, mapXp: killer.mapXp,
    mapLevel: killer.mapLevel || 1, mapXpNeeded: mapDef.xpToAdvance || 99999,
    mapFragments: killer.mapFragments || 0,
  });
}

/**
 * Morte de um JOGADOR — venha o golpe de onde vier (projétil, aura, DoT,
 * relíquia de área, skill do bestiário). Contraparte de `_monsterSkillNpcKill`,
 * que já fazia o mesmo pelo lado do NPC.
 *
 * Antes só o caminho do PROJÉTIL resolvia a morte por completo. Os outros ou
 * faziam metade (aura/DoT: ruína + tela de morte, sem crédito de PvP nenhum) ou
 * não faziam nada (raio, foguete, meteoro, arpão, skills do bestiário: o alvo
 * ficava com 0 de vida e continuava navegando). Consequência prática: matar o
 * alvo do contrato de Procurado com relíquia não pagava a recompensa, não
 * limpava o `wantedTarget` — e o limite diário já tinha sido gasto.
 *
 * Idempotente: só o primeiro golpe a zerar o HP resolve a morte. O marcador é o
 * `_deathResolved`, e NÃO o `dead` — o caminho do projétil marca `dead` já no
 * `hit()`, para os outros projéteis do mesmo tiro pularem o alvo, e só resolve a
 * morte no fim do tick (`_flushHitBatch`).
 *
 * @param {object} victim    jogador que levou o golpe (só age se hp <= 0)
 * @param {number|string|null} killerId  autor do golpe — id de jogador OU de NPC
 *                                       (uid() é um contador só, não colide)
 * @returns {boolean} true se foi esta chamada que matou
 */
function resolvePlayerDeath(victim, killerId = null) {
  if (!victim || victim.isNPC) return false;
  if (victim.hp > 0 || victim._deathResolved) return false;
  victim._deathResolved = true;
  victim.dead        = true;
  victim.isPeaceful  = false;   // sai do modo pesca ao morrer

  // Zona vermelha: perde 10% do ouro no local. Em zona de espólio esse ouro vai
  // para o destroço de 1h (que exige vencer uma abordagem para saquear); nas
  // demais, para a ruína de 10s de sempre. A porcentagem é a mesma nos dois —
  // quem a calcula continua sendo o wreck-manager.
  wreckManager.onPlayerDeath(victim, (v, loss) => spoilManager.onPlayerDeath(v, loss));
  // Tela de morte. urgent=true porque esperar o flush do buffer (~48 ms) para
  // avisar quem acabou de afundar é exatamente o tipo de atraso que o jogador lê
  // como travamento.
  addEvent({
    type: 'entity_dead', id: victim.id, name: victim.name, isNPC: false,
    killerId: killerId === null || killerId === undefined ? undefined : killerId,
  }, victim.mapLevel || 1, true);

  // Morte por NPC/ambiente não credita nada
  const killer = (killerId === null || killerId === undefined) ? null : players.get(killerId);
  if (!killer || killer.id === victim.id) return true;
  _creditPvpKill(killer, victim);
  return true;
}

/** Tudo que um abate de JOGADOR rende a quem matou. Só chamado por resolvePlayerDeath. */
function _creditPvpKill(killer, victim) {
  killer.pvpKills = (killer.pvpKills || 0) + 1;

  // ── Espólio: 5% do XP e das kills da vítima mudam de dono ──────────────────
  const xpTransfer    = Math.floor((victim.mapXp    || 0) * 0.05);
  const killsTransfer = Math.floor((victim.npcKills || 0) * 0.05);
  if (xpTransfer > 0) {
    killer.mapXp = (killer.mapXp || 0) + xpTransfer;
    victim.mapXp = Math.max(0, (victim.mapXp || 0) - xpTransfer);
    // Os dois lados do mesmo XP: quem ganhou e quem perdeu veem a linha.
    journalManager.ledger(killer, JOURNAL_SRC.PVP_KILL,  { xp:  xpTransfer }, { target: victim.name });
    journalManager.ledger(victim, JOURNAL_SRC.PVP_DEATH, { xp: -xpTransfer }, { target: killer.name });
  }
  if (killsTransfer > 0) {
    killer.npcKills = (killer.npcKills || 0) + killsTransfer;
    victim.npcKills = Math.max(0, (victim.npcKills || 0) - killsTransfer);
    // O Tier anda junto com os abates — inclusive os que mudam de dono aqui.
    journalManager.checkTier(killer);
    journalManager.checkTier(victim);
  }

  // ── Contrato de Procurado ─────────────────────────────────────────────────
  // Antes do currency_update lá embaixo: assim o saldo que vai para o cliente já
  // inclui o prêmio, em vez de mandar o valor de antes e corrigir depois.
  if (killer.wantedTarget && killer.wantedTarget.targetId === victim.id) {
    const wReward = killer.wantedTarget;
    killer.gold    = (killer.gold    || 0) + wReward.rewardGold;
    killer.dobroes = (killer.dobroes || 0) + wReward.rewardDobrao;
    killer.wantedTarget = null;
    sendTo(killer.ws, {
      type:         'wanted_killed',
      killedName:   wReward.targetName,
      rewardGold:   wReward.rewardGold,
      rewardDobrao: wReward.rewardDobrao,
      gold:         killer.gold,
      dobroes:      killer.dobroes,
    });
    journalManager.ledger(killer, JOURNAL_SRC.WANTED, {
      gold:    wReward.rewardGold,
      dobroes: wReward.rewardDobrao,
    }, { target: wReward.targetName });
    journalManager.log(killer, JOURNAL_KINDS.REWARD, {
      source:  'procurado',
      gold:    wReward.rewardGold,
      dobroes: wReward.rewardDobrao,
      target:  wReward.targetName,
    });
  }

  // ── Missões diárias ───────────────────────────────────────────────────────
  progressDailyMission(killer, 'pvpKills',  1);
  progressDailyMission(killer, 'shipsSunk', 1);
  if (SHIP_DEFS[victim.activeShip]?.isElite) {
    progressDailyMission(killer, 'eliteKills', 1);
  }

  // ── Carteira dos dois lados (a vítima também perdeu ouro para a ruína) ─────
  const killerMapDef = MAP_DEFS[killer.mapLevel || 1] || {};
  sendTo(killer.ws, {
    type:         'currency_update',
    gold:         killer.gold,
    dobroes:      killer.dobroes,
    npcKills:     killer.npcKills,
    pvpKills:     killer.pvpKills,
    mapXp:        killer.mapXp,
    mapLevel:     killer.mapLevel || 1,
    mapXpNeeded:  killerMapDef.xpToAdvance || 99999,
    mapFragments: killer.mapFragments || 0,
    reward: { type: 'pvp_loot', xp: xpTransfer, kills: killsTransfer },
  });
  const victimMapDef = MAP_DEFS[victim.mapLevel || 1] || {};
  sendTo(victim.ws, {
    type:         'currency_update',
    gold:         victim.gold,
    dobroes:      victim.dobroes,
    npcKills:     victim.npcKills,
    mapXp:        victim.mapXp,
    mapLevel:     victim.mapLevel || 1,
    mapXpNeeded:  victimMapDef.xpToAdvance || 99999,
    mapFragments: victim.mapFragments || 0,
  });
  db.save(killer).catch(e => console.error('Save error:', e));
  db.save(victim).catch(e => console.error('Save error:', e));
}

// Maps 3+ são criados sob demanda via regularManagers (elimina npcManager3/4/6 hardcoded)
const regularManagers = new Map(); // mapLevel (3-6) → { npc: NPCManager, boss: BossManager|null }
// Mapas bônus (7+) — mesma lógica, managers separados para dungeon complete detection
const bonusNpcManagers = new Map(); // mapLevel → NPCManager

// Event buffer dinâmico — chave = mapLevel (int) ou 0 = global
const eventBuffer = new Map();
eventBuffer.set(0, []); // global

let lastBroadcastFlush = Date.now();
const BROADCAST_INTERVAL = parseInt(process.env.BROADCAST_INTERVAL || process.env.VITE_BROADCAST_INTERVAL) || 48;

function addEvent(event, mapLevel = null, urgent = false) {
  if (urgent) {
    players.forEach(player => {
      if (mapLevel === null || (player.mapLevel || 1) === mapLevel) {
        sendTo(player.ws, { type: 'events', events: [event] });
      }
    });
    return;
  }
  const key = (mapLevel === null || mapLevel === undefined) ? 0 : mapLevel;
  if (!eventBuffer.has(key)) eventBuffer.set(key, []);
  eventBuffer.get(key).push(event);
}

function flushEvents() {
  const now = Date.now();
  const MAX_BUFFER_SIZE = 50;
  if (now - lastBroadcastFlush < BROADCAST_INTERVAL) {
    let anyLarge = false;
    eventBuffer.forEach(buf => { if (buf.length >= MAX_BUFFER_SIZE) anyLarge = true; });
    if (!anyLarge) return;
  }
  lastBroadcastFlush = now;

  const globalEvents = eventBuffer.get(0) || [];
  players.forEach(player => {
    const lvl = player.mapLevel || 1;
    const events = [...globalEvents, ...(eventBuffer.get(lvl) || [])];
    if (events.length > 0) sendTo(player.ws, { type: 'events', events });
  });

  // Limpa todos os buffers
  eventBuffer.forEach((_, k) => eventBuffer.set(k, []));
}

// 3. Proxy dinâmico — agrega todos os managers (regular + bônus)
// Map extra para NPCs dinâmicos (wild pets, etc.) — suporta set/delete diretamente
const extraNpcs = new Map();

const allNpcs = new Proxy({}, {
  get(_, prop) {
    if (prop === 'get') return id => {
      const extra = extraNpcs.get(id); if (extra) return extra;
      let r = npcManager.npcs.get(id) || npcManager2.npcs.get(id);
      if (r) return r;
      for (const { npc } of regularManagers.values()) { const n = npc?.npcs.get(id); if (n) return n; }
      for (const m of bonusNpcManagers.values())      { const n = m.npcs.get(id); if (n) return n; }
    };
    if (prop === 'set')    return (id, npc) => extraNpcs.set(id, npc);
    if (prop === 'has') return id => {
      if (extraNpcs.has(id)) return true;
      if (npcManager.npcs.has(id) || npcManager2.npcs.has(id)) return true;
      for (const { npc } of regularManagers.values()) { if (npc?.npcs.has(id)) return true; }
      for (const m of bonusNpcManagers.values())      { if (m.npcs.has(id)) return true; }
      return false;
    };
    if (prop === 'values') return () => {
      const arr = [...extraNpcs.values(), ...npcManager.npcs.values(), ...npcManager2.npcs.values()];
      for (const { npc } of regularManagers.values()) { if (npc && !npc.destroyed) arr.push(...npc.npcs.values()); }
      for (const m of bonusNpcManagers.values())      { if (!m.destroyed) arr.push(...m.npcs.values()); }
      return arr[Symbol.iterator]();
    };
    if (prop === 'forEach') return cb => {
      extraNpcs.forEach(cb);
      npcManager.npcs.forEach(cb); npcManager2.npcs.forEach(cb);
      for (const { npc } of regularManagers.values()) { if (npc && !npc.destroyed) npc.npcs.forEach(cb); }
      for (const m of bonusNpcManagers.values())      { if (!m.destroyed) m.npcs.forEach(cb); }
    };
    if (prop === 'delete') return id => {
      if (extraNpcs.delete(id)) return true;
      if (npcManager.npcs.delete(id) || npcManager2.npcs.delete(id)) return true;
      for (const { npc } of regularManagers.values()) { if (npc?.npcs.delete(id)) return true; }
      for (const m of bonusNpcManagers.values())      { if (m.npcs.delete(id)) return true; }
      return false;
    };
    return undefined;
  }
});

// 4. Boss managers (one per map zone)
//
// ── Por que existe um wireBossManager ────────────────────────────────────────
// Um BossManager não nasce só aqui: os mapas 3+ criam o deles em
// ensureRegularManager, e os mapas 1 e 2 são DESTRUÍDOS depois de 5 min vazios
// (ver "Limpeza de mapas vazios") e recriados quando alguém volta. Cada um
// desses lugares plugava as dependências na mão, e nenhum lembrava do
// `journal` — como o boss-manager chama `this.journal?.ledger(...)`, o chefe
// morria em silêncio e a aba Diário nunca via a linha. Mesma história com
// `_onBossKill`, que é quem conta a missão diária de chefes.
//
// Agora existe UM lugar que sabe do que um BossManager precisa, e todo ponto
// de criação passa por ele.
let   bossManager  = new BossManager(wss, players, npcs, 1); // let — pode ser recriado
let   bossManager2 = new BossManager(wss, players, null, 2); // let — pode ser recriado
// bossManager3 alias mantido para compatibilidade com código legado (usado via projectileManager.bossManagers)
let   bossManager3 = null;

/**
 * Liga um BossManager recém-criado a tudo que ele precisa para pagar o chefe
 * por completo: grupo, extrato do Diário e as missões diárias de chefe.
 * Chamar em TODO ponto que faz `new BossManager(...)`.
 * @param {object} boss BossManager recém-criado
 * @returns {object} o mesmo manager, para encadear na criação
 */
function wireBossManager(boss) {
  if (!boss) return boss;
  boss.partyManager  = partyManager;
  boss.journal       = journalManager;
  boss._onBossKill   = (killer)      => progressDailyMission(killer,      'bossKills',   1);
  boss._onBossAssist = (participant) => progressDailyMission(participant, 'bossAssists', 1);
  return boss;
}

wireBossManager(bossManager);
wireBossManager(bossManager2);

// 5. Wire everything into projectileManager
projectileManager.npcs          = allNpcs;
// Wire petManager: lookup de NPCs (validação de alvo), broadcast em lote e
// intercept defensivo (relíquia do pet dispara ANTES do dano chegar no dono)
petManager.projectileManager    = projectileManager;
petManager.addEvent             = addEvent;
projectileManager.petManager    = petManager;
attackManager.petManager        = petManager;
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
worldBossManager.journal           = journalManager;

// 6b. Frota de Caçadores — evento periódico: 1–3 navios colossais caçam os
// jogadores de um mapa (managers/fleet-event-manager.js). getMapManager e
// addEvent são declarações hoisted — a referência aqui é válida.
const fleetEventManager = new FleetEventManager(wss, players, MAP_DEFS, getMapManager, addEvent);
// Diário: o bounty da frota vira uma linha no histórico do caçador.
fleetEventManager.journal = journalManager;

// ── Callbacks de Missões Diárias ─────────────────────────────────────────────
// Nomes dos monstros do recife (um por mapa 1-3)
const _REEF_NPC_NAMES = ['Abyssal Stalker', 'Dreadfin Leviathan', 'Gilded Reef Manta'];

// ── Tutorial: o primeiro abate de NPC concede a Pinça Esmagadora (r14) ───────
// É a skill do próprio carangueijo, o bicho que o jogador acabou de matar: o
// primeiro poder vem de quem morreu, que é a promessa do bestiário inteiro.
// Estado 0→1 aqui; 1→2 só via mensagem tutorial_complete do cliente. A concessão
// é server-side (e não a pedido do cliente) para não ser forjável.
function maybeGrantTutorialRelic(killer) {
  if (!killer || (killer.tutorialState || 0) !== 0) return;
  killer.tutorialState = 1;
  // +1500 de ouro de bônus — cobre o canhão c4 (1000) + Curandeiro (100) que os
  // passos seguintes do tutorial mandam comprar, com folga para munição.
  killer.gold = (killer.gold || 0) + 1500;
  journalManager.ledger(killer, JOURNAL_SRC.TUTORIAL, { gold: 1500 });
  const instanceId = `rl_tut_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
  if (!killer.inventory.relics) killer.inventory.relics = [];
  killer.inventory.relics.push({ instanceId, relicId: 'r14' });
  // Auto-equipa na primeira tecla livre — o passo seguinte do tutorial pede para
  // usar a pinça sem passar pelo painel de relíquias. Com o deck posicional,
  // "vazio" é ter só nulls; testar `length === 0` deixava de auto-equipar
  // qualquer jogador que já tivesse um deck de 4 buracos.
  const maxRelT = killer.maxRelics || 4;
  const livre = _firstFreeSlot(killer.relicDeck, maxRelT);
  if (livre !== -1) {
    killer.relicDeck = _normalizeDeck(killer.relicDeck, maxRelT);
    killer.relicDeck[livre] = instanceId;
  }
  db.save(killer, true).catch(e => console.error('Save error:', e));
  sendTo(killer.ws, {
    type:           'relic_state',
    relicDeck:      killer.relicDeck,
    relicInventory: killer.inventory.relics,
    mana:           killer.mana,
    maxMana:        killer.maxMana,
  });
  sendTo(killer.ws, { type: 'currency_update', gold: killer.gold, dobroes: killer.dobroes || 0 });
}

function _setupMissionCallbacks(pmgr) {
  // Centro e raio de detecção da ilha mercado (mapa 3) para missão marketDefense
  const _marketCenter = MAP_DEFS[3]?.market?.center || { x: 0, z: 0 };
  const _marketRadius = (MAP_DEFS[3]?.market?.securyRadius || 300) * 2;

  // ── NPC morto pelo jogador ─────────────────────────────────────────────────
  pmgr._onNpcKill = (killer, gold, npc) => {
    maybeGrantTutorialRelic(killer);
    // Frota de Caçadores: bounty + progresso do evento (qualquer caminho de dano)
    if (npc && npc.isFleetShip) fleetEventManager.onFleetShipKilled(killer, npc);
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

  // Abate de jogador (missões pvpKills/shipsSunk/eliteKills, espólio de 5% e
  // contrato de Procurado) mora em `_creditPvpKill`, chamado por
  // `resolvePlayerDeath` — o único lugar onde um jogador morre.

  // ── Jogador recebe dano ────────────────────────────────────────────────────
  pmgr._onPlayerDamaged = (player, dmg) => {
    player._lastDamageTakenAt = Date.now(); // reseta contador do perfectKills
    progressDailyMission(player, 'damageBlocked', dmg);
  };

  // ── Dano causado no boss mundial ───────────────────────────────────────────
  pmgr._onWorldBossDamage = (shooter, dmg) => {
    progressDailyMission(shooter, 'worldBossDamage', dmg);
  };

  // ── Boss regular morto ────────────────────────────────────────────────────
  // Mora em `wireBossManager`, junto do `journal` e do `partyManager`: um
  // BossManager recriado precisa dos três e antes só recebia um.
}
_setupMissionCallbacks(projectileManager);

// Registra bossManagers iniciais no projectileManager dinâmico
projectileManager.bossManagers.set(1, bossManager);
projectileManager.bossManagers.set(2, bossManager2);

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
//
// Sem multiplicador de alcance por talento: o nó que fazia isso (atk_miralonga)
// virou o Rasga-Velame, que aplica lentidão no acerto. Alcance é o eixo que
// este jogo não quer esticar — mais alcance só afasta os dois barcos.
function recalcCannons(player) {
  if (!player.cannons.length) {
    player.cannonRange       = 80;
    player.cannonCooldownMax = 5000;
    player.cannonLifesteal   = 0;
    player.cannonDamage      = 0;
    player.cannonCooldown    = 0;
    player.cannonCritChance  = 0;
    player.cannonCritMult    = 1.5;
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
  // Crítico do canhão: "melhor de", mesma convenção do lifesteal — equipar dois
  // c6 com a Pontaria não dobra a chance, e um c6 sem o upgrade não dilui a de
  // quem tem (seria o oposto do que "melhorar um canhão" promete).
  let bestCrit = 0, bestCritMult = 0;

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
        if (ud.critChance && ud.critChance > bestCrit) {
          bestCrit     = ud.critChance;
          bestCritMult = ud.critMult || 1.5;
        }
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
  player.cannonCritChance  = Math.min(bestCrit, 0.5);
  // Base do crítico: ×1,5, não o dobro. Ver a nota no `cannon_crit_upgrade`
  // (constants/maps.js) — é lá que mora o número de verdade; estes `|| 1.5` são
  // só o fallback de quem não comprou o upgrade.
  player.cannonCritMult    = bestCritMult || 1.5;
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

// ── World Time (dia/noite sincronizado entre todos os jogadores) ──────────────
// 1 ciclo completo = DAY_DURATION_S segundos reais = 24 horas de jogo
// Começa ao meio-dia (12.0) para que os primeiros jogadores entrem com luz.
const DAY_DURATION_S       = 1200; // 20 min reais = 1 dia de jogo
let worldTimeHour          = 12.0; // hora atual (0.0 – 24.0)
let _worldTimeBroadcastAcc = 0;    // acumulador em ms para o broadcast periódico

// ── Lua de Sangue ────────────────────────────────────────────────────────────
// Evento GLOBAL (não por mapa): sorteado uma única vez no anoitecer, com 1% de
// chance, e válido até o amanhecer. Durante a lua, NPCs e bosses nascem com os
// atributos multiplicados por bloodMoonMult (2× ou 3×) POR CIMA da dificuldade
// do jogador, e a recompensa é multiplicada pelo mesmo fator.
const BLOOD_MOON_CHANCE = 0.01;
const NIGHT_START_HOUR  = 19.0;   // anoitecer: momento do sorteio
const NIGHT_END_HOUR    = 5.0;    // amanhecer: fim garantido do evento
let bloodMoonActive = false;
let bloodMoonMult   = 1;

/**
 * Sorteia/encerra a Lua de Sangue nas viradas do ciclo. Detecta a passagem POR
 * cima do limiar (prev → cur) em vez de testar só a hora atual: assim o sorteio
 * roda exatamente uma vez por noite, e não a cada tick da faixa noturna.
 */
function _updateBloodMoon(prevHour, curHour) {
  const crossed = (from, to, mark) =>
    (from < mark && to >= mark) || (from > to && (from < mark || to >= mark));

  if (!bloodMoonActive && crossed(prevHour, curHour, NIGHT_START_HOUR)) {
    if (Math.random() < BLOOD_MOON_CHANCE) {
      bloodMoonActive = true;
      bloodMoonMult   = Math.random() < 0.5 ? 2 : 3;
      worldState.setBloodMoon(true, bloodMoonMult);
      console.log(`🔴 LUA DE SANGUE nesta noite! Multiplicador ${bloodMoonMult}×`);
      _broadcastBloodMoon();
    }
  } else if (bloodMoonActive && crossed(prevHour, curHour, NIGHT_END_HOUR)) {
    bloodMoonActive = false;
    bloodMoonMult   = 1;
    worldState.setBloodMoon(false, 1);
    console.log('🌅 A Lua de Sangue terminou.');
    _broadcastBloodMoon();
  }
}

/** Avisa na hora (sem esperar o broadcast de 30 s) — a virada precisa ser nítida. */
function _broadcastBloodMoon() {
  const msg = JSON.stringify({
    type: 'world_time', hour: worldTimeHour, bloodMoon: bloodMoonActive,
  });
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// O multiplicador do evento é lido por `worldState.bloodMoonFactor()`
// (utils/world-state.js), alimentado pelo `setBloodMoon` acima. Existia aqui
// uma segunda cópia da mesma conta que ninguém chamava.

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
  // Broadcast XP gain to that player. Mandar `xp`/`xpNeeded` junto é o que
  // permite a barra do Capitão → Habilidades andar em tempo real; sem isso o
  // cliente só conseguia atualizar o nível e a barra ficava congelada no valor
  // que veio no init (só "andava" depois de relogar).
  sendTo(player.ws, {
    type: 'skill_xp', skill, amount,
    level:    sk.level,
    xp:       sk.xp,
    xpNeeded: xpForLevel(sk.level),
  });
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
// O SHIP_DEFS traz o PISO do navio bônus, mas quem manda é a instância que o
// jogador possui: o HP dela foi ROLADO entre hpMin e hpMax quando o navio caiu,
// e é esse valor que a vida máxima tem de usar. Todo caminho que recalcula vida
// — subir a skill de vida, comprar upgrade na ilha — passa por aqui, então o
// override mora AQUI e não em cada chamador; era ele faltando na compra do
// upgrade que fazia a vida despencar de 200k para o piso da tabela.
function recalcMaxHp(player) {
  const bonus = player.activeBonusShipStats;
  _recalcMaxHp(player, SHIP_DEFS, TALENT_DEFS, bonus ? (bonus.maxHp || bonus.hp || 1000) : null);
}

/**
 * Recalcula TUDO que deriva de talentos: os bônus agregados, a vida máxima, os
 * slots de canhão e a mana máxima.
 *
 * Existe porque esta conta estava copiada em cinco lugares — login, restauração
 * e ativação de navio bônus, compra de talento, reset e troca de navio — cada um
 * com uma parcela diferente faltando. Bastava um deles esquecer um pedaço para o
 * jogador perder o efeito sem nenhum erro aparecer: trocar de navio zerava o
 * Reservatório Arcano, os navios bônus ignoravam o Casco Reforçado, e comprar um
 * talento de vida percentual não mexia na vida até o próximo login.
 *
 * Qualquer talento novo que mexa em stat derivado entra AQUI, e todos os
 * caminhos passam a respeitá-lo de graça.
 *
 * @param {object}  player
 * @param {object}  [opts]
 * @param {boolean} [opts.fillHp]   enche a vida (ativação de navio novo)
 * @param {boolean} [opts.fillMana] enche a mana (login)
 */
function refreshTalentDerived(player, opts = {}) {
  applyTalentBonuses(player);

  const bonus = player.activeBonusShipStats;
  recalcMaxHp(player); // já usa o HP do navio bônus quando há um ativo
  if (bonus) {
    player.maxCannons = (bonus.cannon || 5) + (player.talentCannonBonus || 0);
  } else {
    const ship = SHIP_DEFS[player.activeShip] || SHIP_DEFS.fragata;
    player.maxCannons = _calcMaxCannons(ship, player.talentCannonBonus || 0, MAX_CANNON_SLOTS);
  }

  // Reservatório Arcano soma mana máxima em cima do que o navio dá.
  const reliqC = SHIP_RELIQC[player.activeShip] || {};
  player.maxMana = (reliqC.maxMana ?? 8) + fx.maxManaBonus(player);

  player.hp   = opts.fillHp   ? player.maxHp   : Math.min(player.hp   || 0, player.maxHp);
  player.mana = opts.fillMana ? player.maxMana : Math.min(player.mana || 0, player.maxMana);
}

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
  const allDefs = DAILY_MISSIONS || [];
  const count   = DAILY_MISSION_COUNT || 5;
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

// ═══════════════════════════════════════════════════════════════════════════════
// Troca de mapa pela borda — detecção + confirmação do jogador
// ═══════════════════════════════════════════════════════════════════════════════

const BORDER_EDGE  = 20;   // faixa de detecção, em unidades, a partir da borda
const BORDER_SPAWN = 150;  // offset de nascimento na borda oposta do mapa destino

/** Onde o barco nasce no mapa destino, por direção de saída. */
const BORDER_SPAWN_AT = {
  norte: { axis: 'z', value: (s) =>  (s / 2) - BORDER_SPAWN },
  sul:   { axis: 'z', value: (s) => -(s / 2) + BORDER_SPAWN },
  left:  { axis: 'x', value: (s) =>  (s / 2) - 80 },
  right: { axis: 'x', value: (s) => -(s / 2) + 80 },
};

/** Testes de "chegou na borda" + clamp que segura o barco ali, para um mapa. */
// Detecção de borda, sem alocação. `lim` = (mapSize / 2) - BORDER_EDGE, ou seja
// a mesma fronteira que a antiga borderDirs() montava por closure. São tabelas
// de módulo (criadas uma vez) porque isto roda por jogador a cada tick.
const BORDER_TEST = {
  norte: (p, lim) => p.z <= -lim,
  sul:   (p, lim) => p.z >=  lim,
  left:  (p, lim) => p.x <= -lim,
  right: (p, lim) => p.x >=  lim,
};
const BORDER_BLOCK = {
  norte: (p, lim) => { p.z = -lim; },
  sul:   (p, lim) => { p.z =  lim; },
  left:  (p, lim) => { p.x = -lim; },
  right: (p, lim) => { p.x =  lim; },
};

/**
 * Borda dividida (ex.: mapa 11 sul → [6, 10]): array de destinos.
 * Para bordas norte/sul a metade oeste (x<0) vai pro primeiro e a leste pro
 * segundo; para left/right decide pela metade em z.
 */
function resolveBorderTarget(p, dir, targetRaw) {
  if (!Array.isArray(targetRaw)) return targetRaw;
  const axis = BORDER_SPAWN_AT[dir]?.axis || 'z';
  return axis === 'z'
    ? (p.x < 0 ? targetRaw[0] : targetRaw[1])
    : (p.z < 0 ? targetRaw[0] : targetRaw[1]);
}

/**
 * Lista de entidades mandada na ENTRADA de um mapa (`init` e `map_transition`).
 *
 * Com AOI ligada ela vai VAZIA de propósito. O cliente cria uma entidade para
 * cada item desta lista, mas o servidor só sabe remover (via `r`) aquilo que ele
 * mesmo mandou pelo AOI — um NPC criado por aqui e fora do raio de visão nunca
 * entraria na lista de remoção e ficaria de navio-fantasma parado no mapa.
 *
 * Não se perde nada: o broadcast seguinte chega em no máximo 100 ms e preenche
 * tudo que está no alcance. O pré-carregamento de modelos não depende desta
 * lista — _preload_map_npcs() no cliente lê o mapDef.
 */
function entrySnapshot(mgr) {
  if (AOI_ENABLED) return [];
  return mgr ? mgr.snapshot() : [];
}

/** Cancela o aviso de borda (jogador se afastou, morreu, saiu do mapa…). */
function clearBorderPrompt(p) {
  if (!p._pendingBorder) return;
  p._pendingBorder = null;
  sendTo(p.ws, { type: 'border_prompt_clear' });
}

/**
 * Executa a troca de mapa pela borda. Só é chamada depois que o jogador
 * confirma o aviso — a detecção da borda por si só nunca teleporta ninguém.
 */
function applyBorderTransition(p, dir, targetLevel) {
  const level     = p.mapLevel || 1;
  const targetDef = MAP_DEFS[targetLevel];
  const spawn     = BORDER_SPAWN_AT[dir];
  if (!targetDef || !spawn) return false;

  console.log(`🗺️ ${p.name}: mapa ${level} → ${targetLevel} (${dir})`);
  const targetSize = targetDef.size;
  if (spawn.axis === 'z') p.z = spawn.value(targetSize);
  else                    p.x = spawn.value(targetSize);

  // O eixo livre é mantido do mapa anterior — clampa aos limites do destino
  // (mapas têm tamanhos diferentes; sem isso dá pra nascer fora da borda)
  const _edgeClamp = targetSize / 2 - 40;
  p.x = Math.max(-_edgeClamp, Math.min(_edgeClamp, p.x));
  p.z = Math.max(-_edgeClamp, Math.min(_edgeClamp, p.z));

  p.mapLevel = targetLevel;
  p._pendingBorder = null;
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
  const bpKts   = targetDef.boss?.killsToSpawn ?? 10;
  const bpTot   = getMapKills(targetLevel);
  const bpAlive = getMapBossAlive(targetLevel);
  sendTo(p.ws, {
    type:    'map_transition',
    toLevel: targetLevel,
    mapDef:  targetDef,
    mapSize: targetSize,
    x:       p.x,
    z:       p.z,
    mapXp:   p.mapXp || 0,
    npcs:    entrySnapshot(targetMgr),
    bossProgress: targetDef.boss
      ? (bpKts === 0
          ? { current: 0, needed: 0, mapLevel: targetLevel, bossAlive: bpAlive }
          : { current: bpTot % bpKts, needed: bpKts, mapLevel: targetLevel, bossAlive: bpAlive })
      : null,
    dailyMissions: targetLevel === 4 ? buildDailyMissions(p) : undefined,
    wrecks: wreckManager.snapshot(targetLevel),   // ruínas ativas (zona vermelha)
    spoils: spoilManager.snapshot(targetLevel),   // espólios de abordagem (zona red+)
  });
  return true;
}

const TICK_RATE = parseInt(process.env.TICK_RATE || process.env.VITE_TICK_RATE) || 16
setInterval(() => {
  const _tickT0 = performance.now();
  const now = Date.now();
  const dt  = (now - lastTick) / 1000;
  lastTick  = now;

  playerManager.update(dt);
  missionBoatManager.update(now, dt);
  fleetEventManager.update(now);
  wreckManager.update(now);
  spoilManager.update(now);

  // ── World time — avança e transmite periodicamente ────────────────────────
  const _prevHour = worldTimeHour;
  worldTimeHour = (worldTimeHour + dt * 24.0 / DAY_DURATION_S) % 24.0;
  _updateBloodMoon(_prevHour, worldTimeHour);
  _worldTimeBroadcastAcc += dt * 1000;
  if (_worldTimeBroadcastAcc >= 30000) {
    _worldTimeBroadcastAcc = 0;
    const wtMsg = JSON.stringify({
      type: 'world_time', hour: worldTimeHour, bloodMoon: bloodMoonActive,
    });
    wss.clients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) ws.send(wtMsg);
    });
  }

  // ── distanceSailed: rastreia distância percorrida por jogadores ───────────
  // Guarda a posição anterior em dois escalares em vez de um objeto novo por
  // jogador por tick (eram ~12,5 mil objetos/s com 200 jogadores, todos lixo
  // para o GC no tick seguinte).
  players.forEach(p => {
    if (p.dead || p.x === undefined || p.z === undefined) return;
    if (p._lastMissionX !== undefined) {
      const _ddx  = p.x - p._lastMissionX;
      const _ddz  = p.z - p._lastMissionZ;
      const _dist = Math.sqrt(_ddx * _ddx + _ddz * _ddz);
      // Sanity check: ignora teleports (> 200u) e movimentos mínimos (< 0.5u)
      if (_dist >= 0.5 && _dist < 200) {
        progressDailyMission(p, 'distanceSailed', Math.round(_dist));
      }
    }
    p._lastMissionX = p.x;
    p._lastMissionZ = p.z;
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
        ensureManagersForMap(_retMap);
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
  // A borda NUNCA teleporta sozinha: o barco é segurado no limite e o cliente
  // recebe `border_prompt`. A troca só acontece quando o jogador confirma
  // (`confirm_map_transition`) — sem isso dava pra sair do mapa sem querer no
  // meio de uma batalha, só por manobrar perto da borda.
  players.forEach(p => {
    if (p.dead) { clearBorderPrompt(p); return; }
    // AFK: sem transição por borda
    if (p.afkTraining || MAP_DEFS[p.mapLevel]?.isTrainingMap) { clearBorderPrompt(p); return; }

    const level = p.mapLevel || 1;
    const mapDef = MAP_DEFS[level];
    if (!mapDef) { clearBorderPrompt(p); return; }

    const sideMapEntry = mapDef.sideMap?.[0];
    if (!sideMapEntry) { clearBorderPrompt(p); return; }

    // `lim` é a mesma fronteira que borderDirs() calculava. A checagem virou
    // tabela de módulo (BORDER_TEST/BORDER_BLOCK) porque borderDirs() alocava um
    // objeto com 4 sub-objetos e 8 closures POR JOGADOR, POR TICK — a 62,5 Hz
    // com 200 jogadores eram ~160 mil alocações por segundo só para comparar
    // quatro números. A ordem das direções é preservada (memoizada no próprio
    // sideMapEntry) para não mudar qual saída ganha quando o barco está na
    // quina de duas bordas.
    const lim = (mapDef.size / 2) - BORDER_EDGE;
    const dirs = sideMapEntry._dirs
      || (sideMapEntry._dirs = Object.keys(sideMapEntry).filter(d => BORDER_TEST[d]));

    let atBorder = false;
    for (const dir of dirs) {
      if (!BORDER_TEST[dir](p, lim)) continue;
      const block = BORDER_BLOCK[dir];
      const targetRaw = sideMapEntry[dir];

      atBorder = true;
      const targetLevel = resolveBorderTarget(p, dir, targetRaw);

      // Mapa 5 (Treino AFK) é acessível apenas por compra — bloqueia borda
      if (targetLevel === 5) {
        block(p, lim);
        clearBorderPrompt(p);
        break;
      }

      const targetDef = MAP_DEFS[targetLevel];
      if (!targetDef) { block(p, lim); clearBorderPrompt(p); break; }

      // Gate de XP: apenas em direção 'norte' quando mapDef.xpToAdvance está definido
      // E apenas se o mapa destino também é de progressão (xpRequired > 0)
      // Mapas utilitários (ex: Ilha do Banco com xpRequired: 0) nunca são bloqueados
      if (dir === 'norte' && mapDef.xpToAdvance && (targetDef.xpRequired || 0) > 0) {
        const xp = p.mapXp || 0;
        if (xp < mapDef.xpToAdvance) {
          block(p, lim);
          clearBorderPrompt(p);
          if (!p._borderMsgCooldown || Date.now() - p._borderMsgCooldown > 4000) {
            p._borderMsgCooldown = Date.now();
            sendTo(p.ws, { type: 'border_blocked', level, xp, needed: mapDef.xpToAdvance, nextMapName: targetDef.name });
          }
          break;
        }
      }

      // Segura o barco na borda e pede confirmação (uma vez por chegada).
      block(p, lim);
      const pend = p._pendingBorder;
      if (!pend || pend.dir !== dir || pend.target !== targetLevel || pend.from !== level) {
        p._pendingBorder = { dir, target: targetLevel, from: level };
        sendTo(p.ws, {
          type:        'border_prompt',
          toLevel:     targetLevel,
          nextMapName: targetDef.name,
          dir,
        });
      }
      break;
    }

    // Saiu da faixa da borda — some com o aviso
    if (!atBorder) clearBorderPrompt(p);
  });

  // Update NPC managers — mapas 1 e 2 always active, resto dinâmico
  //
  // O índice é montado UMA VEZ por tick. Antes cada mapa chamava
  // `new Map([...players].filter(...))`, varrendo TODOS os jogadores: com 200
  // jogadores e 12 mapas ativos davam ~150 mil iterações e 750 Maps por segundo
  // só para o GC limpar depois.
  const _emptyPlayers = new Map();
  const _playersByMap = new Map();
  players.forEach((p, id) => {
    const lvl = p.mapLevel || 1;
    let m = _playersByMap.get(lvl);
    if (!m) { m = new Map(); _playersByMap.set(lvl, m); }
    m.set(id, p);
  });
  const _playersForMap = lvl => _playersByMap.get(lvl) || _emptyPlayers;

  if (!npcManager.destroyed)  npcManager.update(dt,  _playersForMap(1));
  if (!npcManager2.destroyed) npcManager2.update(dt, _playersForMap(2));
  for (const [lvl, { npc }] of regularManagers) {
    if (npc && !npc.destroyed) npc.update(dt, _playersForMap(lvl));
  }
  // Mapas bônus (7/8/9)
  for (const [lvl, mgr] of bonusNpcManagers) {
    if (!mgr.destroyed) {
      const bonusPlayers = _playersForMap(lvl);
      mgr.update(dt, bonusPlayers);
      // ── Bonus dungeon: máquina de estados npcs → boss → complete ─────────
      // NPCs são deletados de mgr.npcs ao morrer (proxy), não apenas marcados dead.
      if (mgr._phase === 'npcs' && mgr._initialNpcCount > 0 && mgr.npcs.size === 0) {
        // Todos os NPCs regulares mortos — spawnar boss do dungeon
        mgr._phase = 'boss';
        const mapDef   = MAP_DEFS[lvl] || {};
        const dungeonId = mapDef.bonusMapId;                       // 'bonus_map_1' etc.
        const dungeonDef = dungeonId && BONUS_DUNGEON_DEFS[dungeonId];
        const npcDef     = dungeonDef && BONUS_NPC_DEFS[dungeonDef.npcId];
        if (npcDef) {
          mgr.spawnWithDef(npcDef, lvl, 0, 0);
          mgr._bossSpawnedAt = Date.now();
          console.log(`💀 [BonusDungeon] Boss spawnou: ${npcDef.name} no mapa ${lvl}`);
          for (const [, p] of bonusPlayers) {
            sendTo(p.ws, { type: 'bonus_boss_spawn', bossName: npcDef.name, mapLevel: lvl });
          }
        } else {
          // Sem boss definido → completar direto
          mgr._phase = 'complete';
          const md = MAP_DEFS[lvl] || {};
          for (const [, p] of bonusPlayers) sendBonusDungeonComplete(p, lvl, md);
        }
      }

      // Boss morreu (npcs vazio + grace de 500ms desde o spawn)
      if (mgr._phase === 'boss' && mgr._bossSpawnedAt > 0
          && (Date.now() - mgr._bossSpawnedAt) > 500 && mgr.npcs.size === 0) {
        mgr._phase = 'complete';
        const mapDef = MAP_DEFS[lvl] || {};
        console.log(`🏆 [BonusDungeon] Boss morto — enviando recompensas mapa ${lvl}`);
        for (const [, p] of bonusPlayers) {
          sendBonusDungeonComplete(p, lvl, mapDef);
        }
      }
    }
  }
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

  // ── Healing zone tick — 10% HP/s quando parado dentro do raio ───────────
  players.forEach(p => {
    if (p.dead || p.hp >= p.maxHp) return;
    if (p.speed > 0.1) return; // só cura se o barco estiver parado
    const zones = (MAP_DEFS[p.mapLevel] || {}).healingZones || [];
    for (const zone of zones) {
      const dx = p.x - zone.x, dz = p.z - zone.z;
      if (dx * dx + dz * dz > zone.radius * zone.radius) continue;
      const amount = Math.max(1, Math.round(p.maxHp * (zone.healPct || 0.10) * dt));
      const prev   = p.hp;
      p.hp = Math.min(p.maxHp, p.hp + amount);
      const healed = p.hp - prev;
      if (healed > 0) {
        sendTo(p.ws, { type: 'heal', amount: healed, hp: p.hp, maxHp: p.maxHp,
                       targetId: p.id, x: p.x, z: p.z, source: 'zone' });
        grantSkillXp(p, 'vida', Math.max(1, Math.floor(healed / 10)), wss);
      }
      break; // uma zona por tick é suficiente
    }
  });

  // ── Healer pirate tick ────────────────────────────────────────────────────
  players.forEach(p => {
    if (p.dead || p.hp >= p.maxHp) return;
    // TODOS os curandeiros equipados curam, não só o primeiro: com várias vagas
    // por navio, o `find` de antes fazia o 2º ao 10º não valerem nada.
    const healers = (p.pirates || []).filter(pr => pr === 'healer' || pr === 'healer_elite');
    if (!healers.length) return;

    // O intervalo e a regra de ficar fora de combate são iguais nos dois tipos;
    // o primeiro serve de referência para o relógio.
    const pirateDef = PIRATE_DEFS[healers[0]];
    if (!pirateDef?.healInterval) return;

    const timeSinceCombat = now - (p.lastCombatTime || 0);
    if (pirateDef.needsIdle && timeSinceCombat < (pirateDef.combatCooldown || 2000)) return;

    if (!p._healerTimer) p._healerTimer = 0;
    p._healerTimer += dt * 1000;

    if (p._healerTimer >= pirateDef.healInterval) {
      p._healerTimer = 0;
      // Soma a cura de cada curandeiro; Recuperação (def_recuperacao) multiplica.
      let bruto = 0;
      for (const h of healers) bruto += PIRATE_DEFS[h]?.healAmount || 0;
      const amount = Math.max(1, Math.round(bruto * fx.healingReceivedMult(p)));
      const prev = p.hp;
      p.hp = Math.min(p.maxHp, p.hp + amount);
      const healed = p.hp - prev;
      if (healed > 0) {
        sendTo(p.ws, { type: 'heal', amount: healed, hp: p.hp, source: 'healer' });
        // Vitalidade sobe "ao ser curado" (é o que a skill promete no painel).
        // O curandeiro costuma ser a MAIOR fonte de cura do jogador e não dava
        // XP nenhum — no campo de treino ele era a única cura ativa e a skill
        // simplesmente não subia. Mesma proporção da relíquia de cura.
        grantSkillXp(p, 'vida', Math.max(1, Math.floor(healed / 10)), wss);
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
        // Queimadura acumulativa + slow por pilha — ver utils/aura-burn.js. O
        // `salvo` é a mesma base de dano que a relíquia usa (poder de fogo do
        // barco), para a queimadura acompanhar o barco em vez de ser um número
        // solto que envelhece.
        const aDef   = RELIC_DEFS.r10 || {};
        const aSalvo = relicDamageFor(p, { damagePct: 1.0 });

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
          const npcStacks = applyAuraBurn(npc, p, aDef, aSalvo, now);
          aHits.push({ id: npc.id, dmg: aDamage, hp: npc.hp, isNPC: true, stacks: npcStacks });
          if (npc.hp <= 0 && !npc.dead) {
            npc.dead = true;
            if (npc.isBoss) {
              addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, isBoss: true, killerId: p.id }, npc.mapLevel);
              if (npc.isWorldBoss) {
                worldBossManager.onWorldBossDead(npc, p.id);
              } else {
                const _aBossLvl = npc.mapLevel || 1;
              const aBossMgr = projectileManager.bossManagers.get(_aBossLvl)
                            || (_aBossLvl === 2 ? bossManager2 : bossManager);
                if (aBossMgr) aBossMgr.onBossDead(npc, p.id);
                worldBossManager.onZoneBossDead(npc, p.id);
              }
              projectileManager.npcs.delete(npc.id);
            } else {
              const rewards = projectileManager.grantNpcKillRewards(p, npc);
              addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, killerId: p.id, goldDrop: rewards.goldDrop }, npc.mapLevel);
              const _nLvlA = npc.mapLevel || 1;
              const aMgr = (_nLvlA === 1 ? npcManager : _nLvlA === 2 ? npcManager2 : getMapManager(_nLvlA));
              aMgr && aMgr.respawnScaled(npc.id, p.npcKills || 0, _nLvlA);
              _npcKillBossAccounting(_nLvlA, p.npcKills || 0);
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
          if (!relicCanHitPlayer(p, target)) return;
          if (Math.hypot(target.x - p.x, target.z - p.z) > aRange) return;
          target.hp = Math.max(0, target.hp - aDamage);
          target.lastCombatTime = now;
          const tgtStacks = applyAuraBurn(target, p, aDef, aSalvo, now);
          aHits.push({ id: target.id, dmg: aDamage, hp: target.hp, isNPC: false, stacks: tgtStacks });
          resolvePlayerDeath(target, p.id);
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
    // Névoa Espectral (do jogador ou do pet): invencível também pausa DoT — sem
    // gastar a carga do escudo (ver utils/invincibility.js).
    if (!isNPC && isInvincible(e, now)) return;
    e.dots = e.dots.filter(dot => {
      if (now < dot.next) return true;
      e.hp = Math.max(0, e.hp - dot.dmg);
      dot.dur -= dot.tick;
      dot.next = now + dot.tick;
      const effect = dot.effect || 'fire';
      // `hp`/`maxHp` vão junto para a barra de vida acompanhar o tique na hora,
      // em vez de esperar o próximo `state` (100 ms) — o DoT é a única fonte de
      // dano que não passa por um evento com HP.
      dotBatch.push({ targetId: e.id, targetIsNPC: isNPC, dmg: dot.dmg, effect,
                      hp: e.hp, maxHp: e.maxHp, x: e.x, z: e.z, mapLevel: e.mapLevel || 1 });
      // DOT kill — handle death if HP reached 0
      if (e.hp <= 0 && !e.dead) {
        e.dead = true;
        if (isNPC) {
          const killer = players.get(dot.ownerId);
          if (e.isBoss) {
            addEvent({ type: 'entity_dead', id: e.id, isNPC: true, isBoss: true, killerId: dot.ownerId }, e.mapLevel);
            const _dotBossLvl = e.mapLevel || 1;
            const dotBossMgr = projectileManager.bossManagers.get(_dotBossLvl)
                            || (_dotBossLvl === 2 ? bossManager2 : bossManager);
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
              // Multiplicador de dificuldade travado no NPC (kills por DoT também
              // escalam) — recompensa usa a METADE dos atributos (difficultyRewardMult)
              const dotDiff = difficultyRewardMult(e.diffMult || 1);
              const gold = Math.round(Math.floor(baseGold * (1 + (killer.dropBonus||0)) * (1 + tier*0.01)) * dotDiff);
              killer.gold += gold;
              // Dobrao drop
              let dotDobrao = 0;
              if ((dotNpcDef.dobraoChance || 0) > 0 && Math.random() < dotNpcDef.dobraoChance) {
                const dAmt = Math.round(Math.floor(Math.random() * (dotNpcDef.dobraoMax - dotNpcDef.dobraoMin + 1) + dotNpcDef.dobraoMin) * dotDiff);
                killer.dobroes = (killer.dobroes || 0) + dAmt;
                dotDobrao = dAmt;
              }
              // XP grant on DOT kill — use e.mapLevel (NPC zone), not killer.mapLevel
              const dotXpMapDef = MAP_DEFS[e.mapLevel || 1] || MAP_DEFS[1];
              const xpGained = Math.round(Math.floor((dotXpMapDef.npc?.xpPerKill || 12) * (1 + tier * 0.01)) * dotDiff);
              killer.mapXp = (killer.mapXp || 0) + xpGained;
              // Mesma fonte do abate a tiro: o jogador não distingue quem deu o
              // golpe final, e separar em duas linhas só picotaria o extrato.
              journalManager.accrue(killer, JOURNAL_SRC.NPC_KILL,
                { gold, xp: xpGained, dobroes: dotDobrao });
              journalManager.checkTier(killer);
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
              // ── Recompensa de grupo (abate por DoT) ───────────────────────
              // Mesma regra do abate a tiro (projectile-manager): ouro e XP
              // cheios para cada companheiro na zona, com bônus por cabeça. Só
              // o fragmento já era assim. O caminho do DoT ficava de fora e
              // isso apareceria em jogo como "matei com fogo e o grupo não
              // ganhou nada" — o jogador não distingue quem deu o golpe final.
              const dotFragGain = Math.floor(FRAGMENT_DROP_NPC * dotDiff);
              killer.mapFragments = (killer.mapFragments || 0) + dotFragGain;
              const dotPartyMembers = partyManager.getPartyMembersInZone(killer.id, e.mapLevel || 1, players);
              const dotPartyMult = partyRewardMult(dotPartyMembers.length);
              const dotMateGold  = Math.floor(gold     * dotPartyMult);
              const dotMateXp    = Math.floor(xpGained * dotPartyMult);
              for (const m of dotPartyMembers) {
                m.gold         = (m.gold  || 0) + dotMateGold;
                m.mapXp        = (m.mapXp || 0) + dotMateXp;
                m.mapFragments = (m.mapFragments || 0) + dotFragGain;
                if (m.ws?.readyState === 1) {
                  sendTo(m.ws, { type: 'currency_update', gold: m.gold, dobroes: m.dobroes, mapFragments: m.mapFragments });
                }
                journalManager.accrue(m, JOURNAL_SRC.PARTY_SHARE, { gold: dotMateGold, xp: dotMateXp });
                db.save(m).catch(err => console.error('Save error:', err));
              }
              // O bônus do próprio matador entra como diferença: `gold` e
              // `xpGained` já foram creditados cheios acima.
              if (dotPartyMult > 1.0) {
                killer.gold  += dotMateGold - gold;
                killer.mapXp += dotMateXp   - xpGained;
              }
              db.save(killer).catch(e => console.error('Save error:', e));
              const curXpNeeded = (MAP_DEFS[killer.mapLevel || 1] || MAP_DEFS[1]).xpToAdvance || 99999;
              sendTo(killer.ws, { type: 'currency_update', gold: killer.gold, dobroes: killer.dobroes, reward: { type:'gold', amount: gold }, npcKills: killer.npcKills, mapXp: killer.mapXp, mapLevel: killer.mapLevel || 1, mapXpNeeded: curXpNeeded, mapFragments: killer.mapFragments });
            }
            addEvent({ type: 'entity_dead', id: e.id, isNPC: true, goldDrop: baseGold, killerId: dot.ownerId }, e.mapLevel);
            const dotNpcLevel = e.mapLevel || 1;
            ensureManagersForMap(dotNpcLevel);
            const dotMgr = dotNpcLevel === 1 ? npcManager
                         : dotNpcLevel === 2 ? npcManager2
                         : getMapManager(dotNpcLevel);
            dotMgr && dotMgr.respawnScaled(e.id, killer ? (killer.npcKills||0) : 0, dotNpcLevel);
            // Boss spawn trigger — dinâmico para todos os mapas
            const _dotKts = MAP_DEFS[dotNpcLevel]?.boss?.killsToSpawn ?? 0;
            if (_dotKts > 0) {
              const _dotTot = (projectileManager.killCounters.get(dotNpcLevel) || 0) + 1;
              projectileManager.killCounters.set(dotNpcLevel, _dotTot);
              if (dotNpcLevel === 1) projectileManager.totalNpcKills  = _dotTot;
              else if (dotNpcLevel === 2) projectileManager.totalNpcKills2 = _dotTot;
              else if (dotNpcLevel === 3) projectileManager.totalNpcKills3 = _dotTot;
              const _dotBm = projectileManager.bossManagers.get(dotNpcLevel)
                          || (dotNpcLevel === 2 ? bossManager2 : bossManager);
              console.log(`[boss-debug] (dot) map=${dotNpcLevel} kill=${_dotTot} kts=${_dotKts} bossAlive=${!!_dotBm?.bossAlive}`);
              if (_dotBm && (_dotTot % _dotKts) === 0 && !_dotBm.bossAlive) {
                const rarity = _dotBm.rollPendingRarity();
                addEvent({ type: 'boss_incoming', rarity, mapLevel: dotNpcLevel }, dotNpcLevel);
                const dotKills = killer ? (killer.npcKills || 0) : 0;
                const tid = setTimeout(() => _dotBm.spawn(dotKills), 2000);
                console.log(`[boss-debug] (dot) scheduled spawn timer=${tid} for map=${dotNpcLevel}`);
              }
              addEvent({ type: 'boss_progress', current: _dotTot % _dotKts, needed: _dotKts, mapLevel: dotNpcLevel, bossAlive: !!_dotBm?.bossAlive }, dotNpcLevel);
            }
          }
        } else {
          // Quem aplicou o DoT leva o crédito do abate (o `dot.ownerId` já era
          // usado para creditar a kill de NPC logo acima) — respawn é manual,
          // o cliente pede com request_respawn.
          resolvePlayerDeath(e, dot.ownerId);
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
    // NPC snapshots — dinâmico para todos os mapas
    const npcSnapByZone = new Map();
    const _snapMgr = (mgr, lvl) => {
      if (mgr && !mgr.destroyed) npcSnapByZone.set(lvl, mgr.snapshot().filter(n => !n.isBoss || n.isWorldBoss));
    };
    _snapMgr(npcManager,  1);
    _snapMgr(npcManager2, 2);
    for (const [lvl, { npc }] of regularManagers) { _snapMgr(npc, lvl); }
    for (const [lvl, mgr] of bonusNpcManagers) {
      // Dungeon bosses (isDungeonBoss) devem aparecer no NPC snapshot — não estão no bossManagers
      if (mgr && !mgr.destroyed)
        npcSnapByZone.set(lvl, mgr.snapshot().filter(n => !n.isBoss || n.isDungeonBoss));
    }

    const playerSnap  = playerManager.snapshot();

    // Boss snapshot — dinâmico: percorre todos os bossManagers registrados
    const bossSnap = [];
    const _allBossManagers = [bossManager, bossManager2,
      ...regularManagers.values().map ? [...regularManagers.values()].map(e => e.boss) : []];
    // Usa o Map dinâmico como fonte canônica
    projectileManager.bossManagers.forEach(mgr => {
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

    // ── Meta da zona (clima + barco de missões) ────────────────────────────
    // Vai junto em toda mensagem de state, mas também precisa FORÇAR o envio
    // quando muda: o cliente remove o barco quando o campo `missionBoat` some
    // (ver _update_mission_boat em main.gd), então se o barco trocar de mapa num
    // tick em que ninguém se mexeu, sem esse force o barco ficaria fantasma.
    if (!global._zoneMeta) global._zoneMeta = new Map();
    const zoneMeta = new Map();
    const zonesWithPlayers = new Set();
    players.forEach(p => zonesWithPlayers.add(p.mapLevel || 1));
    for (const zone of zonesWithPlayers) {
      const weather = weatherManager.get(zone, now);
      const boat    = missionBoatManager.snapshotFor(zone);
      const prev    = global._zoneMeta.get(zone);
      const changed = !prev || prev.weather !== weather || !!prev.boat !== !!boat;
      zoneMeta.set(zone, { weather, boat, changed });
      global._zoneMeta.set(zone, { weather, boat: !!boat });
    }

    if (AOI_ENABLED) {
      // ── Broadcast com interest management ────────────────────────────────
      // Uma indexação por mapa (O(N)) e depois uma consulta por jogador — em vez
      // da lista inteira do mapa serializada uma vez por jogador (O(P²)).
      const liveIds = new Set();
      const zoneIndex = new Map();
      for (const zone of zonesWithPlayers) {
        const entities = [
          ...(playersByZone.get(zone)  || []),
          ...(npcSnapByZone.get(zone)  || []),
          ...(bossesByZone.get(zone)   || []),
        ];
        for (const e of entities) liveIds.add(e.id);
        zoneIndex.set(zone, stateBuilder.buildZone(entities, zone));
      }

      players.forEach(p => {
        const zone = p.mapLevel || 1;
        const idx  = zoneIndex.get(zone);
        if (!idx) return;
        const meta = zoneMeta.get(zone);
        const msg  = stateBuilder.buildFor(p, idx);
        // Nada entrou, saiu nem se mexeu e a meta da zona não mudou: silêncio.
        // Num porto com gente parada isso corta a maior parte do tráfego.
        if (!msg && !(meta && meta.changed)) return;
        const out = msg || { type: 'state', aoi: 1 };
        if (meta) {
          out.weather = meta.weather;
          if (meta.boat) out.missionBoat = meta.boat;
        }
        // Serializa aqui (em vez de deixar o sendTo fazer) só para conseguir
        // contar os bytes que saem — é o mesmo trabalho, mais um contador.
        const raw = JSON.stringify(out);
        _serverMetrics.stateBytesSent += raw.length;
        _serverMetrics.broadcastsSent++;
        sendRaw(p.ws, raw);
      });

      // Baselines de entidades que já morreram/sumiram (só varre quando cresce)
      stateBuilder.pruneBaseline(liveIds);
    } else {
      // ── Broadcast legado (AOI_ENABLED=0) ─────────────────────────────────
      // Mantido como rota de fuga. Mesmo aqui a mensagem é serializada UMA VEZ
      // por mapa em vez de uma vez por jogador — ela é idêntica para todo mundo
      // da zona, então o stringify por jogador era desperdício puro.
      const rawByZone = new Map();
      for (const zone of zonesWithPlayers) {
        const meta = zoneMeta.get(zone);
        const stateMsg = {
          type:    'state',
          players: playersByZone.get(zone) || [],
          npcs:    [...(npcSnapByZone.get(zone) || []), ...(bossesByZone.get(zone) || [])],
          weather: meta ? meta.weather : undefined,
        };
        if (meta && meta.boat) stateMsg.missionBoat = meta.boat;
        rawByZone.set(zone, JSON.stringify(stateMsg));
      }
      players.forEach(p => {
        const raw = rawByZone.get(p.mapLevel || 1);
        if (raw) sendRaw(p.ws, raw);
      });
    }
  }

  // ── Limpeza de mapas vazios (a cada minuto) — dinâmico ───────────────────
  if (!global._lastMapCleanup || now - global._lastMapCleanup > 60000) {
    global._lastMapCleanup = now;
    if (!global._mapEmptySince) global._mapEmptySince = new Map();

    // Mapas 1 e 2 têm lógica especial (mapa 1 só destrói se mapa 2 tem jogadores)
    const pInMap1 = [...players.values()].filter(p => (p.mapLevel||1) === 1).length;
    const pInMap2 = [...players.values()].filter(p => (p.mapLevel||1) === 2).length;
    const destroy = (lvl, npc, boss) => {
      console.log(`🗑️ Destruindo managers do Mapa ${lvl} (vazio)`);
      if (npc  && !npc.destroyed)  { npc.destroy();  npc.destroyed  = true; }
      if (boss && !boss.destroyed) { boss.destroy(); boss.destroyed = true; }
      global._mapEmptySince.delete(lvl);
    };
    const checkEmpty = (lvl, count, npc, boss, condition = true) => {
      if (count === 0 && condition) {
        if (!global._mapEmptySince.has(lvl)) global._mapEmptySince.set(lvl, now);
        if (now - global._mapEmptySince.get(lvl) > 300000) destroy(lvl, npc, boss);
      } else {
        global._mapEmptySince.delete(lvl);
      }
    };
    checkEmpty(1, pInMap1, npcManager, bossManager, pInMap2 > 0);
    checkEmpty(2, pInMap2, npcManager2, bossManager2);
    // Maps 3+ via regularManagers — todos dinâmicos
    for (const [lvl, { npc, boss }] of regularManagers) {
      const pCount = [...players.values()].filter(p => (p.mapLevel||1) === lvl).length;
      checkEmpty(lvl, pCount, npc, boss);
    }
  }

  // ── Rede de segurança: ninguém navega com 0 de vida ───────────────────────
  // Cada fonte de dano chama resolvePlayerDeath com o autor do golpe, que é o
  // caminho bom (o abate rende crédito a alguém). Este laço cobre o resto —
  // fontes sem dono, como o DoT legado do player-manager — para que o pior caso
  // seja "morreu sem creditar ninguém" em vez de "ficou vivo com HP zerado".
  players.forEach(p => { if (p._dbLoaded && p.hp <= 0) resolvePlayerDeath(p, null); });

  flushEvents();

  // Custo deste tick. Medido no fim, depois do broadcast — é ele que domina.
  const _tickMs = performance.now() - _tickT0;
  _serverMetrics.tickCount++;
  _serverMetrics.lastTickMs = _tickMs;
  _serverMetrics.tickMsSum += _tickMs;
  if (_tickMs > _serverMetrics.maxTickMs) _serverMetrics.maxTickMs = _tickMs;
  if (_tickMs > 20) _serverMetrics.slowTicks++;
}, TICK_RATE);

// Save all players every 15s — uses a single batch query instead of N individual saves
setInterval(() => {
  db.batchSave(players).catch(e => console.error('Periodic batch save error:', e));
  // Mesmo tique fecha as janelas vencidas do livro-caixa (ver accrue). O sweep
  // é barato — só olha o relógio de quem tem balde aberto.
  journalManager.sweep(players);
}, 15000);

// ── Mana regen: +0,5/s por jogador (metade da velocidade antiga de +1/s) ──────
// O talento "Fluxo de Mana" (árvore Recurso, anel 1) dá +8% de velocidade de
// recuperação por nível — no máximo (10) são +80%. Acumulador fracionário por
// jogador para a taxa < 1 e o bônus não perderem resolução.
const MANA_REGEN_PER_SEC = 0.5;
setInterval(() => {
  players.forEach(p => {
    if (!p || !p.name || !p._dbLoaded) return;
    if (p.mana >= p.maxMana) { p._manaAcc = 0; return; }
    // Fluxo de Mana sempre, Concentração só fora de combate.
    let rate = MANA_REGEN_PER_SEC * fx.manaRegenMult(p);
    p._manaAcc = (p._manaAcc || 0) + rate;
    if (p._manaAcc >= 1) {
      const add = Math.floor(p._manaAcc);
      p._manaAcc -= add;
      p.mana = Math.min(p.maxMana, p.mana + add);
      sendTo(p.ws, { type: 'mana_update', mana: p.mana, maxMana: p.maxMana });
    }
  });
}, 1000);

// ── Blips do minimapa ────────────────────────────────────────────────────────
// O minimapa mostra o mapa INTEIRO, então não pode se alimentar do `state`, que
// com AOI só carrega o entorno do jogador. Vai em mensagem própria.
//
// 2 Hz porque o minimapa tem ~200 px para 2400 unidades de mapa: 1 px ≈ 12 u, e
// um NPC anda menos de um pixel entre dois broadcasts. Pela mesma razão a
// posição vai em inteiro — já é mais fina que o pixel que vai desenhá-la.
//
// Custo medido com 200 jogadores: +3,7% sobre o tráfego do estado. Barato
// porque NPC é outra ordem de grandeza que jogador — o mapa mais populoso tem
// 21 (mapa 10), contra os 200 jogadores. Dos jogadores só vão os do GRUPO
// (máx. 4): mandar os 200 custaria +30%, oito vezes mais que todos os NPCs.
const BLIP_RATE_MS = parseInt(process.env.BLIP_RATE_MS) || 500;
setInterval(() => {
  if (players.size === 0) return;

  const blipZones = new Set();
  players.forEach(p => blipZones.add(p.mapLevel || 1));

  // A lista de NPCs é idêntica para todo mundo do mapa: serializa UMA vez por
  // mapa e reusa o mesmo pedaço de JSON em todas as mensagens.
  const npcFrag = new Map();
  for (const zone of blipZones) {
    const out = [];
    const collect = (mgr) => {
      if (!mgr || mgr.destroyed || !mgr.npcs) return;
      mgr.npcs.forEach(n => {
        if (!n || n.dead) return;
        out.push([Math.round(n.x), Math.round(n.z), n.isBoss ? 1 : 0]);
      });
    };
    collect(getMapManager(zone));
    collect(projectileManager.bossManagers.get(zone)); // boss vive em manager próprio
    npcFrag.set(zone, JSON.stringify(out));
  }

  players.forEach(p => {
    if (!p.ws) return;
    const zone  = p.mapLevel || 1;
    // getPartyMembersInZone já exclui o próprio jogador, os mortos e quem está
    // em outro mapa — é a mesma checagem que a divisão de recompensa usa.
    const mates = partyManager.getPartyMembersInZone(p.id, zone, players);
    const pFrag = mates.length
      ? JSON.stringify(mates.map(m => [Math.round(m.x), Math.round(m.z)]))
      : '[]';
    sendRaw(p.ws, `{"type":"blips","n":${npcFrag.get(zone) || '[]'},"p":${pFrag}}`);
  });
}, BLIP_RATE_MS);

// ── Helpers para gerenciamento dinâmico de mapas ──────────────────────────────
function getMapManager(level) {
  if (level >= 7) {
    // isBonusMap (7/8/9) → bonusNpcManagers; mapas regulares altos (10+) → regularManagers
    if (MAP_DEFS[level]?.isBonusMap) return bonusNpcManagers.get(level) || null;
    return regularManagers.get(level)?.npc || null;
  }
  if (level === 1) return npcManager;
  if (level === 2) return npcManager2;
  return regularManagers.get(level)?.npc || null;
}

function ensureBonusMapManager(level) {
  const existing = bonusNpcManagers.get(level);
  if (existing && !existing.destroyed) return existing;
  const mgr = new NPCManager(projectileManager, MAP_DEFS, level, attackManager);
  mgr.destroyed    = false;
  mgr._phase       = 'npcs'; // 'npcs' → 'boss' → 'complete'
  mgr._bossSpawnedAt = 0;
  mgr.wallManager  = wallManager;
  bonusNpcManagers.set(level, mgr);
  _rewireProjectileManager();
  return mgr;
}

function getMapKills(level) {
  // killCounters é o registro dinâmico; aliases legados para maps 1-3
  return projectileManager.killCounters.get(level)
      || (level === 3 ? projectileManager.totalNpcKills3
        : level === 2 ? projectileManager.totalNpcKills2
        : projectileManager.totalNpcKills)
      || 0;
}

function getMapBossAlive(level) {
  // bossManagers dinâmico primeiro, aliases legados como fallback
  const bm = projectileManager.bossManagers.get(level);
  if (bm) return !!bm.bossAlive;
  if (level === 2) return !!bossManager2?.bossAlive;
  if (level === 1) return !!bossManager?.bossAlive;
  return !!(regularManagers.get(level)?.boss?.bossAlive);
}

// ── Contabiliza kill de NPC normal e dispara boss se threshold atingido ───────
function _npcKillBossAccounting(mapLvl, killerKills) {
  const kts = MAP_DEFS[mapLvl]?.boss?.killsToSpawn ?? 0;
  if (kts <= 0) return; // mapa sem boss (ex: training map)

  // Atualiza contador dinâmico + aliases legados
  const tot = (projectileManager.killCounters.get(mapLvl) || 0) + 1;
  projectileManager.killCounters.set(mapLvl, tot);
  if (mapLvl === 1) projectileManager.totalNpcKills  = tot;
  else if (mapLvl === 2) projectileManager.totalNpcKills2 = tot;
  else if (mapLvl === 3) projectileManager.totalNpcKills3 = tot;

  // Resolve boss manager dinamicamente
  const bm = projectileManager.bossManagers.get(mapLvl)
           || (mapLvl === 2 ? bossManager2 : mapLvl === 1 ? bossManager : null);

  if (bm && (tot % kts) === 0 && !bm.bossAlive) {
    const rarity = bm.rollPendingRarity?.() ?? null;
    addEvent({ type: 'boss_incoming', rarity, mapLevel: mapLvl }, mapLvl);
    setTimeout(() => { if (bm && !bm.bossAlive) bm.spawn(killerKills); }, 2000);
  }
  addEvent({
    type: 'boss_progress',
    current:   tot % kts,
    needed:    kts,
    mapLevel:  mapLvl,
    bossAlive: !!(bm?.bossAlive),
  }, mapLvl);
}

// ── Garante manager para QUALQUER mapa regular (3-6 e futuros) ───────────────
function ensureRegularManager(level) {
  const existing = regularManagers.get(level);
  if (existing && !existing.npc.destroyed) return existing;

  console.log(`🔄 Criando managers do Mapa ${level}`);
  const npc  = new NPCManager(projectileManager, MAP_DEFS, level, attackManager);
  npc.destroyed = false;
  npc.wallManager = wallManager;

  const mapDef = MAP_DEFS[level] || {};
  let boss = null;
  if (mapDef.boss) {
    boss = wireBossManager(new BossManager(wss, players, npc.npcs, level));
    boss.destroyed = false;

    // Mapa 6 — boss com respawn por timer, não por kills
    if (level === 6) {
      boss._onBossKill = (killer) => {
        progressDailyMission(killer, 'bossKills', 1);
        if (boss._respawnTimer) clearTimeout(boss._respawnTimer);
        const delay = mapDef.boss.respawnDelay || 3600000;
        const mins  = Math.round(delay / 60000);
        addEvent({ type: 'boss_respawn_scheduled', mapLevel: level, respawnAt: Date.now() + delay, delayMs: delay }, level);
        console.log(`👻 Boss do Mapa ${level} morto — respawn em ${mins} min`);
        boss._respawnTimer = setTimeout(() => {
          boss._respawnTimer = null;
          const e = regularManagers.get(level);
          if (e && !e.boss.destroyed && !e.boss.bossAlive) {
            addEvent({ type: 'boss_incoming', rarity: null, mapLevel: level }, level);
            setTimeout(() => { if (e.boss && !e.boss.bossAlive) e.boss.spawn(0); }, 5000);
          }
        }, delay);
      };
      // Spawn imediato se boss não está vivo
      if (!boss.bossAlive) {
        addEvent({ type: 'boss_incoming', rarity: null, mapLevel: level }, level);
        setTimeout(() => { if (boss && !boss.bossAlive) boss.spawn(0); }, 5000);
      }
    }
  }

  const entry = { npc, boss };
  regularManagers.set(level, entry);

  // Registra no bossManagers dinâmico do projectileManager
  if (boss) {
    projectileManager.bossManagers.set(level, boss);
    // Aliases legados para compatibilidade
    if (level === 2) { projectileManager.bossManager2 = boss; }
    if (level === 3) { projectileManager.bossManager3 = boss; }
    if (level === 6) { projectileManager.bossManager6 = boss; }
  }

  // Reconecta allNpcs proxy e npcManagers list
  _rewireProjectileManager();
  return entry;
}

function _rewireProjectileManager() {
  projectileManager.npcs = allNpcs;
  const allNpcMgrs = [npcManager, npcManager2];
  for (const { npc } of regularManagers.values()) { if (npc && !npc.destroyed) allNpcMgrs.push(npc); }
  projectileManager.npcManagers = allNpcMgrs;
  if (worldBossManager) worldBossManager.npcManagers = allNpcMgrs;
}

function ensureManagersForMap(level) {
  if (level === 1) {
    if (!npcManager || npcManager.destroyed) {
      console.log('🔄 Recriando managers do Mapa 1');
      npcManager = new NPCManager(projectileManager, MAP_DEFS, 1, attackManager);
      npcManager.destroyed = false;
      npcManager.wallManager = wallManager;
      bossManager = wireBossManager(new BossManager(wss, players, npcManager.npcs, 1));
      bossManager.destroyed = false;
      projectileManager.bossManager = bossManager;
      projectileManager.bossManagers.set(1, bossManager);
      _rewireProjectileManager();
    }
  } else if (level === 2) {
    if (!npcManager2 || npcManager2.destroyed) {
      console.log('🔄 Recriando managers do Mapa 2');
      npcManager2 = new NPCManager(projectileManager, MAP_DEFS, 2, attackManager);
      npcManager2.destroyed = false;
      npcManager2.wallManager = wallManager;
      bossManager2 = wireBossManager(new BossManager(wss, players, npcManager2.npcs, 2));
      bossManager2.destroyed = false;
      projectileManager.bossManager2 = bossManager2;
      projectileManager.bossManagers.set(2, bossManager2);
      _rewireProjectileManager();
    }
  } else if (level >= 7 && MAP_DEFS[level]?.isBonusMap) {
    ensureBonusMapManager(level);
  } else if (MAP_DEFS[level]) {
    ensureRegularManager(level);
  }
}

// ── Passagens antigas (ancient_stone_arch): teleporte entre mapas ─────────────
const ARCH_NEAR_RADIUS       = 160;    // raio de validação (client mostra o aviso em ~120)
const ARCH_COMBAT_COOLDOWN_MS = 30000; // 30s fora de combate p/ poder teleportar

/** true se o jogador está perto de uma passagem no mapa atual (anti-cheat). */
function isNearArch(p) {
  const arches = ARCH_PORTALS[p.mapLevel] || [];
  return arches.some(a => Math.hypot(p.x - a.x, p.z - a.z) <= ARCH_NEAR_RADIUS);
}

/**
 * Sorteia uma passagem de OUTRO mapa que o XP do jogador permita acessar
 * (mapXp >= xpRequired do destino). null se não houver destino elegível.
 */
function pickArchDestination(currentLevel, playerMapXp) {
  const xp = playerMapXp || 0;
  const dests = [];
  for (const [lvlStr, arches] of Object.entries(ARCH_PORTALS)) {
    const lvl = Number(lvlStr);
    if (lvl === currentLevel) continue;            // sempre troca de mapa
    const def = MAP_DEFS[lvl];
    if (!def) continue;
    if ((def.xpRequired || 0) > xp) continue;      // além do que o XP do jogador libera
    for (const a of arches) dests.push({ level: lvl, x: a.x, z: a.z });
  }
  if (dests.length === 0) return null;
  return dests[Math.floor(Math.random() * dests.length)];
}

/** true se existe alguma passagem em OUTRO mapa (ignorando o gate de XP). */
function hasOtherArch(currentLevel) {
  return Object.keys(ARCH_PORTALS).some(l => Number(l) !== currentLevel && MAP_DEFS[Number(l)]);
}

/**
 * Teleporta um jogador para (spawnX, spawnZ) em targetLevel. Espelha o bloco de
 * transição por borda, mas com destino explícito. Assume que já foi validado.
 */
function teleportPlayerToMap(p, targetLevel, spawnX, spawnZ) {
  const targetDef = MAP_DEFS[targetLevel];
  if (!targetDef) return false;
  const fromLevel  = p.mapLevel || 1;
  const targetSize = targetDef.size;
  const clamp      = targetSize / 2 - 40;
  p.x = Math.max(-clamp, Math.min(clamp, spawnX));
  p.z = Math.max(-clamp, Math.min(clamp, spawnZ));
  p.mapLevel = targetLevel;
  _notifyWantedHunters(p);

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
  const bpKts   = targetDef.boss?.killsToSpawn ?? 10;
  const bpTot   = getMapKills(targetLevel);
  const bpAlive = getMapBossAlive(targetLevel);
  console.log(`🌀 ${p.name}: passagem antiga ${fromLevel} → ${targetLevel}`);
  sendTo(p.ws, {
    type:    'map_transition',
    toLevel: targetLevel,
    mapDef:  targetDef,
    mapSize: targetSize,
    x:       p.x,
    z:       p.z,
    mapXp:   p.mapXp || 0,
    npcs:    entrySnapshot(targetMgr),
    bossProgress: targetDef.boss
      ? (bpKts === 0
          ? { current: 0, needed: 0, mapLevel: targetLevel, bossAlive: bpAlive }
          : { current: bpTot % bpKts, needed: bpKts, mapLevel: targetLevel, bossAlive: bpAlive })
      : null,
    dailyMissions: targetLevel === 4 ? buildDailyMissions(p) : undefined,
    wrecks: wreckManager.snapshot(targetLevel),
    spoils: spoilManager.snapshot(targetLevel),
  });
  return true;
}

/** Handler do pedido de teleporte por passagem antiga. Valida e teleporta. */
function handleArchTeleport(p) {
  if (!p || p.dead) return;
  const now = Date.now();
  const sinceCombat = now - (p.lastCombatTime || 0);
  if (sinceCombat < ARCH_COMBAT_COOLDOWN_MS) {
    const wait = Math.ceil((ARCH_COMBAT_COOLDOWN_MS - sinceCombat) / 1000);
    sendTo(p.ws, { type: 'teleport_arch_denied', reason: 'combat', wait });
    return;
  }
  if (!isNearArch(p)) {
    sendTo(p.ws, { type: 'teleport_arch_denied', reason: 'not_near' });
    return;
  }
  const dest = pickArchDestination(p.mapLevel, p.mapXp);
  if (!dest) {
    // Sem destino: por falta de XP (há arcadas, mas todas exigem mais) ou nenhuma
    const reason = hasOtherArch(p.mapLevel) ? 'xp' : 'no_dest';
    sendTo(p.ws, { type: 'teleport_arch_denied', reason });
    return;
  }
  teleportPlayerToMap(p, dest.level, dest.x, dest.z);
}

// ── Correio entre jogadores ───────────────────────────────────────────────────
const DEV_NAME            = 'Bagatinha';  // destinatário padrão (feedback ao dev)
const MAIL_TITLE_MAX      = 120;
const MAIL_BODY_MAX       = 2000;
const MAIL_MIN_INTERVAL_MS = 3000;        // anti-spam entre envios do mesmo jogador

/** Jogador ONLINE com esse nome (para notificação ao vivo). null se offline. */
function _findOnlinePlayerByName(name) {
  for (const p of players.values()) {
    if (p && p.name === name) return p;
  }
  return null;
}

async function handleMailSend(p, msg) {
  const to    = String(msg.toName || '').trim();
  const title = String(msg.title  || '').trim().slice(0, MAIL_TITLE_MAX);
  const body  = String(msg.body   || '').trim().slice(0, MAIL_BODY_MAX);
  if (!to || !title || !body) { sendTo(p.ws, { type: 'mail_error', reason: 'empty' }); return; }

  const now = Date.now();
  if (now - (p._lastMailAt || 0) < MAIL_MIN_INTERVAL_MS) {
    sendTo(p.ws, { type: 'mail_error', reason: 'rate' });
    return;
  }
  try {
    // Destinatário precisa existir — exceto o dev (canal de feedback sempre válido)
    if (to !== DEV_NAME && !(await db.playerExists(to))) {
      sendTo(p.ws, { type: 'mail_error', reason: 'not_found', toName: to });
      return;
    }
    p._lastMailAt = now;
    await db.sendMail(p.name, to, title, body);
    sendTo(p.ws, { type: 'mail_sent', toName: to });
    // Notifica o destinatário se estiver online
    const online = _findOnlinePlayerByName(to);
    if (online && online.ws && online.ws !== p.ws) {
      sendTo(online.ws, { type: 'mail_notify', fromName: p.name, title });
    }
  } catch (err) {
    console.error('[MAIL] send error:', err);
    sendTo(p.ws, { type: 'mail_error', reason: 'server' });
  }
}

async function handleMailInbox(p) {
  try {
    sendTo(p.ws, { type: 'mail_inbox', mails: await db.getInbox(p.name) });
  } catch (err) {
    console.error('[MAIL] inbox error:', err);
    sendTo(p.ws, { type: 'mail_inbox', mails: [] });
  }
}

async function handleMailContacts(p) {
  try {
    const sent = await db.getSentContacts(p.name);
    // "Bagatinha" sempre primeiro (padrão), sem duplicar
    const contacts = [DEV_NAME, ...sent.filter(n => n !== DEV_NAME)];
    sendTo(p.ws, { type: 'mail_contacts', contacts });
  } catch (err) {
    console.error('[MAIL] contacts error:', err);
    sendTo(p.ws, { type: 'mail_contacts', contacts: [DEV_NAME] });
  }
}

async function handleMailSearch(p, msg) {
  const q = String(msg.q || '').trim();
  if (q.length < 1) { sendTo(p.ws, { type: 'mail_search_result', q, names: [] }); return; }
  try {
    sendTo(p.ws, { type: 'mail_search_result', q, names: await db.searchPlayerNames(q, 20) });
  } catch (err) {
    console.error('[MAIL] search error:', err);
    sendTo(p.ws, { type: 'mail_search_result', q, names: [] });
  }
}

async function handleMailRead(p, msg) {
  const id = Number(msg.id) || 0;
  if (!id) return;
  try { await db.markMailRead(id, p.name); }
  catch (err) { console.error('[MAIL] read error:', err); }
}

// WebSocket
wss.on('connection', (ws) => {
  console.log('Client connected');
  let player = null;

  ws.isAlive = true;
  ws._openedAt = Date.now();
  // Estado do anti-flood (token bucket)
  ws._rlTokens     = WS_MSG_BUCKET_CAP;
  ws._rlLast       = Date.now();
  ws._rlViolations = 0;
  ws.on('pong', () => { ws.isAlive = true; });

  // ── Sem este handler o processo INTEIRO cai ────────────────────────────────
  // O `ws` faz `websocket.emit('error', err)` em erro de protocolo/frame, e um
  // 'error' de EventEmitter sem ouvinte vira exceção não tratada. Como não há
  // `process.on('uncaughtException')` aqui, um frame malformado de UM cliente
  // derrubava o servidor de todo mundo.
  ws.on('error', (err) => {
    console.error(`[WS] erro na conexão de "${player?.name || 'sem login'}":`, err.message);
  });

  ws.on('message', async (raw) => {
    // ── Anti-flood: recarrega tokens e descarta excesso ──────────────────────
    const _rlNow = Date.now();
    ws._rlTokens = Math.min(
      WS_MSG_BUCKET_CAP,
      ws._rlTokens + ((_rlNow - ws._rlLast) / 1000) * WS_MSG_REFILL_RATE
    );
    ws._rlLast = _rlNow;
    if (ws._rlTokens < 1) {
      if (++ws._rlViolations > WS_MSG_MAX_VIOLATIONS) {
        console.warn(`[SECURITY] Flood de "${player?.name || 'desconhecido'}" — encerrando conexão`);
        return ws.terminate();
      }
      return; // descarta a mensagem excedente
    }
    ws._rlTokens -= 1;
    ws._rlViolations = 0;
    _serverMetrics.messagesReceived++;

    try {
      const msg = JSON.parse(raw);
      // Mensagens permitidas antes do login (fluxo de conta)
      const PRE_LOGIN = msg.type === 'login' || msg.type === 'register'
        || msg.type === 'forgot_password' || msg.type === 'reset_password';
      if (!player && !PRE_LOGIN) return;

      switch (msg.type) {

        case 'login': {
          const result = await handleLogin(ws, msg);
          if (result) player = result; // null = auth/DB falhou, cliente recebeu erro
          break;
        }

        case 'register': {
          if (player) break; // já logado nesta conexão
          const result = await handleRegister(ws, msg);
          if (result) player = result;
          break;
        }

        case 'forgot_password': {
          if (!player) await handleForgotPassword(ws, msg);
          break;
        }

        case 'reset_password': {
          if (!player) await handleResetPassword(ws, msg);
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

        // ── Cliente perdeu o `full` de alguma entidade ──────────────────────
        // O AOI manda o registro completo UMA vez, na entrada da visão; depois
        // dela só vai a tupla slim, que o cliente descarta se não conhecer o id.
        // Quando isso acontece a entidade fica invisível PARA SEMPRE — viva,
        // mirando e batendo. O cliente detecta o slim órfão e pede o reenvio
        // aqui (main.gd::_request_aoi_resync, estrangulado a 2 s).
        case 'aoi_resync': {
          if (!player) break;
          stateBuilder.resetViewer(player);
          player._aoiLastCd = undefined;   // força o próprio barco a ir completo
          break;
        }

        case 'input': {
          player.input = { w: !!msg.w, a: !!msg.a, s: !!msg.s, d: !!msg.d };
          // Any WASD key press cancels a pending click-to-move target
          if (msg.w || msg.a || msg.s || msg.d) player.moveTarget = null;
          break;
        }

        case 'set_peaceful': {
          // Modo pesca: jogador fica invisível para NPCs enquanto pescar
          player.isPeaceful = !!msg.peaceful;
          break;
        }

        case 'set_difficulty': {
          // Troca a dificuldade do jogador (afeta escala dos NPCs + recompensas).
          // Só permitido FORA de combate e se a dificuldade já estiver desbloqueada.
          const idx = msg.difficulty | 0;
          const def = difficultyDef(idx);
          if (!DIFFICULTIES[idx]) {
            sendTo(ws, { type: 'difficulty_error', reason: 'invalid' });
            break;
          }
          if (!isDifficultyUnlocked(idx, player.npcKills || 0)) {
            sendTo(ws, { type: 'difficulty_error', reason: 'locked', reqKills: def.reqKills, difficulty: player.difficulty || 0 });
            break;
          }
          if (Date.now() - (player.lastCombatTime || 0) < 6000) {
            sendTo(ws, { type: 'difficulty_error', reason: 'in_combat', difficulty: player.difficulty || 0 });
            break;
          }
          player.difficulty = idx;
          sendTo(ws, { type: 'difficulty_set', difficulty: idx });
          db.save(player, true).catch(e => console.error('Save error (difficulty):', e));
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
          // boatVisit: abriu as missões perto do Barco de Missões
          if (missionBoatManager.isPlayerNear(player)) {
            progressDailyMission(player, 'boatVisit', 1);
          }
          sendTo(player.ws, { type: 'daily_missions', missions: buildDailyMissions(player) });
          break;
        }

        case 'get_ranking': {
          if (!player) break;
          handleGetRanking(player, msg);
          break;
        }

        case 'mail_send':     { if (player) handleMailSend(player, msg);  break; }
        case 'mail_inbox':    { if (player) handleMailInbox(player);      break; }
        case 'mail_contacts': { if (player) handleMailContacts(player);   break; }
        case 'mail_search':   { if (player) handleMailSearch(player, msg); break; }
        case 'mail_read':     { if (player) handleMailRead(player, msg);  break; }

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

        // ── Zona Vermelha: saquear ruína de jogador afundado (tecla F) ──────
        case 'loot_wreck': {
          if (!player) break;
          wreckManager.tryLoot(player, String(msg.wreckId || ''));
          break;
        }

        // ── Espólio de abordagem (zona Red ou superior) ─────────────────────
        // DOIS pedidos, não três. `spoil_inspect` é só o farol 🟢🟡🔴 que o
        // cliente pinta no destroço quando o jogador chega perto — não conta
        // nada sobre o butim. `spoil_raid` é o F: aborda e, vencendo, saqueia
        // no mesmo gesto. Não existe estado "venci mas ainda não saqueei".
        case 'spoil_inspect': {
          if (!player) break;
          spoilManager.handleInspect(player, String(msg.spoilId || ''));
          break;
        }
        case 'spoil_raid': {
          if (!player) break;
          spoilManager.handleRaid(player, String(msg.spoilId || ''));
          break;
        }

        // ── Tripulação de piratas ───────────────────────────────────────────
        case 'pirate_board': {
          if (!player) break;
          pirateManager.handleBoard(player, msg);
          break;
        }
        case 'pirate_state_request': {
          if (!player) break;
          pirateManager.sendState(player);
          break;
        }

        // ── Diário do capitão ───────────────────────────────────────────────
        case 'journal_list': {
          if (!player) break;
          journalManager.sendList(player,
            Math.max(1, Math.min(200, Number(msg.limit || 60))),
            Number(msg.before || 0));
          break;
        }
        case 'battle_report': {
          if (!player) break;
          journalManager.sendReport(player, Number(msg.reportId || 0));
          break;
        }

        // ── Loja Geral (Comida de Pet, RUN, e o que vier) ───────────────────
        case 'buy_general_item': {
          if (!player) break;
          handleBuyGeneralItem(player, msg, ws);
          break;
        }

        case 'teleport_arch': {
          if (!player) break;
          handleArchTeleport(player);
          break;
        }

        // ── Borda do mapa: jogador confirmou a viagem (tecla no cliente) ────
        case 'confirm_map_transition': {
          if (!player || player.dead) break;
          const pend = player._pendingBorder;
          if (!pend) break;
          // Revalida no servidor: ainda precisa estar encostado NAQUELA borda.
          const _bLvl = player.mapLevel || 1;
          const _bDef = MAP_DEFS[_bLvl];
          // pend.from garante que o aviso não sobreviveu a um teleporte/respawn
          if (!_bDef || pend.from !== _bLvl) { clearBorderPrompt(player); break; }
          const _bTest = BORDER_TEST[pend.dir];
          if (!_bTest || !_bTest(player, (_bDef.size / 2) - BORDER_EDGE)) {
            clearBorderPrompt(player);
            break;
          }
          applyBorderTransition(player, pend.dir, pend.target);
          break;
        }

        case 'request_respawn': {
          if (player && player.dead) {
            // ── Morte em mapa bônus: perde o mapa e volta ao normal ──────────
            if (MAP_DEFS[player.mapLevel]?.isBonusMap) {
              const bonusMapId = MAP_DEFS[player.mapLevel].bonusMapId;
              const returnLevel = player.preBonusMapLevel || 1;
              const returnX     = (Math.random() - 0.5) * getMapSize(returnLevel) * 0.5;
              const returnZ     = (Math.random() - 0.5) * getMapSize(returnLevel) * 0.5;

              // Remove o mapa bônus dos desbloqueados
              player.bonusMapsUnlocked = (player.bonusMapsUnlocked || []).filter(id => id !== bonusMapId);
              // Reseta mapPieces para o dungeon (exige farmar peças novamente)
              const mapDef = MAP_DEFS[player.mapLevel];
              const bonusDef = BONUS_MAPS.find(m => m.id === bonusMapId);
              if (bonusDef && player.mapPieces) {
                player.mapPieces[bonusDef.pieceId] = 0;
              }
              player.dead     = false;
              player._deathResolved = false;   // libera a próxima morte (resolvePlayerDeath)
              player.hp       = Math.max(1, Math.floor((player.maxHp || 100) * 0.10));
              player.mapLevel = returnLevel;
              player.x        = returnX;
              player.z        = returnZ;
              player.speed    = 0;
              player.input    = { w: false, a: false, s: false, d: false };
              delete player.preBonusMapLevel;
              delete player.preBonusX;
              delete player.preBonusZ;

              ensureManagersForMap(returnLevel);
              const retMgr    = getMapManager(returnLevel);
              const retMapDef = MAP_DEFS[returnLevel];
              db.save(player, true).catch(e => console.error('Save error (bonus death):', e));
              sendTo(ws, {
                type:             'map_transition',
                toLevel:          returnLevel,
                mapDef:           retMapDef,
                mapSize:          retMapDef.size,
                x:                returnX,
                z:                returnZ,
                mapXp:            player.mapXp || 0,
                npcs:             entrySnapshot(retMgr),
                bossProgress:     retMapDef.boss
                  ? { current: 0, needed: retMapDef.boss.killsToSpawn ?? 10, mapLevel: returnLevel, bossAlive: getMapBossAlive(returnLevel) }
                  : null,
                bonusDied:        true,
                bonusMapsUnlocked: player.bonusMapsUnlocked,
                mapPieces:         player.mapPieces || {},
              });
              console.log(`💀 ${player.name} morreu no mapa bônus → volta ao mapa ${returnLevel}, perdeu ${bonusMapId}`);
              break;
            }

            // ── Respawn normal ────────────────────────────────────────────────
            const mapSize = getMapSize(player.mapLevel || 1);
            player.hp             = Math.max(1, Math.floor((player.maxHp || 100) * 0.10));
            player.dead           = false;
            player._deathResolved = false;   // libera a próxima morte (resolvePlayerDeath)
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
            // ── Imunidade pós-respawn: 30 s de safe period ──────────────────
            const SAFE_MS = 30000;
            player.safeUntil = Date.now() + SAFE_MS;
            sendTo(ws, { type: 'respawn', x: player.x, z: player.z, hp: player.hp, maxHp: player.maxHp });
            sendTo(ws, { type: 'cannon_state', charges: totalCharges, maxCharges: totalCharges, cooldown: 0, cooldownMax: player.cannonCooldownMax, homingCharges: 0 });
            sendTo(ws, { type: 'safe_period', duration: SAFE_MS });
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

        case 'chat_send': {
          if (!player) break;
          handleChatSend(player, msg);
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

        case 'unlock_bonus_map': {
          if (!player) break;
          handleUnlockBonusMap(player, msg, ws);
          break;
        }

        case 'enter_bonus_map': {
          if (!player) break;
          handleEnterBonusMap(player, msg, ws);
          break;
        }

        case 'leave_bonus_map':
        case 'leave_dungeon': {
          if (!player) break;
          handleLeaveBonusMap(player, ws);
          break;
        }

        case 'bank_deposit': {
          if (!player) break;
          handleBankDeposit(player, msg, ws);
          break;
        }

        case 'bank_withdraw': {
          if (!player) break;
          handleBankWithdraw(player, msg, ws);
          break;
        }

        case 'sell_rare_ship': {
          if (!player) break;
          handleSellRareShip(player, msg, ws);
          break;
        }

        // ── Casa de leilões (mesma ilha do banco, mapa 7) ───────────────────
        // Os quatro handlers são async e cada um grava no banco antes de
        // responder. O `.catch` é obrigatório: sem ele, uma falha de MySQL
        // viraria unhandled rejection e derrubaria o processo inteiro por
        // causa de um lance.
        case 'auction_list': {
          if (!player) break;
          auctionManager.handleList(player);
          break;
        }

        case 'auction_create': {
          if (!player) break;
          auctionManager.handleCreate(player, msg)
            .catch(e => console.error('[Leilão] create:', e.message));
          break;
        }

        case 'auction_bid': {
          if (!player) break;
          auctionManager.handleBid(player, msg)
            .catch(e => console.error('[Leilão] bid:', e.message));
          break;
        }

        case 'auction_cancel': {
          if (!player) break;
          auctionManager.handleCancel(player, msg)
            .catch(e => console.error('[Leilão] cancel:', e.message));
          break;
        }

        case 'activate_bonus_ship':
        case 'equip_bonus_ship': {
          if (!player) break;
          handleActivateBonusShip(player, msg, ws);
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

        // ── TUTORIAL: cliente concluiu (ou pulou) o onboarding ─────────────
        case 'tutorial_complete': {
          if (!player) break;
          if ((player.tutorialState || 0) < 2) {
            player.tutorialState = 2;
            db.save(player, true).catch(e => console.error('Save error:', e));
          }
          break;
        }

        // ── RELIC: use (activate ability) ────────────────────────────────────
        case 'use_relic': {
          if (!player) break;
          handleUseRelic(player, msg);
          break;
        }

        // ── Mira contínua de relíquia canalizada ─────────────────────────────
        // Sopro Pútrido, Barragem Giratória e Jato do Pescoço re-miram a cada
        // tick. O cliente manda a posição do cursor enquanto a skill roda; o
        // motor lê a última mira em _resolveOnce. É só uma posição no mundo —
        // nenhum dano depende deste pacote, então não precisa de validação
        // além do descarte por idade (1 s) que o motor já faz.
        case 'relic_aim': {
          if (!player) break;
          const ax = Number(msg.x), az = Number(msg.z);
          if (!Number.isFinite(ax) || !Number.isFinite(az)) break;
          player._relicAim = { x: ax, z: az, t: Date.now() };
          break;
        }

        // ── TALENT: comprar um nível de talento ───────────────────────────────
        case 'buy_talent': {
          if (!player) break;
          handleBuyTalent(player, msg);
          break;
        }

        // ── TALENT: devolver UM nível (clique direito no nó) ─────────────────
        case 'refund_talent': {
          if (!player) break;
          handleRefundTalent(player, msg);
          break;
        }

        // ── TALENT: resetar todos os talentos e devolver pontos ─────────────
        case 'reset_talents': {
          if (!player) break;
          handleResetTalents(player);
          break;
        }

        // ── TALENT: os 3 slots de build ──────────────────────────────────────
        case 'save_talent_build': {
          if (!player) break;
          handleSaveTalentBuild(player, msg);
          break;
        }
        case 'load_talent_build': {
          if (!player) break;
          handleLoadTalentBuild(player, msg);
          break;
        }

        // ── Compra de comida para pets ────────────────────────────────────────
        case 'buy_pet_food': {
          if (!player) break;
          const foodId = String(msg.foodId || '');
          const qty    = Math.max(1, Math.min(999999, Math.floor(Number(msg.qty || 0))));
          // Preço é autoritativo no servidor — ignora msg.price do cliente
          const FOOD_PRICES_SRV = { uva: 30 };
          const unitPrice = FOOD_PRICES_SRV[foodId];
          if (!unitPrice || qty <= 0) {
            sendTo(ws, { type: 'pet_error', reason: 'Item inválido.' });
            break;
          }
          const totalCost = unitPrice * qty;
          if (player.gold < totalCost) {
            sendTo(ws, { type: 'pet_error', reason: `Gold insuficiente (precisa ${totalCost}, tem ${player.gold}).` });
            break;
          }
          player.gold -= totalCost;
          journalManager.ledger(player, JOURNAL_SRC.SHOP_PET_FOOD,
            { gold: -totalCost }, { detail: foodId, n: qty });
          if (!player.inventory) player.inventory = {};
          player.inventory[foodId] = (player.inventory[foodId] || 0) + qty;
          // Pet inativo por falta de comida volta à ativa automaticamente
          petManager.onFoodPurchased(player);
          sendTo(ws, {
            type:         'inventory_update',
            inventory:    player.inventory,
            gold:         player.gold,
            dobroes:      player.dobroes,
            notification: `🍖 +${qty}× ${foodId} adicionado ao inventário! (-${totalCost} 🪙)`,
          });
          db.save(player, true);
          console.log(`[Pet] ${player.name} comprou ${qty}x ${foodId} por ${totalCost}g`);
          break;
        }

        // ── Party ────────────────────────────────────────────────────────────
        case 'party_invite': {
          const targetId = String(msg.targetId || '');
          if (targetId) partyManager.handleInvite(player, targetId, players);
          break;
        }
        case 'party_accept': {
          const inviterId = String(msg.inviterId || '');
          if (inviterId) partyManager.handleAccept(player, inviterId, players);
          break;
        }
        case 'party_reject': {
          const inviterId = String(msg.inviterId || '');
          if (inviterId) partyManager.handleReject(player, inviterId, players);
          break;
        }
        case 'party_leave': {
          partyManager.handleLeave(player, players);
          break;
        }

        case 'equip_navio': {
          if (!player) break;
          handleEquipNavio(player, msg, ws);
          break;
        }

        // ── Pets ────────────────────────────────────────────────────────────
        case 'pet_equip':
        case 'pet_relic_equip':
        case 'pet_relic_unequip': {
          if (!player || !player._dbLoaded) break;
          petManager.handleMessage(player, msg);
          break;
        }

        // Pet usa relíquia OFENSIVA no alvo (validação no petManager, execução aqui)
        case 'pet_use_relic': {
          if (!player || !player._dbLoaded) break;
          handlePetUseRelic(player, msg);
          break;
        }

        // ── Localizador de pets (tecla 3) — leitura pura, sempre liberado ─────
        // Não é cheat: só informa onde estão pets já existentes no mundo.
        // O spawn de teste (debug_spawn_test_pets) também é liberado para
        // facilitar playtest — respeita o cap global e pets são de todos.
        case 'debug_list_pets':
        case 'debug_spawn_test_pets': {
          if (!player || !player._dbLoaded) break;
          petManager.handleMessage(player, msg);
          break;
        }

        // ── Debug/cheat commands — só quando ALLOW_DEBUG_CMDS=1 ───────────────
        case 'debug_spawn_pet':
        case 'debug_give_food':
        case 'debug_level_pet': {
          if (!player || !player._dbLoaded) break;
          if (!ALLOW_DEBUG_CMDS) {
            console.warn(`[SECURITY] '${msg.type}' bloqueado de ${player.name} (ALLOW_DEBUG_CMDS off)`);
            break;
          }
          petManager.handleMessage(player, msg);
          break;
        }

      }
    } catch (e) {
      console.error('Message error:', e);
    }
  });

  ws.on('close', (code, reason) => {
    // O código é o que separa "fechou a janela" (1000/1001) de "o cliente não
    // aguentou o frame" (1009) e de "o TCP morreu" (1006). Sem ele, toda queda
    // tinha exatamente a mesma cara no log — que foi o motivo de a investigação
    // da desconexão de ~30s não ter por onde começar.
    const secs = ((Date.now() - ws._openedAt) / 1000).toFixed(1);
    const why  = code === 1009 ? ' ← FRAME GRANDE DEMAIS PARA O CLIENTE'
               : code === 1006 ? ' ← queda abrupta (sem frame de fecho)'
               : '';
    console.log(`[WS] close code=${code} reason="${reason || ''}" `
      + `player="${player?.name || 'sem login'}" apos ${secs}s${why}`);
    if (player) {
      // Fecha o extrato ANTES de tudo: o último minuto de abates ainda está
      // acumulado na memória do jogador e some junto com ele se não gravar.
      journalManager.flushPlayer(player, true);
      if (player._dbLoaded) {
        db.save(player, true).catch(e => console.error('Save error:', e)); // persist on disconnect
      }
      partyManager.removePlayer(player.id, players);
      partyManager.clearInvites(player.id);
      addEvent({ type: 'player_leave', id: player.id });
      playerManager.remove(player.id);
      players.delete(player.id);
      console.log(`[-] ${player.name} left`);
    }
  });
});

// ── WebSocket handler functions ──────────────────────────────────────────────

async function handleLogin(ws, msg) {
  // ── Resolve o identificador: nome do pirata ou e-mail (contém '@') ─────────
  let loginName = String(msg.name || '').trim();
  if (loginName.includes('@')) {
    let resolved = null;
    try { resolved = await db.findNameByEmail(loginName.toLowerCase()); } catch (_) {}
    if (!resolved) {
      sendTo(ws, { type: 'auth_error', message: 'Nenhuma conta com este e-mail.' });
      return null;
    }
    loginName = resolved;
  }

  // Carrega a conta — o login NÃO cria mais conta nova (isso é papel do cadastro)
  let saved;
  try {
    saved = await db.load(loginName);
  } catch (err) {
    console.error(`[login] DB load failed for ${loginName}:`, err);
    sendTo(ws, { type: 'error', message: 'Erro ao carregar dados. Tente reconectar.' });
    return null;
  }
  if (!saved) {
    sendTo(ws, { type: 'auth_error', message: 'Conta não encontrada. Use "Criar conta" para começar.' });
    return null;
  }

  // ── Autenticação ────────────────────────────────────────────────────────────
  // Contas novas (cadastro) têm senha — a senha é a prova principal.
  // Contas legadas sem senha mantêm o TOFU por token de dispositivo e ganham
  // senha no primeiro login pelo cliente novo (protegido pelo token).
  const password     = (typeof msg.password === 'string') ? msg.password : '';
  const provided     = (typeof msg.secret === 'string' && msg.secret.length >= 8) ? msg.secret : null;
  const providedHash = provided ? hashSecret(provided) : null;

  if (saved.passwordHash) {
    let passOk = false;
    try { passOk = password !== '' && await verifyPassword(password, saved.passwordHash); } catch (_) {}
    if (!passOk) {
      console.warn(`[SECURITY] Login negado para "${loginName}" (senha incorreta)`);
      sendTo(ws, { type: 'auth_error', message: 'Senha incorreta.' });
      return null;
    }
    // Senha correta ⇒ (re)vincula o token deste dispositivo (permite trocar de PC)
    if (providedHash && providedHash !== saved.secretHash) {
      db.setSecretHash(loginName, providedHash).catch(() => {});
    }
  } else {
    if (saved.secretHash) {
      if (!providedHash || providedHash !== saved.secretHash) {
        console.warn(`[SECURITY] Login negado para "${loginName}" (token inválido/ausente)`);
        sendTo(ws, { type: 'auth_error', message: 'Nome já registrado em outro dispositivo.' });
        return null;
      }
    } else if (providedHash) {
      try {
        await db.setSecretHash(loginName, providedHash);
        console.log(`🔐 Token vinculado à conta "${loginName}"`);
      } catch (e) {
        console.error(`[login] setSecretHash falhou para ${loginName}:`, e);
      }
    }
    // Upgrade de conta legada: a primeira senha digitada vira a senha da conta.
    if (password.length >= 6 && password.length <= 64) {
      try {
        await db.setPassword(loginName, await hashPassword(password));
        console.log(`🔐 Senha definida para conta legada "${loginName}"`);
      } catch (e) {
        console.error(`[login] setPassword falhou para ${loginName}:`, e);
      }
    }
  }

  const player = playerManager.create(ws, loginName);
  player._dbLoaded = false;
  players.set(player.id, player);

  // ── Sessão única: derruba conexão anterior de mesmo nome (anti-dupe) ────────
  for (const [pid, other] of players) {
    if (pid === player.id || other.name !== player.name) continue;
    console.log(`[login] Derrubando sessão anterior de "${player.name}"`);
    try { sendTo(other.ws, { type: 'kicked', message: 'Sua conta entrou em outra sessão.' }); } catch (_) {}
    if (other._dbLoaded) db.save(other, true).catch(() => {});
    partyManager.removePlayer(other.id, players);
    partyManager.clearInvites(other.id);
    playerManager.remove(other.id);
    players.delete(other.id);
    try { other.ws?.terminate?.(); } catch (_) {}
  }

  // Garante que os managers do mapa do jogador existam
  ensureManagersForMap(saved.mapLevel || 1);

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
    bala_cura:       0,
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
  // Talentos — as árvores novas usam ids próprios (atk_/def_/res_/mob_), então
  // um save do sistema antigo entra aqui com 10 chaves que não existem mais.
  // migrateLegacyTalents apaga essas chaves e devolve o total como pontos livres.
  player.talents       = saved.talents || { totalSpent: 0 };
  player.talentBuilds  = Array.isArray(saved.talentBuilds) ? saved.talentBuilds : [];
  const refunded       = _migrateLegacyTalents(player, LEGACY_TALENT_MAP);
  if (refunded > 0) {
    console.log(`[TALENTOS] ${player.name}: ${refunded} ponto(s) do sistema antigo devolvidos`);
  }
  // Talentos aposentados (a revisão da árvore de Recurso tirou os que
  // prometiam bônus sobre sistemas que o jogo não tem). Sem esta devolução os
  // pontos parariam de fazer efeito mas continuariam encarecendo as compras
  // seguintes, porque `totalSpent` não sabe que o nó saiu.
  const devolvidos = _refundRemovedTalents(player, TALENT_DEFS);
  if (devolvidos > 0) {
    console.log(`[TALENTOS] ${player.name}: ${devolvidos} ponto(s) de talentos aposentados devolvidos`);
  }
  player.npcKills      = saved.npcKills      || 0;
  player.pvpKills      = saved.pvpKills      || 0;
  player.difficulty    = saved.difficulty    || 0;
  // Tutorial: contas veteranas (≥20 abates) pulam o onboarding — e não recebem
  // a relíquia de brinde, que é recompensa do primeiro abate de novato.
  player.tutorialState = saved.tutorialState || 0;
  if (player.tutorialState === 0 && player.npcKills >= 20) player.tutorialState = 2;
  // Treino AFK: sem isto o estado só existia em memória e um restart do servidor
  // deixava o jogador preso no mapa 5 — a torre seguia atirando (só checa
  // mapLevel), mas sem afkTraining não havia afk_started nem expiração, e o
  // cliente nunca ligava o auto-ataque/auto-relíquia. _afkFromMap não é
  // persistido: o retorno cai no default (mapa 4), que é de onde se compra treino.
  player.afkUntil      = saved.afkUntil || null;
  player.afkTraining   = !!saved.afkTraining;
  player.gender        = saved.gender || '';
  player.email         = saved.email  || '';
  player.mapXp         = saved.mapXp         || 0;
  player.mapLevel      = saved.mapLevel      || 1;
  // Se deslogou dentro de um mapa bônus (isBonusMap), retorna ao mapa regular
  if (player.mapLevel >= 7 && MAP_DEFS[player.mapLevel]?.isBonusMap) {
    player.mapLevel = 1;
    player.x = 0;
    player.z = 0;
  }
  player.mapFragments  = saved.mapFragments  || 0;
  // Bônus de talento + vida, canhões e mana derivados deles. `hp` entra como o
  // valor salvo e sai clampado no maxHp que acabou de ser calculado.
  player.hp = saved.hp != null ? saved.hp : Infinity;
  refreshTalentDerived(player, { fillMana: true });
  // Relics
  player.inventory.relics = saved.inventory.relics || [];
  const shipReliqC = SHIP_RELIQC[savedShipId] || {};
  // `filter(Boolean)` aqui COMPACTAVA o deck no login: quem guardou só o slot do
  // E acordava com ela no Q. O vazio tem de sobreviver ao save/load.
  player.relicDeck = _normalizeDeck(saved.equipped.relics, shipReliqC.maxHelic ?? 8);
  // maxMana e mana já vieram de refreshTalentDerived, com o Reservatório Arcano.
  player.maxRelics = shipReliqC.maxHelic ?? 4;
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
  // Migração: quem comprou o antigo "+30 de Alcance" (`rn`) recebe a Pontaria
  // Mortal (`cr`) no lugar — mesmo slot, mesmo dinheiro já pago. Sem isto o
  // upgrade sumia do canhão em silêncio no primeiro login depois da troca.
  for (const u of player.cannonUpgradesData) {
    if (u && u.rn) { u.cr = 1; u.rn = 0; }
  }
  player.ironPlates          = saved.ironPlates          || 0;
  player.goldDust            = saved.goldDust            || 0;
  player.gunpowder           = saved.gunpowder           || 0;
  player.bonusMapsUnlocked   = saved.bonusMapsUnlocked   || [];
  player.mapPieces           = saved.mapPieces           || {};
  player.bonusShips     = saved.bonusShips     || [];
  // Deduplicar por tipo ao carregar — garante no máximo 1 entrada por tipo de navio
  const rawInv = saved.bonusInventory || [];
  const invByType = new Map();
  for (const s of rawInv) {
    const t = s.id || s.modelKey;
    if (!invByType.has(t)) invByType.set(t, s); // mantém o primeiro (mais antigo = já ativo)
  }
  player.bonusInventory = Array.from(invByType.values());
  player.bankGold            = saved.bankGold            || 0;
  player.bankUnlocked        = saved.bankUnlocked        || false;
  player.cannonResearchLevel = saved.cannonResearchLevel || 0;
  player.shipMaterialLevel   = saved.shipMaterialLevel   || 0;
  // ── Pets — sem isso o pet "some" a cada relogin (o _parse retorna mas
  //    ninguém aplicava no player; mesma classe de bug do bonusShips) ────────
  player.ownedPets   = saved.ownedPets   || [];
  player.equippedPet = saved.equippedPet || '';
  player.petLevels   = saved.petLevels   || {};
  player.petXp       = saved.petXp       || {};
  player.petRelics   = saved.petRelics   || {};
  player.inventory.uva = Number(saved.petFood || 0);   // comida (coluna pet_food)
  player.inventory.run = Number(saved.runStock || 0);  // RUN da tripulação (coluna run_stock)
  // Pad cannonUpgradesData to match inventory.cannons length
  while (player.cannonUpgradesData.length < player.inventory.cannons.length) {
    player.cannonUpgradesData.push({ as: 0, cr: 0, dm: 0 });
  }

  // Pré-carrega os stats do navio bônus ANTES do trim — o limite de canhões
  // tem de ser o do bônus, senão o trim corta o que o jogador tinha equipado.
  player.activeBonusShipStats = saved.activeBonusShipStats || null;
  if (player.activeBonusShipStats) {
    const ship = player.activeBonusShipStats;
    player.activeShip = ship.modelKey || ship.id || player.activeShip;
    refreshTalentDerived(player);
  }

  // Restore equipped cannons from DB (what was equipped last session)
  const savedEquipped = saved.equipped?.cannons || [];
  player.cannons = savedEquipped.filter(cid => player.inventory.cannons.includes(cid));
  // If nothing equipped, equip up to 3 starter cannons from inventory (respect ship limit later)
  if (player.cannons.length === 0) {
    player.cannons = (player.inventory.cannons || []).slice(0, 3);
  }
  // Enforce ship cannon limit (maxCannons já correto para navios bônus)
  player.cannons = _trimCannons(player.cannons, player.maxCannons).cannons;
  player.pirates = saved.equipped?.pirates || [];
  // Vagas de curandeiro do navio ativo — e corta o excedente de um save antigo
  // feito num navio maior.
  refreshHealerSlots(player);
  recalcCannons(player);
  applySkillMultipliers(player); // also calls recalcMaxHp internally

  // Restaura HP/stats completos do navio bônus APÓS applySkillMultipliers
  // (applySkillMultipliers chama recalcMaxHp internamente — sobrescreveria o maxHp do bônus)
  if (player.activeBonusShipStats) {
    const ship = player.activeBonusShipStats;
    player.hp = saved.hp != null ? saved.hp : Infinity;   // refresh clampa no maxHp
    refreshTalentDerived(player);
    console.log(`[BONUS SHIP] Restaurado: "${ship.name}" → maxHp=${player.maxHp}, maxCannons=${player.maxCannons}`);
  }

  // Quem saiu do jogo afundado voltava com 0 de vida (o `hp` é persistido) e
  // navegava assim até o próximo golpe. Volta com a vida de um respawn — e
  // assim a rede de segurança do tick não o afunda no instante do login.
  if (!(player.hp > 0)) {
    player.hp   = Math.max(1, Math.floor((player.maxHp || 100) * 0.10));
    player.dead = false;
  }
  player._deathResolved = false;

  // All DB data is now applied — safe for periodic saves
  player._dbLoaded = true;

  // Entregas do leilão que venceram com o jogador offline (ouro de venda,
  // navio arrematado, navio devolvido, reembolso de lance superado). Tem de
  // rodar ANTES do payload do init: o que chega aqui muda `gold` e
  // `bonusShips`, e os dois são lidos logo abaixo.
  await auctionManager.onPlayerJoined(player);

  const initShots = salvoCount(player);
  const initZone    = player.mapLevel || 1;
  ensureManagersForMap(initZone); // garante managers ativos para o mapa inicial do jogador
  // Idem entrySnapshot(): com AOI a lista vai vazia e o primeiro broadcast
  // preenche só quem está no alcance de visão.
  const initPlayers = AOI_ENABLED ? [] : playerManager.snapshot()
    .filter(ps => (ps.mapLevel || 1) === initZone);
  sendTo(ws, {
    type:             'init',
    serverNow:        Date.now(),   // client uses this to compensate clock skew
    worldTime:        worldTimeHour, // hora atual do jogo (0–24) para sincronizar dia/noite
    bloodMoon:        bloodMoonActive, // entrar no meio do evento já mostra a noite vermelha
    id:               player.id,
    hp:               player.hp,
    maxHp:            player.maxHp,
    x:                player.x,
    z:                player.z,
    mapSize:          (MAP_DEFS[initZone] && MAP_DEFS[initZone].size),
    npcs:             MAP_DEFS[initZone]?.isTrainingMap ? [] : entrySnapshot(getMapManager(initZone) || npcManager),
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
    maxHealers:       player.maxHealers,
    inventory:        player.inventory,
    skills:   player.skills,
    npcKills:   player.npcKills || 0,
    pvpKills:   player.pvpKills || 0,   // ficha do capitão (aba Status)
    // Prateleira da Loja Geral. O cliente não conhece item nenhum pelo nome:
    // a lista inteira vem daqui (constants/shop.js).
    generalShop: SHOP.gerais,
    difficulty:   player.difficulty || 0,
    difficulties: DIFFICULTIES,
    tutorialState: player.tutorialState || 0,
    gender:     player.gender || '',
    mapXp:      player.mapXp    || 0,
    mapLevel:   player.mapLevel || 1,
    mapXpNeeded: (MAP_DEFS[player.mapLevel || 1] || MAP_DEFS[1]).xpToAdvance || 99999,
    mapDef:       MAP_DEFS[player.mapLevel || 1] || MAP_DEFS[1],
    weather:      weatherManager.get(player.mapLevel || 1),
    bossProgress: (() => {
      const lvl  = player.mapLevel || 1;
      const bdef = (MAP_DEFS[lvl] || MAP_DEFS[1]).boss;
      if (!bdef) return null;
      const kts   = bdef.killsToSpawn ?? 0;
      const tot   = getMapKills(lvl);
      const alive = getMapBossAlive(lvl);
      return kts === 0
        ? { current: 0, needed: 0, mapLevel: lvl, bossAlive: alive }
        : { current: tot % kts, needed: kts, mapLevel: lvl, bossAlive: alive };
    })(),
    mapFragments: player.mapFragments || 0,
    activeShip: player.activeShip,    // espelhado no top-level para _get_or_create
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
    talentBuilds:        _normalizeBuilds(player),
    shipIslandUpgrades:  player.shipIslandUpgrades || { hp: 0, defense: 0, damage: 0 },
    cannonUpgradesData:  player.cannonUpgradesData || [],
    ironPlates:          player.ironPlates          || 0,
    goldDust:            player.goldDust            || 0,
    gunpowder:           player.gunpowder           || 0,
    bonusMapsUnlocked:   player.bonusMapsUnlocked   || [],
    mapPieces:           player.mapPieces           || {},
    rareShips:             player.bonusShips             || [],
    bonusInventory:        player.bonusInventory         || [],
    activeBonusInstanceId: player.activeBonusShipStats?.instanceId || '',
    bankGold:              player.bankGold                || 0,
    bankUnlocked:        player.bankUnlocked        || false,
    wrecks:              wreckManager.snapshot(player.mapLevel || 1),  // ruínas ativas (zona vermelha)
    spoils:              spoilManager.snapshot(player.mapLevel || 1),  // espólios de abordagem (zona red+)
    cannonResearchLevel: player.cannonResearchLevel || 0,
    shipMaterialLevel:   player.shipMaterialLevel   || 0,
    // ── Pets ────────────────────────────────────────────────────────────────
    ...petManager.injectInitData(player),
    // ── Piratas ─────────────────────────────────────────────────────────────
    ...pirateManager.injectInitData(player),
    // ── Casa de leilões ─────────────────────────────────────────────────────
    ...auctionManager.injectInitData(player),
    bossProgress: (() => {
      if (MAP_DEFS[initZone]?.isTrainingMap) return null; // mapa de treino: sem boss
      const kts = MAP_DEFS[initZone]?.boss?.killsToSpawn ?? 10;
      if (kts === 0) return { current: 0, needed: 0, mapLevel: initZone, bossAlive: getMapBossAlive(initZone) };
      const tot   = getMapKills(initZone);
      const alive = getMapBossAlive(initZone);
      return { current: tot % kts, needed: kts, mapLevel: initZone, bossAlive: alive };
    })(),
  });

  // Notifica PetManager que jogador entrou (envia pets selvagens do mapa)
  petManager.onPlayerJoined(player);
  // Corta o excesso de peso no porão e apura a RUN da tripulação
  pirateManager.onPlayerJoined(player);

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

// ── Cadastro: nome no jogo + e-mail + senha + sexo ───────────────────────────
async function handleRegister(ws, msg) {
  const name     = String(msg.name || '').trim();
  const email    = String(msg.email || '').trim().toLowerCase();
  const password = (typeof msg.password === 'string') ? msg.password : '';
  const gender   = (msg.gender === 'F') ? 'F' : (msg.gender === 'M' ? 'M' : null);

  const fail = (message) => { sendTo(ws, { type: 'register_error', message }); return null; };

  if (name.length < 2)    return fail('Nome muito curto (mínimo 2 caracteres).');
  if (name.length > 20)   return fail('Nome muito longo (máximo 20 caracteres).');
  if (name.includes('@')) return fail('O nome não pode conter "@".');
  if (!EMAIL_RE.test(email) || email.length > 254) return fail('E-mail inválido.');
  if (password.length < 6)  return fail('A senha precisa de pelo menos 6 caracteres.');
  if (password.length > 64) return fail('Senha muito longa (máximo 64 caracteres).');
  if (!gender)              return fail('Escolha o sexo do pirata.');

  try {
    if (await db.load(name))            return fail('Este nome já está em uso.');
    if (await db.findNameByEmail(email)) return fail('Este e-mail já tem uma conta.');
    await db.createAccount({ name, email, passwordHash: await hashPassword(password), gender });
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') return fail('Este nome já está em uso.');
    console.error('[register] Falha ao criar conta:', err);
    return fail('Erro ao criar a conta. Tente novamente.');
  }

  // Conta criada — entra direto no jogo com as mesmas credenciais
  return handleLogin(ws, { name, password, secret: msg.secret });
}

// ── Recuperação de senha: envia código de 6 dígitos por e-mail ───────────────
async function handleForgotPassword(ws, msg) {
  const email = String(msg.email || '').trim().toLowerCase();
  // Resposta sempre igual — não revela se o e-mail tem conta (anti-enumeração)
  const done = () => sendTo(ws, {
    type: 'recover_sent',
    message: 'Se este e-mail tiver uma conta, o código foi enviado. Confira a caixa de entrada (e o spam).',
  });

  if (!EMAIL_RE.test(email)) return done();
  const last = _recoveryCooldown.get(email) || 0;
  if (Date.now() - last < 60_000) return done(); // máx. 1 envio por minuto por e-mail
  _recoveryCooldown.set(email, Date.now());

  try {
    const name = await db.findNameByEmail(email);
    if (!name) return done();
    const code = String(crypto.randomInt(100000, 1000000)); // 6 dígitos
    await db.setResetCode(name, hashSecret(code), Date.now() + RESET_CODE_TTL_MS);
    _resetAttempts.delete(email);
    await sendRecoveryCode(email, code);
    console.log(`🔑 Código de recuperação gerado para "${name}"`);
  } catch (err) {
    console.error('[recover] Falha ao gerar código:', err);
  }
  return done();
}

// ── Recuperação de senha: valida o código e define a nova senha ──────────────
async function handleResetPassword(ws, msg) {
  const email    = String(msg.email || '').trim().toLowerCase();
  const code     = String(msg.code || '').trim();
  const password = (typeof msg.password === 'string') ? msg.password : '';
  const fail = (message) => sendTo(ws, { type: 'recover_error', message });

  if (password.length < 6)  return fail('A senha precisa de pelo menos 6 caracteres.');
  if (password.length > 64) return fail('Senha muito longa (máximo 64 caracteres).');

  try {
    const name  = EMAIL_RE.test(email) ? await db.findNameByEmail(email) : null;
    const saved = name ? await db.load(name) : null;
    const valid = saved && saved.resetCodeHash
      && Date.now() <= saved.resetExpires
      && hashSecret(code) === saved.resetCodeHash;

    if (!valid) {
      // Anti brute-force: após N códigos errados, invalida o código atual
      const tries = (_resetAttempts.get(email) || 0) + 1;
      _resetAttempts.set(email, tries);
      if (saved && tries >= RESET_MAX_ATTEMPTS) {
        await db.setResetCode(name, null, null);
        _resetAttempts.delete(email);
        console.warn(`[SECURITY] Código de recuperação invalidado por excesso de tentativas (${email})`);
      }
      return fail('Código inválido ou expirado. Peça um novo código.');
    }

    await db.resetPassword(name, await hashPassword(password));
    _resetAttempts.delete(email);
    console.log(`🔑 Senha redefinida para "${name}"`);
    sendTo(ws, { type: 'recover_ok', message: 'Senha redefinida! Entre com a nova senha.' });
  } catch (err) {
    console.error('[recover] Falha ao redefinir senha:', err);
    fail('Erro ao redefinir a senha. Tente novamente.');
  }
}

function handleGoldShieldCost(player, msg) {
  const amount = msg.amount || 0;

  // Gasta ouro do jogador
  if (player.gold >= amount) {
    player.gold -= amount;
    journalManager.accrue(player, JOURNAL_SRC.GOLD_SHIELD, { gold: -amount });

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
  // Atacar abre mão da imunidade pós-respawn — não dá pra atirar sob proteção.
  if (player.safeUntil && Date.now() < player.safeUntil) {
    player.safeUntil = 0;
    sendTo(player.ws, { type: 'safe_period_end' });
  }
  player.castExpires = Date.now() + 350; // 350ms cast penalty — player slows to 15% speed
  // Treino: concede XP de ataque por atirar na torre (sem NPCs para acertar)
  if (MAP_DEFS[player.mapLevel]?.isTrainingMap) {
    grantSkillXp(player, 'ataque', Math.max(1, Math.floor((player.cannonDamage || 10) / 5)), wss);
  }
}

function handleBuyCannon(player, msg, ws) {
  const def = CANNON_DEFS[msg.cannonId];
  if (!def) return;
  const qty       = Math.max(1, Math.min(99999, parseInt(msg.qty) || 1));
  const totalCost = def.price * qty;
  if (def.currency === 'gold') {
    if (player.gold < totalCost) { sendTo(ws, { type:'error', message:'Ouro insuficiente' }); return; }
    player.gold -= totalCost;
  } else {
    if (player.dobroes < totalCost) { sendTo(ws, { type:'error', message:'Dobrões insuficientes' }); return; }
    player.dobroes -= totalCost;
  }
  journalManager.ledger(player, JOURNAL_SRC.SHOP_CANNON,
    def.currency === 'gold' ? { gold: -totalCost } : { dobroes: -totalCost },
    { detail: def.name || msg.cannonId, n: qty });
  if (!player.cannonUpgradesData) player.cannonUpgradesData = [];
  for (let i = 0; i < qty; i++) {
    player.inventory.cannons.push(msg.cannonId);
    // Keep cannonUpgradesData in sync with inventory
    player.cannonUpgradesData.push({ as: 0, cr: 0, dm: 0 });
  }
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
    maxCannons:  player.maxCannons || MAX_CANNON_SLOTS,
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
    .slice(0, player.maxCannons || MAX_CANNON_SLOTS)
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
    maxCannons:  player.maxCannons || MAX_CANNON_SLOTS,
    charges:     shots,
    maxCharges:  shots,
    cooldown:    0,
    cooldownMax: player.cannonCooldownMax,
    range:       player.cannonRange,
    lifesteal:   player.cannonLifesteal,
  });
}

/**
 * Recalcula o porão de piratas do navio ativo e corta o excesso.
 *
 * Precisa rodar em TODA troca de navio: quem descia de um elite para uma
 * fragata continuaria navegando com uma tripulação que não cabe no porão.
 *
 * A régua era CONTAGEM de curandeiros (`maxHealers`) e passou a ser PESO — ver
 * managers/pirate-manager.js. `maxHealers` continua sendo preenchido porque o
 * armazém antigo do cliente ainda lê o campo; quem manda é a capacidade.
 *
 * @returns {number} quantos piratas desembarcaram
 */
function refreshHealerSlots(player) {
  player.maxHealers      = maxHealersFor(player.activeShip);
  player.pirateCapacity  = pirateManager.capacityOf(player);
  return pirateManager.refreshCapacity(player);
}

/**
 * `equip_pirate_sync` é o nome antigo do embarque, de quando só havia
 * curandeiros. Continua valendo — clientes não atualizados seguem funcionando —
 * e delega para o mesmo caminho que o `pirate_board` novo usa, que valida
 * estoque e peso.
 */
function handleEquipPirateSync(player, msg, ws) {
  pirateManager.handleBoard(player, msg);
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
  // missionsCompleted: completar OUTRA missão diária enquanto mission_streak está ativa
  if (missionId !== 'mission_streak') progressDailyMission(player, 'missionsCompleted', 1);
  db.save(player).catch(e => console.error('Save error:', e));
  journalManager.log(player, JOURNAL_KINDS.REWARD, {
    source:  'missao',
    gold:    def.reward.gold   || 0,
    dobroes: def.reward.dobrao || 0,
  });
  journalManager.ledger(player, JOURNAL_SRC.MISSION, {
    gold:    def.reward.gold   || 0,
    dobroes: def.reward.dobrao || 0,
  }, { detail: missionId });
  sendTo(player.ws, {
    type:     'daily_mission_claimed',
    id:       missionId,
    reward:   def.reward,
    gold:     player.gold,
    dobroes:  player.dobroes,
    missions: buildDailyMissions(player),
  });
}

// ── Ranking (Fase 1: xp, npc_kills, pvp_kills, pet) ─────────────────────────
async function handleGetRanking(player, msg) {
  const VALID = ['xp', 'npc_kills', 'pvp_kills', 'pet'];
  const category = VALID.includes(msg.category) ? msg.category : 'xp';
  try {
    const rankings = await db.getRankings();
    const list = rankings[category] || [];
    const myIdx = list.findIndex(e => e.name === player.name);
    sendTo(player.ws, {
      type:    'ranking',
      category,
      entries: list.slice(0, 50).map((e, i) => ({ rank: i + 1, ...e })),
      you:     myIdx >= 0 ? { rank: myIdx + 1, ...list[myIdx] } : null,
    });
  } catch (err) {
    console.error('[RANKING] Error building ranking:', err);
    sendTo(player.ws, { type: 'ranking', category, entries: [], you: null });
  }
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
    rewardGold:  100 * (p.npcKills || 0),
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
    // Piso garantido: presas com poucos/zero kills davam recompensa ZERO,
    // fazendo a caçada parecer "sem recompensa" ao matar o alvo.
    rewardGold:   Math.max(200, 100 * (wTarget.npcKills || 0)),
    rewardDobrao: Math.max(20,   10   * (wTarget.npcKills || 0)),
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
  // Recrutador (res_recrutador) desconta na contratação. O preço é calculado
  // aqui e não no cliente — que só desenha o valor que o servidor mandou.
  const price = Math.max(1, Math.round(item.price * fxTal.piratePriceMult(player)));
  if (item.currency === 'gold') {
    if (player.gold < price) { sendTo(ws, { type:'error', message:'Ouro insuficiente' }); return; }
    player.gold -= price;
  } else {
    if (player.dobroes < price) { sendTo(ws, { type:'error', message:'Dobrões insuficientes' }); return; }
    player.dobroes -= price;
  }
  journalManager.ledger(player, JOURNAL_SRC.SHOP_PIRATE,
    item.currency === 'gold' ? { gold: -price } : { dobroes: -price },
    { detail: item.name || msg.pirateId });
  if (!player.inventory) player.inventory = {};
  if (!player.inventory.pirates) player.inventory.pirates = [];
  player.inventory.pirates.push(msg.pirateId);
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(ws, { type:'inventory_update', inventory: player.inventory, gold: player.gold, dobroes: player.dobroes });
  pirateManager.sendState(player);
}

/**
 * Loja Geral — um handler para toda a prateleira de consumíveis.
 *
 * O catálogo é SHOP.gerais (constants/shop.js); pôr um item novo à venda é
 * acrescentar uma linha lá, sem tocar aqui. Preço e moeda são autoritativos do
 * servidor: `msg` só diz O QUE e QUANTOS.
 */
function handleBuyGeneralItem(player, msg, ws) {
  const item = SHOP.geraisMap[String(msg.itemId || '')];
  const qty  = Math.max(1, Math.min(999999, Math.floor(Number(msg.qty || 0))));
  if (!item || qty <= 0) {
    sendTo(ws, { type: 'error', message: 'Item inválido.' });
    return;
  }

  const total    = item.price * qty;
  const currency = item.currency === 'dobrao' ? 'dobroes' : 'gold';
  if ((player[currency] || 0) < total) {
    sendTo(ws, {
      type: 'error',
      message: `${item.currency === 'dobrao' ? 'Dobrões' : 'Ouro'} insuficiente (precisa ${total}).`,
    });
    return;
  }

  player[currency] -= total;
  journalManager.ledger(player, JOURNAL_SRC.SHOP_GENERAL,
    currency === 'gold' ? { gold: -total } : { dobroes: -total },
    { detail: item.name || item.id, n: qty });
  if (!player.inventory) player.inventory = {};
  player.inventory[item.id] = (player.inventory[item.id] || 0) + qty;

  // Gancho de reativação: comprar comida acorda o pet, comprar RUN acorda a
  // tripulação. Sem isso o jogador compraria e continuaria inativo até o
  // próximo tique de 60s.
  if (item.onBuy === 'pet')     petManager.onFoodPurchased(player);
  if (item.onBuy === 'pirates') pirateManager.onRunPurchased(player);

  sendTo(ws, {
    type:         'inventory_update',
    inventory:    player.inventory,
    gold:         player.gold,
    dobroes:      player.dobroes,
    notification: `${item.icon} +${qty}× ${item.name} (-${total} ${item.currency === 'dobrao' ? '🟡' : '🪙'})`,
  });
  db.save(player, true).catch(e => console.error('Save error:', e));
  console.log(`[Loja] ${player.name} comprou ${qty}x ${item.id} por ${total}`);
}

function handleBuyAmmo(player, msg, ws) {
  const { SHOP } = require('./constants');
  const item = SHOP.ammo[msg.ammoId];
  if (!item) return;
  const packs     = Math.max(1, Math.min(99999, parseInt(msg.packs) || 1)); // how many packs (1 pack = item.qty) — sem limite prático; custo limita
  const totalCost = item.price * packs;
  if (item.currency === 'gold') {
    if (player.gold < totalCost) { sendTo(ws, { type:'error', message:'Ouro insuficiente' }); return; }
    player.gold -= totalCost;
  } else {
    if (player.dobroes < totalCost) { sendTo(ws, { type:'error', message:'Dobrões insuficientes' }); return; }
    player.dobroes -= totalCost;
  }
  journalManager.ledger(player, JOURNAL_SRC.SHOP_AMMO,
    item.currency === 'gold' ? { gold: -totalCost } : { dobroes: -totalCost },
    { detail: item.name || msg.ammoId, n: packs });
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
  // Navio bônus está no SHIP_DEFS para herdar as regras de navio, mas não se
  // compra: sem esta linha um pacote forjado o levaria pelo `price` da tabela.
  if (ship.bonusOnly) { sendTo(ws, { type:'error', message:'Este navio não está à venda' }); return; }
  if (player.inventory.ships.includes(msg.shipId)) { sendTo(ws, { type:'error', message:'Já possui este navio' }); return; }
  if (ship.currency === 'gold') {
    if (player.gold < ship.price) { sendTo(ws, { type:'error', message:'Ouro insuficiente' }); return; }
    player.gold -= ship.price;
  } else if (ship.currency === 'dobrao') {
    if (player.dobroes < ship.price) { sendTo(ws, { type:'error', message:'Dobrões insuficientes' }); return; }
    player.dobroes -= ship.price;
  }
  journalManager.ledger(player, JOURNAL_SRC.SHOP_SHIP,
    ship.currency === 'dobrao' ? { dobroes: -ship.price } : { gold: -ship.price },
    { detail: ship.name || msg.shipId });
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
  journalManager.ledger(player, JOURNAL_SRC.SHOP_SAIL,
    sail.currency === 'dobrao' ? { dobroes: -sail.price } : { gold: -sail.price },
    { detail: sail.name || msg.sailId });
  player.inventory.sails.push(msg.sailId);
  progressDailyMission(player, 'itemsBought', 1);
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(ws, { type:'inventory_update', inventory: player.inventory, gold: player.gold, dobroes: player.dobroes });
}

function handleBuyEliteShip(player, msg, ws) {
  const { SHIP_DEFS } = require('./constants');
  const shipDef = SHIP_DEFS[msg.shipId];
  if (!shipDef || !shipDef.isElite) { sendTo(ws, { type:'error', message:'Navio elite não encontrado' }); return; }
  // Os navios bônus também são isElite — a flag abaixo é o que os separa da loja.
  if (shipDef.bonusOnly) { sendTo(ws, { type:'error', message:'Este navio não está à venda' }); return; }
  if (player.inventory.ships.includes(msg.shipId)) { sendTo(ws, { type:'error', message:'Já possui este navio' }); return; }
  if (shipDef.currency === 'dobrao') {
    if (player.dobroes < shipDef.price) { sendTo(ws, { type:'error', message:'Dobrões insuficientes' }); return; }
    player.dobroes -= shipDef.price;
  } else {
    if (player.gold < shipDef.price) { sendTo(ws, { type:'error', message:'Ouro insuficiente' }); return; }
    player.gold -= shipDef.price;
  }
  journalManager.ledger(player, JOURNAL_SRC.SHOP_ELITE,
    shipDef.currency === 'dobrao' ? { dobroes: -shipDef.price } : { gold: -shipDef.price },
    { detail: shipDef.name || msg.shipId });
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
  journalManager.ledger(player, JOURNAL_SRC.UPG_ISLAND, { dobroes: -def.dobroes },
    { detail: upgradeType, n: level + 1 });
  player.shipIslandUpgrades[upgradeType] = level + 1;

  if (upgradeType === 'hp') {
    // A vida ganha é o DELTA do maxHp, não 5% do SHIP_DEFS: num navio bônus o
    // HP base não vem do SHIP_DEFS e a conta à mão creditava a vida da fragata.
    const _prevMaxHp = player.maxHp || 0;
    refreshTalentDerived(player);
    player.hp = Math.min(player.hp + Math.max(0, player.maxHp - _prevMaxHp), player.maxHp);
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
  journalManager.ledger(player, JOURNAL_SRC.AFK_TRAINING, { gold: -_afkCost },
    { n: _afkHours });
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

// ── Chat ─────────────────────────────────────────────────────────────────────
// Quatro canais: 'global' (todo mundo online), 'map' (mesmo oceano), 'party'
// (grupo, em qualquer mapa) e 'say' (balão em cima do barco, para quem está
// perto). O alcance de 'party' usa partyManager.areAllies() em vez de ler as
// estruturas internas do manager — é a mesma checagem que a bala de cura já
// usa, e não depende do formato interno das parties.
const CHAT_MAX_LEN     = 200;
const CHAT_MIN_GAP_MS  = 700;   // anti-flood: 1 mensagem a cada 0,7 s por jogador
const CHAT_CHANNELS    = ['global', 'map', 'party', 'say'];
// 'say' vira BALÃO flutuando sobre o barco (player.gd:show_chat_bubble), e por
// isso tem regras próprias:
//  • texto curto — 200 caracteres em cima de um barco tapam a tela de quem passa;
//  • alcance curto — mandar para quem não enxerga o barco não vira balão nenhum.
// 180 é o MENOR vision_range possível no cliente (canhão c1: range 80 + 100, ver
// fog_range.gd): assim o barco que fala está sempre dentro da névoa de quem
// recebe, seja qual for o canhão dele. Ainda fica bem além do alcance de combate
// (o melhor canhão atira a 120) — dá para conversar sem estar trocando tiro.
const CHAT_SAY_MAX_LEN = 80;
const CHAT_SAY_RANGE   = 180;

function handleChatSend(player, msg) {
  const channel = CHAT_CHANNELS.includes(msg.channel) ? msg.channel : 'map';

  let text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (!text) return;
  // Remove quebras de linha e controles — o cliente renderiza em label única.
  // O balão tem limite próprio: cabe menos texto em cima de um barco.
  const maxLen = channel === 'say' ? CHAT_SAY_MAX_LEN : CHAT_MAX_LEN;
  text = text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, maxLen);
  if (!text) return;

  const now = Date.now();
  if (now - (player._lastChatAt || 0) < CHAT_MIN_GAP_MS) {
    sendTo(player.ws, { type: 'chat_error', reason: 'flood' });
    return;
  }
  player._lastChatAt = now;

  const out = JSON.stringify({
    type:    'chat_msg',
    channel,
    from:    player.name,
    fromId:  player.id,
    text,
    ts:      now,
  });

  const mapLvl = player.mapLevel || 1;
  players.forEach(p => {
    if (!p.ws || p.ws.readyState !== 1) return;
    if (channel === 'map'   && (p.mapLevel || 1) !== mapLvl) return;
    if (channel === 'party' && p.id !== player.id
        && !(partyManager && partyManager.areAllies(player.id, p.id))) return;
    if (channel === 'say') {
      if ((p.mapLevel || 1) !== mapLvl) return;
      const dx = (p.x || 0) - (player.x || 0);
      const dz = (p.z || 0) - (player.z || 0);
      if (dx * dx + dz * dz > CHAT_SAY_RANGE * CHAT_SAY_RANGE) return;
    }
    p.ws.send(out);
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
  ensureManagersForMap(_retMap);
  db.save(player, true).catch(e => console.error('Save error:', e));
  const _retMgr = getMapManager(_retMap);
  sendTo(player.ws, {
    type: 'map_transition', toLevel: _retMap,
    mapDef: MAP_DEFS[_retMap], mapSize: _retSize,
    x: player.x, z: player.z, mapXp: player.mapXp || 0,
    npcs: entrySnapshot(_retMgr),
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
    player.cannonUpgradesData.push({ as: 0, cr: 0, dm: 0 });
  }
  const upg = player.cannonUpgradesData[idx];
  const field = cupgDef.field; // 'as', 'cr' ou 'dm'
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
  // Depois do estorno das chapas, de propósito: a compra que volta atrás não
  // pode deixar rastro de gasto no extrato.
  journalManager.ledger(player, JOURNAL_SRC.UPG_CANNON,
    cupgDef.currency === 'gold' ? { gold: -cupgDef.price } : { dobroes: -cupgDef.price },
    { detail: cupgDef.name || cupgDef.id });
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
  // Uma linha só com os dois lados do câmbio — o extrato mostra "🪙 −10.000
  // 🟡 +100" e fica claro que foi troca, não gasto.
  journalManager.ledger(player, JOURNAL_SRC.EXCHANGE, { gold: -goldCost, dobroes: dobraoGain });
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

  // Uma linha para a leva inteira, não uma por exploração: quem explora 50
  // vezes de uma vez quer ver "Exploração ×50 · 🟡 −500", não 50 linhas iguais.
  if (timesDobroes > 0) {
    journalManager.ledger(player, JOURNAL_SRC.EXPLORATION,
      { dobroes: -(timesDobroes * FRAGMENT_EXPLORE_FALLBACK_COST) }, { n: timesDobroes });
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
      if (!player.mapPieces) player.mapPieces = {};
      player.mapPieces[reward.id] = (player.mapPieces[reward.id] || 0) + reward.qty;
      resourceResults[reward.id] = (resourceResults[reward.id] || 0) + reward.qty;
      console.log(`[EXPLORE] mapPiece rolled: ${reward.id} → total: ${player.mapPieces[reward.id]}`);
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

function handleUnlockBonusMap(player, msg, ws) {
  const mapId = msg.mapId;
  const mapDef = BONUS_MAPS.find(m => m.id === mapId);
  if (!mapDef) { sendTo(ws, { type: 'error', message: 'Mapa bônus inválido.' }); return; }

  const already = (player.bonusMapsUnlocked || []).includes(mapId);
  if (already) { sendTo(ws, { type: 'error', message: 'Mapa já desbloqueado!' }); return; }

  const pieceId  = mapDef.pieceId;
  const required = mapDef.requiredPieces;
  const owned    = (player.mapPieces || {})[pieceId] || 0;
  if (owned < required) {
    sendTo(ws, { type: 'error', message: `Peças insuficientes! Necessário: ${required} 📜 (você tem ${owned})` });
    return;
  }

  if (!player.mapPieces) player.mapPieces = {};
  player.mapPieces[pieceId] -= required;
  player.bonusMapsUnlocked   = [...(player.bonusMapsUnlocked || []), mapId];
  db.save(player).catch(e => console.error('Save error:', e));

  sendTo(ws, {
    type:              'bonus_map_unlocked',
    mapId,
    mapPieces:         player.mapPieces,
    bonusMapsUnlocked: player.bonusMapsUnlocked,
  });
}

/** Onde o jogador aparece ao entrar na masmorra — ver a nota no corpo. */
const BONUS_ENTRY_Z = 220;

function handleEnterBonusMap(player, msg, ws) {
  const mapId  = msg.mapId;
  const level  = BONUS_MAP_LEVELS[mapId];
  if (!level) { sendTo(ws, { type: 'error', message: 'Mapa bônus inválido.' }); return; }

  let unlocked = (player.bonusMapsUnlocked || []).includes(mapId);

  // Auto-unlock: se ainda não desbloqueado mas tem peças suficientes, faz em um passo
  if (!unlocked) {
    const mapDef  = BONUS_MAPS.find(m => m.id === mapId);
    if (!mapDef) { sendTo(ws, { type: 'error', message: 'Mapa bônus inválido.' }); return; }
    const pieceId  = mapDef.pieceId;
    const required = mapDef.requiredPieces;
    const owned    = (player.mapPieces || {})[pieceId] || 0;
    if (owned < required) {
      sendTo(ws, { type: 'error', message: `Peças insuficientes! Necessário: ${required} 📜 (você tem ${owned})` });
      return;
    }
    if (!player.mapPieces) player.mapPieces = {};
    player.mapPieces[pieceId] -= required;
    player.bonusMapsUnlocked = [...(player.bonusMapsUnlocked || []), mapId];
    unlocked = true;
    console.log(`🗝️ ${player.name} desbloqueou ${mapId} via enter (${required} peças deduzidas)`);
  }

  // Guarda mapa de origem para retornar depois
  player.preBonusMapLevel = player.mapLevel || 1;
  player.preBonusX        = player.x || 0;
  player.preBonusZ        = player.z || 0;
  player.mapLevel         = level;
  // O jogador entra na BORDA e o chefe nasce no centro (spawnWithDef 0,0). Os
  // dois nasciam no mesmo ponto; num mapa de 1200 isso passava despercebido,
  // numa arena de 600 seria nascer dentro do chefe. 220 de distância também é
  // mais que o alcance de canhão (120), então ninguém leva tiro ao chegar.
  player.x                = 0;
  player.z                = BONUS_ENTRY_Z;
  player.speed            = 0;
  player.input            = { w: false, a: false, s: false, d: false };

  // Sempre reinicia o dungeon ao entrar — cada entrada é uma sessão nova,
  // independente de estar em fase 'npcs', 'boss' ou 'complete'.
  const prevMgr = bonusNpcManagers.get(level);
  if (prevMgr) {
    prevMgr.destroyed = true;
    bonusNpcManagers.delete(level);
    console.log(`♻️ [BonusDungeon] Manager do mapa ${level} reiniciado para nova sessão.`);
  }

  ensureBonusMapManager(level);
  const mgr = getMapManager(level);
  const mapDef = MAP_DEFS[level];

  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(ws, {
    type:           'map_transition',
    toLevel:        level,
    mapDef:         mapDef,
    mapSize:        mapDef.size,
    x:              0,
    z:              BONUS_ENTRY_Z,
    mapXp:          player.mapXp || 0,
    npcs:           entrySnapshot(mgr),
    bossProgress:   null,
    isBonusMap:     true,
    bonusMapId:     mapId,
  });
  console.log(`🗺️ ${player.name} entrou em ${mapDef.name} (level ${level})`);
}

function handleLeaveBonusMap(player, ws) {
  if (!MAP_DEFS[player.mapLevel]?.isBonusMap) {
    sendTo(ws, { type: 'error', message: 'Não está em um mapa bônus.' });
    return;
  }

  const returnLevel = player.preBonusMapLevel || 1;
  const returnX     = player.preBonusX        || 0;
  const returnZ     = player.preBonusZ        || 0;
  player.mapLevel   = returnLevel;
  player.x          = returnX;
  player.z          = returnZ;
  player.speed      = 0;
  player.input      = { w: false, a: false, s: false, d: false };
  delete player.preBonusMapLevel;
  delete player.preBonusX;
  delete player.preBonusZ;

  ensureManagersForMap(returnLevel);
  const mgr    = getMapManager(returnLevel);
  const mapDef = MAP_DEFS[returnLevel];

  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(ws, {
    type:         'map_transition',
    toLevel:      returnLevel,
    mapDef:       mapDef,
    mapSize:      mapDef.size,
    x:            returnX,
    z:            returnZ,
    mapXp:        player.mapXp || 0,
    npcs:         entrySnapshot(mgr),
    bossProgress: mapDef.boss
      ? { current: 0, needed: mapDef.boss.killsToSpawn ?? 10, mapLevel: returnLevel, bossAlive: getMapBossAlive(returnLevel) }
      : null,
  });
  console.log(`🚪 ${player.name} saiu do mapa bônus → mapa ${returnLevel}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Bonus Dungeon Complete
// ──────────────────────────────────────────────────────────────────────────────
function sendBonusDungeonComplete(player, mapLevel, mapDef) {
  const ws = player.ws;

  // ── Ler definições da dungeon (BONUS_DUNGEON_DEFS) ─────────────────────────
  const dungeonId  = mapDef.bonusMapId;
  const dungeonDef = dungeonId && BONUS_DUNGEON_DEFS[dungeonId];
  const npcId      = dungeonDef?.npcId;
  const npcDef     = npcId && BONUS_NPC_DEFS[npcId];
  const waveRewards = dungeonDef?.waves?.[0]?.rewards || {};

  // ── Recursos fixos da wave ─────────────────────────────────────────────────
  const dobraoAmt  = waveRewards.dobroes    || 0;
  const goldAmt    = waveRewards.gold       || 0;
  const ironAmt    = waveRewards.ironPlates || 0;
  const dustAmt    = waveRewards.goldDust   || 0;
  const powderAmt  = waveRewards.gunpowder  || 0;

  player.dobroes    = (player.dobroes    || 0) + dobraoAmt;
  player.gold       = (player.gold       || 0) + goldAmt;
  journalManager.ledger(player, JOURNAL_SRC.DUNGEON, { gold: goldAmt, dobroes: dobraoAmt });
  player.ironPlates = (player.ironPlates || 0) + ironAmt;
  player.goldDust   = (player.goldDust   || 0) + dustAmt;
  player.gunpowder  = (player.gunpowder  || 0) + powderAmt;

  // ── Navio raro (chance definida em npcDef) ─────────────────────────────────
  let shipDrop = null;
  if (npcDef && Math.random() < (npcDef.shipDropChance ?? 0.02)) {
    shipDrop = rollBonusShip(npcDef);
    if (!player.bonusShips) player.bonusShips = [];
    player.bonusShips.push(shipDrop);
  }

  // ── A masmorra é CONSUMIDA ao ser vencida ──────────────────────────────────
  // Só a MORTE gastava o desbloqueio (ver request_respawn). Quem completava
  // ficava com `bonusMapsUnlocked` intacto e podia reentrar à vontade: as peças
  // eram cobradas uma vez e a recompensa saía em laço, sem limite. Vencer tem
  // de queimar a entrada exatamente como morrer queima — a diferença entre as
  // duas está no prêmio, não no bilhete.
  //
  // Ao contrário da morte, as peças EXCEDENTES ficam: quem venceu não perde o
  // que já estava farmando para a próxima entrada.
  if (dungeonId) {
    player.bonusMapsUnlocked = (player.bonusMapsUnlocked || []).filter(id => id !== dungeonId);
  }

  db.save(player, true).catch(e => console.error('Save error (bonus complete):', e));

  sendTo(ws, {
    type:            'bonus_dungeon_complete',
    mapLevel,
    autoLeaveMs:     10000,
    dobroes:         player.dobroes,
    gold:            player.gold,
    ironPlates:      player.ironPlates    || 0,
    goldDust:        player.goldDust      || 0,
    gunpowder:       player.gunpowder     || 0,
    rareShips:       player.bonusShips    || [],
    // A Mesa de Exploração precisa saber na hora que a entrada foi gasta —
    // senão o botão "Entrar" continua verde até o próximo login.
    bonusMapsUnlocked: player.bonusMapsUnlocked || [],
    mapPieces:         player.mapPieces         || {},
    rewards: {
      dobroes:    dobraoAmt,
      gold:       goldAmt,
      ironPlates: ironAmt,
      goldDust:   dustAmt,
      gunpowder:  powderAmt,
    },
    shipDrop,
  });
  console.log(`🏆 ${player.name} completou masmorra bônus ${dungeonId ?? mapLevel} — dobrões:${dobraoAmt} ouro:${goldAmt} navio:${shipDrop?.id ?? 'nenhum'}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Banco (Bank)
// ──────────────────────────────────────────────────────────────────────────────
function handleBankDeposit(player, msg, ws) {
  const amount = Math.floor(Number(msg.amount) || 0);
  if (amount <= 0) { sendTo(ws, { type: 'error', message: 'Valor inválido.' }); return; }
  if ((player.gold || 0) < amount) { sendTo(ws, { type: 'error', message: 'Ouro insuficiente.' }); return; }

  player.gold        -= amount;
  player.bankGold     = (player.bankGold || 0) + amount;
  if (!player.bankUnlocked) player.bankUnlocked = true;
  // O cofre não é ganho nem gasto — é o mesmo ouro mudando de bolso. Entra no
  // extrato mesmo assim: quem procura "para onde foram 50 mil" precisa achar o
  // depósito, senão o saldo some sem explicação.
  journalManager.ledger(player, JOURNAL_SRC.BANK_IN, { gold: -amount });

  db.save(player, true).catch(e => console.error('Save error (bank deposit):', e));
  sendTo(ws, {
    type:        'bank_update',
    gold:        player.gold,
    bankGold:    player.bankGold,
    bankUnlocked: player.bankUnlocked,
  });
}

function handleBankWithdraw(player, msg, ws) {
  const amount = Math.floor(Number(msg.amount) || 0);
  if (amount <= 0) { sendTo(ws, { type: 'error', message: 'Valor inválido.' }); return; }
  if ((player.bankGold || 0) < amount) { sendTo(ws, { type: 'error', message: 'Saldo insuficiente no cofre.' }); return; }

  player.bankGold -= amount;
  player.gold      = (player.gold || 0) + amount;
  journalManager.ledger(player, JOURNAL_SRC.BANK_OUT, { gold: amount });

  db.save(player, true).catch(e => console.error('Save error (bank withdraw):', e));
  sendTo(ws, {
    type:        'bank_update',
    gold:        player.gold,
    bankGold:    player.bankGold,
    bankUnlocked: player.bankUnlocked,
  });
}

// Base sell prices per ship rarity (rough gold value)
const RARE_SHIP_SELL_BASE = { normal: 200, raro: 600, epico: 2000, lendario: 8000 };

function handleActivateBonusShip(player, msg, ws) {
  const instanceId = String(msg.instanceId || '');
  if (!instanceId) { sendTo(ws, { type: 'error', message: 'ID inválido.' }); return; }

  if (!player.bonusInventory) player.bonusInventory = [];

  // Procura no banco (ainda não ativado) ou no inventário (reativação)
  let ship = null;
  const bankIdx = (player.bonusShips || []).findIndex(s => s.instanceId === instanceId);
  if (bankIdx !== -1) {
    ship = player.bonusShips[bankIdx];
    player.bonusShips.splice(bankIdx, 1);
    // Upsert no inventário por TIPO de navio — substitui se já existe um do mesmo tipo
    const shipType = ship.id || ship.modelKey;
    const invIdx   = player.bonusInventory.findIndex(s => (s.id || s.modelKey) === shipType);
    if (invIdx !== -1) {
      player.bonusInventory[invIdx] = ship; // substitui pelo novo (stats mais recentes)
    } else {
      player.bonusInventory.push(ship);     // novo tipo → adiciona slot (max 3)
    }
  } else {
    // Já estava no inventário — apenas reativa (clicou Re-ativar)
    ship = player.bonusInventory.find(s => s.instanceId === instanceId);
  }

  if (!ship) { sendTo(ws, { type: 'error', message: 'Navio bônus não encontrado.' }); return; }

  // Aplica stats do navio bônus com todos os bônus de talento / skill / ilha.
  // A ordem importa: activeBonusShipStats precisa estar em pé ANTES, porque é
  // ele que faz refreshTalentDerived calcular sobre o HP do bônus.
  player.activeShip = ship.modelKey || ship.id || player.activeShip;
  player.activeBonusShipStats = ship; // persiste para restaurar no próximo login
  refreshTalentDerived(player, { fillHp: true });
  refreshHealerSlots(player);

  // Aplica propriedades visuais do tipo base do navio
  const baseDef = SHIP_DEFS[player.activeShip] || SHIP_DEFS.fragata;
  player.damageMult    = baseDef.damageMult ?? 1.0;
  player.dropBonus     = baseDef.dropBonus  || 0;
  player.shipSpeedMult = baseDef.speedMult  || 1.0;

  // Trim de canhões equipados se o novo limite for menor
  const tr = _trimCannons(player.cannons, player.maxCannons);
  if (tr.removed > 0) { player.cannons = tr.cannons; recalcCannons(player); }

  if (!player.equipped) player.equipped = {};
  player.equipped.ship = player.activeShip;

  db.save(player, true).catch(e => console.error('Save error (activate bonus ship):', e));
  sendTo(ws, {
    type:                  'bonus_ship_activated',
    instanceId,
    ship,
    equipped:              player.equipped,
    hp:                    player.hp,
    maxHp:                 player.maxHp,
    maxCannons:            player.maxCannons,
    rareShips:             player.bonusShips     || [],
    bonusInventory:        player.bonusInventory || [],
    activeBonusInstanceId: instanceId,
  });
  console.log(`⚔️ ${player.name} ativou: ${ship.name} (hp:${player.maxHp} canhões:${player.maxCannons})`);
}

function handleSellRareShip(player, msg, ws) {
  const instanceId = String(msg.instanceId || '');
  if (!instanceId) { sendTo(ws, { type: 'error', message: 'ID inválido.' }); return; }

  const ships = player.bonusShips || [];
  const idx   = ships.findIndex(s => s.instanceId === instanceId);
  if (idx === -1) { sendTo(ws, { type: 'error', message: 'Navio não encontrado.' }); return; }

  const ship      = ships[idx];
  const tier      = ship.tier || 'normal';
  const salePrice = RARE_SHIP_SELL_BASE[tier] ?? RARE_SHIP_SELL_BASE.normal;
  ships.splice(idx, 1);
  player.bonusShips = ships;
  player.gold       = (player.gold || 0) + salePrice;
  journalManager.ledger(player, JOURNAL_SRC.SHIP_SALE, { gold: salePrice },
    { detail: ship.shipId || ship.name || tier });

  db.save(player, true).catch(e => console.error('Save error (sell rare ship):', e));
  sendTo(ws, {
    type:       'rare_ship_sold',
    instanceId,
    salePrice,
    gold:       player.gold,
    rareShips:  player.bonusShips,
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
  journalManager.ledger(player, JOURNAL_SRC.RESEARCH,
    { gold: -(costDef.gold || 0), dobroes: -(costDef.dobroes || 0) },
    { n: resLevel + 1 });
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
  // (Relíquia pode estar no deck E no pet ao mesmo tempo — usos independentes)
  // O deck é POSICIONAL: índice = tecla, `null` = tecla vazia. Ver utils/relic-deck.js.
  player.relicDeck = equipAt(player.relicDeck, maxRel, instanceId, deckPosition);
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
  const maxRelU = player.maxRelics || 4;
  if (!player.relicDeck) return;
  if (uPos == null || uPos < 0 || uPos >= maxRelU) return;
  // Deactivate gold shield if it was equipped
  const uInstanceId = player.relicDeck[uPos];
  if (uInstanceId) {
    const uInst = (player.inventory.relics || []).find(r => r.instanceId === uInstanceId);
    if (uInst) {
      const uDef = RELIC_DEFS[uInst.relicId];
      if (uDef?.effect === 'gold_shield' && player.relicGoldShieldActive) {
        player.relicGoldShieldActive = false;
        // Todos do mapa (incluindo o dono) desligam a bolha dourada
        addEvent({
          type:     'relic_effect',
          casterId: player.id,
          effect:   'gold_shield',
          active:   false,
        }, player.mapLevel || 1);
      }
    }
  }
  // Esvazia A TECLA — as outras não se mexem (ver utils/relic-deck.js).
  player.relicDeck = unequipAt(player.relicDeck, maxRelU, uPos);
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(player.ws, {
    type:           'relic_state',
    relicDeck:      player.relicDeck,
    relicInventory: player.inventory.relics,
    mana:           player.mana,
    maxMana:        player.maxMana,
  });
}

// Poder de fogo do barco = dano de uma salva completa, espelhando a MESMA conta
// que projectile-manager.hit() faz por projétil (utils/combat-calc):
//   (ammo.damage + cannonDamage) × skillDmg × talentDmg × islandDmg × nº canhões
// Ficam DE FORA de propósito: critMult (é sorteio por tiro) e o bônus de pólvora
// (é consumível — faria o dano da relíquia oscilar com o estoque).
// Antes esta função usava só `cannonDamage × nCannons`, ignorando os
// multiplicadores do atirante. Como o upgrade de dano da ilha vai até nível 30
// (+10% por nível = até 4×), o canhão escalava e a relíquia ficava para trás.
function shipFirepower(player) {
  const nCannons   = (player.cannons && player.cannons.length) || 1;
  const ammoDmg    = (AMMO_DEFS[player.currentAmmo] || AMMO_DEFS.bala_ferro || {}).damage || 0;
  const baseDmg    = ammoDmg + (player.cannonDamage || 0);
  const skillDmg   = player.skillDamageMult || 1.0;
  const talentDmg  = 1 + (player.talentDamageBonus || 0);
  const islandDmg  = 1 + ((player.shipIslandUpgrades?.damage || 0) * 0.10);
  return baseDmg * nCannons * skillDmg * talentDmg * islandDmg;
}

// ── Crítico de relíquia ──────────────────────────────────────────────────────
// 10% base + talento Vidente (+5%/nível, até +25%) = 35% no máximo. Um crítico
// DOBRA o poder do efeito: dano, cura e durações/CC. O sorteio acontece UMA vez
// por uso (em handleUseRelic) e fica em player._relicCrit até o efeito terminar
// de ser montado — assim as várias partes de uma mesma relíquia (ex.: o gelo,
// que tem zona + stun) concordam entre si em vez de sortear cada uma.
const RELIC_CRIT_BASE = 0.10;

function rollRelicCrit(player) {
  return Math.random() < (RELIC_CRIT_BASE + fx.relicCritBonus(player));
}

// Multiplicador do efeito conforme o crítico sorteado para o uso atual.
function relicCritMult(player) {
  return player._relicCrit ? 2 : 1;
}

// Dano de uma relíquia = fração (damagePct) do poder de fogo do barco, com os
// mesmos bônus de relíquia (talento/skill). Se a relíquia não define damagePct,
// cai no dano fixo antigo (relicDef.damage) — mantém compatibilidade.
function relicDamageFor(player, relicDef) {
  const pct   = relicDef.damagePct;
  const raw   = (pct != null) ? shipFirepower(player) * pct : (relicDef.damage || 0);
  // Foco Arcano + Sobrecarga Arcana entram por relicDamageMult; o Estilhaço
  // (dano em área) é somado por quem monta a AoE, não aqui.
  const bonus = fx.relicDamageMult(player) + (player.skillRelicBonus || 0);
  // O crítico entra aqui para cobrir TODAS as relíquias de dano de uma vez
  // (raio, foguete, meteoro, aura, arpão e o uso pelo pet).
  return Math.max(1, Math.round(raw * bonus * relicCritMult(player)));
}

// Alvo válido para dano/CC de uma relíquia lançada por `caster`. Espelha o guard
// dos canhões (projectile-manager.hit) e o da aura: mesmo mapa e PvP habilitado
// na zona. Sem o check de mapa, uma AoE lançada no mapa 1 acertava quem estivesse
// em coordenada parecida em QUALQUER outro mapa — inclusive nos PvE e no treino.
function relicCanHitPlayer(caster, target) {
  if (!target || target.dead) return false;
  if (target.id === caster.id) return false;
  if ((target.mapLevel || 1) !== (caster.mapLevel || 1)) return false;
  return getPvpZone(target.mapLevel || 1) !== 'green';
}

// ── Recarga de relíquia ──────────────────────────────────────────────────────
// Até aqui a única trava do uso era a mana, e ela não segura nada: dava para
// encadear teleporte atrás de teleporte e curar várias vezes dentro da mesma
// troca de tiros. O número vem da RARIDADE (RELIC_COOLDOWN_MS, gravado em
// relicDef.cooldownMs por constants/relics.js), e o talento Ritual encurta —
// este é o primeiro sistema a consumir fx.relicCooldownMult().
//
// A chave é o relicId, NÃO o instanceId: chaveado por instância, equipar duas
// cópias da mesma relíquia no deck dava dois usos alternados e a trava valia
// metade. Duas Âncoras Sagradas continuam sendo uma cura a cada 5 s.
//
// `player._relicCds` é transitório de propósito (mesma família de _relicCrit /
// _relicAim): não vai ao DB, então relogar zera as recargas — irrelevante
// perto do custo de sair e voltar do jogo.
function relicCooldownMs(player, relicDef) {
  const base = relicDef.cooldownMs || 0;
  return base > 0 ? Math.round(base * fx.relicCooldownMult(player)) : 0;
}

function relicCdRemaining(player, relicId) {
  return Math.max(0, ((player._relicCds || {})[relicId] || 0) - Date.now());
}

// Alcance máximo de mira das relíquias "miradas" (runas) = alcance do canhão do
// jogador. Assim, trocar/melhorar canhões estende também o alcance das skills.
function relicCastRange(player) {
  // Braço Longo estica o alcance das runas miradas.
  return (player.cannonRange || 80) * fx.relicRangeMult(player);
}

function handleUseRelic(player, msg) {
  const { instanceId: useInstanceId } = msg;
  let rTx = msg.targetX, rTz = msg.targetZ;
  if (!useInstanceId) return;
  // Verify relic is in player's deck
  if (!player.relicDeck || !player.relicDeck.includes(useInstanceId)) return;
  const relicInstance = (player.inventory.relics || []).find(r => r.instanceId === useInstanceId);
  if (!relicInstance) return;
  const relicDef = RELIC_DEFS[relicInstance.relicId];
  if (!relicDef) return;
  const instanceId2 = useInstanceId;

  // ── Relíquia desativada ────────────────────────────────────────────────
  // Vem antes de TUDO — mana, recarga, mira. Uma relíquia fora de serviço não
  // pode cobrar nada de quem tentou usá-la, e quem já a tem continua com ela
  // no inventário (desativar é reversível, apagar do inventário de todo mundo
  // não é). Ver `relicDisabled` em constants/monster_skills.js.
  if (relicDef.disabled) {
    sendTo(player.ws, {
      type: 'relic_disabled', instanceId: instanceId2,
      relicId: relicInstance.relicId, name: relicDef.name,
    });
    return;
  }

  // Runas miradas: alcance máximo = alcance do canhão. Clampa o ponto-alvo para
  // dentro desse raio (na direção do clique) — todos os handlers abaixo já leem
  // rTx/rTz clampados. Teleporte e arpão têm alcance próprio, ajustado separado.
  if (relicDef.targetMouse && rTx != null && rTz != null) {
    const _castR = relicCastRange(player);
    const _dx = rTx - player.x, _dz = rTz - player.z;
    const _d  = Math.hypot(_dx, _dz);
    if (_d > _castR) {
      const _ratio = _castR / _d;
      rTx = player.x + _dx * _ratio;
      rTz = player.z + _dz * _ratio;
    }
  }

  const now2 = Date.now();
  // Economia Arcana desconta e Sobrecarga Arcana encarece — o custo real da
  // relíquia para ESTE jogador. Mínimo 1 quando a relíquia cobra alguma coisa,
  // senão o desconto no máximo transformaria toda relíquia barata em gratuita.
  const baseManaCost = relicDef.manaCost || 0;
  const manaCost = baseManaCost > 0
    ? Math.max(1, Math.round(baseManaCost * fx.relicManaCostMult(player)))
    : 0;

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
      // Broadcast para todos do mapa verem a bolha dourada no barco
      addEvent({
        type:     'relic_effect',
        casterId: player.id,
        effect:   'gold_shield',
        active:   player.relicGoldShieldActive,
      }, player.mapLevel || 1);
    }
    return;
  }

  // Coro dos Rostos: silenciado não usa relíquia. Vem antes de tudo — nem
  // recarga nem mana são consumidas por uma tentativa que não vai sair.
  if (player._silencedUntil && Date.now() < player._silencedUntil) {
    sendTo(player.ws, {
      type: 'relic_silenced', instanceId: instanceId2,
      remainingMs: player._silencedUntil - Date.now(),
    });
    return;
  }

  // Recarga: uma relíquia por vez, no ritmo da raridade dela. Vem ANTES da mana
  // para que uma tentativa em recarga nunca gaste nada — e o cliente já trava o
  // slot sozinho, então chegar aqui é sinal de deriva de relógio ou de macro.
  const cdLeft = relicCdRemaining(player, relicInstance.relicId);
  if (cdLeft > 0) {
    sendTo(player.ws, {
      type: 'relic_cooldown', instanceId: instanceId2,
      relicId: relicInstance.relicId, remainingMs: cdLeft,
    });
    return;
  }

  // Mana check for non-toggle relics
  if (player.mana < manaCost) {
    sendTo(player.ws, { type: 'relic_no_mana', mana: player.mana, maxMana: player.maxMana, needed: manaCost });
    return;
  }
  player.mana = Math.max(0, player.mana - manaCost);
  // Memória do último golpe de bestiário: é o que o Espelho do Córtex do boss
  // copia. Só relíquia de monstro entra — as r1..r13 não têm versão de bicho,
  // e o espelho precisa de algo que o ATTACK_DEFS saiba lançar.
  if (relicDef.effect === 'monster_skill' && relicDef.skill) {
    player._lastRelicSkill = relicDef.skill;
  }
  // A recarga começa AQUI: a relíquia foi paga e vai sair.
  const relicCdMs = relicCooldownMs(player, relicDef);
  if (relicCdMs > 0) {
    if (!player._relicCds) player._relicCds = {};
    player._relicCds[relicInstance.relicId] = now2 + relicCdMs;
  }
  // Sorteia o crítico UMA vez para este uso. Fica em player._relicCrit e é lido
  // por relicCritMult()/relicDamageFor() ao montar o efeito logo abaixo.
  player._relicCrit = rollRelicCrit(player);
  const critMult = relicCritMult(player);
  // Durações e CC dobram junto: "poder do efeito" não é só dano — um escudo ou
  // um stun crítico precisa durar o dobro para o crítico valer em toda relíquia.
  const critDur  = (ms) => Math.round((ms || 0) * critMult);
  // Campo de Treino: não há NPC para acertar, então todos os grants de XP de
  // relíquia espalhados abaixo (que dependem de npcHits > 0) ficam em zero e o
  // Arcanista nunca subia treinando. Aqui o XP vem do próprio ato de usar,
  // proporcional ao custo de mana — o regen (0,5/s) já limita o ritmo sozinho.
  if (MAP_DEFS[player.mapLevel]?.isTrainingMap) {
    grantSkillXp(player, 'reliquia', Math.max(1, manaCost * 4), wss);
  }
  // Conjuração Ágil encurta a penalidade de cast.
  if (relicDef.castTime) player.castExpires = Date.now() + relicDef.castTime * fx.relicCastMult(player);

  // ── Talentos pendurados no USO da relíquia ──────────────────────────────
  // Impulso Arcano (velocidade por 4s) e Barreira Arcana (escudo em vida).
  fx.onRelicUsed(player, now2);
  const barreira = fx.relicShieldAmount(player);
  if (barreira > 0 && player.hp < player.maxHp) {
    player.hp = Math.min(player.maxHp, player.hp + barreira);
    addEvent({
      type: 'heal', targetId: player.id, amount: barreira,
      x: player.x, z: player.z, hp: player.hp, maxHp: player.maxHp,
    }, player.mapLevel || 1);
  }

  // Apply effect
  // `relicId` + `cooldownMs`: o HUD chaveia a recarga pelo relicId (igual ao
  // servidor) e precisa do tempo JÁ com o desconto do talento aplicado.
  let effectPayload = { type: 'relic_used', instanceId: instanceId2, relicId: relicInstance.relicId, effect: relicDef.effect, mana: player.mana, maxMana: player.maxMana, crit: player._relicCrit, cooldownMs: relicCdMs };

  if (relicDef.effect === 'heal_ship') {
    // Cura escala com o HP máximo (healPct) em vez de valor fixo — sempre
    // relevante independente do tamanho do barco. Fallback para healAmount fixo.
    const healValue = Math.round(critMult * fx.healingReceivedMult(player) * ((relicDef.healPct != null)
      ? Math.round(player.maxHp * relicDef.healPct)
      : (relicDef.healAmount || 0)));
    const healed = Math.min(healValue, player.maxHp - player.hp);
    player.hp = Math.min(player.maxHp, player.hp + healValue);
    effectPayload.hp    = player.hp;
    effectPayload.maxHp = player.maxHp;
    effectPayload.healed = healed;
    if (healed > 0) grantSkillXp(player, 'vida', Math.floor(healed / 10), wss);
    // Broadcast para todos verem a cura no barco desse jogador
    addEvent({
      type:     'relic_effect',
      casterId: player.id,
      effect:   'heal_ship',
      crit:     player._relicCrit,
    }, player.mapLevel || 1);

  } else if (relicDef.effect === 'invincible') {
    const invMs = critDur(relicDef.duration);
    player.relicInvincibleExpires = now2 + invMs;
    effectPayload.duration = invMs;
    // Broadcast para todos verem a bolha de invencibilidade
    addEvent({
      type:     'relic_effect',
      casterId: player.id,
      effect:   'invincible',
      duration: invMs,
      crit:     player._relicCrit,
    }, player.mapLevel || 1);

  } else if (relicDef.effect === 'lightning') {
    const LIGHTNING_RADIUS = relicDef.radius || 20;
    const castMs = relicDef.castTime || 1000;
    const lx = rTx != null ? rTx : player.x;
    const lz = rTz != null ? rTz : player.z;

    // 1. Avisa os clientes DO MESMO MAPA para mostrar o indicador visual.
    //    Sem o mapLevel, addEvent bufferiza como evento global (key 0) e o VFX
    //    do relâmpago aparecia para jogadores em TODOS os mapas.
    addEvent({
      type:     'lightning_cast',
      crit:     player._relicCrit,
      casterId: player.id,
      targetX:  lx,
      targetZ:  lz,
      radius:   LIGHTNING_RADIUS,
      castMs,
    }, player.mapLevel || 1);

    // 1b. Notifica o NPC manager do mapa do jogador para que NPCs tentem desviar
    {
      const _pLvl = player.mapLevel || 1;
      const _lMgr = _pLvl === 1 ? npcManager
                  : _pLvl === 2 ? npcManager2
                  : getMapManager(_pLvl);
      _lMgr?.notifyDangerZone(lx, lz, LIGHTNING_RADIUS, castMs);
    }

    // 2. Aplica dano após o cast time (permite desviar)
    setTimeout(() => {
      if (player.dead) return; // caster morreu durante o cast
      const relicDamage = relicDamageFor(player, relicDef);
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
                const lBossMgr = projectileManager.bossManagers.get(_lBossLvl)
                               || (_lBossLvl === 2 ? bossManager2 : bossManager);
                lBossMgr && lBossMgr.onBossDead(npc, player.id);
                worldBossManager.onZoneBossDead(npc, player.id);
              }
              projectileManager.npcs.delete(npc.id);
            } else {
              const rewards = projectileManager.grantNpcKillRewards(player, npc);
              addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, killerId: player.id, goldDrop: rewards.goldDrop }, npc.mapLevel);
              const _nLvlL = npc.mapLevel || 1;
              const lmgr = _nLvlL === 1 ? npcManager : _nLvlL === 2 ? npcManager2 : getMapManager(_nLvlL);
              lmgr && lmgr.respawnScaled(npc.id, player.npcKills || 0, _nLvlL);
              _npcKillBossAccounting(_nLvlL, player.npcKills || 0);
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
        if (!relicCanHitPlayer(player, p)) return;
        const d = Math.hypot(p.x - lx, p.z - lz);
        if (d <= LIGHTNING_RADIUS) {
          p.hp = Math.max(0, p.hp - relicDamage);
          p.lastCombatTime = Date.now();
          hits2.push({ id: p.id, hp: p.hp, isNPC: false, dmg: relicDamage });
          resolvePlayerDeath(p, player.id);
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
    const ROCKET_RADIUS = relicDef.radius || 8;
    const rkTx = rTx != null ? rTx : player.x + Math.sin(player.rotation || 0) * 80;
    const rkTz = rTz != null ? rTz : player.z + Math.cos(player.rotation || 0) * 80;

    // Tempo de voo escala com a distância (velocidade ~constante), com piso/teto —
    // antes era fixo em castTime, então tiros longos "teleportavam". O dano é
    // aplicado no fim desse castMs, então visual e impacto ficam sincronizados.
    const rkDist  = Math.hypot(rkTx - player.x, rkTz - player.z);
    const ROCKET_SPEED = 320; // unidades/segundo
    const castMs = Math.round(Math.max(relicDef.castTime || 600, Math.min(2600, rkDist / ROCKET_SPEED * 1000)));

    // 1. Avisa os clientes DO MESMO MAPA para mostrar o arco visual (sem mapLevel
    //    o foguete aparecia em todos os mapas).
    addEvent({
      type:     'rocket_cast',
      crit:     player._relicCrit,
      casterId: player.id,
      fromX:    player.x,
      fromZ:    player.z,
      targetX:  rkTx,
      targetZ:  rkTz,
      radius:   ROCKET_RADIUS,
      castMs,
    }, player.mapLevel || 1);

    // 2. Aplica dano após o cast time (permite desviar)
    setTimeout(() => {
      if (player.dead) return;
      const relicDamage = relicDamageFor(player, relicDef);
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
                const rkBossMgr = projectileManager.bossManagers.get(_rkBossLvl)
                                || (_rkBossLvl === 2 ? bossManager2 : bossManager);
                rkBossMgr && rkBossMgr.onBossDead(npc, player.id);
                worldBossManager.onZoneBossDead(npc, player.id);
              }
              projectileManager.npcs.delete(npc.id);
            } else {
              const rewards = projectileManager.grantNpcKillRewards(player, npc);
              addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, killerId: player.id, goldDrop: rewards.goldDrop }, npc.mapLevel);
              const _nLvlR = npc.mapLevel || 1;
              const rkMgr = _nLvlR === 1 ? npcManager : _nLvlR === 2 ? npcManager2 : getMapManager(_nLvlR);
              rkMgr && rkMgr.respawnScaled(npc.id, player.npcKills || 0, _nLvlR);
              _npcKillBossAccounting(_nLvlR, player.npcKills || 0);
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
        if (!relicCanHitPlayer(player, p)) return;
        if (Math.hypot(p.x - rkTx, p.z - rkTz) <= ROCKET_RADIUS) {
          p.hp = Math.max(0, p.hp - relicDamage);
          p.lastCombatTime = Date.now();
          hitsRkt.push({ id: p.id, hp: p.hp, isNPC: false, dmg: relicDamage });
          resolvePlayerDeath(p, player.id);
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
    const spdMs = critDur(relicDef.duration);
    player.relicSpeedExpires = now2 + spdMs;
    player.relicSpeedBonus   = relicDef.speedBonus;
    effectPayload.duration   = spdMs;
    // Broadcast para todos verem o rastro de vento no barco
    addEvent({
      type:     'relic_effect',
      casterId: player.id,
      effect:   'speed_boost',
      duration: spdMs,
      crit:     player._relicCrit,
    }, player.mapLevel || 1);

  } else if (relicDef.effect === 'attract') {
    // Attract all NPCs within range toward this player for `duration` ms
    const attMs = critDur(relicDef.duration);
    player.relicAttractExpires = now2 + attMs;
    player.relicAttractRange   = relicDef.range;
    // Sucção contínua enquanto o chamado dura — ver o trecho do attract em
    // managers/npc-manager.js. Fica no player porque o puxão é POR LANÇADOR.
    player.relicAttractPull    = relicDef.pullSpeed || 0;
    effectPayload.duration     = attMs;
    effectPayload.range        = relicDef.range;
    // Broadcast attract event só para clientes do mesmo mapa
    addEvent({
      type:     'attract_cast',
      casterId: player.id,
      x:        player.x,
      z:        player.z,
      range:    relicDef.range,
      duration: attMs,
      crit:     player._relicCrit,
    }, player.mapLevel || 1);

  } else if (relicDef.effect === 'meteor') {
    // ── Meteoro ───────────────────────────────────────────────────────
    // Single high-damage meteor falls at the target position.
    const castMs     = relicDef.castTime || 700;
    const baseRadius = relicDef.radius   || 55;
    const mtTx       = rTx != null ? rTx : player.x;
    const mtTz       = rTz != null ? rTz : player.z;
    const pos        = { x: mtTx, z: mtTz };

    const applyMeteorHit = (hitPos, radius, dmg) => {
      const hitsM = [];
      projectileManager.npcs.forEach(npc => {
        if (npc.dead) return;
        if (Math.hypot(npc.x - hitPos.x, npc.z - hitPos.z) > radius) return;
        npc.hp = Math.max(0, npc.hp - dmg);
        npc.lastDamageTime = Date.now();
        hitsM.push({ id: npc.id, hp: npc.hp, isNPC: true, dmg });
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
              const mtBossMgr = projectileManager.bossManagers.get(_mtBossLvl)
                              || (_mtBossLvl === 2 ? bossManager2 : bossManager);
              mtBossMgr && mtBossMgr.onBossDead(npc, player.id);
              worldBossManager.onZoneBossDead(npc, player.id);
            }
            projectileManager.npcs.delete(npc.id);
          } else {
            const rewards = projectileManager.grantNpcKillRewards(player, npc);
            addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, killerId: player.id, goldDrop: rewards.goldDrop }, npc.mapLevel);
            const _nLvlM = npc.mapLevel || 1;
            const mtMgr = _nLvlM === 1 ? npcManager : _nLvlM === 2 ? npcManager2 : getMapManager(_nLvlM);
            mtMgr && mtMgr.respawnScaled(npc.id, player.npcKills || 0, _nLvlM);
            _npcKillBossAccounting(_nLvlM, player.npcKills || 0);
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
        if (!relicCanHitPlayer(player, p)) return;
        if (Math.hypot(p.x - hitPos.x, p.z - hitPos.z) <= radius) {
          p.hp = Math.max(0, p.hp - dmg);
          p.lastCombatTime = Date.now();
          hitsM.push({ id: p.id, hp: p.hp, isNPC: false, dmg });
          resolvePlayerDeath(p, player.id);
        }
      });
      return hitsM;
    };

    const relicDmg = relicDamageFor(player, relicDef);

    // Single meteor — show incoming indicator, land after castMs
    addEvent({ type: 'meteor_incoming', x: pos.x, z: pos.z, radius: baseRadius, castMs, crit: player._relicCrit }, player.mapLevel);
    setTimeout(() => {
      if (player.dead) return;
      const hits = applyMeteorHit(pos, baseRadius, relicDmg);
      addEvent({ type: 'meteor_strike', x: pos.x, z: pos.z, radius: baseRadius, hits }, player.mapLevel);
      const npcHits = hits.filter(h => h.isNPC).length;
      if (npcHits > 0) grantSkillXp(player, 'reliquia', npcHits * 27, wss);
    }, castMs);

    effectPayload.targetX = mtTx;
    effectPayload.targetZ = mtTz;
    effectPayload.castMs  = castMs;

  } else if (relicDef.effect === 'teleport') {
    // ── Teleporte ─────────────────────────────────────────────────────
    // Teleporta o jogador até a posição do mouse respeitando range máximo
    // (= alcance do canhão do jogador, como as demais runas)
    const maxRange = relicCastRange(player);

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

  } else if (relicDef.effect === 'ice_zone') {
    // ── Prisão de Gelo ────────────────────────────────────────────────
    // Zona circular: slow instantâneo em quem está dentro; quem AINDA
    // estiver dentro quando o fill completar (zoneMs) congela por stunMs.
    const ICE_RADIUS = relicDef.radius || 40;
    const iceZoneMs  = relicDef.zoneMs || 2000;   // tempo de fill: NÃO dobra, senão
                                                  // o crítico daria MAIS tempo de fuga
    const iceStunMs  = critDur(relicDef.stunMs || 2000);
    const gx = rTx != null ? rTx : player.x;
    const gz = rTz != null ? rTz : player.z;

    // 1. Avisa TODOS os clientes: zona no chão com fill até o stun
    addEvent({
      type:     'ice_cast',
      crit:     player._relicCrit,
      casterId: player.id,
      targetX:  gx,
      targetZ:  gz,
      radius:   ICE_RADIUS,
      zoneMs:   iceZoneMs,
      stunMs:   iceStunMs,
    }, player.mapLevel || 1);

    // 1b. NPCs tentam desviar da zona (mesmo hook do raio)
    {
      const _pLvl = player.mapLevel || 1;
      const _gMgr = _pLvl === 1 ? npcManager
                  : _pLvl === 2 ? npcManager2
                  : getMapManager(_pLvl);
      _gMgr?.notifyDangerZone(gx, gz, ICE_RADIUS, iceZoneMs);
    }

    // 2. Slow instantâneo em NPCs e jogadores inimigos dentro do círculo
    const iceSlowMult = 1 - (relicDef.slowPct || 0.5);
    projectileManager.npcs.forEach(npc => {
      if (npc.dead) return;
      if (Math.hypot(npc.x - gx, npc.z - gz) > ICE_RADIUS) return;
      npc.slowMult    = Math.min(npc.slowMult || 1, iceSlowMult);
      npc.slowExpires = now2 + iceZoneMs;
    });
    players.forEach(p => {
      if (!relicCanHitPlayer(player, p)) return;
      if (Math.hypot(p.x - gx, p.z - gz) > ICE_RADIUS) return;
      p.slowMult       = Math.min(p.slowMult || 1, iceSlowMult);
      p.slowExpires    = now2 + iceZoneMs;
      p.lastCombatTime = Date.now();
    });

    // 3. Stun em quem ainda estiver dentro quando a zona completa
    setTimeout(() => {
      if (player.dead) return; // caster morreu durante a zona
      const tnow    = Date.now();
      const hitsIce = [];
      projectileManager.npcs.forEach(npc => {
        if (npc.dead) return;
        if (npc.isBoss) return; // bosses são imunes a stun (só levam o slow)
        if (Math.hypot(npc.x - gx, npc.z - gz) > ICE_RADIUS) return;
        npc.stunExpires = tnow + iceStunMs;
        hitsIce.push({ id: npc.id, isNPC: true });
      });
      players.forEach(p => {
        if (!relicCanHitPlayer(player, p)) return;
        if (Math.hypot(p.x - gx, p.z - gz) > ICE_RADIUS) return;
        p.stunExpires    = tnow + iceStunMs;
        p.lastCombatTime = tnow;
        hitsIce.push({ id: p.id, isNPC: false });
      });
      addEvent({
        type:     'ice_stun',
        casterId: player.id,
        targetX:  gx,
        targetZ:  gz,
        radius:   ICE_RADIUS,
        stunMs:   iceStunMs,
        hits:     hitsIce,
      }, player.mapLevel || 1);
      // XP de relíquia por NPC congelado (CC puro não mata — recompensa menor)
      const iceNpcHits = hitsIce.filter(h => h.isNPC).length;
      if (iceNpcHits > 0) grantSkillXp(player, 'reliquia', iceNpcHits * 12, wss);
    }, iceZoneMs);

    effectPayload.targetX = gx;
    effectPayload.targetZ = gz;
    effectPayload.zoneMs  = iceZoneMs;

  } else if (relicDef.effect === 'stone_wall') {
    // ── Muro de Pedra ───────────────────────────────────────────────────
    // Mecânica NOVA (não é dano nem slow/stun via stat): registra um
    // obstáculo retangular TEMPORÁRIO que jogador e NPC respeitam
    // exatamente como uma ilha — ver managers/wall-manager.js e
    // utils/collision.js (pushOutOfWalls, mesmo _pushOutOfShape das ilhas).
    const wallLen   = relicDef.wallLength    || 100;
    const wallThick = relicDef.wallThickness || 20;
    // `??` e nao `||`: o muro agora sobe com zoneMs 0 (no clique), e com `||`
    // o zero caia no default de 1,2 s — a relíquia continuaria se anunciando.
    const wallZoneMs = relicDef.zoneMs ?? 1200;
    const wallDurMs  = relicDef.wallMs || 6000;
    const wx = rTx != null ? rTx : player.x;
    const wz = rTz != null ? rTz : player.z;
    // Perpendicular à linha caster→alvo — o muro cruza o caminho de quem
    // vem daquele lado. Na convenção da caixa de colisão (Basis_Y, ver
    // _pushOutOfShape), o eixo do COMPRIMENTO (hw) é o basis.x =
    // (cos rot, -sin rot); com rot = atan2(dx, dz) (o heading até o alvo,
    // mesmo de player.rotation), esse eixo já fica perpendicular à linha —
    // NÃO some π/2 aqui (fazia o muro ficar deitado AO LONGO da linha).
    const wallRot = Math.atan2(wx - player.x, wz - player.z);

    // 1. Broadcast IMEDIATO — todo mundo no mapa vê a marcação subindo
    addEvent({
      type:     'stone_wall_cast',
      crit:     player._relicCrit,
      casterId: player.id,
      targetX:  wx, targetZ: wz, rot: wallRot,
      wallLength: wallLen, wallThickness: wallThick,
      zoneMs: wallZoneMs, wallMs: wallDurMs,
    }, player.mapLevel || 1);

    // 1b. NPCs tentam desviar da área marcada (mesmo hook do raio/gelo)
    {
      const _pLvl = player.mapLevel || 1;
      const _wMgr = _pLvl === 1 ? npcManager
                  : _pLvl === 2 ? npcManager2
                  : getMapManager(_pLvl);
      _wMgr?.notifyDangerZone(wx, wz, Math.max(wallLen, wallThick) * 0.5, wallZoneMs);
    }

    // 2. Depois da marcação, registra o obstáculo físico de verdade
    const wallId = `wall_${player.id}_${now2}`;
    setTimeout(() => {
      if (player.dead) return; // caster morreu durante a marcação — cancela
      wallManager.addWall(player.mapLevel || 1, {
        id: wallId, x: wx, z: wz,
        hw: wallLen / 2, hh: wallThick / 2, rot: wallRot,
        durationMs: wallDurMs,
      });
      addEvent({
        type:     'stone_wall_up',
        casterId: player.id,
        targetX:  wx, targetZ: wz, rot: wallRot,
        wallLength: wallLen, wallThickness: wallThick, wallMs: wallDurMs,
      }, player.mapLevel || 1);
    }, wallZoneMs);

    effectPayload.targetX = wx;
    effectPayload.targetZ = wz;
    effectPayload.zoneMs  = wallZoneMs;

  } else if (relicDef.effect === 'harpoon') {
    // ── Arpão do Leviatã ────────────────────────────────────────────────
    // Skillshot em linha (Q do Nautilus): o 1º inimigo dentro do corredor
    // NO MOMENTO em que o arpão chega (travelMs = janela de desvio) é
    // puxado até pullStopDist do caster + stun curto durante o arrasto.
    // O "arrasto" visual é o lerp que o cliente já faz nas entidades —
    // aqui só reposicionamos e stunamos. Boss leva o dano mas NÃO é puxado.
    const H_RANGE  = relicCastRange(player);   // comprimento do skillshot = alcance do canhão
    const H_RADIUS = relicDef.hitRadius    || 14;
    const H_TRAVEL = relicDef.travelMs     || 500;
    const H_STOP   = relicDef.pullStopDist || 30;
    const H_STUN   = critDur(relicDef.stunMs || 800);

    // Direção do arremesso (fallback: proa do navio)
    let hdx = (rTx != null ? rTx : player.x) - player.x;
    let hdz = (rTz != null ? rTz : player.z) - player.z;
    const hLen = Math.hypot(hdx, hdz);
    if (hLen < 1) { hdx = Math.sin(player.rotation || 0); hdz = Math.cos(player.rotation || 0); }
    else          { hdx /= hLen; hdz /= hLen; }
    const hx0 = player.x, hz0 = player.z;
    const hEndX = hx0 + hdx * H_RANGE, hEndZ = hz0 + hdz * H_RANGE;

    // 1. Broadcast IMEDIATO — todo mundo vê o arpão voando (e pode desviar)
    addEvent({
      type:     'harpoon_cast',
      crit:     player._relicCrit,
      casterId: player.id,
      fromX:    hx0, fromZ: hz0,
      targetX:  hEndX, targetZ: hEndZ,
      travelMs: H_TRAVEL,
    }, player.mapLevel || 1);

    // 2. Resolução no fim do voo: varre o corredor, 1º alvo ao longo da linha
    setTimeout(() => {
      if (player.dead) return;
      const hMapLvl = player.mapLevel || 1;
      // Distância ponto→segmento + posição normalizada t ao longo da linha
      const distToSeg = (px, pz) => {
        const wx2 = px - hx0, wz2 = pz - hz0;
        let t = (wx2 * hdx + wz2 * hdz) / H_RANGE;
        t = Math.max(0, Math.min(1, t));
        const cx2 = hx0 + hdx * H_RANGE * t, cz2 = hz0 + hdz * H_RANGE * t;
        return { d: Math.hypot(px - cx2, pz - cz2), t };
      };
      let best = null; // { ent, isNPC, t } — menor t = 1º na linha
      projectileManager.npcs.forEach(npc => {
        if (npc.dead) return;
        if ((npc.mapLevel || 1) !== hMapLvl) return;
        const { d, t } = distToSeg(npc.x, npc.z);
        if (d > H_RADIUS || t < 0.05) return;
        if (!best || t < best.t) best = { ent: npc, isNPC: true, t };
      });
      players.forEach(p => {
        if (!relicCanHitPlayer(player, p)) return;
        if ((p.mapLevel || 1) !== hMapLvl) return;
        const { d, t } = distToSeg(p.x, p.z);
        if (d > H_RADIUS || t < 0.05) return;
        if (!best || t < best.t) best = { ent: p, isNPC: false, t };
      });
      if (!best) return; // errou — o VFX do cliente recolhe frouxo sozinho

      // ── Dano (escala com poder de fogo) + kill-flow ─────────────────────
      const target = best.ent;
      const hDmg = relicDamageFor(player, relicDef);
      const hitsH = [];
      target.hp = Math.max(0, target.hp - hDmg);
      if (best.isNPC) {
        const npc = target;
        npc.lastDamageTime = Date.now();
        hitsH.push({ id: npc.id, hp: npc.hp, isNPC: true, dmg: hDmg });
        if (npc.isBoss) {
          if (!npc._damageMap) npc._damageMap = new Map();
          npc._damageMap.set(player.id, (npc._damageMap.get(player.id) || 0) + hDmg);
        }
        if (npc.hp <= 0 && !npc.dead) {
          npc.dead = true;
          if (npc.isBoss) {
            addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, isBoss: true, killerId: player.id }, npc.mapLevel);
            if (npc.isWorldBoss) {
              worldBossManager.onWorldBossDead(npc, player.id);
            } else {
              const _hpBossLvl = npc.mapLevel || 1;
              const hpBossMgr = projectileManager.bossManagers.get(_hpBossLvl)
                              || (_hpBossLvl === 2 ? bossManager2 : bossManager);
              hpBossMgr && hpBossMgr.onBossDead(npc, player.id);
              worldBossManager.onZoneBossDead(npc, player.id);
            }
            projectileManager.npcs.delete(npc.id);
          } else {
            const rewards = projectileManager.grantNpcKillRewards(player, npc);
            addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, killerId: player.id, goldDrop: rewards.goldDrop }, npc.mapLevel);
            const _nLvlH = npc.mapLevel || 1;
            const hpMgr = _nLvlH === 1 ? npcManager : _nLvlH === 2 ? npcManager2 : getMapManager(_nLvlH);
            hpMgr && hpMgr.respawnScaled(npc.id, player.npcKills || 0, _nLvlH);
            _npcKillBossAccounting(_nLvlH, player.npcKills || 0);
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
        grantSkillXp(player, 'reliquia', 18, wss);
      } else {
        target.lastCombatTime = Date.now();
        hitsH.push({ id: target.id, hp: target.hp, isNPC: false, dmg: hDmg });
        resolvePlayerDeath(target, player.id);
      }

      // ── Puxão: reposiciona perto do caster + stun durante o arrasto ────
      const grabX = target.x, grabZ = target.z;
      const canPull = !target.dead && !(best.isNPC && target.isBoss);
      let pullX = grabX, pullZ = grabZ;
      if (canPull) {
        const pdx = target.x - player.x, pdz = target.z - player.z;
        const pd = Math.hypot(pdx, pdz) || 1;
        const pulled = {
          x: player.x + (pdx / pd) * H_STOP,
          z: player.z + (pdz / pd) * H_STOP,
        };
        // Nunca puxa pra dentro de ilha/muro nem pra fora do mapa
        const hMs = (MAP_DEFS[hMapLvl] && MAP_DEFS[hMapLvl].size) || 2000;
        pulled.x = Math.max(-hMs / 2, Math.min(hMs / 2, pulled.x));
        pulled.z = Math.max(-hMs / 2, Math.min(hMs / 2, pulled.z));
        pushOutOfIslands(pulled, MAP_DEFS[hMapLvl], 8);
        pushOutOfWalls(pulled, wallManager.getActive(hMapLvl), 8);
        target.x = pulled.x;
        target.z = pulled.z;
        target.stunExpires = Date.now() + H_STUN;
        if (!best.isNPC) target.moveTarget = null; // cancela click-to-move
        pullX = pulled.x;
        pullZ = pulled.z;
      }

      addEvent({
        type:     'harpoon_hit',
        casterId: player.id,
        fromX:    hx0, fromZ: hz0,
        targetId: target.id,
        isNPC:    best.isNPC,
        grabX, grabZ,
        toX: pullX, toZ: pullZ,
        stunMs: canPull ? H_STUN : 0,
        hits:   hitsH,
      }, hMapLvl);
    }, H_TRAVEL);

    effectPayload.targetX = hEndX;
    effectPayload.targetZ = hEndZ;
    effectPayload.castMs  = H_TRAVEL;

  } else if (relicDef.effect === 'aura') {
    // ── Aura Mortal ───────────────────────────────────────────────────
    // Activa uma aura ao redor do barco que pulsa dano em NPCs próximos
    // Dano por tick da aura também escala com o poder de fogo (damagePct por tick).
    const auraTickDmg           = relicDamageFor(player, relicDef);
    // A duração NÃO dobra no crítico: o dano por tick já dobrou acima, e dobrar
    // os dois daria 4× de dano total — desproporcional frente às outras relíquias.
    player.relicAuraExpires     = now2 + (relicDef.duration || 20000);
    player.relicAuraRange       = relicDef.range        || 80;
    player.relicAuraDamage      = auraTickDmg;
    player.relicAuraTickInterval= relicDef.tickInterval || 1000;
    player.relicAuraLastTick    = now2;   // tick imediato na ativação
    effectPayload.duration      = relicDef.duration;
    effectPayload.range         = relicDef.range;
    effectPayload.damage        = auraTickDmg;
    effectPayload.tickInterval  = relicDef.tickInterval;
    // Broadcast para todos verem a aura no barco desse jogador
    addEvent({
      type:     'aura_start',
      crit:     player._relicCrit,
      playerId: player.id,
      range:    player.relicAuraRange,
      duration: relicDef.duration,
    }, player.mapLevel);

  } else if (relicDef.effect === 'monster_skill') {
    // ── Bestiário (r14..r47) ──────────────────────────────────────────
    // UM branch para as 34: a diferença entre a Pinça Esmagadora e a Marcha
    // Fúnebre é DADO (forma/ticks/cc/special em constants/monster_skills.js),
    // não código. Ver managers/monster-skill-manager.js.
    monsterSkillManager.cast(player, relicDef, rTx, rTz, effectPayload);
  }

  // Treino: concede XP de relíquia por usar (sem NPCs para acertar)
  if (MAP_DEFS[player.mapLevel]?.isTrainingMap) {
    grantSkillXp(player, 'reliquia', 30, wss);
  }

  sendTo(player.ws, effectPayload);
}

// ── Pet: dano em área de relíquia usada pelo pet ──────────────────────────────
// Mesmo tratamento de morte de NPC dos efeitos lightning/rocket/meteor do
// handleUseRelic — o DONO do pet recebe as recompensas normalmente.
function relicAreaDamage(player, cx, cz, radius, dmg) {
  const hits = [];
  projectileManager.npcs.forEach(npc => {
    if (npc.dead) return;
    if ((npc.mapLevel || 1) !== (player.mapLevel || 1)) return;
    if (Math.hypot(npc.x - cx, npc.z - cz) > radius) return;
    npc.hp = Math.max(0, npc.hp - dmg);
    npc.lastDamageTime = Date.now();
    hits.push({ id: npc.id, hp: npc.hp, isNPC: true, dmg });
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
          const _bLvl = npc.mapLevel || 1;
          const bMgr = projectileManager.bossManagers.get(_bLvl)
                     || (_bLvl === 2 ? bossManager2 : bossManager);
          bMgr && bMgr.onBossDead(npc, player.id);
          worldBossManager.onZoneBossDead(npc, player.id);
        }
        projectileManager.npcs.delete(npc.id);
      } else {
        const rewards = projectileManager.grantNpcKillRewards(player, npc);
        addEvent({ type: 'entity_dead', id: npc.id, isNPC: true, killerId: player.id, goldDrop: rewards.goldDrop }, npc.mapLevel);
        const _nLvl = npc.mapLevel || 1;
        const mgr = _nLvl === 1 ? npcManager : _nLvl === 2 ? npcManager2 : getMapManager(_nLvl);
        mgr && mgr.respawnScaled(npc.id, player.npcKills || 0, _nLvl);
        _npcKillBossAccounting(_nLvl, player.npcKills || 0);
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
    if (!relicCanHitPlayer(player, p)) return;
    if (Math.hypot(p.x - cx, p.z - cz) > radius) return;
    p.hp = Math.max(0, p.hp - dmg);
    p.lastCombatTime = Date.now();
    hits.push({ id: p.id, hp: p.hp, isNPC: false, dmg });
    resolvePlayerDeath(p, player.id);
  });
  return hits;
}

// Pet usa relíquia ofensiva: petManager valida (pet ativo, relíquia no pet,
// CD, range tolerante) e aqui executamos o efeito com os mesmos VFX das
// relíquias do jogador (cliente já renderiza lightning/rocket/meteor).
function handlePetUseRelic(player, msg) {
  const v = petManager.validateOffensiveUse(player, msg);
  if (!v) return;
  const { relicDef, npc, dmgMult } = v;
  const dmg    = Math.max(1, Math.round(relicDamageFor(player, relicDef) * dmgMult));
  console.log(`[Pet] 🐾 ${player.name}: pet usou ${relicDef.effect} em ${npc.id} (dmg=${dmg}, mult=${dmgMult.toFixed(2)})`);
  const tx     = npc.x, tz = npc.z;
  const mapLvl = player.mapLevel || 1;
  const radius = relicDef.radius || 30;

  // Pet NÃO tem tempo de cast (flag fromPet): o telegraph fica só pro VFX
  // fazer sentido visual — o dano cai quase instantâneo. Balanceamento: o CD
  // por raridade (20/18/15/10s) é o custo, não a esquiva.
  const PET_CAST_MS = 250;

  if (relicDef.effect === 'lightning') {
    addEvent({ type: 'lightning_cast', casterId: player.id, targetX: tx, targetZ: tz, radius, castMs: PET_CAST_MS, fromPet: true }, mapLvl);
    setTimeout(() => {
      if (player.dead) return;
      const hits = relicAreaDamage(player, tx, tz, radius, dmg);
      addEvent({ type: 'lightning_strike', casterId: player.id, targetX: tx, targetZ: tz, hits, fromPet: true }, mapLvl);
    }, PET_CAST_MS);

  } else if (relicDef.effect === 'rocket') {
    addEvent({ type: 'rocket_cast', casterId: player.id, fromX: player.x, fromZ: player.z, targetX: tx, targetZ: tz, radius, castMs: PET_CAST_MS, fromPet: true }, mapLvl);
    setTimeout(() => {
      if (player.dead) return;
      const hits = relicAreaDamage(player, tx, tz, radius, dmg);
      addEvent({ type: 'rocket_strike', casterId: player.id, targetX: tx, targetZ: tz, hits, fromPet: true }, mapLvl);
    }, PET_CAST_MS);

  } else if (relicDef.effect === 'meteor') {
    addEvent({ type: 'meteor_incoming', x: tx, z: tz, radius, castMs: PET_CAST_MS, fromPet: true }, mapLvl);
    setTimeout(() => {
      if (player.dead) return;
      const hits = relicAreaDamage(player, tx, tz, radius, dmg);
      addEvent({ type: 'meteor_strike', x: tx, z: tz, radius, hits, fromPet: true }, mapLvl);
    }, PET_CAST_MS);
  }
}

function handleBuyTalent(player, msg) {
  const { talentId } = msg;
  const tDef = TALENT_DEFS[talentId];
  if (!tDef) return;
  if (!player.talents) player.talents = { totalSpent: 0 };
  const curLevel    = player.talents[talentId] || 0;
  const totalSpent  = player.talents.totalSpent || 0;

  // Nível máximo
  if (curLevel >= tDef.max) {
    sendTo(player.ws, { type: 'error', message: `${tDef.name} já está no nível máximo!` });
    return;
  }

  // Gate de anel: os anéis externos só abrem com pontos investidos NA MESMA
  // árvore — senão dava para comprar um capstone com o primeiro ponto da conta.
  if (tDef.ring > 0) {
    const need  = RING_GATE[tDef.ring] || 0;
    const spent = _countTreeSpent(player, TALENT_DEFS, tDef.tree);
    if (spent < need) {
      sendTo(player.ws, { type: 'error', message: `Investe ${need} pontos em ${tDef.tree} para abrir este anel (tem ${spent}).` });
      return;
    }
  }

  // Requisito de XP (não gasta XP, apenas verifica o mínimo)
  const xpReq = _calcXpRequired(totalSpent, TALENT_XP_BASE, TALENT_XP_GROWTH, TALENT_XP_CAP);
  if ((player.mapXp || 0) < xpReq) {
    sendTo(player.ws, { type: 'error', message: `XP insuficiente! Necessário: ${xpReq.toLocaleString()} XP de mapa` });
    return;
  }

  // Custo em moeda (talentPoints gratuitos têm prioridade)
  let costTier = TALENT_COST_TIERS[TALENT_COST_TIERS.length - 1];
  for (const tier of TALENT_COST_TIERS) { if (totalSpent < tier.upTo) { costTier = tier; break; } }

  // Quanto saiu do bolso de verdade — o ponto gratuito do reset não gasta nada,
  // e o extrato não pode inventar um gasto que não houve.
  let talentPaid = null;
  if ((player.talentPoints || 0) > 0) {
    // Usa um ponto gratuito do reset — sem custo de moeda
    player.talentPoints -= 1;
  } else if (costTier.currency === 'gold') {
    if ((player.gold || 0) < costTier.cost) { sendTo(player.ws, { type: 'error', message: `Ouro insuficiente! Necessário: ${costTier.cost}` }); return; }
    player.gold -= costTier.cost;
    talentPaid = { gold: -costTier.cost };
  } else {
    if ((player.dobroes || 0) < costTier.cost) { sendTo(player.ws, { type: 'error', message: `Dobrões insuficientes! Necessário: ${costTier.cost}` }); return; }
    player.dobroes -= costTier.cost;
    talentPaid = { dobroes: -costTier.cost };
  }

  if (talentPaid) {
    journalManager.ledger(player, JOURNAL_SRC.TALENT, talentPaid,
      { detail: talentId, n: curLevel + 1 });
  }

  // Aplica o nível
  player.talents[talentId] = curLevel + 1;
  player.talents.totalSpent = totalSpent + 1;

  // Sem lista de "quais stats merecem recálculo": a compra vale na hora, seja
  // qual for o talento. A lista antiga só cobria vida plana e slot de canhão,
  // então Casco Reforçado e Reservatório Arcano não faziam nada até relogar.
  refreshTalentDerived(player);

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
    maxMana:      player.maxMana,
    mana:         player.mana,
  });
}

/**
 * Devolve UM nível de um talento (clique direito no nó do painel).
 *
 * O ponto volta como `talentPoints` livre, igual ao reset — a moeda gasta na
 * compra NÃO é devolvida. Sem isso, comprar e devolver em sequência seria uma
 * torneira: o custo sobe por `totalSpent`, que também cai na devolução, então
 * daria para farmar a diferença entre os degraus da tabela de preço.
 */
function handleRefundTalent(player, msg) {
  const { talentId } = msg;
  const tDef = TALENT_DEFS[talentId];
  if (!tDef || !player.talents) return;

  const erro = _validateRefundTalent(player, talentId, {
    talentDefs: TALENT_DEFS,
    ringGate:   RING_GATE,
  });
  if (erro) { sendTo(player.ws, { type: 'error', message: erro }); return; }

  player.talents[talentId]  = (player.talents[talentId] || 0) - 1;
  player.talents.totalSpent = Math.max(0, (player.talents.totalSpent || 0) - 1);
  player.talentPoints       = (player.talentPoints || 0) + 1;

  refreshTalentDerived(player);
  // Devolver Bateria Extra encolhe o limite de canhões — corta o excedente.
  const trim = _trimCannons(player.cannons, player.maxCannons);
  if (trim.removed > 0) { player.cannons = trim.cannons; recalcCannons(player); }

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
    maxMana:      player.maxMana,
    mana:         player.mana,
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
  refreshTalentDerived(player);
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
    maxMana:      player.maxMana,
    mana:         player.mana,
    resetMsg:     `Resetado! +${total} ponto${total !== 1 ? 's' : ''} de talento para usar livremente.`,
  });
}

// ── Builds de talento — 3 slots por capitão ──────────────────────────────────
// Guardar e recolocar uma árvore inteira. Não é um atalho de poder: resetar já
// devolvia todos os pontos de graça (handleResetTalents) e ponto devolvido não
// custa moeda para regastar, então trocar de build sempre foi grátis — só era
// insuportável de fazer à mão, nó por nó. O slot guarda o mapa de níveis e
// nada mais; o custo em moeda ficou lá atrás, na primeira compra de cada ponto.
const TALENT_BUILD_SLOTS = 3;

function _normalizeBuilds(player) {
  if (!Array.isArray(player.talentBuilds)) player.talentBuilds = [];
  player.talentBuilds.length = TALENT_BUILD_SLOTS;
  for (let i = 0; i < TALENT_BUILD_SLOTS; i++) {
    if (!player.talentBuilds[i] || typeof player.talentBuilds[i] !== 'object') {
      player.talentBuilds[i] = null;
    }
  }
  return player.talentBuilds;
}

function _sendTalentUpdate(player, extra = {}) {
  sendTo(player.ws, Object.assign({
    type:         'talent_update',
    talents:      player.talents,
    talentPoints: player.talentPoints || 0,
    talentBuilds: _normalizeBuilds(player),
    gold:         player.gold,
    dobroes:      player.dobroes,
    maxHp:        player.maxHp,
    hp:           player.hp,
    maxCannons:   player.maxCannons,
    maxMana:      player.maxMana,
    mana:         player.mana,
  }, extra));
}

function handleSaveTalentBuild(player, msg) {
  const slot = Math.floor(Number(msg.slot));
  if (!(slot >= 0 && slot < TALENT_BUILD_SLOTS)) return;

  const nodes = _snapshotBuild(player, TALENT_DEFS);
  if (Object.keys(nodes).length === 0) {
    sendTo(player.ws, { type: 'error', message: 'Não há nada na árvore para guardar.' });
    return;
  }
  _normalizeBuilds(player)[slot] = {
    nodes,
    spent:   player.talents?.totalSpent || 0,
    savedAt: Date.now(),
  };
  db.save(player, true).catch(e => console.error('Save error:', e));
  _sendTalentUpdate(player, { buildMsg: `Build guardada no slot ${slot + 1}.` });
}

function handleLoadTalentBuild(player, msg) {
  const slot = Math.floor(Number(msg.slot));
  if (!(slot >= 0 && slot < TALENT_BUILD_SLOTS)) return;

  const build = _normalizeBuilds(player)[slot];
  if (!build) { sendTo(player.ws, { type: 'error', message: 'Slot vazio.' }); return; }

  const erro = _validateBuild(player, build.nodes, {
    talentDefs: TALENT_DEFS,
    ringGate:   RING_GATE,
  });
  if (erro) { sendTo(player.ws, { type: 'error', message: erro }); return; }

  _applyBuild(player, build.nodes, TALENT_DEFS);
  refreshTalentDerived(player);
  // Trocar de build pode encolher o limite de canhões (Bateria Extra saiu) —
  // mesmo corte do reset e da devolução avulsa.
  const trim = _trimCannons(player.cannons, player.maxCannons);
  if (trim.removed > 0) { player.cannons = trim.cannons; recalcCannons(player); }

  db.save(player, true).catch(e => console.error('Save error:', e));
  _sendTalentUpdate(player, { buildMsg: `Build ${slot + 1} aplicada.` });
}

function handleEquipNavio(player, msg, ws) {
  const { SHIP_DEFS } = require('./constants');
  const ship = SHIP_DEFS[msg.shipId];
  if (!ship) return;
  // Navio bônus se equipa por handleActivateBonusShip (que carrega os stats
  // ROLADOS da instância). Passar por aqui zeraria activeBonusShipStats e o
  // jogador perderia a rolagem, ficando com o piso da tabela.
  if (ship.bonusOnly) { sendTo(ws, { type:'error', message:'Use o Banco para ativar um navio bônus' }); return; }
  if (!player.inventory.ships.includes(msg.shipId)) return;
  player.activeShip           = msg.shipId;
  player.activeBonusShipStats = null; // limpa navio bônus ao equipar navio regular
  player.damageMult    = ship.damageMult ?? 1.0;
  player.dropBonus     = ship.dropBonus || 0;
  player.shipSpeedMult = ship.speedMult || 1.0;
  // Vida, canhões e mana do navio novo JÁ com os talentos — a linha de mana que
  // existia aqui não somava o Reservatório Arcano, então trocar de navio comia
  // a mana extra até o próximo login.
  refreshTalentDerived(player);
  // Trim equipped cannons if over new limit
  const trimResult3 = _trimCannons(player.cannons, player.maxCannons);
  if (trimResult3.removed > 0) { player.cannons = trimResult3.cannons; recalcCannons(player); }
  // Idem para os curandeiros: elite tem 10 vagas, navio normal 5.
  refreshHealerSlots(player);
  const newShipReliqC = SHIP_RELIQC[msg.shipId] || {};
  player.maxRelics = newShipReliqC.maxHelic ?? 4;
  player.relicDeck = _normalizeDeck(player.relicDeck, player.maxRelics);
  db.save(player, true).catch(e => console.error('Save error:', e));
  sendTo(ws, {
    type:      'ship_update',
    shipId:    msg.shipId,
    maxHp:     player.maxHp,
    hp:        player.hp,
    maxCannons: player.maxCannons,
    maxHealers: player.maxHealers,
    pirates:   player.pirates || [],
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
  if (auctionManager) auctionManager.destroy();
  
  // Destroi managers dinâmicos (mapas 3-6 e bônus)
  for (const { npc, boss } of regularManagers.values()) {
    if (npc  && !npc.destroyed)  npc.destroy();
    if (boss && !boss.destroyed) boss.destroy();
  }
  for (const mgr of bonusNpcManagers.values()) {
    if (mgr && !mgr.destroyed) mgr.destroy();
  }

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

const PORT = process.env.PORT || 3001;

// Sobe o servidor imediatamente — /api/constants não precisa de banco
server.listen(PORT, () => console.log(`\n⚓  Sea of Code on http://localhost:${PORT}\n`));

// Conecta ao banco em background (WebSocket/jogo só funcionam depois)
db.init().then(async () => {
  // Carrega os leilões e resolve os que venceram com o servidor fora do ar.
  // Antes do log de "DB pronto" de propósito: enquanto isto não termina, um
  // jogador poderia reanunciar um navio que já está em leilão.
  await auctionManager.init();
  console.log('✅ DB pronto — jogo totalmente operacional');
}).catch(err => {
  console.error('❌ Falha ao conectar ao banco:', err.message);
  process.exit(1);
});