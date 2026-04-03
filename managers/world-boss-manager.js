// managers/world-boss-manager.js
const { uid, rand, broadcast, sendTo } = require('../utils/helpers');
const { WORLD_BOSS_DEF, MAP_DEFS } = require('../constants');
const db = require('./db-manager');

class WorldBossManager {
  constructor(wss, players, npcManagers) {
    this.wss = wss;
    this.players = players;
    this.npcManagers = Array.isArray(npcManagers) ? npcManagers : (npcManagers ? [npcManagers] : []);
    this.totalBossKills = 0;
    this.worldBossAlive = false;
    this.worldBossId = null;
    this._spawnTimer = null; // Rastrear timer de spawn
  }

  onZoneBossDead(boss, killerId) {
    this.totalBossKills++;
    const def = WORLD_BOSS_DEF[0];
    const threshold = def.spawnAfterBossKills || 15;

    if (this.totalBossKills >= threshold && !this.worldBossAlive) {
      if (Math.random() < (def.spawnChance || 1.0)) {
        this.totalBossKills = 0;

        // Pré-calcular o mapa ANTES do anúncio para informar os jogadores
        // onde o boss vai aparecer — evita a percepção de "às vezes aparece, às vezes não"
        const allowedMaps   = def.mapLevel || [1];
        const availableMaps = this.npcManagers.map(m => m.zoneLevel);
        const validMaps     = availableMaps.filter(m => allowedMaps.includes(m));
        const preMapLvl     = validMaps.length > 0
          ? validMaps[Math.floor(Math.random() * validMaps.length)]
          : allowedMaps[0];

        broadcast(this.wss, {
          type: 'world_boss_incoming',
          def: {
            name: def.name,
            icon: def.icon,
            rarity: def.rarity,
            spawnDelay: 5000,
            mapLevel: preMapLvl,  // informa qual mapa para que os jogadores possam ir
          }
        });

        // Cancelar timer anterior se existir
        if (this._spawnTimer) {
          clearTimeout(this._spawnTimer);
        }

        this._spawnTimer = setTimeout(() => {
          this._spawnTimer = null;
          this.spawn(preMapLvl);
        }, 5000);
      }
    }
  }

  // mapLvl pode ser pré-computado por onZoneBossDead para incluí-lo no anúncio
  spawn(mapLvl = null) {
    if (this.worldBossAlive) return null;
    this.worldBossAlive = true;

    const def = WORLD_BOSS_DEF[0];
    const rar = def.rarity;

    // Se mapLvl não foi pré-computado (chamada manual), calcular agora
    if (mapLvl === null) {
      const allowedMaps   = def.mapLevel || [1];
      const availableMaps = this.npcManagers.map(m => m.zoneLevel);
      const validMaps     = availableMaps.filter(m => allowedMaps.includes(m));
      mapLvl = validMaps.length > 0
        ? validMaps[Math.floor(Math.random() * validMaps.length)]
        : allowedMaps[0];
    }
    const id = uid();

    // Calcular tier baseado na média de kills dos jogadores online
    let totalKills = 0, onlineCount = 0;
    this.players.forEach(p => {
      if (!p.dead) { 
        totalKills += (p.npcKills || 0); 
        onlineCount++; 
      }
    });
    const avgKills = onlineCount > 0 ? totalKills / onlineCount : 0;
    const tier = Math.floor(avgKills / 10);
    const hpScale = 1 + tier * (def.hpPerTier || 0);
    const dmgScale = 1 + tier * (def.dmgPerTier || 0);

    const scaledHp = Math.round(def.baseHp * hpScale);
    const scaledDmg = Math.round((def.baseDamage || 0) * dmgScale);

    // use map-specific size to choose spawn coordinates
    const mapSize = (MAP_DEFS[mapLvl] && MAP_DEFS[mapLvl].size);
    const boss = {
      id,
      name: '☠☠ ' + def.name,
      x: rand(-mapSize / 4, mapSize / 4),
      y: 0,
      z: rand(-mapSize / 4, mapSize / 4),
      rotation: rand(0, Math.PI * 2),
      hp: scaledHp,
      maxHp: scaledHp,
      speed: 0,
      targetId: null,
      fireTimer: def.fireInterval || 1200,
      dead: false,
      isNPC: true,
      isBoss: true,
      isWorldBoss: true,
      mapLevel: mapLvl,
      rarity: rar.id,
      dmgMult: 3.0,
      rewardMult: rar.rewardMult || 25,
      cannonDmg: scaledDmg,
      hitRadius: def.hitRadius || 16,
      spawnTier: tier,
      npcModel: def.model || null,
      npcScale: def.scale || 1,
      npcYOffset: def.yOffset || 0,
      npcRotOffset: def.rotOffset || 0,
      npcHullColor: def.hullColor,
      npcSailColor: def.sailColor,
      _dobraoMin: def.dobraoMin,
      _dobraoMax: def.dobraoMax,
      _damageMap: new Map(),
      lastDamageTime: 0,
      _spawnTime: Date.now(),
      _inactivityTimer: null, // Timer para despawn por inatividade
    };

    // Auto-destroy se ninguém atacar por 5 minutos
    boss._inactivityTimer = setTimeout(() => {
      if (this.worldBossAlive && boss.hp === boss.maxHp) {
        console.log('🦑 World Boss despawned due to inactivity');
        this._despawn(boss);
      }
    }, 5 * 60 * 1000);

    this.worldBossId = id;
    const mgr = this.npcManagers.find(m => m.zoneLevel === mapLvl);

    // Guard: se não há manager para o mapa alvo, abortar para não travar worldBossAlive
    if (!mgr) {
      console.warn(`🦑 World Boss spawn abortado: nenhum manager encontrado para mapLevel ${mapLvl}`);
      if (boss._inactivityTimer) { clearTimeout(boss._inactivityTimer); boss._inactivityTimer = null; }
      this.worldBossAlive = false;
      this.worldBossId = null;
      return null;
    }

    mgr.npcs.set(id, boss);

    broadcast(this.wss, {
      type: 'world_boss_spawn',
      entity: {
        id: boss.id, name: boss.name,
        x: boss.x, z: boss.z, rotation: boss.rotation,
        hp: boss.hp, maxHp: boss.maxHp,
        isNPC: true, isBoss: true, isWorldBoss: true,
        mapLevel: mapLvl,
        rarity: rar.id,
        rarityLabel: rar.label,
        rarityColor: rar.color,
        npcHullColor: boss.npcHullColor,
        npcSailColor: boss.npcSailColor,
        npcModel: boss.npcModel,
        npcScale: boss.npcScale,
        npcYOffset: boss.npcYOffset,
        npcRotOffset: boss.npcRotOffset,
        spawnTier: tier,
      },
    });
    
    console.log(`🦑 World Boss [${rar.label}] spawned on map ${mapLvl}! HP:${scaledHp} avgTier:${tier} (${onlineCount} players online)`);
    return boss;
  }

