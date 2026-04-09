// managers/NPCManager.js
const { uid, rand, clamp, dist2D } = require('../utils/helpers');
const { MAX_HP, SHIP_SPEED, NPC_COUNT, MAP_DEFS, WORLD_BOSS_DEF, HIT_RADIUS } = require('../constants');

class NPCManager {
  constructor(projectileManager, mapDefs, mapLevel, attackManager = null) {
    this.npcs = new Map();
    this.projectileManager = projectileManager;
    this.attackManager = attackManager;
    this.mapDefs = mapDefs || {};
    this.zoneLevel = mapLevel || 1;
    this._initialNpcCount = 0;   // set after spawnAll; used by dungeon boss-spawn logic
    this._bossPhase       = false;
    this._dungeonBossId   = null;

    // Track respawn timers para poder cancelá-los
    this._respawnTimers = new Map();

    // Zonas de perigo (relíquias, etc.) que os NPCs tentam desviar
    this._dangerZones = []; // [{ x, z, radius, expires }]
    
    // Intervalo de limpeza de caches
    this._cleanupInterval = setInterval(() => {
      this._cleanupStaleData();
    }, 30000); // A cada 30 segundos
    
    this.spawnAll();
  }

  _cleanupStaleData() {
    const now = Date.now();
    
    for (const [id, npc] of this.npcs.entries()) {
      // Limpar DoTs muito antigos (processDots em server.js já cuida da expiração normal)
      if (npc.dots && npc.dots.length > 0) {
        npc.dots = npc.dots.filter(dot => dot.dur > 0);
      }
      
      // Limpar cache de alvo se muito antigo (> 5 segundos sem atualização)
      if (npc._targetCacheTime && now - npc._targetCacheTime > 5000) {
        npc._cachedNearest = null;
        npc._cachedNearestDist = Infinity;
        npc._targetCacheTime = 0;
      }
      
      // Limpar referências a jogadores que não existem mais
      if (npc._cachedNearest && npc._cachedNearest.dead) {
        npc._cachedNearest = null;
        npc._cachedNearestDist = Infinity;
      }
    }
  }

  spawnAll() {
    if (this.mapDefs[this.zoneLevel]?.npc === null) return; // boss-only map
    const npcDef = (this.mapDefs[this.zoneLevel] || {}).npc || {};
    const count  = npcDef.count || NPC_COUNT;
    console.log(`[NPC] Mapa ${this.zoneLevel}: spawnando ${count} NPCs | hitRadius=${npcDef.hitRadius ?? 'N/A (usa HIT_RADIUS)'}`);
    for (let i = 0; i < count; i++) this.spawn(this.zoneLevel);
    this._initialNpcCount = this.npcs.size;
  }

