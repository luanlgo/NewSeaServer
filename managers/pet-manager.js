// managers/pet-manager.js
//
// Sistema completo de pets:
//   • Spawn de pets selvagens nas ruínas (cooldown global de 12h por ruína)
//   • Captura por jogador (cooldown de 12h por jogador × ruína)
//   • Consumo de comida (tick a cada 60s = 1/60 hora)
//   • XP por hit e por tick de comida
//   • Level-up automático
//   • Skill broadcast (efeito distribuído a todos do mapa)
//
// Lógica de autoridade: TUDO roda no servidor.
// Cliente apenas envia: pet_equip, pet_attack, pet_skill
// Servidor responde: pet_update, pet_captured, pet_xp_update,
//                    pet_food_depleted, wild_pet_spawn, wild_pet_removed,
//                    pet_skill_effect

'use strict';

const { uid, broadcast, sendTo } = require('../utils/helpers');

// ── Definições dos pets (espelhadas do PetData.gd) ────────────────────────────
const PET_DEFS = {
  fire_spirit:  { id: 'fire_spirit',  rarity: 2 /* EPIC */,      baseDmg: 18, baseHp: 60,  speed: 22, attackSpd: 2.5, skillCd: 20, maps: [1,2,3,4,5], food: 'cerveja',  skill: 0 /* FIREBALL */       },
  water_dragon: { id: 'water_dragon', rarity: 3 /* LEGENDARY */,  baseDmg: 12, baseHp: 100, speed: 18, attackSpd: 3.0, skillCd: 25, maps: [1,2,4],     food: 'frutas',   skill: 1 /* WATER_BLAST */     },
  storm_hawk:   { id: 'storm_hawk',   rarity: 1 /* RARE */,       baseDmg: 10, baseHp: 50,  speed: 30, attackSpd: 1.8, skillCd: 18, maps: [2,3,5],     food: 'cerveja',  skill: 2 /* LIGHTNING */       },
  coral_golem:  { id: 'coral_golem',  rarity: 1 /* RARE */,       baseDmg: 8,  baseHp: 200, speed: 12, attackSpd: 3.5, skillCd: 30, maps: [1,3,4],     food: 'frutas',   skill: 3 /* CORAL_SHIELD */    },
  void_wisp:    { id: 'void_wisp',    rarity: 0 /* COMMON */,     baseDmg: 5,  baseHp: 40,  speed: 20, attackSpd: 2.0, skillCd: 15, maps: [3,5],       food: 'cerveja',  skill: 4 /* CURSE */           },
};

// Raridade → chance de spawn %
const SPAWN_CHANCE = { 0: 30, 1: 10, 2: 3, 3: 1 };

// Raridade → multiplicador de cooldown de skill (menor = mais rápido)
const SKILL_CD_MULT = { 0: 1.0, 1: 0.8, 2: 0.6, 3: 0.4 };

// ── Constantes de balanceamento ───────────────────────────────────────────────
const FOOD_PER_HOUR      = 10.0;    // unidades de comida/hora
const XP_PER_HIT         = 5.0;    // XP por acerto do pet
const XP_PER_FOOD_TICK   = 0.5;    // XP por tick de comida
const LEVEL_DMG_BONUS    = 0.10;   // +10% dano por nível
const FOOD_TICK_MS       = 60_000; // 1 tick = 60 segundos
const SPAWN_COOLDOWN_MS  = 0;                     // 0 = sem cooldown (TESTE) — restaurar: 12 * 60 * 60 * 1000
const SPAWN_CHECK_MS     = 10_000;                // Verifica spawns a cada 10s  (TESTE) — restaurar: 5 * 60 * 1000

// ── Preços de comida (autoritativo no servidor — cliente não envia price) ─────
const FOOD_PRICES = { frutas: 30, cerveja: 50 };

function xpForLevel(level) {
  return 100 + (level - 1) * 50; // 100, 150, 200...
}

function calcDamage(petId, level) {
  const def = PET_DEFS[petId];
  if (!def) return 0;
  return def.baseDmg * (1 + (level - 1) * LEVEL_DMG_BONUS);
}

