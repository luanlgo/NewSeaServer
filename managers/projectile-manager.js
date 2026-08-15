// managers/projectile-manager.js
const { projUid, dist2D, broadcast, sendTo } = require('../utils/helpers');
const { calcProjectileDamage, calcKillGold, calcKillXp } = require('../utils/combat-calc');
const fx = require('../utils/talent-effects');
const status = require('../utils/talent-status');
const db = require('./db-manager');
const {
  PROJECTILE_SPEED, PROJECTILE_LIFETIME, HIT_RADIUS,
  AMMO_DEFS, PIRATE_DEFS, GOLD_DROP_MIN, GOLD_DROP_MAX,
  FRAGMENT_DROP_NPC, RELIC_DEFS, RELIC_RARITIES,
  SHOW_LOG, CANNON_DEFS, MAP_DEFS, difficultyRewardMult,
} = require('../constants');

const { SKILLS_BY_SOURCE, MONSTER_SKILLS } = require('../constants/monster_skills');
const { starDropAllowed } = require('../utils/star-gate');

// Pool de relíquias de um bicho = os ataques que ele REALMENTE usa.
//
// Antes vinha do nome do MODELO, e isso desalinhou o Verme: ele luta com o
// conjunto do mob mas o modelo é `wrim_boss.glb`, então largava as relíquias de
// BOSS — e as do mob ficaram indroppáveis, porque nenhum NPC usa `wrim.glb`.
// Ou seja, exatamente ao contrário. Derivar dos ATAQUES mantém a promessa da
// tabela ("o ataque que te matou é a relíquia que cai") e ainda serve o caso
// novo: um bicho com os dois conjuntos solta os dois.
//
// O modelo fica de reserva para NPC sem lista de ataques.
function _bestiaryPool(npc) {
  const ids = [];
  for (const a of (npc && npc.attacks) || []) {
    const skill = MONSTER_SKILLS[a];
    if (skill && skill.relicId) ids.push(skill.relicId);
  }
  if (ids.length) return ids;

  const m = npc && npc.npcModel;
  if (typeof m !== 'string') return null;
  const stem = m.split('/').pop().replace(/\.glb$/i, '');
  return SKILLS_BY_SOURCE[stem] || null;
}