  /**
   * Spawns a single NPC from an explicit def (used for dungeon bosses).
   * The NPC is marked noRespawn=true and isDungeonBoss=true.
   */
  spawnWithDef(npcDef, mapLevel, x, z) {
    const id = uid();
    const avgHp     = Math.round((npcDef.stats.hpMin     + npcDef.stats.hpMax)     / 2);
    // cannonMin/Max = quantidade de canhões disparados por salva
    const avgCannon = Math.round((npcDef.stats.cannonMin + npcDef.stats.cannonMax) / 2);
    // dmgMin/Max = dano por projétil individual (fallback para cannonMin/Max se não definido)
    const avgDmg    = Math.round(((npcDef.stats.dmgMin ?? npcDef.stats.cannonMin) +
                                   (npcDef.stats.dmgMax ?? npcDef.stats.cannonMax)) / 2);
    const mapDef    = this.mapDefs[mapLevel] || {};
    const mapSize   = mapDef.size || 1000;
    const npc = {
      id,
      name:         npcDef.name,
      mapLevel,
      x:            x ?? (Math.random() - 0.5) * 100,
      y:            0,
      z:            z ?? (Math.random() - 0.5) * 100,
      rotation:     Math.random() * Math.PI * 2,
      hp:           avgHp,
      maxHp:        avgHp,
      baseHp:       avgHp,
      speed:        rand(0.4, 0.9),
      targetId:     null,
      dead:         false,
      isNPC:        true,
      isBoss:       true,
      isDungeonBoss: true,
      noRespawn:    true,
      stunExpires:  0,
      slowMult:     1,
      slowExpires:  0,
      dots:         [],
      cannonCount:  avgCannon,   // média de cannonMin/cannonMax (ex: 70 para colossal)
      ammoType:     'bala_ferro',
      cannonDmg:    avgDmg,      // dano por projétil individual (dmgMin/dmgMax)
      baseDmg:      avgDmg,
      cannonRange:  npcDef.cannonRange  ?? 150,
      cannonSpread: npcDef.cannonSpread ?? 0.3,  // spread do cone de disparo (rad)
      fireInterval: npcDef.fireInterval ?? 3500,
      hitRadius:    npcDef.hitRadius    ?? 20,
      npcModel:     npcDef.model        ?? null,
      npcScale:     npcDef.scale        ?? null,
      npcYOffset:   npcDef.yOffset      ?? null,
      npcRotOffset: npcDef.rotOffset    ?? null,
      npcHullColor: 0x111111,
      npcSailColor: 0x440022,
      npcFlagColor: 0x220011,
      usesCannons:  npcDef.usesCannons  ?? true,
      attacks:      [],
      _attackCooldowns: {},
      _currentCast:     null,
      _castTimer:       null,
      _nextCannonShot:  0,
      _scaledForKills:  0,
      _lastRescaleTime: 0,
      _lastDamageTime:  0,
      _cachedNearest:   null,
      _cachedNearestDist: Infinity,
      _targetCacheTime:   0,
      _lastRegenBroadcast: 0,
      relicDropChance:  0,
    };
    this.npcs.set(id, npc);
    console.log(`[NPC] Dungeon boss spawned: ${npc.name} (${id}) @ map${mapLevel}`);
    return npc;
  }

  spawn(mapLevel) {
    const id = uid();
    const lvl = mapLevel || 1;
    const mapDef = this.mapDefs[lvl] || {};
    const npcDef = mapDef.npc || {
      baseHp: mapDef.npcBaseHp || MAX_HP,
      names: mapDef.npcNames || ['Corsair'],
      hullColor: mapDef.npcHullColor || 0x3a1a0a,
      sailColor: mapDef.npcSailColor || 0xcc3333,
      flagColor: mapDef.npcFlagColor || 0xcc2222,
    };
    
    const names = npcDef.names || ['Corsair'];
    const baseName = names[Math.floor(Math.random() * names.length)];
    const baseHp = npcDef.baseHp || MAX_HP;
    
    const mapSize = (mapDef && mapDef.size);
    const npc = {
      id,
      name: `${baseName}-${String(id).slice(-3)}`,
      mapLevel: lvl,
      x: rand(-mapSize / 2, mapSize / 2),
      y: 0,
      z: rand(-mapSize / 2, mapSize / 2),
      rotation: rand(0, Math.PI * 2),
      hp: baseHp,
      maxHp: baseHp,
      baseHp,
      speed: rand(0.5, 1.5),
      targetId: null,
      dead: false,
      isNPC: true,
      stunExpires: 0,
      slowMult: 1,
      slowExpires: 0,
      dots: [], // ← Será limpo periodicamente
      cannonCount: 1,
      ammoType: 'bala_ferro',
      cannonDmg: npcDef.baseDamage || 0,
      baseDmg:   npcDef.baseDamage || 0,
      hitRadius: npcDef.hitRadius || HIT_RADIUS,
      npcHullColor: npcDef.hullColor,
      npcSailColor: npcDef.sailColor,
      npcFlagColor: npcDef.flagColor,
      npcModel: npcDef.model || null,
      npcScale:     npcDef.scale     ?? null,
      npcYOffset:   npcDef.yOffset   ?? null,
      npcRotOffset: npcDef.rotOffset ?? null,
      _scaledForKills: -1,
      _lastRescaleTime: 0,
      _lastDamageTime: 0,

      relicDropChance:  npcDef.relicDropChance || 0, // chance de drop de relíquia ao morrer

      // Flag de sistema de ataque:
      //   usesCannons=true  → dispara projéteis via fireInterval (navios piratas)
      //   usesCannons=false → usa ATTACK_DEFS via attackManager (monstros)
      usesCannons:      npcDef.usesCannons  || false,
      cannonRange:      npcDef.cannonRange  || 100,
      fireInterval:     npcDef.fireInterval || 3000,
      _nextCannonShot:  0,

      // Sistema de ataques ATTACK_DEFS (apenas para usesCannons=false)
      attacks:          npcDef.attacks || [],   // IDs dos ataques disponíveis
      _attackCooldowns: {},                      // { attackId: timestampExpiry }
      _currentCast:     null,                   // ID do ataque em cast
      _castTimer:       null,                   // handle do setTimeout do cast

      // Campos de cache (todos prefixados com _)
      _cachedNearest: null,
      _cachedNearestDist: Infinity,
      _targetCacheTime: 0,
      _lastRegenBroadcast: 0,
      _lastAuraTick: 0,
    };
    
    this.npcs.set(id, npc);
    return npc;
  }