class PetManager {
  /**
   * @param {WebSocketServer} wss
   * @param {Map} players         — mapa name → player do server.js
   * @param {Object} db           — DBManager
   */
  constructor(wss, players, db) {
    this.wss     = wss;
    this.players = players;
    this.db      = db;

    // ── Estado global ──────────────────────────────────────────────────────
    // Pets selvagens ativos no mundo: id → { id, petId, mapLevel, x, z, spawnedAt }
    this.wildPets = new Map();

    // Último spawn por ruína: ruinKey → timestamp
    // ruinKey = "mapLevel_ruinIndex" (ex: "1_0")
    this.ruinSpawnTimes = new Map();

    // Posições reais das ruínas por mapa — espelha RUINS_DEFS do main.gd (X, Z)
    // Y ignorado (pet flutua na superfície)
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
      10: [ // Bônus
        [  860,  -897],  // pirate_camp_environment
        [ -350,  -938],  // broken_pirate_shipwreck
        [ -625,   147],  // wooden_dock_structure
        [ -781,  -720],  // ruined_stone_tower
        [ -990,   -80],  // ancient_stone_arch
        [ -490,   860],  // sharp_underwater_rock_formations
      ],
    };
    // Compatibilidade: contagem por mapa
    this.ruinCounts = Object.fromEntries(
      Object.entries(this.ruinPositions).map(([k, v]) => [k, v.length])
    );

    // Timer de consumo de comida: petId no player → last tick timestamp
    // Chave: playerName + '.' + petId
    this.foodTimers = new Map();

    // Referência ao projectileManager (injetada de server.js após construção)
    this.projectileManager = null;

    // Timers internos
    this._spawnCheckInterval = setInterval(() => this._checkAllSpawns(), SPAWN_CHECK_MS);
    this._foodInterval       = setInterval(() => this._tickAllFood(),    FOOD_TICK_MS);
    this._combatInterval     = setInterval(() => this._tickWildCombat(), 2000); // ataque a cada 2s

    console.log('[Pet] PetManager iniciado');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Handlers de mensagens do cliente
  // ═══════════════════════════════════════════════════════════════════════════

  handleMessage(player, data) {
    switch (data.type) {
      case 'pet_equip':     return this._handleEquip(player, data);
      case 'pet_attack':    return this._handleAttack(player, data);
      case 'pet_skill':     return this._handleSkill(player, data);
      case 'pet_capture':   return this._handleCapture(player, data);

      // Debug commands
      case 'debug_spawn_pet':  return this._debugSpawnPet(player, data);
      case 'debug_give_food':  return this._debugGiveFood(player, data);
      case 'debug_level_pet':  return this._debugLevelPet(player, data);
    }
  }

  // ── Equipar pet ───────────────────────────────────────────────────────────

  _handleEquip(player, data) {
    const petId = data.petId || '';

    if (petId === '') {
      player.equippedPet = '';
      this._stopFoodTimer(player.name, player.equippedPet);
      sendTo(player.ws, { type: 'pet_update', equippedPet: '', ownedPets: player.ownedPets || [] });
      this.db.save(player);
      return;
    }

    const owned = (player.ownedPets || []).find(p => p.id === petId);
    if (!owned) {
      sendTo(player.ws, { type: 'pet_error', reason: 'Você não possui esse pet.' });
      return;
    }

    player.equippedPet = petId;
    this._startFoodTimer(player.name, petId);
    sendTo(player.ws, {
      type:        'pet_update',
      equippedPet: petId,
      ownedPets:   player.ownedPets,
      petLevels:   player.petLevels,
      petXp:       player.petXp,
    });
    this.db.save(player);
    console.log(`[Pet] ${player.name} equipou ${petId}`);
  }

  // ── Ataque do pet (cliente confirma hit) ──────────────────────────────────

  _handleAttack(player, data) {
    const petId    = data.petId    || player.equippedPet;
    const targetId = data.targetId || '';
    if (!petId || !player.equippedPet) return;

    const dmg = calcDamage(petId, this._getLevel(player, petId));

    // Aplica XP ao pet
    this._addXp(player, petId, XP_PER_HIT);

    // Broadcast para todos do mapa (animação de hit)
    this._broadcastToMap(player.mapLevel, {
      type:     'pet_attack_effect',
      ownerId:  player.id,
      petId,
      targetId,
      dmg:      Math.round(dmg),
    });
  }

