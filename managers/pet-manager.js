// managers/pet-manager.js
//
// Sistema de pets v2 (Session 13):
//   • Spawn nas ruínas: máx 1 por ruína, máx MAX_WILD_PETS no jogo todo.
//     Ruína entra em cooldown de 2h quando o pet dela é capturado.
//     Pet selvagem NÃO é atacável — entidade pura de captura.
//   • Captura por proximidade: círculo de CAPTURE_RADIUS ao redor do pet.
//     O pet foca quem está há mais tempo dentro do círculo; sair reseta o
//     próprio tempo; troca de foco reseta o progresso. 3min de foco → captura.
//     Quem já possui o tipo é ignorado pelo pet.
//   • Ataque/defesa: o pet usa RELÍQUIAS que o dono equipa nele (petUsable
//     em constants/relics.js). Ofensivas: cliente pede via pet_use_relic e o
//     servidor valida CD/range. Defensivas: interceptOwnerDamage() roda ANTES
//     do dano ser aplicado ao dono (hook em attack/projectile-manager).
//   • Comida: sem comida o pet não morre — fica INATIVO (some do mundo,
//     continua equipado). Comprar comida reativa (onFoodPurchased).
//
// Cliente envia:  pet_equip, pet_use_relic, pet_relic_equip, pet_relic_unequip
// Servidor envia: pet_update, pet_captured, pet_xp_update, pet_level_up,
//                 pet_inactive, pet_reactivated, pet_food_tick,
//                 pet_relic_update, pet_relic_used,
//                 wild_pet_spawn, wild_pet_removed, pet_capture_state

'use strict';

const { uid, sendTo } = require('../utils/helpers');
const { RELIC_DEFS }  = require('../constants/relics');

// ── Definições dos pets (espelhadas do PetData.gd) ────────────────────────────
// navType:  'perto' | 'medio' | 'longo' — distância de órbita ao redor do barco
// moveType: 'voador' | 'nadador'        — estilo de movimento (visual no cliente)
// Comida única: UVA 🍇 (todos os pets comem o mesmo item)
const PET_DEFS = {
  fire_spirit:  { id: 'fire_spirit',  rarity: 2 /* EPIC */,      speed: 22, navType: 'medio', moveType: 'voador',  maps: [1,2,3,4,5], food: 'uva' },
  water_dragon: { id: 'water_dragon', rarity: 3 /* LEGENDARY */, speed: 18, navType: 'medio', moveType: 'nadador', maps: [1,2,4],     food: 'uva' },
  storm_hawk:   { id: 'storm_hawk',   rarity: 1 /* RARE */,      speed: 30, navType: 'longo', moveType: 'voador',  maps: [2,3,5],     food: 'uva' },
  coral_golem:  { id: 'coral_golem',  rarity: 1 /* RARE */,      speed: 12, navType: 'perto', moveType: 'nadador', maps: [1,3,4],     food: 'uva' },
  void_wisp:    { id: 'void_wisp',    rarity: 0 /* COMMON */,    speed: 20, navType: 'perto', moveType: 'voador',  maps: [3,5],       food: 'uva' },
};

// Raridade → chance de spawn % (soma < 100: o resto do roll não spawna nada)
const SPAWN_CHANCE = { 0: 30, 1: 10, 2: 3, 3: 1 };

// ── Constantes de balanceamento ───────────────────────────────────────────────
const MAX_WILD_PETS     = 5;                    // pets selvagens no jogo TODO
const RUIN_COOLDOWN_MS  = 2 * 60 * 60 * 1000;   // 2h após captura
const SPAWN_CHECK_MS    = 5 * 60 * 1000;        // tenta 1 spawn a cada 5min
const CAPTURE_RADIUS    = 50;                   // raio do círculo de captura
const CAPTURE_TIME_MS   = 3 * 60 * 1000;        // 3min de foco contínuo
const CAPTURE_TICK_MS   = 1000;                 // tick de captura/guard

// Distância de órbita por navType (unidades do mundo)
const NAV_DIST  = { perto: 12, medio: 30, longo: 60 };
// Range de uso de relíquia: distância máx do pet ao ALVO (dono ou inimigo)
const PET_RANGE = { curto: 25, medio: 80, longo: 150 };
const RANGE_TOLERANCE = 40; // tolerância na validação server-side (posição do pet é client-side)

// Stats por raridade — épico/lendário "ganham mais status"
const RARITY_DMG_MULT   = { 0: 0.6, 1: 0.8, 2: 1.0, 3: 1.2 };
// CD das relíquias do pet POR RARIDADE (qualquer relíquia): comum 20s, raro 18s,
// épico 15s, lendário 10s — reduzido pelo nível do pet
const RARITY_CD_MS      = { 0: 20000, 1: 18000, 2: 15000, 3: 10000 };
const RELIC_SLOTS_BY_RARITY = { 0: 1, 1: 1, 2: 2, 3: 2 };   // comum/raro=1, épico/lendário=2
const LEVEL_DMG_BONUS   = 0.05;  // +5% dano de relíquia por nível
const LEVEL_CD_BONUS    = 0.02;  // -2% CD por nível (piso 50%)