  respawn(id) {
    this.respawnScaled(id, 0);
  }

  respawnScaled(id, killerKills, mapLevel) {
    // Cancelar qualquer timer existente para este NPC
    if (this._respawnTimers.has(id)) {
      clearTimeout(this._respawnTimers.get(id));
      this._respawnTimers.delete(id);
    }

    // Dungeon NPCs (noRespawn flag or noNpcRespawn on map def) are removed and never re-spawned.
    const npc        = this.npcs.get(id);
    const mapNpcDef  = (this.mapDefs[(mapLevel || npc?.mapLevel) ?? this.zoneLevel] || {}).npc || {};
    if ((npc && npc.noRespawn) || mapNpcDef.noNpcRespawn) {
      this.npcs.delete(id);
      return;
    }

    this.npcs.delete(id);
    
    const timer = setTimeout(() => {
      this._respawnTimers.delete(id);
      
      const npcDef = (this.mapDefs[this.zoneLevel] || {}).npc || {};
      const maxCount = npcDef.count || NPC_COUNT;
      
      if (this.npcs.size >= maxCount) return;
      
      const npc = this.spawn(mapLevel || this.zoneLevel || 1);
      this._rescaleNPC(npc, killerKills);
      npc.hp = npc.maxHp;
      
      this._broadcast({
        type: 'entity_add',
        entity: this.snapshot([npc])[0]
      });
    }, 5000);
    
    this._respawnTimers.set(id, timer);
  }

  get(id) {
    return this.npcs.get(id);
  }
  
  getAll() {
    return Array.from(this.npcs.values());
  }

  // Rescales boss stats — keeps HP proportional, NEVER resets to full
  _rescaleBoss(boss, kills) {
    if (boss._scaledForKills === kills) return;
    // Dungeon bosses têm stats fixos definidos em spawnWithDef — não escalam com kills do jogador.
    // Sem esse guard, _rescaleBoss zeraria cannonDmg e resetaria HP para 600 (fallback).
    if (boss.isDungeonBoss) {
      boss._scaledForKills = kills;
      return;
    }
    const bossDef  = (this.mapDefs[boss.mapLevel || this.zoneLevel] || {}).boss || {};
    const tier     = Math.floor(kills / 10);
    const hpTier   = Math.min(tier, 300);
    const dmgTier  = Math.min(tier, 250);
    const hpScale  = 1 + hpTier  * (bossDef.hpPerTier  || 0);
    const dmgScale = 1 + dmgTier * (bossDef.dmgPerTier  || 0);
    const rarities = bossDef.rarities || [];
    const rarityDef = rarities.find(r => r.id === boss.rarity) || { hpMult: 1 };
    const newMax   = Math.round((bossDef.baseHp || 600) * hpScale * (rarityDef.hpMult || 1));

    if (newMax !== boss.maxHp) {
      const frac = boss.maxHp > 0 ? boss.hp / boss.maxHp : 1;
      boss.maxHp = newMax;
      boss.hp    = Math.min(Math.floor(newMax * frac), newMax);
    }

    boss.cannonDmg      = Math.round((bossDef.baseDamage || 0) * dmgScale);
    boss.spawnTier      = tier;
    boss._scaledForKills = kills;
  }