  // ── Skill do pet ──────────────────────────────────────────────────────────

  _handleSkill(player, data) {
    const petId     = data.petId     || player.equippedPet;
    const skillType = data.skillType ?? -1;
    if (!petId) return;

    const def = PET_DEFS[petId];
    if (!def) return;

    const cdKey = `${player.name}.${petId}.skillCd`;
    const now   = Date.now();
    const lastUsed = this._skillCdMap.get(cdKey) || 0;
    const cdMs  = def.skillCd * (SKILL_CD_MULT[def.rarity] ?? 1.0) * 1000;
    if (now - lastUsed < cdMs) return; // ainda em cooldown
    this._skillCdMap.set(cdKey, now);

    // Efeito da skill — broadcast para mapa
    const target = player._petTarget; // pode ser undefined
    this._broadcastToMap(player.mapLevel, {
      type:      'pet_skill_effect',
      ownerId:   player.id,
      petId,
      skillType,
      x: target?.x ?? player.x,
      z: target?.z ?? player.z,
    });

    // Efeitos de skill com impacto mecânico (debuffs, shields) — aplicar aqui
    this._applySkillEffect(player, skillType, target);

    console.log(`[Pet] ${player.name} usou skill ${skillType} do pet ${petId}`);
  }

  _skillCdMap = new Map(); // namespace isolado para evitar conflito com outros sistemas

  _applySkillEffect(player, skillType, target) {
    // 0=FIREBALL, 1=WATER_BLAST, 2=LIGHTNING, 3=CORAL_SHIELD, 4=CURSE
    switch (skillType) {
      case 3: // Coral Shield — dá escudo temporário ao dono
        player._petShield = { amount: 20, expiresAt: Date.now() + 8000 };
        sendTo(player.ws, { type: 'pet_shield', amount: 20, duration: 8000 });
        break;
      case 4: // Curse — reduz defesa do alvo por 5s
        if (target) target._petCursed = { defReduction: 0.3, expiresAt: Date.now() + 5000 };
        break;
      // FIREBALL, WATER_BLAST, LIGHTNING: dano/efeito calculado no ataque normal
    }
  }

  // ── Captura de pet selvagem ───────────────────────────────────────────────

