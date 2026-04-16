// managers/boss-manager.js
const { uid, rand } = require('../utils/helpers');
const { MAP_DEFS, FRAGMENT_DROP_BOSS, HIT_RADIUS } = require('../constants');
const db = require('./db-manager');

function rollRarity(rarities) {
  const total = rarities.reduce((s, r) => s + r.chance, 0);
  let roll = Math.random() * total;
  for (const r of rarities) {
    roll -= r.chance;
    if (roll <= 0) return r;
  }
  return rarities[0];
}

class BossManager {
  constructor(wss, players, npcs, zoneLevel = 1) {
    this.wss       = wss;
    this.players   = players;
    this.npcs      = npcs;          // map-specific NPC Map (npcManager.npcs)
    this.zoneLevel = zoneLevel;
    this.bossAlive = false;
    this.pendingRarity = null;

    // Monitoramento de memória em desenvolvimento
    if (process.env.NODE_ENV === 'development') {
      this._memoryCheckInterval = setInterval(() => this._checkMemory(), 60000);
    }
  }

  rollPendingRarity() {
    const bossDef = (MAP_DEFS[this.zoneLevel] || MAP_DEFS[1]).boss || {};
    const rarities = bossDef.rarities || [{ id: 'normal', label: 'Normal', hpMult: 1, rewardMult: 1, chance: 1, color: '#aaa' }];
    this.pendingRarity = rollRarity(rarities);
    return this.pendingRarity.id;
  }

  /**
   * Spawna o boss escalando com os kills do jogador que ativou o spawn.
   * @param {number} killerKills  npcKills do jogador que causou o spawn (0 = sem escala)
   */
  spawn(killerKills = 0) {
    if (this.bossAlive) return null;
    this.bossAlive = true;

    const bossDef   = (MAP_DEFS[this.zoneLevel] || MAP_DEFS[1]).boss || {};
    const rarities  = bossDef.rarities || [];
    const rarity    = this.pendingRarity || rollRarity(rarities);
    this.pendingRarity = null;

    // ── Escalagem por tier do killer ─────────────────────────────────────────
    const tier     = Math.floor(killerKills / 10);
    const hpScale  = 1 + tier * (bossDef.hpPerTier  || 0);
    const dmgScale = 1 + tier * (bossDef.dmgPerTier  || 0);

    const baseHp  = bossDef.baseHp || 600;
    const bossHp  = Math.round(baseHp * hpScale * (rarity.hpMult || 1));
    const id      = uid();

    const mapSize = (MAP_DEFS[this.zoneLevel] && MAP_DEFS[this.zoneLevel].size);
    const boss = {
      id,
      name:        '☠ ' + (bossDef.name || 'El Diablo Negro'),
      x:           rand(-mapSize / 3, mapSize / 3),
      y:           0,
      z:           rand(-mapSize / 3, mapSize / 3),
      rotation:    rand(0, Math.PI * 2),
      hp:          bossHp,
      maxHp:       bossHp,
      speed:       0,
      targetId:    null,
      fireTimer:   2000,
      dead:        false,
      isNPC:       true,
      isBoss:      true,
      mapLevel:    this.zoneLevel, // ← critical: marks which map this boss belongs to
      rarity:      rarity.id,
      dmgMult:     rarity.hpMult || 1,   // use hpMult as proxy for dmgMult
      rewardMult:  rarity.rewardMult || 1,
      cannonDmg:   Math.round((bossDef.baseDamage || 0) * dmgScale), // escala com tier
      hitRadius:   bossDef.hitRadius || HIT_RADIUS,
      spawnTier:   tier,                  // guarda o tier para logs/debug
      npcModel:     bossDef.model     || null,
      npcHullColor: bossDef.hullColor  || null,
      npcSailColor: bossDef.sailColor  || null,
      npcScale:     bossDef.scale      || null,
      npcYOffset:   bossDef.yOffset    || null,
      npcRotOffset: bossDef.rotOffset  ?? null,
      // dobrão drop range from MAP_DEFS
      _dobraoMin:  bossDef.dobraoMin || 5,
      _dobraoMax:  bossDef.dobraoMax || 10,
      // Rastreia dano total por jogador para dividir recompensas proporcionalmente
      _damageMap:  new Map(),  // playerId → totalDamageDealt
      lastDamageTime: 0,
      // Sistema de ataques especiais
      attacks:          bossDef.attacks  || [],
      auras:            bossDef.auras    || [],
      _attackCooldowns: {},
      _currentCast:     null,
      _castTimer:       null,
      _auraTicks:       {},   // { auraId: lastTickTimestamp }
    };

    this.npcs.set(id, boss);

    // Only broadcast to players on this zone
    this._broadcastToZone({
      type: 'boss_spawn',
      entity: {
        id: boss.id, name: boss.name,
        x: boss.x, z: boss.z, rotation: boss.rotation,
        hp: boss.hp, maxHp: boss.maxHp,
        isNPC: true, isBoss: true,
        mapLevel: this.zoneLevel,
        rarity: rarity.id, rarityLabel: rarity.label, rarityColor: rarity.color,
        npcModel: boss.npcModel,
        npcHullColor: boss.npcHullColor, npcSailColor: boss.npcSailColor,
        spawnTier: tier,
      }
    });
    console.log(`👹 Boss [${rarity.label.toUpperCase()}] spawned on map ${this.zoneLevel}! HP:${bossHp} Tier:${tier}`);
    return boss;
  }