  // Rescales stats only — NEVER resets HP
  _rescaleNPC(npc, kills) {
    if (npc._scaledForKills === kills) return;
    
    const mapNpcDef = (this.mapDefs[npc.mapLevel || this.zoneLevel] || {}).npc || {};
    const tier    = Math.floor(kills / 10);
    const hpTier  = Math.min(tier, 300);
    const dmgTier = Math.min(tier, 250);
    const hpPerTier  = mapNpcDef.hpPerTier  ?? 0.05;
    const dmgPerTier = mapNpcDef.dmgPerTier ?? 0.08;
    const newMax = Math.floor(npc.baseHp * (1 + hpTier * hpPerTier));
    // Para NPCs com canhões: usa count do MAP_DEFS como base + tier
    // Para monstros (ATTACK_DEFS): cannonCount não é usado, linear de 1
    const baseCannonCount = npc.usesCannons ? (mapNpcDef.cannonCount || 1) : 1;
    npc.cannonCount = Math.min(20, baseCannonCount + dmgTier);
    npc.cannonDmg   = Math.round(npc.baseDmg * (1 + dmgTier * dmgPerTier));

    if (newMax !== npc.maxHp) {
      const frac = npc.maxHp > 0 ? npc.hp / npc.maxHp : 1;
      npc.maxHp = newMax;
      npc.hp = Math.floor(newMax * frac);
    }

    const tiers = [...(mapNpcDef.ammoTiers || [])].sort((a, b) => b.minKills - a.minKills);
    let chosenAmmo = 'bala_ferro';
    for (const t of tiers) {
      if (kills >= t.minKills) {
        chosenAmmo = t.ammo === 'random_special'
          ? (['bala_gelo', 'bala_fogo', 'bala_luz', 'bala_sangue'])[Math.floor(Math.random() * 4)]
          : t.ammo;
        break;
      }
    }
    
    npc.ammoType = chosenAmmo;
    npc._scaledForKills = kills;
  }