  _handleCapture(player, data) {
    const wildId = data.wildId || '';
    if (!wildId) return;

    const wild = this.wildPets.get(wildId);
    if (!wild) {
      sendTo(player.ws, { type: 'pet_error', reason: 'Pet selvagem não encontrado.' });
      return;
    }

    // Verifica cooldown do jogador para esta ruína
    const captureKey  = `${player.name}.${wild.ruinKey}`;
    const lastCapture = player._petCaptureCD?.get(captureKey) || 0;
    if (Date.now() - lastCapture < SPAWN_COOLDOWN_MS) {
      const remainingH = ((SPAWN_COOLDOWN_MS - (Date.now() - lastCapture)) / 3_600_000).toFixed(1);
      sendTo(player.ws, { type: 'pet_error', reason: `Cooldown ativo para esta ruína. Aguarde ${remainingH}h.` });
      return;
    }

    const petId = wild.petId;
    const def   = PET_DEFS[petId];

    // Chance de captura (100% para teste)
    const chance = 100.0; // ajuste em PetTypes.gd CAPTURE_CHANCE
    if (Math.random() * 100 > chance) {
      sendTo(player.ws, { type: 'pet_error', reason: 'O pet escapou!' });
      return;
    }

    // Registra cooldown
    if (!player._petCaptureCD) player._petCaptureCD = new Map();
    player._petCaptureCD.set(captureKey, Date.now());

    // Adiciona ao inventário
    if (!player.ownedPets)  player.ownedPets  = [];
    if (!player.petLevels)  player.petLevels  = {};
    if (!player.petXp)      player.petXp      = {};

    const alreadyOwns = player.ownedPets.find(p => p.id === petId);
    if (!alreadyOwns) {
      player.ownedPets.push({ id: petId, level: 1, xp: 0 });
      player.petLevels[petId] = 1;
      player.petXp[petId]     = 0;
    }

    // Remove do mundo e do hit detection
    this._removeWildPet(wildId, petId, wild.mapLevel, `capturado por ${player.name}`);

    // Responde ao jogador
    sendTo(player.ws, {
      type:      'pet_captured',
      petId,
      level:     1,
      xp:        0,
      ownedPets: player.ownedPets,
      petLevels: player.petLevels,
      petXp:     player.petXp,
    });

    this.db.save(player, true);
    console.log(`[Pet] ${player.name} capturou ${petId} (${def?.rarity ?? '?'})`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Spawn de pets selvagens
  // ═══════════════════════════════════════════════════════════════════════════

  _checkAllSpawns() {
    const now      = Date.now();
    const mapLevels = Object.keys(this.ruinCounts).map(Number);

    for (const mapLevel of mapLevels) {
      const count = this.ruinCounts[mapLevel] || 0;
      for (let i = 0; i < count; i++) {
        const ruinKey  = `${mapLevel}_${i}`;
        const lastSpawn = this.ruinSpawnTimes.get(ruinKey) || 0;
        if (now - lastSpawn < SPAWN_COOLDOWN_MS) continue;

        // Já tem um pet selvagem ativo nesta ruína?
        const alreadyActive = [...this.wildPets.values()].some(w => w.ruinKey === ruinKey);
        if (alreadyActive) continue;

        // Tenta spawnar um pet para este mapa
        this._trySpawnForRuin(mapLevel, i, ruinKey);
      }
    }
  }

  _trySpawnForRuin(mapLevel, ruinIndex, ruinKey) {
    // Quais pets podem nascer neste mapa?
    const eligible = Object.values(PET_DEFS).filter(d => d.maps.includes(mapLevel));
    if (eligible.length === 0) return;

    // Sorteia raridade baseado em chance
    const roll = Math.random() * 100;
    let cumulative = 0;
    let chosenRarity = -1;
    for (const [rarStr, chance] of Object.entries(SPAWN_CHANCE)) {
      cumulative += chance;
      if (roll <= cumulative) { chosenRarity = Number(rarStr); break; }
    }
    if (chosenRarity === -1) return; // não saiu nada

    const byRarity = eligible.filter(d => d.rarity === chosenRarity);
    if (byRarity.length === 0) return;

    const def   = byRarity[Math.floor(Math.random() * byRarity.length)];
    const petId = def.id;
    const id    = uid();

    // Posição real da ruína + pequeno offset aleatório (±15u) para não empilhar
    const ruinPos = (this.ruinPositions[mapLevel] || [])[ruinIndex] || [0, 0];
    const x = ruinPos[0] + (Math.random() - 0.5) * 30;
    const z = ruinPos[1] + (Math.random() - 0.5) * 30;

    const maxHp  = def.baseHp || 100;
    const wildPet = {
      id, petId, mapLevel, ruinKey, x, z, spawnedAt: Date.now(),
      // Campos de NPC para hit detection
      hp: maxHp, maxHp,
      hitRadius:      4.0,      // raio de colisão com projéteis
      dead:           false,
      isWildPet:      true,     // flag para interceptar no projectile-manager
      goldReward:     0,        // sem gold ao matar
      xpReward:       0,
      relicDropChance:0,
      aggroTarget:    null,     // playerId de quem atacou primeiro
      _lastAttackTime:0,
      _lastAttackerId:null,
    };
    this.wildPets.set(id, wildPet);
    this.ruinSpawnTimes.set(ruinKey, Date.now());

    // Registra como NPC no projectile-manager (hit detection)
    if (this.projectileManager) {
      this.projectileManager.npcs.set(id, wildPet);
    }

    // Broadcast para jogadores no mapa
    this._broadcastToMap(mapLevel, {
      type:     'wild_pet_spawn',
      id,
      petId,
      rarity:   def.rarity,
      mapLevel,
      maxHp,
      x,
      z,
    });

    console.log(`[Pet] 🐾 Spawn  pet=${petId}  raridade=${['Common','Rare','Epic','Legendary'][def.rarity]}  mapa=${mapLevel}  ruína=${ruinIndex} (key=${ruinKey})  pos=(${x.toFixed(0)}, ${z.toFixed(0)})  hp=${maxHp}  id=${id}`);

    // Auto-despawn após 30 minutos se não capturado/derrotado
    setTimeout(() => {
      if (this.wildPets.has(id)) {
        this._removeWildPet(id, petId, mapLevel, 'despawn por tempo');
      }
    }, 30 * 60 * 1000);
  }

  // Remove wild pet do mundo e do hit detection
  _removeWildPet(id, petId, mapLevel, reason = '') {
    this.wildPets.delete(id);
    if (this.projectileManager) this.projectileManager.npcs.delete(id);
    this._broadcastToMap(mapLevel, { type: 'wild_pet_removed', id, petId });
    if (reason) console.log(`[Pet] ${petId} removido (${reason})`);
  }

  // Callback chamado pelo projectile-manager quando wild pet morre por projétil
  onWildPetKilled(wildNpc, killer) {
    const wild = this.wildPets.get(wildNpc.id);
    if (!wild) return;

    const CAPTURE_CHANCE = 0.15; // 15% de captura ao derrotar
    this._removeWildPet(wild.id, wild.petId, wild.mapLevel, `morto por ${killer?.name || '?'}`);

    if (!killer) return;

    const roll = Math.random();
    console.log(`[Pet] 🎲 Captura: ${killer.name} rolou ${(roll * 100).toFixed(1)}% (precisa ≤ ${CAPTURE_CHANCE * 100}%)`);

    if (roll <= CAPTURE_CHANCE) {
      // Sucesso — adiciona pet ao inventário
      if (!killer.ownedPets) killer.ownedPets = [];
      if (!killer.petLevels) killer.petLevels  = {};
      if (!killer.petXp)     killer.petXp      = {};
      const alreadyOwns = killer.ownedPets.some(p => p.id === wild.petId);
      if (!alreadyOwns) {
        killer.ownedPets.push({ id: wild.petId });
        killer.petLevels[wild.petId] = 1;
        killer.petXp[wild.petId]     = 0;
      }
      sendTo(killer.ws, {
        type:      'pet_captured',
        petId:     wild.petId,
        ownedPets: killer.ownedPets,
        petLevels: killer.petLevels,
        petXp:     killer.petXp,
        message:   `🐾 ${wild.petId} capturado!`,
      });
      if (this.db) this.db.save(killer, true).catch(() => {});
      console.log(`[Pet] ✅ ${killer.name} capturou ${wild.petId}!`);
    } else {
      sendTo(killer.ws, {
        type:    'pet_escape',
        petId:   wild.petId,
        message: '🐾 O pet escapou! Tente novamente quando respawnar.',
      });
      console.log(`[Pet] ❌ ${killer.name} não capturou ${wild.petId} (escapou)`);
    }
  }

  // Tick de combate dos wild pets — atacam jogadores com aggro a cada 2s
  _tickWildCombat() {
    const now = Date.now();
    for (const [, wild] of this.wildPets) {
      if (wild.dead) continue;
      if (!wild.aggroTarget) continue;

      // Busca o jogador alvo
      const target = this.players.get(wild.aggroTarget);
      if (!target || target.dead || target.mapLevel !== wild.mapLevel) {
        wild.aggroTarget = null; // perde aggro se jogador saiu/morreu
        continue;
      }

      const dist = Math.hypot(target.x - wild.x, target.z - wild.z);
      if (dist > 120) {
        // Jogador fugiu — perde aggro
        wild.aggroTarget = null;
        continue;
      }

      // Ataca a cada 2s (intervalo do tick)
      const def = PET_DEFS[wild.petId];
      const dmg = Math.round((def?.baseDmg || 10) * (1 + Math.random() * 0.3));
      target.hp = Math.max(0, target.hp - dmg);

      this._broadcastToMap(wild.mapLevel, {
        type:     'npc_attack_hit',
        npcId:    wild.id,
        attackId: `wp_${wild.id}_${now}`,
        shape:    'circle',
        x: target.x, z: target.z,
        hits: [{ targetId: target.id, damage: dmg, hp: target.hp, maxHp: target.maxHp }],
        effects: [],
      });

      if (target.hp <= 0 && !target.dead) {
        target.dead = true; // o loop principal do server.js lida com respawn
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Sistema de comida
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

    const foodItem   = def.food; // 'cerveja' ou 'frutas'
    const foodNeeded = FOOD_PER_HOUR / 60.0; // consumo por tick (1 tick = 1 min)

    // Verifica inventário
    const inventory = player.inventory || {};
    const foodAmt   = Number(inventory[foodItem] || 0);

    if (foodAmt <= 0) {
      // Sem comida — pet some
      player.equippedPet = '';
      sendTo(player.ws, {
        type:  'pet_food_depleted',
        petId,
        reason: `Seu pet ficou sem ${foodItem}!`,
      });
      console.log(`[Pet] ${player.name} pet ${petId} sumiu por falta de comida.`);
      this.db.save(player);
      return;
    }

    // Consome comida
    inventory[foodItem] = Math.max(0, foodAmt - foodNeeded);
    player.inventory = inventory;

    // Dá XP
    this._addXp(player, petId, XP_PER_FOOD_TICK);

    // Atualiza inventário no cliente
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

  _startFoodTimer(playerName, petId) {
    // Nada a fazer — _tickAllFood cobre todos os jogadores
    console.log(`[Pet] Food timer ativo para ${playerName} → ${petId}`);
  }

  _stopFoodTimer(playerName, petId) {
    // Nada a fazer — _tickAllFood verifica equippedPet
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Sistema de XP e level-up
  // ═══════════════════════════════════════════════════════════════════════════

  _getLevel(player, petId) {
    return (player.petLevels?.[petId]) ?? 1;
  }

  _addXp(player, petId, amount) {
    if (!player.petXp)    player.petXp    = {};
    if (!player.petLevels) player.petLevels = {};

    const currentXp  = Number(player.petXp[petId]    || 0);
    const currentLv  = Number(player.petLevels[petId] || 1);
    let newXp  = currentXp + amount;
    let newLv  = currentLv;
    let leveledUp = false;

    while (newXp >= xpForLevel(newLv)) {
      newXp -= xpForLevel(newLv);
      newLv++;
      leveledUp = true;
    }

    player.petXp[petId]    = newXp;
    player.petLevels[petId] = newLv;

    // Atualiza owned_pets também
    const owned = (player.ownedPets || []).find(p => p.id === petId);
    if (owned) { owned.xp = newXp; owned.level = newLv; }

    const updateMsg = {
      type:  'pet_xp_update',
      petId,
      xp:    newXp,
      level: newLv,
      xpNext: xpForLevel(newLv),
    };
    sendTo(player.ws, updateMsg);

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
  // Player conectou/desconectou
  // ═══════════════════════════════════════════════════════════════════════════

  onPlayerJoined(player) {
    // Envia pets selvagens ativos no mapa do jogador
    let sentAny = false;
    for (const [, wild] of this.wildPets) {
      if (wild.mapLevel === player.mapLevel) {
        sendTo(player.ws, {
          type:     'wild_pet_spawn',
          id:       wild.id,
          petId:    wild.petId,
          rarity:   PET_DEFS[wild.petId]?.rarity ?? 0,
          mapLevel: wild.mapLevel,
          x:        wild.x,
          z:        wild.z,
        });
        sentAny = true;
      }
    }

    // TESTE: se não há nenhum pet ativo no mapa, spawna um imediatamente
    // próximo ao jogador (≤200u) preferindo pets com GLB disponível
    if (!sentAny) {
      const GLB_PETS = ['fire_spirit', 'water_dragon']; // têm assets/pets/3d/*.glb
      const eligible = GLB_PETS.filter(pid => {
        const def = PET_DEFS[pid];
        return def && def.maps.includes(player.mapLevel);
      });
      const petId = eligible.length > 0
        ? eligible[Math.floor(Math.random() * eligible.length)]
        : null;
      if (petId) {
        const def     = PET_DEFS[petId];
        const id      = uid();
        // Usa a posição da primeira ruína do mapa — pet aparece onde o jogador vai encontrar
        const mapRuins = this.ruinPositions[player.mapLevel] || [];
        const ruinPos  = mapRuins.length > 0
          ? mapRuins[Math.floor(Math.random() * mapRuins.length)]
          : [(player.x || 0) + 80, (player.z || 0)];
        const x       = ruinPos[0] + (Math.random() - 0.5) * 30;
        const z       = ruinPos[1] + (Math.random() - 0.5) * 30;
        const ruinKey = `join_${player.name}_${Date.now()}`;
        const wild    = { id, petId, mapLevel: player.mapLevel, ruinKey, x, z, spawnedAt: Date.now() };
        this.wildPets.set(id, wild);
        this.ruinSpawnTimes.set(ruinKey, Date.now());
        sendTo(player.ws, {
          type:     'wild_pet_spawn',
          id,
          petId,
          rarity:   def.rarity,
          mapLevel: player.mapLevel,
          x,
          z,
        });
        console.log(`[Pet] 🐾 Pet de boas-vindas: ${petId} spawnado perto de ${player.name} (x:${x.toFixed(0)}, z:${z.toFixed(0)})`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Debug commands (via chat /comando)
  // ═══════════════════════════════════════════════════════════════════════════

  _debugSpawnPet(player, data) {
    const petId    = data.petId    || 'void_wisp';
    const mapLevel = player.mapLevel || 1;
    const ruinKey  = `debug_${Date.now()}`;
    const id       = uid();
    const wild     = { id, petId, mapLevel, ruinKey, x: player.x + 20, z: player.z, spawnedAt: Date.now() };
    this.wildPets.set(id, wild);
    this._broadcastToMap(mapLevel, {
      type:     'wild_pet_spawn',
      id,
      petId,
      rarity:   PET_DEFS[petId]?.rarity ?? 0,
      mapLevel,
      x: wild.x,
      z: wild.z,
    });
    sendTo(player.ws, { type: 'notification', msg: `🐾 Pet selvagem ${petId} spawnado próximo a você.` });
  }

  _debugGiveFood(player, data) {
    const amount = Number(data.amount || 50);
    if (!player.inventory) player.inventory = {};
    player.inventory.cerveja = (player.inventory.cerveja || 0) + amount;
    player.inventory.frutas  = (player.inventory.frutas  || 0) + amount;
    sendTo(player.ws, {
      type:         'inventory_update',
      inventory:    player.inventory,
      notification: `🍺 +${amount} cerveja e +${amount} frutas adicionados.`,
    });
    this.db.save(player);
  }

  _debugLevelPet(player, data) {
    const petId    = data.petId    || player.equippedPet;
    const newLevel = Number(data.level || 5);
    if (!petId) return;
    if (!player.petLevels) player.petLevels = {};
    if (!player.petXp)     player.petXp = {};
    player.petLevels[petId] = newLevel;
    player.petXp[petId]     = 0;
    const owned = (player.ownedPets || []).find(p => p.id === petId);
    if (owned) { owned.level = newLevel; owned.xp = 0; }
    sendTo(player.ws, {
      type:  'pet_xp_update',
      petId,
      xp:    0,
      level: newLevel,
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
      if (p && p.mapLevel === mapLevel && p.ws && p.ws.readyState === 1 /*OPEN*/) {
        sendTo(p.ws, msg);
      }
    }
  }

  // Inclui dados de pets no payload do init enviado ao jogador
  injectInitData(player) {
    return {
      ownedPets:   player.ownedPets   || [],
      equippedPet: player.equippedPet || '',
      petLevels:   player.petLevels   || {},
      petXp:       player.petXp       || {},
    };
  }

  destroy() {
    clearInterval(this._spawnCheckInterval);
    clearInterval(this._foodInterval);
  }
}

module.exports = PetManager;
