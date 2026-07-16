// managers/NPCManager.js
const { uid, rand, clamp, dist2D } = require('../utils/helpers');
const { pushOutOfIslands, pushOutOfWalls } = require('../utils/collision');
const { MAX_HP, SHIP_SPEED, NPC_COUNT, MAP_DEFS, WORLD_BOSS_DEF, HIT_RADIUS, difficultyMult } = require('../constants');

// ── Equilíbrio de aggro dos NPCs normais (navios piratas / monstros) ─────────
// Bosses ignoram estes limites (perseguem sem distância máxima).
//   AGGRO   → distância para começar a perseguir um novo alvo (menor = menos chato)
//   DEAGGRO → distância para desistir do alvo atual (aggro "pegajoso": > AGGRO)
//   LEASH   → distância máxima do ponto de spawn antes de desistir e voltar pra casa
//             (impede que o NPC seja arrastado pelo mapa inteiro)
const NPC_AGGRO_RANGE   = 150;
const NPC_DEAGGRO_RANGE = 320;
const NPC_LEASH_RANGE   = 700;

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
      _scaledForDiff:   1,   // dungeon boss tem stats fixos; guard de _rescaleBoss
      diffMult:         1,
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
      _scaledForDiff:  null, // sentinela: força o 1º rescale (define cannonCount/ammo base)
      diffMult:        1,    // multiplicador de dificuldade atual (recompensa usa este)
      diffIdx:         0,    // índice da dificuldade atual (seleção de munição)
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
      // Nasce na dificuldade base; o update() reescala para a dificuldade do
      // jogador mais próximo assim que alguém entra em alcance.
      this._rescaleNPC(npc);
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

  // Rescales boss stats — keeps HP proportional, NEVER resets to full.
  // Escala APENAS pela dificuldade escolhida pelo jogador (não por kills).
  _rescaleBoss(boss, diffMult = boss.diffMult || 1) {
    if (boss._scaledForDiff === diffMult) return;
    // Dungeon bosses têm stats fixos definidos em spawnWithDef — não escalam.
    // Sem esse guard, _rescaleBoss zeraria cannonDmg e resetaria HP para 600 (fallback).
    if (boss.isDungeonBoss) {
      boss._scaledForDiff = diffMult;
      return;
    }
    const bossDef   = (this.mapDefs[boss.mapLevel || this.zoneLevel] || {}).boss || {};
    const rarities  = bossDef.rarities || [];
    const rarityDef = rarities.find(r => r.id === boss.rarity) || { hpMult: 1 };
    const newMax    = Math.round((bossDef.baseHp || 600) * diffMult * (rarityDef.hpMult || 1));

    if (newMax !== boss.maxHp) {
      const frac = boss.maxHp > 0 ? boss.hp / boss.maxHp : 1;
      boss.maxHp = newMax;
      boss.hp    = Math.min(Math.floor(newMax * frac), newMax);
    }

    boss.cannonDmg      = Math.round((bossDef.baseDamage || 0) * diffMult);
    boss.diffMult       = diffMult;
    boss.spawnTier      = 0;
    boss._scaledForDiff = diffMult;
  }

  // Rescales stats only — NEVER resets HP.
  // Escala APENAS pela dificuldade escolhida pelo jogador (não pela quantidade de kills).
  _rescaleNPC(npc, diffMult = npc.diffMult || 1, diffIdx = npc.diffIdx || 0) {
    if (npc._scaledForDiff === diffMult) return;

    const mapNpcDef = (this.mapDefs[npc.mapLevel || this.zoneLevel] || {}).npc || {};
    // HP e dano por projétil escalam somente pela dificuldade.
    const newMax = Math.floor(npc.baseHp * diffMult);
    // cannonCount é fixo pela base do mapa (não cresce mais com kills).
    const baseCannonCount = npc.usesCannons ? (mapNpcDef.cannonCount || 1) : 1;
    npc.cannonCount = Math.min(20, baseCannonCount);
    npc.cannonDmg   = Math.round(npc.baseDmg * diffMult);
    npc.diffMult    = diffMult;
    npc.diffIdx     = diffIdx;
    npc._scaledForDiff = diffMult;

    if (newMax !== npc.maxHp) {
      const frac = npc.maxHp > 0 ? npc.hp / npc.maxHp : 1;
      npc.maxHp = newMax;
      npc.hp = Math.floor(newMax * frac);
    }

    // Munição escala pela dificuldade: cada nível libera o próximo tier de munição.
    const tiers = [...(mapNpcDef.ammoTiers || [])].sort((a, b) => a.minKills - b.minKills);
    let chosenAmmo = 'bala_ferro';
    if (tiers.length > 0) {
      const t = tiers[Math.min(diffIdx, tiers.length - 1)];
      chosenAmmo = t.ammo === 'random_special'
        ? (['bala_gelo', 'bala_fogo', 'bala_luz', 'bala_sangue'])[Math.floor(Math.random() * 4)]
        : t.ammo;
    }
    npc.ammoType = chosenAmmo;
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
          if (!p.dead && !p.isPeaceful && !(p.safeUntil && now < p.safeUntil)) {
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
      // Escala do NPC = dificuldade escolhida pelo alvo (não escala mais por kills).
      // Só re-escala fora de combate (20s sem dano): ao tomar dano o NPC TRAVA
      // sua dificuldade até passar esse tempo sem sofrer ação — evita que
      // o jogador troque a dificuldade no meio da luta para mudar a recompensa.
      const noRecentDamage = !npc.lastDamageTime || (now - npc.lastDamageTime > 20000);
      if (nearest && nearest.id !== npc.targetId && noRecentDamage && !npc.isBoss) {
        const diffIdx  = nearest.difficulty || 0;
        const diffMult = difficultyMult(diffIdx);
        if (diffMult !== npc._scaledForDiff) {
          this._rescaleNPC(npc, diffMult, diffIdx);
          this._broadcast({
            type: 'entity_rescale',
            id: npc.id,
            hp: npc.hp,
            maxHp: npc.maxHp,
            tier: 0
          });
        }
      }

      // Boss rescale — só ocorre se o boss estiver fora de combate por 5 minutos.
      // Durante o combate o tier é fixo, independente de quem entrou na zona.
      // Dungeon bosses têm stats fixos (spawnWithDef), não sofrem rescale.
      if (npc.isBoss && !npc.isWorldBoss && !npc.isDungeonBoss) {
        const RESCALE_OOC_MS = 5 * 60 * 1000; // 5 minutos fora de combate
        const outOfCombat = !npc.lastDamageTime || (now - npc.lastDamageTime > RESCALE_OOC_MS);

        if (outOfCombat) {
          if (nearest && nearest.id !== npc.targetId) {
            // Fora de combate e novo target em range → rescala para a dificuldade dele
            const diffMult = difficultyMult(nearest.difficulty || 0);
            if (diffMult !== npc._scaledForDiff) {
              this._rescaleBoss(npc, diffMult);
              this._broadcast({
                type: 'entity_rescale',
                id: npc.id,
                hp: npc.hp,
                maxHp: npc.maxHp,
                tier: 0,
              });
              console.log(`👹 Boss map${npc.mapLevel} rescaled → diff ${nearest.difficulty || 0} (OOC, target: ${nearest.id})`);
            }
          } else if (!nearest && (npc._scaledForDiff || 1) !== 1) {
            // Fora de combate e sem ninguém por perto → reset para dificuldade base
            this._rescaleBoss(npc, 1);
            this._broadcast({
              type: 'entity_rescale',
              id: npc.id,
              hp: npc.hp,
              maxHp: npc.maxHp,
              tier: 0,
            });
            console.log(`👹 Boss map${npc.mapLevel} reset → base (OOC, idle)`);
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
        // Ilhas intangíveis também no caminho de atração — mesmas formas de
        // colisão dos jogadores (utils/collision.js), em qualquer mapa
        pushOutOfIslands(npc, MAP_DEFS[npc.mapLevel || 1], 8);
        // Muros temporários de relíquia — mesma consulta do loop principal.
        const _attractWalls = this.wallManager?.getActive(npc.mapLevel || 1);
        if (_attractWalls && _attractWalls.length) pushOutOfWalls(npc, _attractWalls, 8);
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
      // so they never drift into fog and disappear. NPCs normais usam aggro
      // pegajoso (AGGRO/DEAGGRO) + leash do spawn — ver bloco padrão abaixo.
      if (!dodging) {

        // ── Melee boss (humanóide) — aggro + máquina de estados ─────────────────
        if (npc.isBoss && npc.moveType === 'melee') {

          // — Aggro por dano recebido (checa lastDamageTime sem precisar alterar projectile-manager)
          if (npc.aggroState === 'passive') {
            const dmgT = npc.lastDamageTime || 0;
            if (dmgT > npc._lastCheckedDmgTime) {
              npc.aggroState = 'aggressive';
              npc._proximityMap?.clear();
              console.log(`👹 Boss map${npc.mapLevel} → AGRESSIVO (dano recebido)`);
            }
            npc._lastCheckedDmgTime = dmgT;
          }

          // — Aggro por proximidade (20 s contínuos dentro do raio)
          if (npc.aggroState === 'passive' && npc._proximityMap) {
            for (const [pid, p] of playersMap) {
              if (p.dead) continue;
              const d = dist2D(npc, p);
              if (d <= npc._aggroRange) {
                if (!npc._proximityMap.has(pid)) {
                  npc._proximityMap.set(pid, now);
                } else if (now - npc._proximityMap.get(pid) >= npc._aggroTime) {
                  npc.aggroState = 'aggressive';
                  npc._proximityMap.clear();
                  console.log(`👹 Boss map${npc.mapLevel} → AGRESSIVO (${pid} ficou ${npc._aggroTime/1000}s perto)`);
                  break;
                }
              } else {
                npc._proximityMap.delete(pid);
              }
            }
          }

          // — Verificar/iniciar ataque especial (melee boss)
          if (npc.aggroState === 'aggressive' && !npc._currentCast && nearestForCombat) {
            for (const atk of (npc.attacks || [])) {
              const cd = npc._attackCooldowns[atk.id] || 0;
              if (now < cd) continue;
              if (dist2D(npc, nearestForCombat) > (atk.triggerRange || 600)) continue;
              npc._currentCast = {
                id: atk.id, atk,
                startTime: now,
                _dmgDealt: false,
                targetX: nearestForCombat.x,
                targetZ: nearestForCombat.z,
                targetId: nearestForCombat.id,
              };
              npc._attackCooldowns[atk.id] = now + atk.cooldown;
              this._broadcast({
                type: 'boss_cast_start',
                npcId: npc.id, attackId: atk.id,
                animIdx: atk.animIdx, animSpeed: atk.animSpeed,
                phase1End: atk.phase1End, phase2End: atk.phase2End,
                totalDuration: atk.totalDuration,
              });
              console.log(`👹 [boss-cast] ${atk.id} map${npc.mapLevel} → (${nearestForCombat.x.toFixed(0)},${nearestForCombat.z.toFixed(0)})`);
              break;
            }
          }

          // — Processar fases do cast ativo
          if (npc._currentCast) {
            const { atk, startTime, targetX, targetZ } = npc._currentCast;
            const elapsed = now - startTime;

            if (elapsed < atk.phase1End) {
              // Fase 1 (0–1.5s): afunda — parado
              npc.speed = 0; npc.moveState = 'cast';

            } else if (elapsed < atk.phase2End) {
              // Fase 2 (1.5–4s): nada embaixo do barco — 200% velocidade
              const dx = targetX - npc.x;
              const dz = targetZ - npc.z;
              const d  = Math.sqrt(dx * dx + dz * dz);
              if (d > 15) {
                npc.rotation = Math.atan2(dx, dz);
                npc.speed    = SHIP_SPEED * 2.0;
              } else {
                npc.speed = 0; // chegou sob o barco
              }
              npc.moveState = 'cast';

            } else if (elapsed < atk.totalDuration) {
              // Fase 3 (4–7s): emerge — parado, aplica dano uma única vez
              npc.speed = 0; npc.moveState = 'cast';
              if (!npc._currentCast._dmgDealt) {
                npc._currentCast._dmgDealt = true;
                for (const [pid, p] of playersMap) {
                  if (p.dead) continue;
                  if (dist2D(npc, p) > (atk.damageRadius || 220)) continue;
                  let dmg = Math.round((atk.damage || 200) * (npc.dmgMult || 1));
                  // Invencível (Névoa) + defensiva do pet valem aqui também
                  if (p.relicInvincibleExpires && Date.now() < p.relicInvincibleExpires) continue;
                  const petMgr = this.projectileManager ? this.projectileManager.petManager : null;
                  if (petMgr) {
                    dmg = petMgr.interceptOwnerDamage(p, dmg);
                    if (dmg <= 0) continue;
                  }
                  p.hp = Math.max(0, p.hp - dmg);
                  if (p.hp <= 0 && !p.dead) p.dead = true;
                  this._broadcast({ type: 'npc_attack_hit', targetId: pid, damage: dmg, x: npc.x, z: npc.z, attackId: atk.id });
                }
                this._broadcast({ type: 'boss_emerge_vfx', npcId: npc.id, x: npc.x, z: npc.z });
                console.log(`👹 [boss-cast] emerge VFX+dmg @ (${npc.x.toFixed(0)},${npc.z.toFixed(0)}) r=${atk.damageRadius}`);
              }
            } else {
              // Cast finalizado — volta ao movimento normal
              npc._currentCast = null;
            }

          } else if (npc.aggroState === 'passive') {
            // Parado — nada de chase
            npc.speed     = 0;
            npc.moveState = 'idle';
            npc.targetId  = null;
          } else {
            // Agressivo — persegue o mais próximo (walk perto, run longe)
            if (nearestForCombat) {
              npc.targetId = nearestForCombat.id;
              const mAng = Math.atan2(nearestForCombat.x - npc.x, nearestForCombat.z - npc.z);
              let mDiff = mAng - npc.rotation;
              while (mDiff >  Math.PI) mDiff -= Math.PI * 2;
              while (mDiff < -Math.PI) mDiff += Math.PI * 2;
              npc.rotation += clamp(mDiff, -0.08, 0.08);
              if (nearestDistForCombat <= (npc.closeRange || 200)) {
                npc.speed     = SHIP_SPEED * 0.7125 * (npc.slowMult || 1); // 50% × 1.5
                npc.moveState = 'walk';
              } else {
                npc.speed     = SHIP_SPEED * 1.425  * (npc.slowMult || 1); // 100% × 1.5
                npc.moveState = 'run';
              }
            } else {
              // Nenhum jogador visível — aguarda parado
              npc.speed     = 0;
              npc.moveState = 'idle';
              npc.targetId  = null;
            }
          }
        } else

        // ── Movimento padrão (navios piratas / monstros normais) ────────────────
        if (true) {
        // Ponto de origem (home) para o leash — inicializado preguiçosamente
        if (npc.spawnX === undefined) { npc.spawnX = npc.x; npc.spawnZ = npc.z; }
        const homeDist = Math.hypot(npc.x - npc.spawnX, npc.z - npc.spawnZ);
        const leashed  = !npc.isBoss && homeDist > NPC_LEASH_RANGE;

        // Decisão de alvo — bosses sempre engajam; NPCs normais usam aggro pegajoso:
        // engajam de perto (AGGRO), mantêm até o alvo fugir além de DEAGGRO, e
        // desistem se forem arrastados para longe do spawn (leash).
        let engaged = false;
        if (npc.isBoss) {
          engaged = !!nearestForCombat;
        } else if (!leashed && nearestForCombat) {
          engaged = (npc.targetId === nearestForCombat.id)
            ? nearestDistForCombat < NPC_DEAGGRO_RANGE
            : nearestDistForCombat < NPC_AGGRO_RANGE;
        }

        if (engaged && nearestForCombat) {
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
        } else if (leashed) {
          // Arrastado para longe demais → desiste do alvo e navega de volta ao spawn
          npc.targetId = null;
          const angleHome = Math.atan2(npc.spawnX - npc.x, npc.spawnZ - npc.z);
          let diffH = angleHome - npc.rotation;
          while (diffH > Math.PI)  diffH -= Math.PI * 2;
          while (diffH < -Math.PI) diffH += Math.PI * 2;
          npc.rotation += clamp(diffH, -0.06, 0.06);
          npc.speed = Math.min(npc.speed + 0.04, SHIP_SPEED * 0.6 * (npc.slowMult || 1));
        } else {
          npc.rotation += (Math.random() - 0.5) * 0.02;
          npc.speed = Math.min(npc.speed + 0.01, SHIP_SPEED * 0.4 * (npc.slowMult || 1));
          npc.targetId = null;
        }
        } // fecha if(true) do bloco padrão
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

      // Ilhas intangíveis para NPCs — em QUALQUER mapa, respeitando as mesmas
      // formas de colisão dos jogadores (colliders do editor ou islandRadius)
      if (pushOutOfIslands(npc, MAP_DEFS[npc.mapLevel || 1], 8)) {
        // Deflete a rota para longe da ilha (evita ficar "raspando" na borda)
        npc.rotation += Math.PI * 0.5 + rand(-0.3, 0.3);
      }
      // Muros temporários de relíquia (ex.: Muro de Pedra) — o NPC é
      // empurrado pra fora e deflete a rota, exatamente como numa ilha.
      const _mainWalls = this.wallManager?.getActive(npc.mapLevel || 1);
      if (_mainWalls && _mainWalls.length && pushOutOfWalls(npc, _mainWalls, 8)) {
        npc.rotation += Math.PI * 0.5 + rand(-0.3, 0.3);
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
      moveState:    n.moveState  || null,
      aggroState:   n.aggroState || null,
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