  update(dt, players) {
    const now = Date.now();
    const playersMap = players instanceof Map ? players : new Map(players.map(p => [p.id, p]));
    
    this.npcs.forEach(npc => {
      if (npc.dead) return;

      // Limpar status effects expirados
      if (npc.slowExpires && now > npc.slowExpires) {
        npc.slowMult = 1;
        npc.slowExpires = 0;
      }
      if (npc.stunExpires && now > npc.stunExpires) npc.stunExpires = 0;

      if (npc.stunExpires && now < npc.stunExpires) return;

      // Cache de alvo com timeout
      if (!npc._targetCacheTime || now - npc._targetCacheTime > 200) {
        npc._targetCacheTime = now;
        let nearest_ = null;
        let nearestDist_ = Infinity;
        
        for (const p of playersMap.values()) {
          if (!p.dead) {
            const d = dist2D(npc, p);
            if (d < nearestDist_) {
              nearestDist_ = d;
              nearest_ = p;
            }
          }
        }
        
        npc._cachedNearest = nearest_;
        npc._cachedNearestDist = nearestDist_;
      }
      
      let nearest = npc._cachedNearest;
      let nearestDist = npc._cachedNearestDist ?? Infinity;
      
      // Invalidar cache se necessário
      if (nearest && (nearest.dead || !playersMap.has(nearest.id))) {
        nearest = null;
        nearestDist = Infinity;
        npc._targetCacheTime = 0;
        npc._cachedNearest = null;
      }

      // NPC rescale
      const noRecentDamage = !npc.lastDamageTime || (now - npc.lastDamageTime > 20000);
      if (nearest && nearest.id !== npc.targetId && noRecentDamage && !npc.isBoss) {
        const kills = nearest.npcKills || 0;
        if (kills !== npc._scaledForKills) {
          this._rescaleNPC(npc, kills);
          this._broadcast({
            type: 'entity_rescale',
            id: npc.id,
            hp: npc.hp,
            maxHp: npc.maxHp,
            tier: Math.floor(kills / 10)
          });
        }
      }

      // Boss rescale — atualiza tier ao pegar novo target; reseta se ocioso
      // Dungeon bosses têm stats fixos (spawnWithDef), não sofrem rescale
      if (npc.isBoss && !npc.isWorldBoss && !npc.isDungeonBoss) {
        if (nearest && nearest.id !== npc.targetId) {
          // Novo target: rescala imediatamente para o tier dele
          const kills = nearest.npcKills || 0;
          if (kills !== npc._scaledForKills) {
            this._rescaleBoss(npc, kills);
            this._broadcast({
              type: 'entity_rescale',
              id: npc.id,
              hp: npc.hp,
              maxHp: npc.maxHp,
              tier: npc.spawnTier,
            });
            console.log(`👹 Boss map${npc.mapLevel} rescaled → tier ${npc.spawnTier} (target: ${nearest.id})`);
          }
        } else if (!nearest) {
          // Sem ninguém por perto + 30s sem dano → reset para tier 0
          const bossIdleReset = !npc.lastDamageTime || (now - npc.lastDamageTime > 30000);
          if (bossIdleReset && (npc._scaledForKills || 0) !== 0) {
            this._rescaleBoss(npc, 0);
            this._broadcast({
              type: 'entity_rescale',
              id: npc.id,
              hp: npc.hp,
              maxHp: npc.maxHp,
              tier: 0,
            });
            console.log(`👹 Boss map${npc.mapLevel} reset → tier 0 (idle)`);
          }
        }
      }

      // Boss regeneration
      if (npc.isBoss && npc.hp < npc.maxHp) {
        const bossMapDef = (MAP_DEFS[npc.mapLevel || 1] || MAP_DEFS[1]).boss || {};
        const wbDef = npc.isWorldBoss ? WORLD_BOSS_DEF[0] : null;
        const regenDelay = (wbDef || bossMapDef).regenDelay || 20000;
        const regenPerSec = (wbDef || bossMapDef).regenPerSec || 0;
        
        if (regenPerSec > 0 && (now - (npc.lastDamageTime || 0)) >= regenDelay) {
          const healed = regenPerSec * dt;
          npc.hp = Math.min(npc.maxHp, npc.hp + healed);
          
          if (!npc._lastRegenBroadcast || now - npc._lastRegenBroadcast >= 500) {
            npc._lastRegenBroadcast = now;
            this._broadcast({
              type: 'hit',
              targetId: npc.id,
              targetIsNPC: true,
              hp: Math.round(npc.hp),
              maxHp: npc.maxHp,
              dmg: 0,
              regen: true
            });
          }
        }
      }


      // Attraction relic
      let attractPlayer = null;
      let attractDist = Infinity;
      
      for (const p of playersMap.values()) {
        if (!p.dead && p.relicAttractExpires && now < p.relicAttractExpires) {
          const d = dist2D(npc, p);
          if (d <= p.relicAttractRange && d < attractDist) {
            attractDist = d;
            attractPlayer = p;
          }
        }
      }
      
      if (attractPlayer) {
        const angle2 = Math.atan2(attractPlayer.x - npc.x, attractPlayer.z - npc.z);
        let diff2 = angle2 - npc.rotation;
        while (diff2 > Math.PI) diff2 -= Math.PI * 2;
        while (diff2 < -Math.PI) diff2 += Math.PI * 2;
        npc.rotation += clamp(diff2, -0.12, 0.12);
        npc.speed = Math.min(npc.speed + 0.08, SHIP_SPEED * 0.9 * (npc.slowMult || 1));
        npc.x += Math.sin(npc.rotation) * npc.speed * dt * 30;
        npc.z += Math.cos(npc.rotation) * npc.speed * dt * 30;
        {
          const ms = (MAP_DEFS[npc.mapLevel] && MAP_DEFS[npc.mapLevel].size);
          npc.x = clamp(npc.x, -ms / 2, ms / 2);
          npc.z = clamp(npc.z, -ms / 2, ms / 2);
        }
        // Island avoidance on attract path (Map 3)
        if ((npc.mapLevel || 1) === 3) {
          const mkt = MAP_DEFS[3]?.market;
          if (mkt) {
            const cx = mkt.center?.x || 0; const cz = mkt.center?.z || 0;
            const iR = (mkt.islandRadius || 100) + 8;
            const ddx = npc.x - cx; const ddz = npc.z - cz;
            const dd2 = ddx * ddx + ddz * ddz;
            if (dd2 < iR * iR && dd2 > 0) {
              const dd = Math.sqrt(dd2);
              npc.x = cx + (ddx / dd) * iR;
              npc.z = cz + (ddz / dd) * iR;
            }
          }
        }
        return;
      }

      // Island security zone: skip target if player is within securyRadius of any safe island
      let nearestForCombat = nearest;
      let nearestDistForCombat = nearestDist;
      if (nearest && !npc.isBoss) {
        const _mapDef = MAP_DEFS[npc.mapLevel || 1] || {};
        const _safeIsland = _mapDef.banking || _mapDef.market;
        if (_safeIsland?.securyRadius) {
          const _sc = _safeIsland.center || { x: 0, z: 0 };
          const _pdx = nearest.x - _sc.x;
          const _pdz = nearest.z - _sc.z;
          const _secR = _safeIsland.securyRadius;
          const _inSafe = _safeIsland.islandShape === 'square'
            ? Math.abs(_pdx) <= _secR && Math.abs(_pdz) <= _secR
            : (_pdx * _pdx + _pdz * _pdz) < _secR * _secR;
          if (_inSafe) nearestForCombat = null; // player in safe zone — don't engage
        }
      }

      // Limpar zonas de perigo expiradas (feito uma vez por tick global, não por NPC,
      // mas é barato o suficiente aqui — lista pequena)
      if (this._dangerZones.length) {
        this._dangerZones = this._dangerZones.filter(dz => dz.expires > now);
      }

      // Desvio de zonas de perigo (relíquias do jogador, etc.)
      // O NPC verifica se está na zona ou se está se aproximando dela e desvia.
      // Tem prioridade sobre a navegação normal mas é interrompido pelo cast.
      let dodging = false;
      if (!npc._currentCast && this._dangerZones.length) {
        for (const dz of this._dangerZones) {
          const ddx = npc.x - dz.x;
          const ddz = npc.z - dz.z;
          const distToDanger = Math.sqrt(ddx * ddx + ddz * ddz);
          // buffer de 25u além do raio para reagir antes de entrar
          if (distToDanger < dz.radius + 25) {
            // Girar em direção oposta ao centro da zona
            const escapeAngle = Math.atan2(ddx, ddz);
            let diffD = escapeAngle - npc.rotation;
            while (diffD > Math.PI) diffD -= Math.PI * 2;
            while (diffD < -Math.PI) diffD += Math.PI * 2;
            npc.rotation += clamp(diffD, -0.10, 0.10);
            const maxSpd = npc.isBoss ? SHIP_SPEED * 0.95 : SHIP_SPEED * 0.75;
            npc.speed = Math.min(npc.speed + 0.07, maxSpd * (npc.slowMult || 1));
            dodging = true;
            break;
          }
        }
      }

      // Combat — bosses always pursue the nearest player (no distance limit)
      // so they never drift into fog and disappear. Regular NPCs disengage at 210 u.
      if (!dodging) {
        const engageRange = npc.isBoss ? Infinity : 210;
        if (nearestForCombat && nearestDistForCombat < engageRange) {
          npc.targetId = nearestForCombat.id;

          if (npc.usesCannons) {
            // ── Navios piratas: disparo de canhão via fireInterval ─────────────
            if (nearestDistForCombat <= npc.cannonRange) {
              const fireNow = Date.now();
              if (fireNow >= npc._nextCannonShot) {
                npc._nextCannonShot = fireNow + npc.fireInterval;
                const count   = npc.cannonCount || 1;
                const spread  = npc.cannonSpread ?? 0.3;
                const baseAng = Math.atan2(nearestForCombat.x - npc.x, nearestForCombat.z - npc.z);
                for (let ci = 0; ci < count; ci++) {
                  const ang = baseAng + (Math.random() - 0.5) * spread;
                  // Projétil vai em direção ao alvo, limitado pelo cannonRange
                  const projDist = Math.min(nearestDistForCombat + 20, npc.cannonRange);
                  this.projectileManager.spawn(
                    npc,
                    npc.x + Math.sin(ang) * projDist,
                    npc.z + Math.cos(ang) * projDist,
                    0, 1.0, npc.cannonDmg || 0
                  );
                }
              }
            }
          } else if (this.attackManager) {
            // ── Monstros: sistema ATTACK_DEFS (telegraph + AoE) ──────────────
            this.attackManager.tryAttack(npc, nearestForCombat, [...players.values()], this.zoneLevel);
          }

          // Ao usar um ataque (cast de monstro), o NPC desacelera para concentrar a mira
          if (npc._currentCast) {
            npc.speed = Math.max(0, npc.speed - 0.08);
          } else {
            const angle = Math.atan2(nearestForCombat.x - npc.x, nearestForCombat.z - npc.z);
            let diff = angle - npc.rotation;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            npc.rotation += clamp(diff, -0.06, 0.06);
            // Bosses are slightly faster so they can chase a fleeing player
            const maxSpd = npc.isBoss ? SHIP_SPEED * 0.95 : SHIP_SPEED * 0.7;
            npc.speed = Math.min(npc.speed + 0.05, maxSpd * (npc.slowMult || 1));
          }
        } else {
          npc.rotation += (Math.random() - 0.5) * 0.02;
          npc.speed = Math.min(npc.speed + 0.01, SHIP_SPEED * 0.4 * (npc.slowMult || 1));
          npc.targetId = null;
        }
      }

      npc.x += Math.sin(npc.rotation) * npc.speed * dt * 30;
      npc.z += Math.cos(npc.rotation) * npc.speed * dt * 30;

      {
        const ms = (MAP_DEFS[npc.mapLevel] && MAP_DEFS[npc.mapLevel].size);
        if (Math.abs(npc.x) > ms / 2 || Math.abs(npc.z) > ms / 2) {
          npc.rotation += Math.PI + rand(-0.5, 0.5);
        }
        npc.x = clamp(npc.x, -ms / 2, ms / 2);
        npc.z = clamp(npc.z, -ms / 2, ms / 2);
      }

      // Island avoidance (Map 3) — ilha intangível para NPCs
      if ((npc.mapLevel || 1) === 3) {
        const market = MAP_DEFS[3]?.market;
        if (market) {
          const cx = market.center?.x || 0;
          const cz = market.center?.z || 0;
          const iRad = (market.islandRadius || 100) + 8;
          const dx = npc.x - cx;
          const dz = npc.z - cz;
          const dist2 = dx * dx + dz * dz;
          if (dist2 < iRad * iRad && dist2 > 0) {
            const dist = Math.sqrt(dist2);
            npc.x = cx + (dx / dist) * iRad;
            npc.z = cz + (dz / dist) * iRad;
            // Deflect NPC rotation away from island
            npc.rotation += Math.PI * 0.5 + rand(-0.3, 0.3);
          }
        }
      }

      // Auras tickam sempre, independente de haver alvo
      if (this.attackManager && npc.auras?.length) {
        this.attackManager.tickAuras(npc, [...players.values()], this.zoneLevel);
      }
    });
  }