  _despawn(boss) {
    if (!boss) return;
    
    this.worldBossAlive = false;
    this.worldBossId = null;
    
    // Limpar timer de inatividade
    if (boss._inactivityTimer) {
      clearTimeout(boss._inactivityTimer);
      boss._inactivityTimer = null;
    }
    
    // Limpar damageMap
    if (boss._damageMap) {
      boss._damageMap.clear();
      boss._damageMap = null;
    }
    
    // Remover do NPC manager
    const mgr = this.npcManagers.find(m => m.zoneLevel === boss.mapLevel);
    if (mgr) {
      mgr.npcs.delete(boss.id);
    }
    
    broadcast(this.wss, { type: 'world_boss_despawned' });
  }

  onWorldBossDead(boss, killerId) {
    this.worldBossAlive = false;
    this.worldBossId = null;

    // Limpar timer de inatividade
    if (boss._inactivityTimer) {
      clearTimeout(boss._inactivityTimer);
      boss._inactivityTimer = null;
    }

    const def = WORLD_BOSS_DEF[0];
    const rar = def.rarity;

    const dmgMap = boss._damageMap || new Map();
    if (dmgMap.size === 0) {
      dmgMap.set(killerId, 1);
    }
    
    const totalDmg = Math.max(1, [...dmgMap.values()].reduce((a, b) => a + b, 0));
    const baseDrops = Math.floor(def.dobraoMin + Math.random() * (def.dobraoMax - def.dobraoMin));
    const tierScale = 1 + (boss.spawnTier || 0) * (def.rewardPerTier || 0.50);
    const totalDrops = Math.round(baseDrops * tierScale);

    let killerName = '???';
    
    for (const [playerId, dmg] of dmgMap.entries()) {
      const player = this.players.get(playerId);
      if (!player) continue;

      const share = dmg / totalDmg;
      const drops = Math.max(1, Math.round(totalDrops * share));
      const frags = Math.round((def.mapFragments || 60) * share);

      player.dobroes = (player.dobroes || 0) + drops;
      player.mapFragments = (player.mapFragments || 0) + frags;

      db.save(player, true).catch(e => console.error('WorldBoss save error:', e));
      
      sendTo(player.ws, {
        type: 'currency_update',
        gold: player.gold,
        dobroes: player.dobroes,
        reward: { type: 'dobrao', amount: drops, share: Math.round(share * 100) },
        mapFragments: player.mapFragments,
      });

      if (playerId === killerId) killerName = player.name || playerId;
    }

    // 🔥 Limpar damageMap após uso
    if (boss._damageMap) {
      boss._damageMap.clear();
      boss._damageMap = null;
    }

    // Remover o boss do NPC manager
    const mgr = this.npcManagers.find(m => m.zoneLevel === boss.mapLevel);
    if (mgr) {
      mgr.npcs.delete(boss.id);
    }

    broadcast(this.wss, {
      type: 'world_boss_dead',
      bossId: boss.id,
      killerId,
      killerName,
      rarityLabel: rar.label,
      rarityColor: rar.color,
    });
    
    console.log(`🦑 World Boss slain by ${killerName}! Rewards shared by ${dmgMap.size} player(s)`);
  }

  destroy() {
    console.log('🛑 Destruindo WorldBossManager...');
    
    // Cancelar timer de spawn pendente
    if (this._spawnTimer) {
      clearTimeout(this._spawnTimer);
      this._spawnTimer = null;
    }
    
    // Se houver world boss vivo, limpá-lo
    if (this.worldBossAlive && this.worldBossId) {
      const mgr = this.npcManagers.find(m => m.npcs.has(this.worldBossId));
      if (mgr) {
        const boss = mgr.npcs.get(this.worldBossId);
        if (boss) {
          if (boss._damageMap) {
            boss._damageMap.clear();
            boss._damageMap = null;
          }
          if (boss._inactivityTimer) {
            clearTimeout(boss._inactivityTimer);
            boss._inactivityTimer = null;
          }
          mgr.npcs.delete(this.worldBossId);
        }
      }
    }
    
    // Limpar referências
    this.players = null;
    this.npcManagers = null;
    this.wss = null;
    
    console.log('✅ WorldBossManager destruído');
  }

  _sendTo(ws, data) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(data));
  }
}

module.exports = WorldBossManager;