  _processPlayerReward(playerId, damage, boss, totalDamage) {
    if (!this.players) return; // BossManager já foi destruído (race com projectile flush)
    const player = this.players.get(playerId);
    if (!player) {
      console.warn(`[boss-debug] _processPlayerReward: player ${playerId} not found`);
      return;
    }

    const bossDef = (MAP_DEFS[this.zoneLevel] || MAP_DEFS[1]).boss || {};
    const rarities = bossDef.rarities || [];
    const rarityDef = rarities.find(r => r.id === boss.rarity) || {
      rewardMult: 1,
      label: 'Normal',
      color: '#aaa'
    };

    const dobraoMin = boss._dobraoMin || bossDef.dobraoMin || 5;
    const dobraoMax = boss._dobraoMax || bossDef.dobraoMax || 10;
    const baseDrops = Math.floor(rand(dobraoMin, dobraoMax + 1));
    const tierScale = 1 + (boss.spawnTier || 0) * (bossDef.rewardPerTier || 0.30);
    const totalDrops = Math.round(baseDrops * rarityDef.rewardMult * tierScale);

    const share = damage / totalDamage;
    let drops    = Math.max(1, Math.round(totalDrops * share));
    let fragDrop = Math.round((FRAGMENT_DROP_BOSS[boss.rarity] || FRAGMENT_DROP_BOSS.normal) * share);

    // ── Divisão de recompensas de grupo ──────────────────────────────────────
    const partyMembers = this.partyManager
      ? this.partyManager.getPartyMembersInZone(playerId, this.zoneLevel, this.players)
      : [];

    if (partyMembers.length > 0) {
      const totalSplit = partyMembers.length + 1;
      const memberDrops = Math.max(1, Math.floor(drops    / totalSplit));
      const memberFrags = Math.max(0, Math.floor(fragDrop / totalSplit));

      for (const m of partyMembers) {
        m.dobroes      = (m.dobroes      || 0) + memberDrops;
        m.mapFragments = (m.mapFragments || 0) + memberFrags;
        db.save(m, true).catch(e => console.error('Save error:', e));
        this._sendTo(m.ws, {
          type:     'currency_update',
          gold:     m.gold,
          dobroes:  m.dobroes,
          reward:   { type: 'dobrao', amount: memberDrops, share: Math.round(share * 100 / totalSplit) },
          mapFragments: m.mapFragments,
        });
      }
      drops    = memberDrops;
      fragDrop = memberFrags;
    }

    player.dobroes = (player.dobroes || 0) + drops;
    player.mapFragments = (player.mapFragments || 0) + fragDrop;

    db.save(player, true).catch(e => console.error('Save error:', e));
    console.log(`[boss-debug] rewarding player ${playerId}: damage=${damage} totalDmg=${totalDamage} wsReady=${!!player.ws && player.ws.readyState === 1}`);

    this._sendTo(player.ws, {
      type: 'currency_update',
      gold: player.gold,
      dobroes: player.dobroes,
      reward: {
        type: 'dobrao',
        amount: drops,
        share: Math.round(share * 100)
      },
      mapFragments: player.mapFragments,
    });
  }