  snapshot(filter) {
    const list = filter || Array.from(this.npcs.values());
    return list.map(n => ({
      id: n.id,
      name: n.name,
      x: n.x,
      y: n.y,
      z: n.z,
      rotation: n.rotation,
      hp: n.hp,
      maxHp: n.maxHp,
      speed: n.speed,
      dead: n.dead,
      isNPC: true,
      isBoss: n.isBoss,
      isDungeonBoss: n.isDungeonBoss || false,
      isWorldBoss: n.isWorldBoss || false,
      rarity: n.rarity || null,
      mapLevel: n.mapLevel || 1,
      npcHullColor: n.npcHullColor,
      npcSailColor: n.npcSailColor,
      npcFlagColor: n.npcFlagColor,
      npcModel:     n.npcModel || null,
      npcScale:     n.npcScale,
      npcYOffset:   n.npcYOffset,
      npcRotOffset: n.npcRotOffset,
      usesCannons:  n.usesCannons || false,
    }));
  }

  _broadcast(data) {
    const msg = JSON.stringify(data);
    if (this.projectileManager.players) {
      // Broadcast para jogadores desta zona
      for (const p of this.projectileManager.players.values()) {
        if ((p.mapLevel || 1) === this.zoneLevel && p.ws?.readyState === 1) {
          p.ws.send(msg);
        }
      }
    } else if (this.projectileManager.wss) {
      // Fallback: broadcast para todos
      for (const ws of this.projectileManager.wss.clients) {
        const MAX_BUFFER = parseInt(process.env.MAX_BUFFER);
        if (ws.readyState === 1 && ws.bufferedAmount < MAX_BUFFER) ws.send(msg);
      }
    }
  }