// ownedIds: Set de relicIds que o jogador já possui (para evitar duplicatas)
// npc:      se for um dos 9 bichos do bestiário, ele só solta os PRÓPRIOS ataques
//           (o ataque que te matou é a relíquia que cai). Só cai no sorteio
//           global quando o bicho não tem conjunto próprio ou você já tem os 4.
function _rollRelicDrop(ownedIds = new Set(), npc = null) {
  // ⭐ só cai na Lua de Sangue. Fora dela o conjunto do bicho vale como se ela
  // não existisse — o jogador leva as outras, e a ⭐ fica como o troféu de uma
  // noite específica. Quem já ganhou usa quando quiser (sem gate de uso).
  const takeable = (id) => !ownedIds.has(id) && starDropAllowed(id);

  const doBicho = _bestiaryPool(npc);
  const pool = doBicho ? doBicho.filter(takeable) : [];
  if (pool.length > 0) {
    // Dentro do conjunto do bicho o sorteio é uniforme: as 4 skills dele são
    // igualmente "dele", e a raridade já está embutida na chance de drop do NPC.
    const relicId = pool[Math.floor(Math.random() * pool.length)];
    const instanceId = `rl_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
    return { instanceId, relicId, rarity: RELIC_DEFS[relicId].rarity };
  }

  // Filtra apenas relíquias que o jogador ainda não tem (e respeita o gate ⭐:
  // sem isto o sorteio global devolveria de dia a mesma ⭐ barrada acima)
  const available = Object.entries(RELIC_DEFS).filter(([id]) => takeable(id));
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

    // ── Crítico do canhão (Pontaria Mortal do c6) ────────────────────────────
    // Sorteado POR TIRO, não por salva: com o c6 sendo `doubleShot`, sortear uma
    // vez só faria a salva inteira crescer ou não junto, e a leitura vira
    // "rodada boa/rodada ruim" em vez de "aquele tiro entrou bonito".
    //
    // Fica FORA do bloco de homing de propósito: `isCrit` só existia lá dentro,
    // e como nenhum pirata do jogo tem `homingRadius`, crítico nenhum acontecia.
    // Olho de Águia soma à chance do canhão e a Cascata empurra o tiro seguinte
    // a um crítico; Sangue Frio engorda o multiplicador com a vida alta.
    if (!shooter.isNPC) {
      const baseChance = shooter.cannonCritChance || 0;
      const chance     = fx.critChance(shooter, baseChance);
      if (chance > 0) {
        const hpFrac = shooter.maxHp ? shooter.hp / shooter.maxHp : 1;
        proj.isCrit = Math.random() < chance;
        if (proj.isCrit) {
          proj.critMult = fx.critMult(shooter, shooter.cannonCritMult || 1.5, hpFrac);
          // Critico e Sangue Frio so viram icone no tiro que saiu critico.
          status.noteHit(shooter, 'crit_chance');
          status.noteHit(shooter, 'crit_damage_pct');
          if (hpFrac > 0.80) status.noteHit(shooter, 'crit_damage_high_hp');
        }
        fx.noteCritRoll(shooter, proj.isCrit);
      }
    }

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

  /**
   * @param {boolean} [isFree] salva de graça do Tiro Duplo: não gasta munição
   *                           nem pólvora e não re-arma a recarga do canhão.
   */
  spawnSalvo(shooter, targetX, targetZ, isFree = false) {
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
    if (!isFree && shooter.currentAmmo !== 'bala_ferro') {
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
    if (!isFree && !shooter.isNPC && (shooter.gunpowder || 0) > 0) {
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
      // Salva Cerrada só paga quando o navio despeja a bordada inteira — com um
      // canhão só não há "salva".
      proj.isFullSalvo = totalShots > 1;
      // Bala de Corrente: o projétil atravessa e ainda pega um segundo alvo.
      if (!proj.piercing && Math.random() < fx.pierceChance(shooter)) {
        proj.piercing   = true;
        proj.hitTargets = new Set();
        status.noteHit(shooter, 'pierce_chance');
      }
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

    // A salva de graça não re-arma a recarga: se armasse, o Tiro Duplo puniria
    // quem o comprou, zerando o progresso do cooldown a cada sorteio.
    if (!isFree) {
      // Pólvora Seca encurta a recarga. O cooldownMax fica intacto: é ele que o
      // resto do servidor usa como "recarga do navio", e mexer nele faria o
      // desconto acumular a cada tiro.
      shooter.cannonCooldown = Math.max(1, Math.round(shooter.cannonCooldownMax * fx.reloadMult(shooter)));

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

      // ── Tiro Duplo: uma segunda bordada, sem munição e sem recarga ────────
      if (Math.random() < fx.doubleShotChance(shooter)) {
        status.noteHit(shooter, 'double_shot_chance');
        this.spawnSalvo(shooter, targetX, targetZ, true);
      }
    }
  }

  /**
   * Talentos que disparam DEPOIS de o dano entrar. Ficam fora de hit() só para
   * não engordar mais uma função que já é a mais longa do arquivo.
   *
   * - Sanguessuga cura o atirador com uma fração do dano causado.
   * - Casco de Espinhos devolve parte do golpe a quem bateu.
   * - Absorção transforma dano recebido em mana.
   * - Sentinela soma uma pilha de redução por golpe recebido.
   * - Segundo Fôlego e Teimosia são os dois salva-vidas: rodam por último, já
   *   com o hp atualizado, e Teimosia é a ÚNICA que pode ressuscitar de 0.
   */
  _applyTalentOnHit(shooter, target, targetIsPlayer, dmg, proj, now) {
    // Sanguessuga — vale contra qualquer alvo, inclusive NPC.
    if (shooter && !shooter.dead) {
      const heal = fx.lifestealAmount(shooter, dmg);
      if (heal > 0 && shooter.hp < shooter.maxHp) {
        status.noteHit(shooter, 'lifesteal_pct', now);
        shooter.hp = Math.min(shooter.maxHp, shooter.hp + heal);
        this._broadcastToMap(shooter.mapLevel || 1, {
          type: 'heal', targetId: shooter.id, amount: heal,
          x: shooter.x, z: shooter.z, hp: shooter.hp, maxHp: shooter.maxHp,
        });
      }
    }

    if (!targetIsPlayer) return;

    fx.onHitTaken(target, now);

    // Absorção — o dano recebido vira mana (acumulador fracionário, igual ao
    // regen: 1% de um golpe de 40 é 0,4 e sem acumulador nunca viraria mana).
    const mana = fx.damageToMana(target, dmg);
    if (mana > 0 && target.maxMana) {
      status.noteHit(target, 'damage_to_mana_pct', now);
      target._absorbAcc = (target._absorbAcc || 0) + mana;
      if (target._absorbAcc >= 1) {
        const add = Math.floor(target._absorbAcc);
        target._absorbAcc -= add;
        target.mana = Math.min(target.maxMana, (target.mana || 0) + add);
        sendTo(target.ws, { type: 'mana_update', mana: target.mana, maxMana: target.maxMana });
      }
    }

    // Casco de Espinhos — devolve ao atacante conhecido, nunca a si mesmo.
    const thorns = fx.thornsDamage(target, dmg);
    if (thorns > 0 && proj.ownerId && proj.ownerId !== target.id) {
      const atk = this.players.get(proj.ownerId) || (this.npcs && this.npcs.get(proj.ownerId));
      if (atk && !atk.dead) {
        status.noteHit(target, 'thorns_pct', now);
        atk.hp = Math.max(0, atk.hp - thorns);
        this._broadcastToMap(target.mapLevel || 1, {
          type: 'thorns_reflect', targetId: target.id,
          shooterId: proj.ownerId, dmg: thorns, hp: atk.hp,
        });
      }
    }

    // Teimosia — 1 de vida em vez da morte. Só se o golpe é que matou.
    if (target.hp <= 0) {
      const save = fx.deathSaveChance(target);
      if (save > 0 && Math.random() < save) {
        status.noteHit(target, 'death_save_chance', now);
        target.hp = 1;
        this._broadcastToMap(target.mapLevel || 1, { type: 'death_save', targetId: target.id, hp: 1 });
      }
    }

    // Segundo Fôlego — cura ao cruzar 25%, no máximo 1× por minuto.
    const wind = fx.secondWindHeal(target, now);
    if (wind > 0) {
      status.noteHit(target, 'second_wind_pct', now);
      target.hp = Math.min(target.maxHp, target.hp + wind);
      this._broadcastToMap(target.mapLevel || 1, {
        type: 'heal', targetId: target.id, amount: wind,
        x: target.x, z: target.z, hp: target.hp, maxHp: target.maxHp,
      });
    }
  }

  // hit() only accumulates damage into _hitBatch — no broadcasts here.
  // All network messages are sent once per tick in _flushHitBatch().
  hit(proj, target, isNPC) {
    // ── Imunidade pós-respawn: projéteis de NPCs não acertam jogadores em safe period ──
    if (!isNPC && proj.ownerIsNPC && target.safeUntil && Date.now() < target.safeUntil) return;

    // ── Zona verde (PVE): dano jogador→jogador desabilitado. O projétil
    //    atravessa sem ser consumido, para ainda acertar NPCs no caminho.
    //    bala_cura passa (cura de aliado é tratada logo abaixo). ─────────────
    if (!isNPC && !proj.ownerIsNPC && proj.ammoType !== 'bala_cura') {
      const _zone = (MAP_DEFS[target.mapLevel || 1] || {}).pvpZone || 'yellow';
      if (_zone === 'green') return;
    }

    // ── Bala de cura: só funciona em jogadores aliados do grupo ─────────────
    if (!isNPC && !proj.ownerIsNPC && proj.ammoType === 'bala_cura') {
      if (proj.piercing) proj.hitTargets.add(target.id);
      else { proj.dead = true; this.projectiles.delete(proj.id); }

      const shooter2 = this.players.get(proj.ownerId);
      const isAlly   = shooter2 && this.partyManager && this.partyManager.areAllies(shooter2.id, target.id);
      if (isAlly) {
        const ammo = AMMO_DEFS['bala_cura'] || {};
        // Cura escala com o poder de fogo do atirante (healMult × cannonDamage).
        // O valor fixo antigo (5 HP) era imperceptível na escala atual de HP.
        const healMult    = ammo.healMult || 3;
        // Recuperação (def_recuperacao) é do lado de QUEM RECEBE a cura.
        const HEAL_AMOUNT = Math.round(Math.max(ammo.healAmount || 5,
                                     Math.round((shooter2.cannonDamage || 0) * healMult))
                                     * fx.healingReceivedMult(target));
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
    // 1.5 é o crítico do homing (o antigo); o do canhão traz o próprio no
    // projétil, senão a Pontaria Mortal valeria o mesmo que o upgrade de Dano.
    const critMult   = proj.isCrit ? (proj.critMult || 1.5) : 1.0;
    const damageMult = proj.damageMultiplier || 1.0;
    const shooter2   = !proj.ownerIsNPC ? this.players.get(proj.ownerId) : null;
    const skillDmg   = shooter2?.skillDamageMult || 1.0;
    const targetIsPlayer = !this.npcs.has(target.id);
    const skillDef   = (targetIsPlayer && target.skillDefense) ? (1 - target.skillDefense) : 1.0;
    const now        = Date.now();

    // Coletores da barra de status: as funções abaixo anotam neles cada talento
    // que realmente contribuiu neste golpe (ver utils/talent-status.js).
    const procAtk = [];
    const procDef = [];

    // ── Talentos do ATIRADOR ────────────────────────────────────────────────
    // Um multiplicador só, montado com o contexto do golpe: contra quem, a que
    // distância, com que vida dos dois lados, e com os acúmulos em pé.
    const talentDmg  = shooter2 ? fx.outgoingDamageMult(shooter2, {
      targetIsPlayer,
      targetIsNPC:    !targetIsPlayer,
      targetIsBoss:   !!target.isBoss,
      targetHpFrac:   target.maxHp ? target.hp / target.maxHp : 1,
      targetHasCC:    !!((target.slowExpires && now < target.slowExpires)
                      || (target.stunExpires && now < target.stunExpires)),
      dist:           dist2D(shooter2, target),
      isFirstHit:     fx.consumeOpener(shooter2, target.id),
      attackerHpFrac: shooter2.maxHp ? shooter2.hp / shooter2.maxHp : 1,
      isFullSalvo:    !!proj.isFullSalvo,
      isSpecialAmmo:  !!proj.ammoType && proj.ammoType !== 'bala_ferro',
    }, procAtk) : 1.0;

    // ── Talentos do ALVO ────────────────────────────────────────────────────
    // A Bala Perfurante do atirador come parte da redução; o resto (crítico,
    // parado, solo/grupo, vs NPC/jogador…) sai de damageReduction.
    const allyCount = (targetIsPlayer && this.partyManager?.getPartyMembersInZone)
      ? this.partyManager.getPartyMembersInZone(target.id, target.mapLevel || 1, this.players).length
      : 0;
    const talentDef = targetIsPlayer ? (1 - fx.damageReduction(target, {
      fromNPC:    !!proj.ownerIsNPC,
      fromPlayer: !proj.ownerIsNPC,
      isCrit:     !!proj.isCrit,
      isStill:    !target.speed,
      inParty:    allyCount > 0,
      allyCount,
      pen:        shooter2 ? fx.armorPen(shooter2) : 0,
    }, procDef)) : 1.0;
    // Island upgrades: defense (-5% per level) and damage (+10% per level)
    const islandDef  = (targetIsPlayer && target.shipIslandUpgrades?.defense)
      ? (1 - Math.min(target.shipIslandUpgrades.defense * 0.05, 0.80))
      : 1.0;
    const islandDmg  = (shooter2?.shipIslandUpgrades?.damage)
      ? (1 + shooter2.shipIslandUpgrades.damage * 0.10)
      : 1.0;
    // Cannon damage adds to ammo base (cannon.damage was defined but unused before)
    const baseDmg    = ammo.damage + (proj.cannonDmg || 0);
    // Carapaça de Kraken: redução plana, aplicada depois dos multiplicadores.
    const talentFlatDef = targetIsPlayer ? (target.tal?.flat_reduction || 0) : 0;
    const dmg        = calcProjectileDamage({ baseDmg, critMult, damageMult, skillDmg, skillDef, talentDmg, talentDef, islandDef, islandDmg, talentFlatDef });

    // A Bala Perfurante entra no multiplicador do ALVO (come a redução dele),
    // mas quem a comprou foi o atirador — então é status dele.
    if (shooter2 && fx.armorPen(shooter2) > 0) status.noteHit(shooter2, 'armor_pen_pct');
    if (shooter2) status.noteProcs(shooter2, procAtk, now);
    if (targetIsPlayer) status.noteProcs(target, procDef, now);

    // ── Manobra Evasiva / Alvo Difícil: o tiro passa raspando ───────────────
    // Antes de qualquer mitigação — desviar é não ser atingido, não levar menos.
    if (targetIsPlayer) {
      const dodge = fx.dodgeChance(target, !!target.speed);
      if (dodge > 0 && Math.random() < dodge) {
        // Desvio é evento discreto: só vira ícone quando REALMENTE salvou.
        status.noteHit(target, 'dodge_chance', now);
        this._broadcastToMap(target.mapLevel || 1, { type: 'dodge', targetId: target.id });
        return;
      }
    }

    // ── Relic: invincibility (r2) ────────────────────────────────────────────
    if (!isNPC && target.relicInvincibleExpires && now < target.relicInvincibleExpires) {
      // Avisa o mapa que o escudo absorveu o golpe — a bolha pulsa em branco
      this._broadcastToMap(target.mapLevel || 1, { type: 'shield_block', targetId: target.id });
      return;
    }

    // ── Névoa Espectral do BICHO (`special: 'phase'`) ────────────────────────
    // O mesmo efeito da r2, só que do outro lado do canhão: o arauto se desfaz
    // e por `holdMs` o tiro o atravessa. Sem `!isNPC` de propósito — pela mesma
    // razão que a Carapaça logo abaixo perdeu o dela: o buff é do monstro, e um
    // guard de "só jogador" faria o efeito sumir justamente no caminho que
    // importa, que é você atirando nele.
    if (target.phaseUntil && now < target.phaseUntil) {
      this._broadcastToMap(target.mapLevel || 1, { type: 'shield_block', targetId: target.id });
      return;
    }

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

    // ── Relic: Carapaça Eriçada (r32) — mitiga e DEVOLVE parte do golpe ─────
    // As placas eriçadas são o kit de tanque do leviatã-tartaruga: reduzem o
    // dano e refletem uma fração em quem bateu. O reflect só vale contra
    // atirador conhecido (proj.ownerId) e nunca se auto-aplica.
    // Sem o `!isNPC` que havia aqui: a carapaça é do BICHO tanto quanto do
    // jogador (o leviatã-tartaruga a usa), e o guard fazia o buff dele ser
    // ignorado justamente no caminho que importa — o seu tiro contra ele.
    if (target.relicBulwarkExpires && now < target.relicBulwarkExpires) {
      const mitigated = Math.round(finalDmg * (target.relicBulwarkReduction || 0.4));
      finalDmg = Math.max(0, finalDmg - mitigated);
      const reflect = Math.round(mitigated * (target.relicBulwarkReflect || 0.3));
      if (reflect > 0 && proj.ownerId && proj.ownerId !== target.id) {
        const shooter = this.players.get(proj.ownerId)
                     || (this.npcs && this.npcs.get(proj.ownerId));
        if (shooter && !shooter.dead) {
          shooter.hp = Math.max(0, shooter.hp - reflect);
          this._broadcastToMap(target.mapLevel || 1, {
            type: 'bulwark_reflect', targetId: target.id,
            shooterId: proj.ownerId, dmg: reflect, hp: shooter.hp,
          });
        }
      }
    }

    // ── Pet: relíquia defensiva intercepta ANTES do dano ser aplicado ───────
    if (!isNPC && this.petManager) {
      finalDmg = this.petManager.interceptOwnerDamage(target, finalDmg);
      if (finalDmg <= 0) {
        this._broadcastToMap(target.mapLevel || 1, { type: 'shield_block', targetId: target.id });
        return;
      }
    }

    target.hp = Math.max(0, target.hp - finalDmg);

    // ── Talentos que reagem ao golpe ────────────────────────────────────────
    // Ordem importa: Teimosia e Segundo Fôlego precisam rodar DEPOIS do hp cair,
    // senão salvariam com base na vida de antes.
    if (shooter2) fx.onHitDealt(shooter2);
    this._applyTalentOnHit(shooter2, target, targetIsPlayer, finalDmg, proj, now);

    // Apply state changes immediately (server-authoritative)
    if (ammo.slow > 0) {
      // Casco Escorregadio suaviza a INTENSIDADE, Vontade de Ferro encurta a DURAÇÃO.
      const slowPower = ammo.slow * (targetIsPlayer ? fx.slowStrengthMult(target) : 1);
      const slowDur   = ammo.slowDur * (targetIsPlayer ? fx.ccDurationMult(target) : 1);
      target.slowMult    = 1 - slowPower;
      target.slowExpires = now + slowDur;
    }
    if (ammo.dotDmg > 0) {
      const effect = proj.ammoType === 'bala_sangue' ? 'bleed' : 'fire';
      if (!target.dots) target.dots = [];
      target.dots.push({
        dmg: ammo.dotDmg, tick: ammo.dotTick, dur: ammo.dotDur,
        next: now + ammo.dotTick, ownerId: proj.ownerId, effect,
      });
    }
    // Óleo Incendiário: o acerto queima o alvo por 3s com uma fração do golpe.
    if (shooter2) {
      const burn = fx.burnDot(shooter2, finalDmg);
      if (burn) {
        if (!target.dots) target.dots = [];
        target.dots.push({ ...burn, next: now + burn.tick, ownerId: shooter2.id });
      }
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
      target.dead = true;       // mark dead now so other projectiles skip it
      target.isPeaceful = false; // sai do modo pesca ao morrer
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

    // Multiplicador de dificuldade TRAVADO no NPC (definido pelo npc-manager ao
    // escalar). Usar o do NPC — e não o do killer — impede o exploit de trocar
    // a dificuldade pouco antes de matar para inflar a recompensa.
    // Recompensa escala pela METADE dos atributos (difficultyRewardMult).
    const diffMult   = npc.diffMult || 1;
    // Lua de Sangue: a recompensa é a da dificuldade REAL do jogador multiplicada
    // pelo fator do evento. Não dá para jogar o total em difficultyRewardMult()
    // porque ela satura no último tier (mult 10 → 5): no Extremo, uma lua 3× daria
    // inimigos 30× mais fortes e exatamente a mesma recompensa de uma noite comum.
    const bloodMult  = npc.bloodMult || 1;
    const rewardMult = difficultyRewardMult(diffMult / bloodMult) * bloodMult;

    if (killer) {
      killer.npcKills = (killer.npcKills || 0) + 1;

      // Carnificina (pilha de dano), Ventania (velocidade 5s) e Colheita de
      // Almas (mana por abate) — todas penduradas no mesmo evento.
      fx.onKill(killer);
      const manaKill = fx.manaOnKill(killer);
      if (manaKill > 0 && killer.maxMana) {
        killer._manaKillAcc = (killer._manaKillAcc || 0) + manaKill;
        if (killer._manaKillAcc >= 1) {
          const add = Math.floor(killer._manaKillAcc);
          killer._manaKillAcc -= add;
          killer.mana = Math.min(killer.maxMana, (killer.mana || 0) + add);
          sendTo(killer.ws, { type: 'mana_update', mana: killer.mana, maxMana: killer.maxMana });
        }
      }

      // Todo bônus de espólio passa por lootMult: ele já soma Pilhador/Estudioso,
      // Sabedoria Antiga (só em chefe) e Tesouro do Abismo numa conta só.
      //
      // Antes isto era um empilhado de multiplicações aqui, e os chefes de mapa
      // e o boss mundial usavam OUTRA conta nos managers deles — o mesmo talento
      // rendia diferente conforme quem matasse o chefe. Percentuais da mesma
      // família somam; multiplicá-los inflava o total (2,52× em vez de 2,10×).
      finalGold = calcKillGold({
        baseGold,
        dropBonus:       killer.dropBonus || 0,
        talentGoldBonus: fx.lootMult(killer, 'gold') - 1,
      });
      const xpPerKill = npcMapDef.npc?.xpPerKill || 12;
      xpGained = calcKillXp({
        xpPerKill,
        talentXpBonus: fx.lootMult(killer, npc.isBoss ? 'xp_boss' : 'xp') - 1,
      });

      // Dificuldade multiplica as recompensas (metade do fator de HP/dano)
      finalGold = Math.round(finalGold * rewardMult);
      xpGained  = Math.round(xpGained  * rewardMult);

      // Veia de Ouro — chance de dobrar o ouro do espólio.
      if (Math.random() < fx.goldDoubleChance(killer)) finalGold *= 2;

      // Dobrao drop (só para o killer — não é dividido)
      if ((npcDef.dobraoChance || 0) > 0 && Math.random() < (npcDef.dobraoChance + (killer.talentDobraoBonus || 0))) {
        let dobraoAmt = Math.round(Math.floor(Math.random() * (npcDef.dobraoMax - npcDef.dobraoMin + 1) + npcDef.dobraoMin)
                                   * rewardMult * fx.lootMult(killer, 'dobrao'));
        // Cofre Duplo — mesma ideia da Veia de Ouro, do lado do dobrão.
        if (Math.random() < fx.dobraoDoubleChance(killer)) dobraoAmt *= 2;
        killer.dobroes = (killer.dobroes || 0) + dobraoAmt;
      }

      // ── Divisão de recompensas de grupo ──────────────────────────────────
      const partyMembers = this.partyManager
        ? this.partyManager.getPartyMembersInZone(killer.id, mapLvl, this.players)
        : [];
      const totalMembers = partyMembers.length + 1;
      const memberGold   = Math.floor(finalGold / totalMembers);
      const memberXp     = Math.floor(xpGained  / totalMembers);
      // Fragmentos NÃO são divididos: cada membro (e o killer) recebe o total por
      // kill de qualquer um do grupo. Ex.: 3 membros matando 1 NPC cada → todos +3.
      const memberFrags  = Math.floor(FRAGMENT_DROP_NPC * rewardMult);

      killer.gold  += memberGold;
      killer.mapXp  = (killer.mapXp || 0) + memberXp;

      for (const m of partyMembers) {
        m.gold       = (m.gold       || 0) + memberGold;
        m.mapXp      = (m.mapXp      || 0) + memberXp;
        m.mapFragments = (m.mapFragments || 0) + memberFrags;
        if (m.ws?.readyState === 1) {
          sendTo(m.ws, { type: 'currency_update', gold: m.gold, dobroes: m.dobroes, mapFragments: m.mapFragments });
        }
        if (this.db) this.db.save(m, true).catch(() => {});
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

      // Relic drop (dificuldade aumenta a chance, com teto de 95%)
      if (Math.random() < Math.min(0.95, (npc.relicDropChance || 0) * rewardMult)) {
        if (!killer.inventory.relics) killer.inventory.relics = [];
        const ownedIds = new Set(killer.inventory.relics.map(r => r.relicId));
        const dropped  = _rollRelicDrop(ownedIds, npc);
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

      // Marca o atacante (jogador) em combate ao causar dano num NPC — usado pela
      // guarda "só troca de dificuldade fora de combate" no handler set_difficulty.
      if (isNPC && !batch.ownerIsNPC && killerProj) {
        const _shooter = this.players.get(killerProj.ownerId);
        if (_shooter) _shooter.lastCombatTime = now;
      }

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
        // O número já sai marcado como crítico: o `crit_hit` abaixo é posicional
        // (só x/z) e não dava para saber QUAL número dele veio.
        crit: hasCrit,
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
          // Zona vermelha: vítima perde 10% do ouro e dropa ruína saqueável
          if (this.wreckManager) this.wreckManager.onPlayerDeath(target);

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

    // ── Broad-phase por mapa ────────────────────────────────────────────────
    // `this.npcs` é o Proxy que agrega TODOS os managers, então o código antigo
    // varria os NPCs do mundo inteiro para cada projétil e só descartava pelo
    // mapLevel lá dentro do checkHit. Bucketizar uma vez por tick troca
    // O(projéteis × entidades_do_mundo) por O(entidades) + O(projéteis × mesmo_mapa).
    //
    // Iterar um array congelado (em vez do Map vivo) é seguro: o checkHit já
    // começa descartando alvo morto, e quem nasce no meio do tick simplesmente
    // entra na conta do tick seguinte.
    const npcsByMap    = new Map();
    const playersByMap = new Map();
    const _bucket = (map, key, item) => {
      let arr = map.get(key);
      if (!arr) { arr = []; map.set(key, arr); }
      arr.push(item);
    };
    this.npcs.forEach(n    => { if (n && !n.dead) _bucket(npcsByMap,    n.mapLevel || 1, n); });
    this.players.forEach(p => { if (p && !p.dead) _bucket(playersByMap, p.mapLevel || 1, p); });

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

      // Só as entidades do mapa do dono do projétil — o checkHit mantém a
      // checagem de mapLevel como segunda barreira.
      const _mapNpcs = npcsByMap.get(p.ownerMapLevel);
      if (_mapNpcs) for (let i = 0; i < _mapNpcs.length; i++) checkHit(_mapNpcs[i], true);
      const _mapPlayers = playersByMap.get(p.ownerMapLevel);
      if (_mapPlayers) for (let i = 0; i < _mapPlayers.length; i++) checkHit(_mapPlayers[i], false);

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
            type:     'heal',
            targetId: shooter.id,
            amount:   total,
            hp:       shooter.hp,
            source:   'lifesteal',
            x:        shooter.x,
            z:        shooter.z,
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