  /**
   * Distribui recompensas proporcionalmente ao dano causado por cada jogador.
   * O matador recebe o crédito total se ninguém mais contribuiu.
   */
  onBossDead(boss, killerId) {
    if (!this.players) return; // BossManager já foi destruído
    this.bossAlive = false;
    const bossDef    = (MAP_DEFS[this.zoneLevel] || MAP_DEFS[1]).boss || {};
    const rarities   = bossDef.rarities || [];
    const rarityDef  = rarities.find(r => r.id === boss.rarity) || { rewardMult: 1, label: 'Normal', color: '#aaa' };
    const dobraoMin  = boss._dobraoMin || bossDef.dobraoMin || 5;
    const dobraoMax  = boss._dobraoMax || bossDef.dobraoMax || 10;
    const baseDrops  = Math.floor(rand(dobraoMin, dobraoMax + 1));
    // Escala a recompensa com o tier do boss (calculado no spawn)
    const tierScale  = 1 + (boss.spawnTier || 0) * (bossDef.rewardPerTier || 0.30);
    const totalDrops = Math.round(baseDrops * rarityDef.rewardMult * tierScale);

    // ── Calcular share de cada jogador pelo dano causado ─────────────────────
    const dmgMap = boss._damageMap || new Map();
    if (dmgMap.size === 0) {
      // Ninguém registrado → crédito total para o killer
      dmgMap.set(killerId, 1);
    }

    const totalDmg = Math.max(1, [...dmgMap.values()].reduce((a, b) => a + b, 0));
    for (const [playerId, dmg] of dmgMap.entries()) {
      this._processPlayerReward(playerId, dmg, boss, totalDmg);
    }

    // Callback bossAssists: todos os participantes (antes de limpar o damageMap)
    if (this._onBossAssist && this.players) {
      for (const [participantId] of dmgMap.entries()) {
        const participant = this.players.get(participantId);
        if (participant) this._onBossAssist(participant);
      }
    }

    // 🔥 CRÍTICO: Limpeza de memória
    boss._damageMap?.clear();
    boss._damageMap = null;
    this.npcs.delete(boss.id);

    // Callback para missões diárias (killer recebe crédito de boss kill)
    if (this._onBossKill && this.players) {
      const killer = this.players.get(killerId);
      if (killer) this._onBossKill(killer);
    }

    // Notificar jogadores (inclui mapa e total de drops para mensagem cliente)
    this._broadcastToZone({
      type: 'boss_dead', 
      bossId: boss.id, 
      killerId,
      rarity: boss.rarity,
      mapLevel: boss.mapLevel,
      drops: totalDrops,
    });
  }

  // Broadcast only to players on this zone
  _broadcastToZone(data) {
    if (!this.players) return; // BossManager já foi destruído
    // Serializar uma única vez
    const msg = JSON.stringify(data);
    this.players.forEach(p => {
      if ((p.mapLevel || 1) === this.zoneLevel && p.ws?.readyState === 1) {
        p.ws.send(msg);
      }
    });
  }

  _checkMemory() {
    const mem = process.memoryUsage();
    const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
    
    console.log(`[Zone ${this.zoneLevel}] Heap: ${heapUsedMB}/${heapTotalMB}MB | NPCs: ${this.npcs.size}`);
    
    // Alerta se memória estiver alta
    if (heapUsedMB > 500) { // 500MB threshold
      console.warn(`⚠️ Alta memória na zona ${this.zoneLevel}: ${heapUsedMB}MB`);
    }
  }

  // 🔥 MÉTODO DE CLEANUP OBRIGATÓRIO
  destroy() {
    if (this._memoryCheckInterval) {
      clearInterval(this._memoryCheckInterval);
    }
    
    this.pendingRarity = null;
    this.wss = null;
    this.players = null;
    
    // Limpar NPCs desta zona
    if (this.npcs) {
      for (const [id, npc] of this.npcs) {
        if (npc.mapLevel === this.zoneLevel) {
          if (npc._damageMap) {
            npc._damageMap.clear();
            npc._damageMap = null;
          }
          this.npcs.delete(id);
        }
      }
    }
    
    this.npcs = null;
  }

  _sendTo(ws, data) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(data));
  }
}

module.exports = BossManager;