  /** Broadcast to ALL connected players regardless of zone (for world boss events). */
  _broadcastAll(data) {
    const msg = JSON.stringify(data);
    
    if (this.projectileManager.wss) {
      for (const ws of this.projectileManager.wss.clients) {
        const MAX_BUFFER = parseInt(process.env.MAX_BUFFER);
        if (ws.readyState === 1 && ws.bufferedAmount < MAX_BUFFER) ws.send(msg);
      }
    }
  }

  /**
   * Registra uma zona de perigo para que os NPCs tentem desviar.
   * @param {number} x
   * @param {number} z
   * @param {number} radius  raio da zona
   * @param {number} durationMs  duração em ms (normalmente = castTime da relíquia)
   */
  notifyDangerZone(x, z, radius, durationMs) {
    this._dangerZones.push({ x, z, radius, expires: Date.now() + durationMs });
  }

  // Método de cleanup para quando a zona é destruída
  destroy() {
    // Cancelar todos os timers de respawn
    for (const [id, timer] of this._respawnTimers) {
      clearTimeout(timer);
    }
    this._respawnTimers.clear();
    
    // Limpar intervalo de cleanup
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    
    // Limpar todos os NPCs
    for (const npc of this.npcs.values()) {
      // Limpar arrays e referências
      if (npc.dots) npc.dots.length = 0;
      npc._cachedNearest = null;
    }
    
    this.npcs.clear();
    this.projectileManager = null;
    this.mapDefs = null;
  }
}

module.exports = NPCManager;