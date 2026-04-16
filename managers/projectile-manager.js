// managers/projectile-manager.js
const { projUid, dist2D, broadcast, sendTo } = require('../utils/helpers');
const { calcProjectileDamage, calcKillGold, calcKillXp } = require('../utils/combat-calc');
const db = require('./db-manager');
const {
  PROJECTILE_SPEED, PROJECTILE_LIFETIME, HIT_RADIUS,
  AMMO_DEFS, PIRATE_DEFS, GOLD_DROP_MIN, GOLD_DROP_MAX,
  FRAGMENT_DROP_NPC, RELIC_DEFS, RELIC_RARITIES,
  SHOW_LOG, CANNON_DEFS, MAP_DEFS,
} = require('../constants');

// ownedIds: Set de relicIds que o jogador já possui (para evitar duplicatas)
function _rollRelicDrop(ownedIds = new Set()) {
  // Filtra apenas relíquias que o jogador ainda não tem
  const available = Object.entries(RELIC_DEFS).filter(([id]) => !ownedIds.has(id));
  if (available.length === 0) return null; // já tem todas

  // Reconstrói pesos apenas para as disponíveis
  const totalWeight = available.reduce((s, [, d]) => {
    return s + (RELIC_RARITIES[d.rarity]?.dropWeight || 1);
  }, 0);

  let roll = Math.random() * totalWeight;
  let chosenEntry = available[available.length - 1]; // fallback
  for (const entry of available) {
    const w = RELIC_RARITIES[entry[1].rarity]?.dropWeight || 1;
    roll -= w;
    if (roll <= 0) { chosenEntry = entry; break; }
  }

  const [relicId, def] = chosenEntry;
  const instanceId = `rl_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
  return { instanceId, relicId, rarity: def.rarity };
}

class ProjectileManager {
  constructor(wss, players, npcs, npcManagers, bossManager, mapDefs) {
    this.wss = wss;
    this.players = players;
    this.npcs = npcs;
    this.npcManagers = Array.isArray(npcManagers) ? npcManagers : (npcManagers ? [npcManagers] : []);
    this.bossManager = bossManager;
    this.bossManager2 = bossManager;
    this.bossManager3 = bossManager; // will be updated by server when map3 manager exists
    this.mapDefs = mapDefs || {};

    // ── Registros dinâmicos (substituem as vars hardcoded por mapa) ───────────
    this.bossManagers  = new Map(); // mapLevel → BossManager
    this.killCounters  = new Map(); // mapLevel → totalKills (int)

    this.projectiles = new Map();
    this._hitBatch = new Map();
    this._lifesteals = new Map();
    this._respawnTimers = new Map(); // Rastrear timers de respawn

    this.totalNpcKills = 0;
    this.totalNpcKills2 = 0;
    this.totalNpcKills3 = 0;
    
    // Cleanup periódico
    this._cleanupInterval = setInterval(() => {
      this._cleanupStaleData();
    }, 30000); // A cada 30 segundos
    
    // Limitar tamanho do batch
    this._maxBatchSize = 1000;
  }

  _cleanupStaleData() {
    const now = Date.now();
    const MAX_DOT_AGE = 30000; // 30 segundos
    
    // Limpar _hitBatch muito antigo (caso de erro)
    if (this._hitBatch.size > this._maxBatchSize) {
      console.warn(`⚠️ HitBatch muito grande: ${this._hitBatch.size}, limpando...`);
      this._hitBatch.clear();
    }
    
    // Limpar _lifesteals de jogadores desconectados
    for (const [playerId] of this._lifesteals) {
      if (!this.players.has(playerId)) {
        this._lifesteals.delete(playerId);
      }
    }
    
    // Limpar DOTs expirados de NPCs
    for (const npc of this.npcs.values()) {
      if (npc.dots && npc.dots.length > 0) {
        npc.dots = npc.dots.filter(dot => 
          dot.next && (dot.next + MAX_DOT_AGE) > now
        );
      }
      
      // Limpar _damageMap de bosses se muito antigo (boss morreu mas referência ficou?)
      if (npc.isBoss && npc._damageMap) {
        // Se o boss está morto há mais de 5 minutos, limpar mapa
        if (npc.dead && npc.deathTime && (now - npc.deathTime) > 300000) {
          npc._damageMap.clear();
          npc._damageMap = null;
        }
      }
    }
    
    // Limpar projéteis perdidos (muito antigos)
    for (const [id, proj] of this.projectiles) {
      if (now - proj.born > PROJECTILE_LIFETIME * 2) {
        this.projectiles.delete(id);
      }
    }
  }

  spawn(shooter, targetX, targetZ, lifesteal = 0, damageMult = 1.0, cannonDmg = 0) {
    const id = projUid();

    const dx = targetX - shooter.x;
    const dz = targetZ - shooter.z;
    const angle = Math.atan2(dx, dz);

    const speedVariation = 0.95 + Math.random() * 0.1;
    const actualSpeed = PROJECTILE_SPEED * speedVariation;

    // NPCs use shooter.ammoType, players use shooter.currentAmmo
    const resolvedAmmo = shooter.isNPC
      ? (shooter.ammoType || 'bala_ferro')
      : (shooter.currentAmmo || 'bala_ferro');
    const isPiercing = resolvedAmmo === 'bala_perfurante';
    const proj = {
      id,
      ownerId:      shooter.id,
      ownerIsNPC:   !!shooter.isNPC,
      ownerMapLevel: shooter.mapLevel || 1,  // zone isolation
      lifesteal,
      cannonDmg,
      x: shooter.x,
      y: 0,
      z: shooter.z,
      vx: Math.sin(angle) * actualSpeed,
      vz: Math.cos(angle) * actualSpeed,
      ammoType:   resolvedAmmo,
      targetX,
      targetZ,
      born:       Date.now(),
      dead:       false,
      damageMultiplier: damageMult,
      piercing:   isPiercing,
      hitTargets: isPiercing ? new Set() : null, // track already-hit for piercing
      // Max travel distance = cannon range (piercing was ignoring this entirely)
      maxDist: shooter.cannonRange || 80,
      spawnX: shooter.x,
      spawnZ: shooter.z,
      _createdAt: Date.now(),
    };

    // HOMING
    if (!shooter.isNPC && shooter.homingCharges > 0) {
      let bestHoming = { radius: 0, strength: 0, crit: 0 };

      shooter.pirates.forEach(pid => {
        const def = PIRATE_DEFS[pid];
        if (def?.homingRadius && def.homingRadius > bestHoming.radius) {
          bestHoming = {
            radius:   def.homingRadius,
            strength: def.homingStrength,
            crit:     def.critChance || 0,
          };
        }
      });

      if (bestHoming.radius > 0) {
        let nearestTarget = null;
        let nearestDist   = bestHoming.radius + 1;

        this.npcs.forEach(npc => {
          if (!npc.dead) {
            const d = dist2D(shooter, npc);
            if (d < bestHoming.radius && d < nearestDist) {
              nearestDist   = d;
              nearestTarget = npc;
            }
          }
        });

        this.players.forEach(player => {
          if (!player.dead && player.id !== shooter.id) {
            const d = dist2D(shooter, player);
            if (d < bestHoming.radius && d < nearestDist) {
              nearestDist   = d;
              nearestTarget = player;
            }
          }
        });

        if (nearestTarget) {
          proj.homingTargetId    = nearestTarget.id;
          proj.homingTargetIsNPC = !!nearestTarget.isNPC;
          proj.homingStrength    = bestHoming.strength;
          proj.isCrit            = Math.random() < bestHoming.crit;
          shooter.homingCharges--;
        }
      }
    }

    this.projectiles.set(id, proj);

    // Broadcast deferred — spawnSalvo sends one batch message for all shots
    // For NPC shots (not from spawnSalvo), broadcast individually zone-filtered
    // so map 1 NPC projectiles don't appear as ghost shots on map 2 (and vice-versa)
    if (proj.ownerIsNPC) {
      const projMsg = JSON.stringify({
        type: 'spawn_projectile',
        projectile: {
          id:         proj.id,
          ownerId:    proj.ownerId,
          ownerIsNPC: true,
          x:          proj.x,
          z:          proj.z,
          targetX,
          targetZ,
          ammoType:   proj.ammoType,
          isHoming:   !!proj.homingTargetId,
        }
      });
      const ownerZone = proj.ownerMapLevel || 1;
      this.players.forEach(p => {
        if ((p.mapLevel || 1) === ownerZone && p.ws?.readyState === 1) {
          p.ws.send(projMsg);
        }
      });
    }

    return proj;
  }

  spawnSalvo(shooter, targetX, targetZ) {
    const dx       = targetX - shooter.x;
    const dz       = targetZ - shooter.z;
    const distance = Math.hypot(dx, dz);

    // Build shot list: each cannon = 1 shot, doubleShot = 2
    const shots = [];
    shooter.cannons.forEach(cid => {
      const def   = CANNON_DEFS[cid];
      const count = def?.doubleShot ? 2 : 1;
      for (let i = 0; i < count; i++) shots.push(cid);
    });

    const totalShots = shots.length || 1;

    // Cluster spread radius around target — scales with distance
    // Close range: tight cluster. Long range: wider spread.
    const spreadRadius = Math.min(12, Math.max(3, distance * 0.08));

    // Consume ammo before firing
    if (shooter.currentAmmo !== 'bala_ferro') {
      const stock = shooter.inventory?.ammo?.[shooter.currentAmmo] || 0;
      if (stock < totalShots) {
        shooter.currentAmmo = 'bala_ferro';
        sendTo(shooter.ws, { type: 'ammo_confirm', ammoId: 'bala_ferro', reason: 'out_of_stock', ammo: shooter.inventory.ammo });
      } else {
        shooter.inventory.ammo[shooter.currentAmmo] -= totalShots;
        // Send updated ammo count back so hotbar stays accurate
        sendTo(shooter.ws, { type: 'ammo_confirm', ammoId: shooter.currentAmmo, ammo: shooter.inventory.ammo });
      }
    }

    // ── Pólvora: consome 1 por salvo, concede +10% dano ──────────────────────
    let gunpowderMult = 1.0;
    if (!shooter.isNPC && (shooter.gunpowder || 0) > 0) {
      shooter.gunpowder -= 1;
      gunpowderMult = 1.10;
      // Inform client of new gunpowder stock
      sendTo(shooter.ws, {
        type:      'currency_update',
        gold:      shooter.gold,
        dobroes:   shooter.dobroes,
        gunpowder: shooter.gunpowder,
      });
    }

    // Fire each shot — collect into batch, send ONE message
    const spawnedProjs = [];
    shots.forEach(cid => {
      let impactX, impactZ;
      const def = CANNON_DEFS[cid] || {};
      const ls = def.lifesteal || 0;

      if (totalShots === 1) {
        const drift = (Math.random() - 0.5) * spreadRadius * 0.4;
        const perp  = Math.atan2(dx, dz) + Math.PI / 2;
        impactX = targetX + Math.cos(perp) * drift;
        impactZ = targetZ + Math.sin(perp) * drift;
      } else {
        let rx, rz;
        do {
          rx = (Math.random() * 2 - 1) * spreadRadius;
          rz = (Math.random() * 2 - 1) * spreadRadius;
        } while (rx * rx + rz * rz > spreadRadius * spreadRadius);
        impactX = targetX + rx;
        impactZ = targetZ + rz;
      }

      const proj = this.spawn(shooter, impactX, impactZ, ls, (shooter.damageMultiplier || 1.0) * gunpowderMult, shooter.cannonDamage || 0);
      spawnedProjs.push({
        id:       proj.id,
        ownerId:  proj.ownerId,
        x:        proj.x,
        z:        proj.z,
        targetX:  impactX,
        targetZ:  impactZ,
        ammoType: proj.ammoType,
        isHoming: !!proj.homingTargetId,
      });
    });

    // ONE broadcast for the entire salvo — but only to players in the same mapLevel
    if (spawnedProjs.length > 0) {
      const msg = JSON.stringify({
        type:        'spawn_salvo',
        ownerId:     shooter.id,
        ownerIsNPC:  false,
        projectiles: spawnedProjs,
      });
      const ownerZone = shooter.mapLevel || 1;
      this.players.forEach(p => {
        if ((p.mapLevel || 1) === ownerZone && p.ws?.readyState === 1) {
          p.ws.send(msg);
        }
      });
    }

    shooter.lastActionTime = Date.now();
    shooter.cannonCooldown = shooter.cannonCooldownMax;

    sendTo(shooter.ws, {
      type:          'cannon_state',
      charges:       0,
      maxCharges:    totalShots,
      cooldown:      shooter.cannonCooldown,
      cooldownMax:   shooter.cannonCooldownMax,
      homingCharges: shooter.homingCharges,
      ammo:          shooter.inventory?.ammo,
      range:         shooter.cannonRange,
    });
  }

  // hit() only accumulates damage into _hitBatch — no broadcasts here.
  // All network messages are sent once per tick in _flushHitBatch().
  hit(proj, target, isNPC) {
    // ── Bala de cura: só funciona em jogadores aliados do grupo ─────────────
    if (!isNPC && !proj.ownerIsNPC && proj.ammoType === 'bala_cura') {
      if (proj.piercing) proj.hitTargets.add(target.id);
      else { proj.dead = true; this.projectiles.delete(proj.id); }

      const shooter2 = this.players.get(proj.ownerId);
      const isAlly   = shooter2 && this.partyManager && this.partyManager.areAllies(shooter2.id, target.id);
      if (isAlly) {
        const ammo        = AMMO_DEFS['bala_cura'] || {};
        const HEAL_AMOUNT = ammo.healAmount || 5;
        target.hp = Math.min(target.maxHp, target.hp + HEAL_AMOUNT);
        this._broadcastToMap(target.mapLevel || 1, {
          type: 'heal', targetId: target.id,
          amount: HEAL_AMOUNT, x: target.x, z: target.z,
          hp: target.hp, maxHp: target.maxHp,
        });
      }
      return; // sem dano independente de ser aliado ou não
    }

    if (proj.piercing) {
      proj.hitTargets.add(target.id);
    } else {
      proj.dead = true;
      this.projectiles.delete(proj.id);
    }

    const ammo       = AMMO_DEFS[proj.ammoType] || AMMO_DEFS.bala_ferro;
    const critMult   = proj.isCrit ? 1.5 : 1.0;
    const damageMult = proj.damageMultiplier || 1.0;
    const shooter2   = !proj.ownerIsNPC ? this.players.get(proj.ownerId) : null;
    const skillDmg   = shooter2?.skillDamageMult || 1.0;
    const targetIsPlayer = !this.npcs.has(target.id);
    const skillDef   = (targetIsPlayer && target.skillDefense) ? (1 - target.skillDefense) : 1.0;
    // Talent bonuses: attacker damage (+2% per dano level) and target defense (-3% DR per defesa level now configured via constants)
    const talentDmg  = shooter2 ? (1 + (shooter2.talentDamageBonus || 0)) : 1.0;
    const talentDef  = (targetIsPlayer && target.talentDefenseBonus) ? (1 - target.talentDefenseBonus) : 1.0;
    // Island upgrades: defense (-5% per level) and damage (+10% per level)
    const islandDef  = (targetIsPlayer && target.shipIslandUpgrades?.defense)
      ? (1 - Math.min(target.shipIslandUpgrades.defense * 0.05, 0.80))
      : 1.0;
    const islandDmg  = (shooter2?.shipIslandUpgrades?.damage)
      ? (1 + shooter2.shipIslandUpgrades.damage * 0.10)
      : 1.0;
    // Cannon damage adds to ammo base (cannon.damage was defined but unused before)
    const baseDmg    = ammo.damage + (proj.cannonDmg || 0);
    const dmg        = calcProjectileDamage({ baseDmg, critMult, damageMult, skillDmg, skillDef, talentDmg, talentDef, islandDef, islandDmg });

    const now = Date.now();

    // ── Relic: invincibility (r2) ────────────────────────────────────────────
    if (!isNPC && target.relicInvincibleExpires && now < target.relicInvincibleExpires) return;

    // ── Relic: gold shield (r5) — 30% DR, 10% of blocked gold cost ──────────
    let finalDmg = dmg;
    if (!isNPC && target.relicGoldShieldActive) {
      const blocked = Math.round(dmg * 0.30);
      finalDmg = dmg - blocked;
      const goldCost = Math.round(blocked * 0.10);
      if (goldCost > 0) {
        target.gold = Math.max(0, (target.gold || 0) - goldCost);
        sendTo(target.ws, { type: 'gold_shield_cost', goldCost, gold: target.gold });
      }
    }

    target.hp = Math.max(0, target.hp - finalDmg);

    // Apply state changes immediately (server-authoritative)
    if (ammo.slow > 0) {
      target.slowMult    = 1 - ammo.slow;
      target.slowExpires = now + ammo.slowDur;
    }
    if (ammo.dotDmg > 0) {
      const effect = proj.ammoType === 'bala_sangue' ? 'bleed' : 'fire';
      if (!target.dots) target.dots = [];
      target.dots.push({
        dmg: ammo.dotDmg, tick: ammo.dotTick, dur: ammo.dotDur,
        next: now + ammo.dotTick, ownerId: proj.ownerId, effect,
      });
    }
    // Stun is rolled ONCE per salvo (not per projectile) in _flushHitBatch
    if (!isNPC) {
      target.lastCombatTime = now;
      target.lastActionTime = now;
    } else {
      target._lastDamageTime = now;
      if (shooter2) { shooter2.lastActionTime = now; shooter2.lastCombatTime = now; }
    }

    // Accumulate into batch — merge hits on same target within this tick
    let batch = this._hitBatch.get(target.id);
    if (!batch) {
      batch = {
        target, isNPC,
        ownerIsNPC: !!proj.ownerIsNPC,
        totalDmg: 0, hasCrit: false,
        effects: new Set(), // 'slow','fire','bleed','stun'
        killerProj: null,  // proj that caused death (for kill logic)
        ammo,              // last ammo (for effect durations)
        stunChance: 0,     // max stun chance across this salvo
        stunDur:    0,     // stun duration (ms) from ammo def
      };
      this._hitBatch.set(target.id, batch);
    }
    batch.totalDmg += dmg;
    if (proj.isCrit) batch.hasCrit = true;
    if (ammo.slow > 0)   batch.effects.add('slow');
    if (ammo.dotDmg > 0) batch.effects.add(proj.ammoType === 'bala_sangue' ? 'bleed' : 'fire');
    // Accumulate stun — single roll per salvo in _flushHitBatch (not per projectile)
    if (ammo.stunChance > 0) {
      batch.stunChance = Math.max(batch.stunChance, ammo.stunChance);
      batch.stunDur    = ammo.stunDur || 3000;
    }
    if (target.hp <= 0 && !batch.killerProj) batch.killerProj = proj;

    // Track last damage time for NPC/boss regen cooldown
    target.lastDamageTime = now;

    // ── Track per-player damage on bosses com limite de tamanho ──
    if (isNPC && target.isBoss && !proj.ownerIsNPC && shooter2) {
      if (!target._damageMap) target._damageMap = new Map();

      // Limitar tamanho do damageMap (máximo 100 jogadores por boss)
      if (target._damageMap.size < 100 || target._damageMap.has(shooter2.id)) {
        target._damageMap.set(shooter2.id, (target._damageMap.get(shooter2.id) || 0) + finalDmg);
      }
      // Callback para missão worldBossDamage (boss mundial)
      if (target.isWorldBoss && this._onWorldBossDamage) this._onWorldBossDamage(shooter2, finalDmg);
    }

    if (!isNPC) {
      target.lastCombatTime = now;
      target.lastActionTime = now;
      // Callback para missão damageBlocked (dano absorvido pelo jogador)
      if (this._onPlayerDamaged) this._onPlayerDamaged(target, finalDmg);
    }

    // Lifesteal — accumulate per tick, flush via _lifesteals map to avoid 30 msgs/salvo
    if (proj.lifesteal > 0 && !proj.ownerIsNPC) {
      const shooter = this.players.get(proj.ownerId);
      if (shooter && !shooter.dead) {
        // use finalDmg (after mitigation) so overheal matches actual damage dealt
        const heal = Math.round(finalDmg * proj.lifesteal);
        shooter.hp = Math.min(shooter.maxHp, shooter.hp + heal);
        // Accumulate — flush batched heal in update() every 150ms
        if (!this._lifesteals) this._lifesteals = new Map();
        const cur = this._lifesteals.get(proj.ownerId) || { total: 0, shooter };
        cur.total += heal;
        cur.shooter = shooter;
        this._lifesteals.set(proj.ownerId, cur);
      }
    }

    // Skill XP accumulated here (per hit, not per tick — small amounts, OK)
    if (!proj.ownerIsNPC && this.grantSkillXp) {
      const shooter = this.players.get(proj.ownerId);
      if (shooter) this.grantSkillXp(shooter, 'ataque', Math.max(1, Math.floor(dmg / 5)), this.wss);
    }
    if (!isNPC && this.grantSkillXp) {
      this.grantSkillXp(target, 'defesa', Math.max(1, Math.floor(dmg / 5)), this.wss);
    }

    // Death handled in _flushHitBatch() at end of tick
    if (target.hp <= 0) {
      target.dead = true; // mark dead now so other projectiles skip it
    }
  } // end hit()

  /**
   * Grants all kill rewards for one regular (non-boss) NPC death.
   * Handles: gold, XP, dobrões, map fragments, relic drop, boss spawn counter.
   * Does NOT broadcast entity_dead, call respawnScaled, or save to DB — callers do that.
   * @param {Object|null} killer  player who killed (may be null for environment kills)
   * @param {Object}      npc     the dead NPC object
   * @returns {{ finalGold, xpGained, goldDrop }}
   */
  grantNpcKillRewards(killer, npc) {
    const mapLvl    = npc.mapLevel || 1;
    const npcMapDef = (this.mapDefs || {})[mapLvl] || {};
    const npcDef    = npcMapDef.npc || {};
    const goldMin   = npcDef.goldMin ?? GOLD_DROP_MIN;
    const goldMax   = npcDef.goldMax ?? GOLD_DROP_MAX;
    const baseGold  = Math.floor(Math.random() * (goldMax - goldMin + 1) + goldMin);

    let finalGold = 0, xpGained = 0;

    if (killer) {
      killer.npcKills = (killer.npcKills || 0) + 1;
      const killTier  = Math.floor(killer.npcKills / 10);
      finalGold = calcKillGold({
        baseGold,
        dropBonus:      killer.dropBonus     || 0,
        killTier,
        goldPerTier:    npcDef.goldPerTier   ?? 0.01,
        talentGoldBonus: killer.talentGoldBonus || 0,
      });
      const xpPerKill = npcMapDef.npc?.xpPerKill || 12;
      xpGained = calcKillXp({ xpPerKill, killTier, talentXpBonus: killer.talentXpBonus || 0 });

      // Dobrao drop (só para o killer — não é dividido)
      if ((npcDef.dobraoChance || 0) > 0 && Math.random() < (npcDef.dobraoChance + (killer.talentDobraoBonus || 0))) {
        const dobraoAmt = Math.floor(Math.random() * (npcDef.dobraoMax - npcDef.dobraoMin + 1) + npcDef.dobraoMin);
        killer.dobroes = (killer.dobroes || 0) + dobraoAmt;
      }

      // ── Divisão de recompensas de grupo ──────────────────────────────────
      const partyMembers = this.partyManager
        ? this.partyManager.getPartyMembersInZone(killer.id, mapLvl, this.players)
        : [];
      const totalMembers = partyMembers.length + 1;
      const memberGold   = Math.floor(finalGold / totalMembers);
      const memberXp     = Math.floor(xpGained  / totalMembers);
      const memberFrags  = Math.floor(FRAGMENT_DROP_NPC / totalMembers);

      killer.gold  += memberGold;
      killer.mapXp  = (killer.mapXp || 0) + memberXp;

      for (const m of partyMembers) {
        m.gold       = (m.gold       || 0) + memberGold;
        m.mapXp      = (m.mapXp      || 0) + memberXp;
        m.mapFragments = (m.mapFragments || 0) + memberFrags;
        if (m.ws?.readyState === 1) {
          sendTo(m.ws, { type: 'currency_update', gold: m.gold, dobroes: m.dobroes });
        }
      }

      finalGold = memberGold;
      xpGained  = memberXp;

      // Map unlock notification (xpToAdvance is per-map in MAP_DEFS)
      const xpNeeded = this.mapDefs.xpToAdvance || 99999;
      if (xpNeeded && killer.mapXp >= xpNeeded && (this.mapDefs || {})[killer.mapLevel + 1]) {
        if (!killer._mapUnlockNotified) {
          killer._mapUnlockNotified = true;
          sendTo(killer.ws, { type: 'map_level_up', level: killer.mapLevel + 1, xpNeeded });
        }
      } else {
        killer._mapUnlockNotified = false;
      }

      // Fragment drop (killer recebe sua parte; membros já receberam acima)
      killer.mapFragments = (killer.mapFragments || 0) + memberFrags;

      // Relic drop
      if (Math.random() < (npc.relicDropChance || 0)) {
        if (!killer.inventory.relics) killer.inventory.relics = [];
        const ownedIds = new Set(killer.inventory.relics.map(r => r.relicId));
        const dropped  = _rollRelicDrop(ownedIds);
        if (dropped) {
          killer.inventory.relics.push(dropped);
          const relicDef   = RELIC_DEFS[dropped.relicId];
          const rarityMeta = RELIC_RARITIES[dropped.rarity];
          sendTo(killer.ws, {
            type:        'relic_drop',
            relic:       dropped,
            name:        relicDef?.name || dropped.relicId,
            icon:        relicDef?.icon || '🏺',
            rarity:      dropped.rarity,
            rarityLabel: rarityMeta?.label || dropped.rarity,
            rarityColor: rarityMeta?.color || '#aaa',
          });
        }
      }
    }

    // Callback para missões diárias (definido externamente em server.js)
    if (killer && this._onNpcKill) this._onNpcKill(killer, finalGold, npc);

    return { finalGold, xpGained, goldDrop: finalGold };
  }

  // Called once per tick after all collision checks — 1 message per target instead of 1 per projectile
  _flushHitBatch(now) {
    if (this._hitBatch.size === 0) return;

    // Limitar tamanho do batch para prevenir memory leak
    if (this._hitBatch.size > this._maxBatchSize) {
      console.error(`⚠️ HitBatch overflow: ${this._hitBatch.size}, limpando...`);
      this._hitBatch.clear();
      return;
    }

    // Accumulate gold/xp per killer across all kills this tick
    const killerRewards = new Map(); // killerId → { killer, gold, xp }
    const processedTargets = new Set();

    this._hitBatch.forEach((batch, targetId) => {
      // Evitar processar o mesmo target múltiplas vezes
      if (processedTargets.has(targetId)) return;
      processedTargets.add(targetId);
      
      const { target, isNPC, totalDmg, hasCrit, effects, killerProj, ammo } = batch;

      // ── ONE stun roll per salvo — stun só aplica em jogadores, não em NPCs ──
      if (!isNPC && batch.stunChance > 0 && Math.random() < batch.stunChance) {
        target.stunExpires = now + batch.stunDur;
        effects.add('stun');
      }

      // ONE hit update per target — filtrado por mapa
      const _hitMapLvl = target.mapLevel || 1;

      // Roubo de ouro: projétil NPC contra jogador em mapa com goldStealRatio
      let goldStolen = 0;
      if (!isNPC && batch.ownerIsNPC) {
        const goldStealRatio = (MAP_DEFS[_hitMapLvl] || {}).goldStealRatio || 0;
        if (goldStealRatio > 0 && totalDmg > 0) {
          goldStolen = Math.max(1, Math.floor(totalDmg * goldStealRatio));
          target.gold = Math.max(0, (target.gold || 0) - goldStolen);
        }
      }

      this._broadcastToMap(_hitMapLvl, {
        type: 'hit', targetId, targetIsNPC: isNPC,
        hp: target.hp, maxHp: target.maxHp,
        dmg: totalDmg, x: target.x, z: target.z,
        goldStolen,
      });

      // ONE status_effect per effect type per target
      if (effects.size > 0) {
        effects.forEach(effect => {
          const dur = effect === 'slow'  ? (ammo.slowDur || 2000)
                    : effect === 'stun'  ? (ammo.stunDur || 3000)
                    :                      (ammo.dotDur  || 3000);
          this._broadcastToMap(_hitMapLvl, { type: 'status_effect', effect, targetId, targetIsNPC: isNPC, x: target.x, z: target.z, dur });
        });
      }

      if (hasCrit) this._broadcastToMap(_hitMapLvl, { type: 'crit_hit', x: target.x, z: target.z });

      // Kill logic com cleanup
      if (target.dead && killerProj) {
        const proj = killerProj;
        const killer = !proj.ownerIsNPC ? this.players.get(proj.ownerId) : null;

        if (isNPC) {
          if (target.isDungeonBoss) {
            // Dungeon Boss: chama handleDungeonComplete no servidor
            this._broadcastToMap(target.mapLevel || 1, { type: 'entity_dead', id: targetId, isNPC: true, killerId: proj.ownerId, goldDrop: 0 });
            this.npcs.delete(targetId);
            if (this.onDungeonBossKilled) this.onDungeonBossKilled(killer, target);
          } else if (target.isBoss) {
            // Marcar hora da morte para cleanup futuro
            target.deathTime = now;

            const _bossMapLvl = target.mapLevel || 1;
            if (target.isWorldBoss) {
              // World Boss: broadcast global + notificar worldBossManager
              broadcast(this.wss, { type: 'entity_dead', id: targetId, isNPC: true, isBoss: true, isWorldBoss: true, killerId: proj.ownerId });
              if (this.worldBossManager) this.worldBossManager.onWorldBossDead(target, proj.ownerId);
            } else {
              // Zone Boss: broadcast filtrado por mapa + notificar zone + world boss managers
              this._broadcastToMap(_bossMapLvl, { type: 'entity_dead', id: targetId, isNPC: true, isBoss: true, killerId: proj.ownerId });
              const bossMgr = this.bossManagers.get(_bossMapLvl)
                           || ((_bossMapLvl === 6 ? this.bossManager6 : _bossMapLvl === 3 ? this.bossManager3 : _bossMapLvl === 2 ? this.bossManager2 : this.bossManager));
              if (bossMgr) bossMgr.onBossDead(target, proj.ownerId);
              if (this.worldBossManager) this.worldBossManager.onZoneBossDead(target, proj.ownerId);
            }

            // Remover NPC do Map
            this.npcs.delete(targetId);
          } else {
            // Regular NPC kill
            const rewards = this.grantNpcKillRewards(killer, target);

            this._broadcastToMap(target.mapLevel || 1, {
              type: 'entity_dead',
              id: targetId,
              isNPC: true,
              mapLevel: target.mapLevel || 1,
              goldDrop: rewards.goldDrop,
              killerId: proj.ownerId,
            });

            const mgr = this.npcManagers.find(m => m.zoneLevel === (target.mapLevel || 1));
            if (mgr) {
              mgr.respawnScaled(targetId, killer ? killer.npcKills : 0, target.mapLevel || 1);
            }

            // Remover NPC do Map
            this.npcs.delete(targetId);

            if (killer) {
              const kr = killerRewards.get(killer.id) || { killer, gold: 0, xp: 0, fragments: 0 };
              kr.gold += rewards.finalGold;
              kr.xp += rewards.xpGained;
              kr.fragments += FRAGMENT_DROP_NPC;
              killerRewards.set(killer.id, kr);
            }
            // ===== Boss spawn accounting — dinâmico por mapa =====
            try {
              const mapLvl = target.mapLevel || 1;
              const kts    = this.mapDefs[mapLvl]?.boss?.killsToSpawn ?? 0;
              if (kts > 0) {
                // killCounters é o registro dinâmico; também atualiza aliases legados
                const prev = this.killCounters.get(mapLvl) || 0;
                const kills = prev + 1;
                this.killCounters.set(mapLvl, kills);
                // Aliases legados (para compatibilidade com getMapKills em server.js)
                if (mapLvl === 1) this.totalNpcKills  = kills;
                else if (mapLvl === 2) this.totalNpcKills2 = kills;
                else if (mapLvl === 3) this.totalNpcKills3 = kills;

                // Resolve boss manager: registro dinâmico primeiro, depois aliases legados
                const bm = this.bossManagers.get(mapLvl)
                        || (mapLvl === 6 ? this.bossManager6
                          : mapLvl === 3 ? this.bossManager3
                          : mapLvl === 2 ? this.bossManager2
                          : this.bossManager);

                console.log(`[boss-debug] (proj) map=${mapLvl} kill=${kills} kts=${kts} bossAlive=${!!bm?.bossAlive}`);

                if (bm && (kills % kts) === 0 && !bm.bossAlive) {
                  const rarity = bm.rollPendingRarity();
                  console.log(`[boss-debug] (proj) boss_incoming map=${mapLvl} totalKills=${kills} kts=${kts} rarity=${rarity}`);
                  broadcast(this.wss, { type: 'boss_incoming', mapLevel: mapLvl, rarity });
                  const dotKills = killer ? killer.npcKills : 0;
                  const timerKey = `boss_${mapLvl}`;
                  const old = this._respawnTimers.get(timerKey);
                  if (old) clearTimeout(old);
                  const timerId = setTimeout(() => {
                    this._respawnTimers.delete(timerKey);
                    bm.spawn(dotKills);
                  }, 2000);
                  console.log(`[boss-debug] (proj) scheduled spawn timer=${timerId} for map=${mapLvl}`);
                  this._respawnTimers.set(timerKey, timerId);
                }

                // Broadcast kill progress
                broadcast(this.wss, { type: 'boss_progress', current: kills % kts, needed: kts, mapLevel: mapLvl, bossAlive: !!bm?.bossAlive });
              }
            } catch (err) {
              console.error('[boss-debug] spawn error:', err && err.message ? err.message : err);
            }
          }
        } else {
          // Player killed by projectile — broadcast entity_dead para mostrar tela de morte
          broadcast(this.wss, {
            type:     'entity_dead',
            id:       targetId,
            isNPC:    false,
            killerId: proj.ownerId,
          });

          // ── Sistema Procurado + missão pvpKills ──────────────────────────
          const pvpKiller = this.players.get(proj.ownerId);
          if (pvpKiller) {
            pvpKiller.pvpKills = (pvpKiller.pvpKills || 0) + 1;
            // ── 5% XP and npcKills transfer on PvP kill ──────────────────
            const xpTransfer    = Math.floor((target.mapXp    || 0) * 0.05);
            const killsTransfer = Math.floor((target.npcKills || 0) * 0.05);
            if (xpTransfer > 0) {
              pvpKiller.mapXp  = (pvpKiller.mapXp  || 0) + xpTransfer;
              target.mapXp     = Math.max(0, (target.mapXp || 0) - xpTransfer);
            }
            if (killsTransfer > 0) {
              pvpKiller.npcKills  = (pvpKiller.npcKills  || 0) + killsTransfer;
              target.npcKills     = Math.max(0, (target.npcKills || 0) - killsTransfer);
            }
            if (xpTransfer > 0 || killsTransfer > 0) {
              if (this._onPvpLoot) this._onPvpLoot(pvpKiller, target, xpTransfer, killsTransfer);
            }
            // Callback para missão pvpKills (definido em server.js) — passa o jogador morto
            if (this._onPvpKill) this._onPvpKill(pvpKiller, target);
            // Verificar se o killer tem o jogador morto como alvo Procurado
            if (pvpKiller.wantedTarget && pvpKiller.wantedTarget.targetId === targetId) {
              const wReward = pvpKiller.wantedTarget;
              pvpKiller.gold    = (pvpKiller.gold    || 0) + wReward.rewardGold;
              pvpKiller.dobroes = (pvpKiller.dobroes || 0) + wReward.rewardDobrao;
              pvpKiller.wantedTarget = null;
              sendTo(pvpKiller.ws, {
                type:         'wanted_killed',
                killedName:   wReward.targetName,
                rewardGold:   wReward.rewardGold,
                rewardDobrao: wReward.rewardDobrao,
                gold:         pvpKiller.gold,
                dobroes:      pvpKiller.dobroes,
              });
            }
          }
        }
      }

      // Cleanup de dados de NPC morto sem killerProj (ex: morto por aura/DOT antes do tick)
      if (isNPC && target.dead && !killerProj) {
        this._cleanupNPCData(target);
        this.npcs.delete(targetId);
      }
    });

    // Enviar currency updates
    killerRewards.forEach(({ killer, gold, xp, fragments }) => {
      if (killer && this.players.has(killer.id)) {
        db.save(killer).catch(e => console.error('[DB] Save error:', e.message));
        
        const curMapDef = (this.mapDefs || {})[killer.mapLevel || 1] || { xpToAdvance: 1800 };
        sendTo(this._getPlayerWebSocket(killer), {
          type: 'currency_update',
          gold: killer.gold,
          dobroes: killer.dobroes,
          reward: { type: 'gold', amount: gold },
          npcKills: killer.npcKills,
          mapXp: killer.mapXp,
          mapLevel: killer.mapLevel || 1,
          mapXpNeeded: curMapDef.xpToAdvance || 99999,
          mapFragments: killer.mapFragments || 0,
        });
      }
    });

    this._hitBatch.clear();
  } // end _flushHitBatch

  // Helper para obter WebSocket do jogador
  _getPlayerWebSocket(player) {
    // Implementar conforme sua estrutura - pode vir do PlayerManager
    return player.ws;
  }

  // Limpar dados de um NPC morto
  _cleanupNPCData(npc) {
    if (npc.dots) {
      npc.dots.length = 0;
      npc.dots = null;
    }
    if (npc._damageMap) {
      npc._damageMap.clear();
      npc._damageMap = null;
    }
    npc._cachedNearest = null;
  }

  update(dt) {
    const now = Date.now();

    // Limitar número de projéteis processados por tick
    const MAX_PROJECTILES_PER_TICK = 5000;
    let processed = 0;

    // Usar entries() para poder deletar durante iteração
    for (const [id, p] of this.projectiles.entries()) {
      if (processed++ > MAX_PROJECTILES_PER_TICK) {
        console.warn(`⚠️ Muitos projéteis: ${this.projectiles.size}, limitando processamento`);
        break;
      }
      
      if (p.dead) {
        this.projectiles.delete(id);
        continue;
      }

      if (now - p.born > PROJECTILE_LIFETIME) {
        p.dead = true;
        this.projectiles.delete(id);
        continue;
      }

      // 1. Move — save previous position for swept collision
      const prevX = p.x, prevZ = p.z;
      p.x += p.vx * dt * 30;
      p.z += p.vz * dt * 30;

      // 2. Homing steering (after move)
      if (p.homingTargetId) {
        const target = p.homingTargetIsNPC
          ? this.npcs.get(p.homingTargetId)
          : this.players.get(p.homingTargetId);

        if (target && !target.dead) {
          const speed = Math.hypot(p.vx, p.vz);
          const hdx   = target.x - p.x;
          const hdz   = target.z - p.z;
          const dist  = Math.hypot(hdx, hdz);

          if (dist > 1) {
            const nx = hdx / dist;
            const nz = hdz / dist;
            p.vx += nx * speed * (p.homingStrength || 0.1) * dt * 10;
            p.vz += nz * speed * (p.homingStrength || 0.1) * dt * 10;
            const ns = Math.hypot(p.vx, p.vz);
            p.vx = (p.vx / ns) * speed;
            p.vz = (p.vz / ns) * speed;
          }
        } else {
          p.homingTargetId = null;
        }
      }

      // 3. Swept collision — check line from prevX/prevZ to current pos
      //    Prevents tunneling when projectile moves 28u/tick vs HIT_RADIUS 8u
      const checkHit = (target, isNPC) => {
        if (p.dead || target.dead || target.id === p.ownerId) return;
        if (isNPC && p.ownerIsNPC) return;
        if (p.hitTargets?.has(target.id)) return;
        // Zone isolation — projectiles can't cross map boundaries
        if ((target.mapLevel || 1) !== p.ownerMapLevel) return;
        // Point-to-segment distance (swept check)
        const ex = p.x - prevX, ez = p.z - prevZ;       // segment vector
        const fx = prevX - target.x, fz = prevZ - target.z;
        const a = ex*ex + ez*ez;
        const hr = target.hitRadius || HIT_RADIUS;
        if (a < 0.0001) { // zero-length segment fallback
          if (dist2D(p, target) < hr) this.hit(p, target, isNPC);
          return;
        }
        const b = 2*(fx*ex + fz*ez);
        const c = fx*fx + fz*fz - hr*hr;
        let disc = b*b - 4*a*c;
        if (disc < 0) return; // no intersection
        disc = Math.sqrt(disc);
        const t1 = (-b - disc) / (2*a);
        const t2 = (-b + disc) / (2*a);
        if (t1 <= 1 && t2 >= 0) this.hit(p, target, isNPC);
      };

      this.npcs.forEach(target => checkHit(target, true));
      this.players.forEach(target => checkHit(target, false));

      if (p.dead) continue; // killed by collision above

      // 4. Range limit — AFTER collision so last-frame hits register
      if (p.maxDist) {
        const traveled = Math.hypot(p.x - p.spawnX, p.z - p.spawnZ);
        if (traveled >= p.maxDist) {
          p.dead = true;
          this.projectiles.delete(id);
          continue;
        }
      }

      // 5. Overshoot check (non-piercing only)
      if (!p.piercing) {
        const toTargetX = p.targetX - p.x;
        const toTargetZ = p.targetZ - p.z;
        const dot = toTargetX * p.vx + toTargetZ * p.vz;
        if (dot <= 0) {
          p.dead = true;
          this.projectiles.delete(id);
        }
      }
    }

    // Flush hits
    this._flushHitBatch(now);

    // Limpar lifesteals de jogadores desconectados
    if (this._lifesteals && this._lifesteals.size > 0) {
      for (const [ownerId] of this._lifesteals) {
        if (!this.players.has(ownerId)) {
          this._lifesteals.delete(ownerId);
        }
      }
      
      // Enviar heals acumulados
      this._lifesteals.forEach(({ total, shooter }, ownerId) => {
        if (shooter && this.players.has(ownerId)) {
          sendTo(this._getPlayerWebSocket(shooter), {
            type: 'heal',
            amount: total,
            hp: shooter.hp,
            source: 'lifesteal',
            x: shooter.x,
            z: shooter.z
          });
        }
      });
      this._lifesteals.clear();
    }

    // Para debug - mostre a cada 60 segundos
    if (SHOW_LOG &&!this._lastStatsTime || now - this._lastStatsTime > 60000) {
      this._lastStatsTime = now;
      console.log(`📊 [ProjectileManager Stats]
        Projéteis ativos: ${this.projectiles.size}
        HitBatch size: ${this._hitBatch.size}
        Lifesteals pending: ${this._lifesteals.size}
        Respawn timers: ${this._respawnTimers.size}
        NPCs ativos: ${this.npcs?.size || 0}
        Players ativos: ${this.players?.size || 0}
      `);
    }
  }

  snapshot() {
    // Limitar snapshot a 1000 projéteis para evitar sobrecarga
    const MAX_SNAPSHOT = 1000;
    const projArray = Array.from(this.projectiles.values())
      .filter(p => !p.dead);
    
    if (projArray.length > MAX_SNAPSHOT) {
      console.warn(`⚠️ Muitos projéteis no snapshot: ${projArray.length}, limitando`);
      return projArray.slice(0, MAX_SNAPSHOT).map(p => ({
        id: p.id, x: p.x, z: p.z
      }));
    }
    
    return projArray.map(p => ({ id: p.id, x: p.x, z: p.z }));
  }

  // Método de cleanup para quando a zona é destruída
  destroy() {
    console.log('🛑 Destruindo ProjectileManager...');
    
    // Limpar intervalo de cleanup
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    
    // Cancelar todos os timers de respawn
    for (const timer of this._respawnTimers.values()) {
      clearTimeout(timer);
    }
    this._respawnTimers.clear();
    
    // Limpar todos os projéteis
    this.projectiles.clear();
    
    // Limpar batches
    this._hitBatch.clear();
    this._lifesteals.clear();
    
    // Limpar referências
    this.players = null;
    this.npcs = null;
    this.npcManagers = null;
    this.bossManager = null;
    this.bossManager2 = null;
    this.wss = null;
    
    console.log('✅ ProjectileManager destruído');
  }
  // Envia mensagem apenas para jogadores no mesmo mapa que o alvo
  _broadcastToMap(mapLevel, data) {
    const msg = JSON.stringify(data);
    this.players.forEach(p => {
      if ((p.mapLevel || 1) === mapLevel && p.ws?.readyState === 1) p.ws.send(msg);
    });
  }
} // end class ProjectileManager

module.exports = ProjectileManager;