// Gatilhos defensivos (fração do maxHp APÓS o hit)
const TRIGGER_INVINCIBLE = 0.25;
const TRIGGER_HEAL       = 0.60;
const TRIGGER_SPEED      = 0.50;
// Guard mode ANTES dos gatilhos (75%): o pet precisa estar a range curto do
// dono para a defensiva disparar — se só se aproximasse a 50%, a cura de 60%
// nunca sairia com pets de navegação média/longa
const GUARD_HP_PCT       = 0.75;

// Comida / XP
const FOOD_PER_HOUR    = 10.0;
const FOOD_TICK_MS     = 60_000;
const XP_PER_OFFENSIVE = 8;
const XP_PER_DEFENSIVE = 10;
const XP_PER_FOOD_TICK = 0.5;
const FOOD_PRICES      = { uva: 30 };

function xpForLevel(level) {
  return 100 + (level - 1) * 50; // 100, 150, 200...
}

class PetManager {
  /**
   * @param {WebSocketServer} wss
   * @param {Map} players         — mapa id → player do server.js
   * @param {Object} db           — DBManager
   */
  constructor(wss, players, db) {
    this.wss     = wss;
    this.players = players;
    this.db      = db;

    // Pets selvagens ativos: id → { id, petId, rarity, mapLevel, ruinKey, x, z,
    //   spawnedAt, inside: Map<playerId, enteredAt>, focusId, focusStartAt }
    this.wildPets = new Map();

    // Cooldown pós-captura por ruína: ruinKey → timestamp de liberação
    this.ruinCooldownUntil = new Map();

    // Posições reais das ruínas por mapa — espelha RUINS_DEFS do main.gd (X, Z)
    this.ruinPositions = {
      1: [ // Mar dos Corsários
        [ -310,  -210],  // ruined_stone_tower
        [  310,  -210],  // underwater_rock_spikes
        [  486,   360],  // large_underwater_mountain
        [ -355,   361],  // wooden_dock_structure
      ],
      2: [ // Mares do Norte — sem ruínas definidas, usa posições genéricas
        [ -400,  -400], [ 400, -400], [ 400, 400], [-400, 400],
      ],
      3: [ // Abismo escuro
        [ 1291,  -310],  // abandoned_graveyard
        [-1319,  -239],  // abandoned_graveyard
        [ 1001, -1201],  // large_ancient_stone_statue_in_ruins
        [ -875,   307],  // large_ancient_stone_statue_in_ruins
        [-1645,  1493],  // underwater_fissure
        [ 1380,  1099],  // ancient_temple
        [-1150, -1078],  // sharp_underwater_rock_formations
      ],
      4: [ // Oceano azul
        [  330,   250],  // broken_pirate_shipwreck
        [  805,   977],  // underwater_rock_spikes
        [ -787,  -700],  // ancient_stone_arch
        [ -847,   600],  // large_underwater_mountain
        [  630,  -712],  // small_ruin_fragments
      ],
      5: [ // Vazio
        [  210,   190],  // underwater_fissure_emitting_mysterious_energy
        [ -310,  -260],
        [  390,   360],
        [ -390,   210],
        [ -210,   310],  // abandoned_graveyard
        [  360,  -310],  // large_ancient_stone_statue_in_ruins
        [  290,  -390],  // sharp_underwater_rock_formations
      ],
    };

    // Cooldown de relíquia do pet: `${playerId}.${instanceId}` → expiresAt
    this._relicCds = new Map();

    // Injetados pelo server.js após construção:
    this.projectileManager = null;   // lookup de NPCs (validação de alvo)
    this.addEvent          = null;   // broadcast em lote por mapa

    this._spawnCheckInterval = setInterval(() => this._checkAllSpawns(), SPAWN_CHECK_MS);
    this._foodInterval       = setInterval(() => this._tickAllFood(),    FOOD_TICK_MS);
    this._captureInterval    = setInterval(() => { this._tickCaptures(); this._tickGuard(); this._tickMapChanges(); }, CAPTURE_TICK_MS);

    console.log('[Pet] PetManager v2 iniciado');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Handlers de mensagens do cliente
  // ═══════════════════════════════════════════════════════════════════════════

  handleMessage(player, data) {
    switch (data.type) {
      case 'pet_equip':         return this._handleEquip(player, data);
      case 'pet_relic_equip':   return this._handleRelicEquip(player, data);
      case 'pet_relic_unequip': return this._handleRelicUnequip(player, data);

      // Debug commands
      case 'debug_spawn_pet':  return this._debugSpawnPet(player, data);
      case 'debug_give_food':  return this._debugGiveFood(player, data);
      case 'debug_level_pet':  return this._debugLevelPet(player, data);
      case 'debug_list_pets':  return this._debugListPets(player);
      case 'debug_spawn_test_pets': return this._debugSpawnTestPets(player);
    }
  }

  // ── Equipar pet ───────────────────────────────────────────────────────────

  _handleEquip(player, data) {
    const petId = data.petId || '';

    if (petId === '') {
      player.equippedPet = '';
      player.petActive   = false;
      player._petDist    = null;
      this._sendPetUpdate(player);
      this.db.save(player);
      return;
    }

    const owned = (player.ownedPets || []).find(p => p.id === petId);
    if (!owned) {
      sendTo(player.ws, { type: 'pet_error', reason: 'Você não possui esse pet.' });
      return;
    }

    player.equippedPet = petId;
    player.petActive   = this._foodCount(player, petId) > 0;
    player._petDist    = null;
    this._sendPetUpdate(player);
    if (!player.petActive) {
      sendTo(player.ws, { type: 'pet_inactive', petId, reason: `Seu pet está sem ${PET_DEFS[petId]?.food || 'comida'}.` });
    }
    this.db.save(player);
    console.log(`[Pet] ${player.name} equipou ${petId} (ativo=${player.petActive})`);
  }

  _sendPetUpdate(player) {
    sendTo(player.ws, {
      type:        'pet_update',
      equippedPet: player.equippedPet || '',
      ownedPets:   player.ownedPets   || [],
      petLevels:   player.petLevels   || {},
      petXp:       player.petXp       || {},
      petRelics:   player.petRelics   || {},
      petActive:   !!player.petActive,
    });
  }

  // ── Relíquias no pet ──────────────────────────────────────────────────────

  relicSlotsFor(petId) {
    const def = PET_DEFS[petId];
    return RELIC_SLOTS_BY_RARITY[def?.rarity ?? 0] || 1;
  }

  _handleRelicEquip(player, data) {
    const petId      = String(data.petId || '');
    const instanceId = String(data.instanceId || '');
    if (!petId || !instanceId) return;

    const def = PET_DEFS[petId];
    if (!def || !(player.ownedPets || []).some(p => p.id === petId)) {
      sendTo(player.ws, { type: 'pet_error', reason: 'Você não possui esse pet.' });
      return;
    }

    const instance = (player.inventory?.relics || []).find(r => r.instanceId === instanceId);
    if (!instance) {
      sendTo(player.ws, { type: 'pet_error', reason: 'Relíquia não encontrada no inventário.' });
      return;
    }

    const rdef = RELIC_DEFS[instance.relicId];
    if (!rdef?.petUsable) {
      sendTo(player.ws, { type: 'pet_error', reason: 'Essa relíquia não pode ser usada por pets.' });
      return;
    }

    // A relíquia pode estar no deck do jogador E no pet ao mesmo tempo —
    // o jogador usa com mana, o pet usa com o próprio CD.
    if (!player.petRelics) player.petRelics = {};
    // Já alocada em algum pet?
    for (const [pid, list] of Object.entries(player.petRelics)) {
      if ((list || []).includes(instanceId)) {
        sendTo(player.ws, { type: 'pet_error', reason: `Relíquia já equipada no pet ${pid}.` });
        return;
      }
    }

    const slots = this.relicSlotsFor(petId);
    const list  = player.petRelics[petId] || [];
    if (list.length >= slots) {
      sendTo(player.ws, { type: 'pet_error', reason: `Esse pet só tem ${slots} slot(s) de relíquia.` });
      return;
    }

    list.push(instanceId);
    player.petRelics[petId] = list;
    sendTo(player.ws, { type: 'pet_relic_update', petId, relics: list, petRelics: player.petRelics });
    this.db.save(player, true);
    console.log(`[Pet] ${player.name} equipou relíquia ${instance.relicId} (${instanceId}) no pet ${petId}`);
  }

  _handleRelicUnequip(player, data) {
    const petId      = String(data.petId || '');
    const instanceId = String(data.instanceId || '');
    if (!petId || !player.petRelics?.[petId]) return;

    player.petRelics[petId] = player.petRelics[petId].filter(id => id !== instanceId);
    sendTo(player.ws, { type: 'pet_relic_update', petId, relics: player.petRelics[petId], petRelics: player.petRelics });
    this.db.save(player, true);
  }

  /** Instância está alocada em ALGUM pet? (use_relic do jogador deve rejeitar) */
  isRelicAllocatedToPet(player, instanceId) {
    if (!player.petRelics) return false;
    for (const list of Object.values(player.petRelics)) {
      if ((list || []).includes(instanceId)) return true;
    }
    return false;
  }

  /** Relíquias do pet resolvidas: [{ instanceId, relicId, rdef }] */
  _petRelicInstances(player, petId) {
    const out = [];
    for (const instanceId of (player.petRelics?.[petId] || [])) {
      const inst = (player.inventory?.relics || []).find(r => r.instanceId === instanceId);
      const rdef = inst ? RELIC_DEFS[inst.relicId] : null;
      if (rdef?.petUsable) out.push({ instanceId, relicId: inst.relicId, rdef });
    }
    return out;
  }

  // ── Stats do pet (raridade + nível) ───────────────────────────────────────

  petDamageMult(player, petId) {
    const def = PET_DEFS[petId];
    if (!def) return 0.6;
    const lv = this._getLevel(player, petId);
    return (RARITY_DMG_MULT[def.rarity] ?? 0.6) * (1 + (lv - 1) * LEVEL_DMG_BONUS);
  }

  petCdMs(player, petId, _rdef) {
    const def = PET_DEFS[petId];
    const lv  = this._getLevel(player, petId);
    const lvMult = Math.max(0.5, 1 - (lv - 1) * LEVEL_CD_BONUS);
    return Math.round((RARITY_CD_MS[def?.rarity ?? 0] || 20000) * lvMult);
  }

  _cdReady(player, instanceId) {
    return (this._relicCds.get(`${player.id}.${instanceId}`) || 0) <= Date.now();
  }

  _startCd(player, petId, instanceId, rdef) {
    const cdMs = this.petCdMs(player, petId, rdef);
    this._relicCds.set(`${player.id}.${instanceId}`, Date.now() + cdMs);
    return cdMs;
  }

  // ── Uso OFENSIVO (pet_use_relic) — validação; execução fica no server.js ──
  // Retorna { relicDef, instanceId, npc, dmgMult, cdMs } ou null (erro já enviado).

  validateOffensiveUse(player, msg) {
    const reject = (why) => {
      console.log(`[Pet] ✋ pet_use_relic rejeitado (${player.name}): ${why}`);
      sendTo(player.ws, { type: 'pet_error', reason: `Pet: ${why}` });
      return null;
    };
    const instanceId = String(msg.instanceId || '');
    const targetId   = String(msg.targetId   || '');
    const petId      = player.equippedPet || '';
    if (!instanceId || !targetId || !petId) return reject('sem instanceId/targetId/pet equipado');
    if (!player.petActive) return reject('pet inativo (sem comida)');

    const def = PET_DEFS[petId];
    if (!def) return null;

    const relics = this._petRelicInstances(player, petId);
    const entry  = relics.find(r => r.instanceId === instanceId);
    if (!entry || entry.rdef.petTarget !== 'inimigo') return reject('relíquia não está no pet ou não é ofensiva');
    if (!this._cdReady(player, instanceId)) return null; // CD é esperado, sem log

    // uid() do servidor gera chaves NUMÉRICAS no Map de NPCs; o cliente manda
    // string — Map.get é type-strict, então tenta os dois
    let npc = this.projectileManager?.npcs.get(targetId);
    if (!npc && !Number.isNaN(Number(targetId))) {
      npc = this.projectileManager?.npcs.get(Number(targetId));
    }
    if (!npc || npc.dead) return reject(`alvo ${targetId} não existe ou morreu`);
    if ((npc.mapLevel || 1) !== (player.mapLevel || 1)) return reject('alvo em outro mapa');

    // Range tolerante: posição do pet é client-side; validamos contra o dono.
    const maxDist = (PET_RANGE[entry.rdef.petRange] || 80)
                  + (NAV_DIST[def.navType] || 30)
                  + RANGE_TOLERANCE;
    const dist = Math.hypot(npc.x - player.x, npc.z - player.z);
    if (dist > maxDist) return reject(`alvo longe demais (${Math.round(dist)} > ${maxDist})`);

    const cdMs = this._startCd(player, petId, instanceId, entry.rdef);
    sendTo(player.ws, {
      type: 'pet_relic_used', petId, instanceId,
      effect: entry.rdef.effect, cdMs, targetId,
    });
    this._addXp(player, petId, XP_PER_OFFENSIVE);
    return { relicDef: entry.rdef, instanceId, npc, dmgMult: this.petDamageMult(player, petId), cdMs };
  }

  // ── Intercept DEFENSIVO — chamado ANTES de aplicar dano de NPC ao jogador ──
  // Retorna o dano final (0 se o pet absorveu com invencibilidade).

  interceptOwnerDamage(player, dmg) {
    if (!player || dmg <= 0) return dmg;
    const petId = player.equippedPet;
    if (!petId || !player.petActive) return dmg;
    const def = PET_DEFS[petId];
    if (!def) return dmg;

    const maxHp   = player.maxHp || 100;
    const hpAfter = player.hp - dmg;

    // Pet precisa estar PERTO do dono — com "lunge": no momento do golpe ele
    // pode dar uma arrancada de meio segundo (curto + speed×0.5). Cobre pets
    // de navegação perto/média instantaneamente; navegação longa ainda precisa
    // se aproximar (trade-off da navegação preservado).
    const dist  = (player._petDist != null) ? player._petDist : (NAV_DIST[def.navType] || 30);
    const lunge = PET_RANGE.curto + (def.speed || 20) * 0.5;
    if (dist > lunge) {
      // Diagnóstico: defensiva teria disparado mas o pet ainda está voltando
      const now = Date.now();
      if (hpAfter <= maxHp * TRIGGER_HEAL && (player._petFarLogAt || 0) < now - 5000) {
        player._petFarLogAt = now;
        console.log(`[Pet] 🛡 ${player.name}: defensiva bloqueada — pet a ${dist.toFixed(0)}u do dono (precisa ≤ ${lunge.toFixed(0)})`);
      }
      return dmg;
    }

    // Prioridade: invencível (emergência) > cura > velocidade — 1 gatilho por hit
    const byPriority = { invincible: 0, heal_ship: 1, speed_boost: 2 };
    const relics = this._petRelicInstances(player, petId)
      .filter(r => r.rdef.petTarget === 'dono' && byPriority[r.rdef.effect] != null)
      .sort((a, b) => byPriority[a.rdef.effect] - byPriority[b.rdef.effect]);

    for (const { instanceId, rdef } of relics) {
      if (!this._cdReady(player, instanceId)) continue;

      if (rdef.effect === 'invincible' && hpAfter <= maxHp * TRIGGER_INVINCIBLE) {
        const cdMs = this._startCd(player, petId, instanceId, rdef);
        player.relicInvincibleExpires = Date.now() + (rdef.duration || 5000);
        this._emitDefense(player, petId, instanceId, rdef, cdMs, { duration: rdef.duration });
        return 0; // golpe absorvido

      } else if (rdef.effect === 'heal_ship' && hpAfter <= maxHp * TRIGGER_HEAL) {
        const cdMs = this._startCd(player, petId, instanceId, rdef);
        const healValue = Math.round(maxHp * (rdef.healPct || 0.30));
        player.hp = Math.min(maxHp, player.hp + healValue);
        this._emitDefense(player, petId, instanceId, rdef, cdMs, { healed: healValue });
        return dmg;

      } else if (rdef.effect === 'speed_boost' && hpAfter <= maxHp * TRIGGER_SPEED) {
        const cdMs = this._startCd(player, petId, instanceId, rdef);
        player.relicSpeedExpires = Date.now() + (rdef.duration || 5000);
        player.relicSpeedBonus   = rdef.speedBonus || 0.5;
        this._emitDefense(player, petId, instanceId, rdef, cdMs, { duration: rdef.duration });
        return dmg;
      }
    }
    return dmg;
  }

  _emitDefense(player, petId, instanceId, rdef, cdMs, extra) {
    // O lunge aconteceu — o pet agora está colado no dono
    player._petDist = Math.min(player._petDist ?? 5, 5);
    sendTo(player.ws, {
      type: 'pet_relic_used', petId, instanceId,
      effect: rdef.effect, cdMs,
      hp: player.hp, maxHp: player.maxHp,
      ...extra,
    });
    // VFX no mapa — cliente já renderiza relic_effect (bolhas no barco do dono)
    if (this.addEvent) {
      this.addEvent({
        type:     'relic_effect',
        casterId: player.id,
        effect:   rdef.effect,
        fromPet:  true,
        petId,
        duration: rdef.duration,
      }, player.mapLevel || 1);
    }
    this._addXp(player, petId, XP_PER_DEFENSIVE);
    console.log(`[Pet] 🛡 ${player.name}: pet ${petId} usou ${rdef.effect} (defensivo)`);
  }

  // ── Guard mode: distância escalar do pet ao dono (modelo server-side) ─────
  // O cliente espelha a mesma regra visualmente (HP < 50% → pet voa pra perto).

  _tickGuard() {
    const now = Date.now();
    for (const [, p] of this.players) {
      if (!p || !p.equippedPet || !p.petActive) { if (p) p._petDist = null; continue; }
      const def = PET_DEFS[p.equippedPet];
      if (!def) continue;

      const navDist = NAV_DIST[def.navType] || 30;
      if (p._petDist == null) p._petDist = navDist;

      const hasDefensive = this._petRelicInstances(p, p.equippedPet)
        .some(r => r.rdef.petTarget === 'dono');
      // Guard ao ENTRAR EM COMBATE (não só por HP): o pet precisa já estar
      // perto quando o burst chegar — se esperasse o HP cair, o primeiro
      // golpe grande passava sem proteção
      const inCombat  = (now - (p.lastCombatTime || 0)) < 8000;
      const wantGuard = hasDefensive && (inCombat || p.hp < (p.maxHp || 100) * GUARD_HP_PCT);
      const desired   = wantGuard ? 0 : navDist;

      const step = (def.speed || 20) * (CAPTURE_TICK_MS / 1000);
      p._petDist += Math.max(-step, Math.min(step, desired - p._petDist));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Spawn de pets selvagens
  // ═══════════════════════════════════════════════════════════════════════════

  _checkAllSpawns() {
    if (this.wildPets.size >= MAX_WILD_PETS) return;
    const now = Date.now();

    const candidates = [];
    for (const [mapLevelStr, positions] of Object.entries(this.ruinPositions)) {
      const mapLevel = Number(mapLevelStr);
      // Só mapas onde algum pet pode nascer
      if (!Object.values(PET_DEFS).some(d => d.maps.includes(mapLevel))) continue;
      for (let i = 0; i < positions.length; i++) {
        const ruinKey = `${mapLevel}_${i}`;
        if ((this.ruinCooldownUntil.get(ruinKey) || 0) > now) continue;
        const alreadyActive = [...this.wildPets.values()].some(w => w.ruinKey === ruinKey);
        if (alreadyActive) continue;
        candidates.push({ mapLevel, i, ruinKey });
      }
    }
    if (candidates.length === 0) return;

    // No máximo 1 spawn por tick — sorteia uma ruína elegível
    const c = candidates[Math.floor(Math.random() * candidates.length)];
    this._trySpawnForRuin(c.mapLevel, c.i, c.ruinKey);
  }

  _trySpawnForRuin(mapLevel, ruinIndex, ruinKey) {
    const eligible = Object.values(PET_DEFS).filter(d => d.maps.includes(mapLevel));
    if (eligible.length === 0) return;

    // Sorteia raridade — se o roll cair fora das chances, nada spawna neste tick
    const roll = Math.random() * 100;
    let cumulative = 0;
    let chosenRarity = -1;
    for (const [rarStr, chance] of Object.entries(SPAWN_CHANCE)) {
      cumulative += chance;
      if (roll <= cumulative) { chosenRarity = Number(rarStr); break; }
    }
    if (chosenRarity === -1) return;

    const byRarity = eligible.filter(d => d.rarity === chosenRarity);
    if (byRarity.length === 0) return;

    const def   = byRarity[Math.floor(Math.random() * byRarity.length)];
    const petId = def.id;
    const id    = uid();

    // Posição real da ruína + pequeno offset aleatório (±15u)
    const ruinPos = (this.ruinPositions[mapLevel] || [])[ruinIndex] || [0, 0];
    const x = ruinPos[0] + (Math.random() - 0.5) * 30;
    const z = ruinPos[1] + (Math.random() - 0.5) * 30;

    const wildPet = {
      id, petId, rarity: def.rarity, mapLevel, ruinKey, x, z,
      spawnedAt:    Date.now(),
      inside:       new Map(),   // playerId → enteredAt
      focusId:      null,
      focusStartAt: 0,
    };
    this.wildPets.set(id, wildPet);

    this._broadcastToMap(mapLevel, this._wildSpawnMsg(wildPet));
    console.log(`[Pet] 🐾 Spawn ${petId} (${['Comum','Raro','Épico','Lendário'][def.rarity]}) mapa=${mapLevel} ruína=${ruinKey} pos=(${x.toFixed(0)}, ${z.toFixed(0)}) — ${this.wildPets.size}/${MAX_WILD_PETS} no mundo`);
  }

  _wildSpawnMsg(wild) {
    return {
      type:     'wild_pet_spawn',
      id:       wild.id,
      petId:    wild.petId,
      rarity:   wild.rarity,
      mapLevel: wild.mapLevel,
      x:        wild.x,
      z:        wild.z,
      radius:   CAPTURE_RADIUS,
    };
  }

  _removeWildPet(id, reason = '', capturedBy = '') {
    const wild = this.wildPets.get(id);
    if (!wild) return;
    this.wildPets.delete(id);
    this._broadcastToMap(wild.mapLevel, {
      type: 'wild_pet_removed', id, petId: wild.petId, capturedBy,
    });
    if (reason) console.log(`[Pet] ${wild.petId} removido (${reason})`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Captura por proximidade (tick de 1s)
  // ═══════════════════════════════════════════════════════════════════════════

  _tickCaptures() {
    const now = Date.now();
    for (const [, wild] of this.wildPets) {
      // Quem está dentro do círculo agora (pet ignora quem já possui o tipo)
      const insideNow = new Set();
      for (const [, p] of this.players) {
        if (!p || p.dead || (p.mapLevel || 1) !== wild.mapLevel) continue;
        if (!p.ws || p.ws.readyState !== 1) continue;
        if ((p.ownedPets || []).some(o => o.id === wild.petId)) continue;
        if (Math.hypot(p.x - wild.x, p.z - wild.z) > CAPTURE_RADIUS) continue;
        insideNow.add(p.id);
        if (!wild.inside.has(p.id)) wild.inside.set(p.id, now);
      }
      // Saiu do círculo → o tempo DELE reseta (dos outros não)
      for (const pid of [...wild.inside.keys()]) {
        if (!insideNow.has(pid)) wild.inside.delete(pid);
      }

      const hadFocus = wild.focusId != null;

      // Foco: quem está há mais tempo dentro do círculo
      let focusId = null, oldest = Infinity;
      for (const [pid, t] of wild.inside) {
        if (t < oldest) { oldest = t; focusId = pid; }
      }

      // Troca de foco (ou início) reseta o progresso de captura
      if (focusId !== wild.focusId) {
        wild.focusId      = focusId;
        wild.focusStartAt = focusId ? now : 0;
      }

      const progressMs = wild.focusId ? (now - wild.focusStartAt) : 0;

      // Captura completa!
      if (wild.focusId && progressMs >= CAPTURE_TIME_MS) {
        const catcher = this.players.get(wild.focusId);
        if (catcher) {
          this._completeCapture(catcher, wild);
          continue;
        }
      }

      // Broadcast do estado (enquanto há disputa, ou 1 último para limpar a UI)
      if (wild.inside.size > 0 || hadFocus) {
        const focusPlayer = wild.focusId ? this.players.get(wild.focusId) : null;
        this._broadcastToMap(wild.mapLevel, {
          type:        'pet_capture_state',
          wildId:      wild.id,
          petId:       wild.petId,
          x:           wild.x,
          z:           wild.z,
          radius:      CAPTURE_RADIUS,
          focusId:     wild.focusId,
          focusName:   focusPlayer?.name || '',
          progressMs,
          totalMs:     CAPTURE_TIME_MS,
          insideCount: wild.inside.size,
        });
      }
    }
  }

  _completeCapture(player, wild) {
    const petId = wild.petId;

    if (!player.ownedPets) player.ownedPets = [];
    if (!player.petLevels) player.petLevels = {};
    if (!player.petXp)     player.petXp     = {};

    if (!player.ownedPets.some(p => p.id === petId)) {
      player.ownedPets.push({ id: petId, level: 1, xp: 0 });
      player.petLevels[petId] = 1;
      player.petXp[petId]     = 0;
    }

    // Ruína entra em cooldown de 2h a partir da captura
    this.ruinCooldownUntil.set(wild.ruinKey, Date.now() + RUIN_COOLDOWN_MS);
    this._removeWildPet(wild.id, `capturado por ${player.name}`, player.name);

    sendTo(player.ws, {
      type:      'pet_captured',
      petId,
      level:     1,
      xp:        0,
      ownedPets: player.ownedPets,
      petLevels: player.petLevels,
      petXp:     player.petXp,
      message:   `🐾 ${petId} capturado!`,
    });

    this.db.save(player, true);
    console.log(`[Pet] ✅ ${player.name} capturou ${petId} após ${(CAPTURE_TIME_MS / 60000).toFixed(0)}min de foco`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Sistema de comida — sem comida o pet fica INATIVO (não desequipa)
  // ═══════════════════════════════════════════════════════════════════════════

  _tickAllFood() {
    for (const [, player] of this.players) {
      if (!player || player.dead || !player.equippedPet) continue;
      this._tickPlayerFood(player);
    }
  }

  _tickPlayerFood(player) {
    const petId = player.equippedPet;
    const def   = PET_DEFS[petId];
    if (!def) return;
    if (!player.petActive) return; // inativo não consome

    const foodItem   = def.food;
    const foodNeeded = FOOD_PER_HOUR / 60.0;

    const inventory = player.inventory || {};
    const foodAmt   = Number(inventory[foodItem] || 0);

    if (foodAmt <= 0) {
      player.petActive = false;
      sendTo(player.ws, {
        type:   'pet_inactive',
        petId,
        reason: `Seu pet ficou sem ${foodItem}! Compre mais no Farol para reativá-lo.`,
      });
      console.log(`[Pet] ${player.name}: pet ${petId} inativo (sem ${foodItem})`);
      this.db.save(player);
      return;
    }

    inventory[foodItem] = Math.max(0, foodAmt - foodNeeded);
    player.inventory = inventory;

    this._addXp(player, petId, XP_PER_FOOD_TICK);

    sendTo(player.ws, {
      type:      'pet_food_tick',
      petId,
      foodItem,
      foodLeft:  inventory[foodItem],
      xp:        player.petXp?.[petId] ?? 0,
      level:     player.petLevels?.[petId] ?? 1,
    });

    this.db.save(player);
  }

  /** Chamado pelo server.js após buy_pet_food — reativa o pet se ganhou comida */
  onFoodPurchased(player) {
    const petId = player.equippedPet;
    if (!petId || player.petActive) return;
    if (this._foodCount(player, petId) <= 0) return;
    player.petActive = true;
    sendTo(player.ws, { type: 'pet_reactivated', petId });
    console.log(`[Pet] ${player.name}: pet ${petId} reativado (comida comprada)`);
  }

  _foodCount(player, petId) {
    const def = PET_DEFS[petId];
    if (!def) return 0;
    return Number(player.inventory?.[def.food] || 0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Sistema de XP e level-up
  // ═══════════════════════════════════════════════════════════════════════════

  _getLevel(player, petId) {
    return (player.petLevels?.[petId]) ?? 1;
  }

  _addXp(player, petId, amount) {
    if (!player.petXp)     player.petXp     = {};
    if (!player.petLevels) player.petLevels = {};

    const currentXp = Number(player.petXp[petId]     || 0);
    const currentLv = Number(player.petLevels[petId] || 1);
    let newXp = currentXp + amount;
    let newLv = currentLv;
    let leveledUp = false;

    while (newXp >= xpForLevel(newLv)) {
      newXp -= xpForLevel(newLv);
      newLv++;
      leveledUp = true;
    }

    player.petXp[petId]     = newXp;
    player.petLevels[petId] = newLv;

    const owned = (player.ownedPets || []).find(p => p.id === petId);
    if (owned) { owned.xp = newXp; owned.level = newLv; }

    sendTo(player.ws, {
      type:   'pet_xp_update',
      petId,
      xp:     newXp,
      level:  newLv,
      xpNext: xpForLevel(newLv),
    });

    if (leveledUp) {
      sendTo(player.ws, {
        type:    'pet_level_up',
        petId,
        level:   newLv,
        message: `🆙 Seu pet subiu para nível ${newLv}!`,
      });
      console.log(`[Pet] ${player.name} pet ${petId} → nível ${newLv}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Player conectou / trocou de mapa
  // ═══════════════════════════════════════════════════════════════════════════

  onPlayerJoined(player) {
    // Ativo = tem comida (estado não persiste; deriva do inventário)
    if (player.equippedPet) {
      player.petActive = this._foodCount(player, player.equippedPet) > 0;
    }
    player._petLastMapLevel = player.mapLevel || 1;
    this._sendWildPetsOfMap(player);
  }

  _sendWildPetsOfMap(player) {
    for (const [, wild] of this.wildPets) {
      if (wild.mapLevel === (player.mapLevel || 1)) {
        sendTo(player.ws, this._wildSpawnMsg(wild));
      }
    }
  }

  // Detecta troca de mapa (borda, respawn, bônus) e reenvia os pets do mapa novo
  _tickMapChanges() {
    for (const [, p] of this.players) {
      if (!p || !p.ws || p.ws.readyState !== 1) continue;
      const lvl = p.mapLevel || 1;
      if (p._petLastMapLevel === lvl) continue;
      p._petLastMapLevel = lvl;
      this._sendWildPetsOfMap(p);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Debug commands (ALLOW_DEBUG_CMDS=1)
  // ═══════════════════════════════════════════════════════════════════════════

  _debugSpawnPet(player, data) {
    const petId    = data.petId || 'void_wisp';
    const def      = PET_DEFS[petId];
    if (!def) return;
    const mapLevel = player.mapLevel || 1;
    const id       = uid();
    const wild     = {
      id, petId, rarity: def.rarity, mapLevel,
      ruinKey: `debug_${Date.now()}`,
      x: player.x + 60, z: player.z,
      spawnedAt: Date.now(),
      inside: new Map(), focusId: null, focusStartAt: 0,
    };
    this.wildPets.set(id, wild);
    this._broadcastToMap(mapLevel, this._wildSpawnMsg(wild));
    sendTo(player.ws, { type: 'notification', msg: `🐾 Pet selvagem ${petId} spawnado próximo a você.` });
  }

  _debugGiveFood(player, data) {
    const amount = Number(data.amount || 50);
    if (!player.inventory) player.inventory = {};
    player.inventory.uva = (player.inventory.uva || 0) + amount;
    this.onFoodPurchased(player);
    sendTo(player.ws, {
      type:         'inventory_update',
      inventory:    player.inventory,
      notification: `🍇 +${amount} uvas adicionadas.`,
    });
    this.db.save(player);
  }

  // Spawn de teste (tecla 3 → "+"): preenche as ruínas do MAPA ATUAL do
  // jogador com pets até o cap global, para playtest imediato.
  _debugSpawnTestPets(player) {
    const mapLevel  = player.mapLevel || 1;
    const positions = this.ruinPositions[mapLevel] || [];
    const eligible  = Object.values(PET_DEFS).filter(d => d.maps.includes(mapLevel));
    if (eligible.length === 0) {
      sendTo(player.ws, { type: 'notification', msg: `🐾 Mapa ${mapLevel} não tem pets elegíveis.` });
      this._debugListPets(player);
      return;
    }

    let spawned = 0;
    for (let i = 0; i < positions.length; i++) {
      if (this.wildPets.size >= MAX_WILD_PETS) break;
      const ruinKey = `${mapLevel}_${i}`;
      if ([...this.wildPets.values()].some(w => w.ruinKey === ruinKey)) continue;

      const def   = eligible[Math.floor(Math.random() * eligible.length)];
      const id    = uid();
      const x     = positions[i][0] + (Math.random() - 0.5) * 30;
      const z     = positions[i][1] + (Math.random() - 0.5) * 30;
      const wild  = {
        id, petId: def.id, rarity: def.rarity, mapLevel, ruinKey, x, z,
        spawnedAt: Date.now(),
        inside: new Map(), focusId: null, focusStartAt: 0,
      };
      this.wildPets.set(id, wild);
      this._broadcastToMap(mapLevel, this._wildSpawnMsg(wild));
      spawned++;
    }

    sendTo(player.ws, { type: 'notification', msg: `🐾 ${spawned} pet(s) de teste spawnados no mapa ${mapLevel}.` });
    console.log(`[Pet] 🧪 Spawn de teste: ${spawned} pets no mapa ${mapLevel} (pedido por ${player.name})`);
    this._debugListPets(player);
  }

  // Lista todos os pets selvagens do MUNDO (todos os mapas) — localizador tecla 3
  _debugListPets(player) {
    const pets = [];
    for (const [, w] of this.wildPets) {
      const focusPlayer = w.focusId ? this.players.get(w.focusId) : null;
      pets.push({
        id:         w.id,
        petId:      w.petId,
        rarity:     w.rarity,
        mapLevel:   w.mapLevel,
        x:          Math.round(w.x),
        z:          Math.round(w.z),
        focusName:  focusPlayer?.name || '',
        progressMs: w.focusId ? (Date.now() - w.focusStartAt) : 0,
        totalMs:    CAPTURE_TIME_MS,
      });
    }
    sendTo(player.ws, { type: 'debug_pet_list', pets, max: MAX_WILD_PETS });
  }

  _debugLevelPet(player, data) {
    const petId    = data.petId || player.equippedPet;
    const newLevel = Number(data.level || 5);
    if (!petId) return;
    if (!player.petLevels) player.petLevels = {};
    if (!player.petXp)     player.petXp = {};
    player.petLevels[petId] = newLevel;
    player.petXp[petId]     = 0;
    const owned = (player.ownedPets || []).find(p => p.id === petId);
    if (owned) { owned.level = newLevel; owned.xp = 0; }
    sendTo(player.ws, {
      type:   'pet_xp_update',
      petId,
      xp:     0,
      level:  newLevel,
      xpNext: xpForLevel(newLevel),
    });
    sendTo(player.ws, { type: 'notification', msg: `🆙 Pet ${petId} setado para nível ${newLevel}.` });
    this.db.save(player);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  _broadcastToMap(mapLevel, msg) {
    for (const [, p] of this.players) {
      if (p && (p.mapLevel || 1) === mapLevel && p.ws && p.ws.readyState === 1 /*OPEN*/) {
        sendTo(p.ws, msg);
      }
    }
  }

  // Inclui dados de pets no payload do init enviado ao jogador.
  // O init é montado ANTES de onPlayerJoined — deriva o estado ativo aqui,
  // senão petActive vai como false e o pet nunca aparece no login.
  injectInitData(player) {
    if (player.equippedPet && player.petActive == null) {
      player.petActive = this._foodCount(player, player.equippedPet) > 0;
    }
    return {
      ownedPets:   player.ownedPets   || [],
      equippedPet: player.equippedPet || '',
      petLevels:   player.petLevels   || {},
      petXp:       player.petXp       || {},
      petRelics:   player.petRelics   || {},
      petActive:   !!player.petActive,
    };
  }

  destroy() {
    clearInterval(this._spawnCheckInterval);
    clearInterval(this._foodInterval);
    clearInterval(this._captureInterval);
  }
}

module.exports = PetManager;
module.exports.PET_DEFS   = PET_DEFS;
module.exports.NAV_DIST   = NAV_DIST;
module.exports.PET_RANGE  = PET_RANGE;
module.exports.FOOD_PRICES = FOOD_PRICES;
