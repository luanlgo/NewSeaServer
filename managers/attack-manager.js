// managers/attack-manager.js
//
// Gerencia seleção, telegraph, cast e resolução de dano de ataques de NPC.
// NPCs não contêm lógica de ataque — apenas referenciam IDs de ATTACK_DEFS.
//
// Fluxo por ataque:
//   1. tryAttack()        — NPC escolhe um ataque disponível (range + cooldown + peso)
//   2. _beginCast()       — emite npc_telegraph para o cliente, agenda resolução
//   3. _resolveAttack()   — aplica dano; projéteis via ProjectileManager, AoE direto
//   4. cooldown           — registrado em npc._attackCooldowns[id]

'use strict';

const { dist2D } = require('../utils/helpers');
const { ATTACK_DEFS, MAP_DEFS } = require('../constants');

class AttackManager {
  /**
   * @param {Function} addEvent         — broadcast fn do server.js
   * @param {Object}   projectileManager
   */
  constructor(addEvent, projectileManager) {
    this.addEvent = addEvent;
    this.pm       = projectileManager;
  }

  // ── API pública ──────────────────────────────────────────────────────────────

  /**
   * Tenta iniciar um ataque para um NPC.
   * Chamado pelo npc-manager a cada tick, quando o NPC tem um alvo válido.
   *
   * @param {Object}   npc
   * @param {Object}   target       — jogador mais próximo
   * @param {Object[]} allPlayers   — todos os jogadores do mapa
   * @param {number}   mapLevel
   */
  tryAttack(npc, target, allPlayers, mapLevel) {
    if (npc._currentCast) return; // já está em cast
    if (npc.dead || target.dead)  return;
    if (npc._nextAttackTime && Date.now() < npc._nextAttackTime) return; // cooldown entre ataques

    const dist     = dist2D(npc, target);
    const available = this._getAvailable(npc, dist);
    if (!available.length) return;

    const attack = this._selectWeighted(available);
    this._beginCast(npc, attack, target, allPlayers, mapLevel);
  }

  /**
   * Cancela cast pendente de um NPC (ex: morte durante telegraph).
   * @param {Object} npc
   */
  cancelCast(npc) {
    if (npc._castTimer) {
      clearTimeout(npc._castTimer);
      npc._castTimer = null;
    }
    npc._currentCast = null;
  }

  // ── Seleção ──────────────────────────────────────────────────────────────────

  _getAvailable(npc, dist) {
    const now = Date.now();
    const ids  = npc.attacks;
    if (!ids?.length) return [];

    const available = ids
      .map(id => ATTACK_DEFS[id])
      .filter(atk =>
        atk &&
        atk.shape !== 'aura' &&
        dist >= atk.rangeMin &&
        dist <= atk.rangeMax &&
        !(npc._attackCooldowns?.[atk.id] > now)
      );

    // Embaralha para que o peso não seja influenciado pela posição no array
    for (let i = available.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [available[i], available[j]] = [available[j], available[i]];
    }

    return available;
  }

  _selectWeighted(attacks) {
    const total = attacks.reduce((s, a) => s + a.weight, 0);
    let r = Math.random() * total;
    for (const atk of attacks) {
      r -= atk.weight;
      if (r <= 0) return atk;
    }
    return attacks[attacks.length - 1];
  }

  // ── Cast / Telegraph ─────────────────────────────────────────────────────────

  _beginCast(npc, attack, target, allPlayers, mapLevel) {
    npc._currentCast = attack.id;

    // Para all_players_in_range: trava posição de TODOS os jogadores no alcance
    let multiTargets = null;
    if (attack.targetMode === 'all_players_in_range') {
      const range = attack.rangeMax || 320;
      const inRange = allPlayers.filter(p =>
        p.mapLevel === mapLevel && !p.dead && dist2D(npc, p) <= range
      );
      if (inRange.length > 0) {
        multiTargets = inRange.map(p => ({ x: p.x, z: p.z }));
      }
    }

    const targetX = target.x;
    const targetZ = target.z;

    this.addEvent({
      type:         'npc_telegraph',
      npcId:        npc.id,
      attackId:     attack.id,
      shape:        attack.shape,
      npcX:         npc.x,
      npcZ:         npc.z,
      x:            targetX,
      z:            targetZ,
      radius:       attack.radius,
      angle:        attack.angle,
      length:       attack.length,
      width:        attack.width,
      duration:     attack.castTime,
      color:        attack.telegraph?.color,
      multiTargets: multiTargets,
    }, mapLevel);

    const timer = setTimeout(() => {
      npc._castTimer   = null;
      npc._currentCast = null;
      if (!npc._attackCooldowns) npc._attackCooldowns = {};
      // Jitter de ±20% no cooldown para que ataques com cooldown igual
      // não expirem sempre na mesma ordem (A→B→C→A→B→C)
      const jitter = attack.cooldown * (Math.random() * 0.4 - 0.2);
      npc._attackCooldowns[attack.id] = Date.now() + attack.cooldown + jitter;
      // Pausa aleatória entre ataques (800ms–2200ms) para que múltiplos ataques
      // disponíveis ao mesmo tempo não resultem sempre no mesmo ser escolhido primeiro
      npc._nextAttackTime = Date.now() + 800 + Math.random() * 1400;
      if (npc.dead) return;

      if (multiTargets) {
        for (const t of multiTargets) {
          this._resolveAttack(npc, attack, t.x, t.z, allPlayers, mapLevel);
        }
      } else {
        this._resolveAttack(npc, attack, targetX, targetZ, allPlayers, mapLevel);
      }
    }, attack.castTime);

    npc._castTimer = timer;
  }

  // ── Resolução de dano ────────────────────────────────────────────────────────

  _resolveAttack(npc, attack, targetX, targetZ, allPlayers, mapLevel) {
    if (attack.shape === 'projectile') {
      this._spawnProjectiles(npc, attack, targetX, targetZ);
      return;
    }

    const hits = [];
    const mapPlayers = allPlayers.filter(p => p.mapLevel === mapLevel && !p.dead);

    const goldStealRatio = (MAP_DEFS[mapLevel] || {}).goldStealRatio || 0;

    for (const p of mapPlayers) {
      if (this._isHit(p, attack, targetX, targetZ, npc)) {
        let dmg = Math.max(1, Math.floor((npc.cannonDmg || 1) * attack.damageMult));
        // Aplica debuff de defesa se ativo
        const defDebuff = p.activeDebuffs?.find(d => d.type === 'defense_buff' && d.expiresAt > Date.now());
        if (defDebuff) dmg = Math.round(dmg * (1 + Math.abs(defDebuff.value)));
        // Escudo de Ouro: 30% DR (mesmo que projectile-manager)
        if (p.relicGoldShieldActive) {
          const blocked = Math.round(dmg * 0.30);
          dmg -= blocked;
          const goldCost = Math.round(blocked * 0.10);
          if (goldCost > 0) p.gold = Math.max(0, (p.gold || 0) - goldCost);
        }
        p.hp = Math.max(0, p.hp - dmg);
        p.lastCombatTime = Date.now();

        // Roubo de ouro (goldStealRatio definido no MAP_DEFS do mapa)
        let goldStolen = 0;
        if (goldStealRatio > 0 && dmg > 0) {
          goldStolen = Math.max(1, Math.floor(dmg * goldStealRatio));
          p.gold     = Math.max(0, (p.gold || 0) - goldStolen);
        }

        hits.push({ id: p.id, hp: p.hp, dmg, goldStolen });

        // Verifica morte do jogador
        if (p.hp <= 0 && !p.dead) {
          p.dead = true;
          this.addEvent({
            type:     'entity_dead',
            id:       p.id,
            name:     p.name,
            isNPC:    false,
            killerId: npc.id,
          }, mapLevel, /* urgent */ true);
        }

        // Aplica efeitos (debuffs + pull) ao jogador
        if (attack.effects?.length) {
          if (!p.activeDebuffs) p.activeDebuffs = [];
          const now = Date.now();
          for (const eff of attack.effects) {
            if (eff.type === 'pull') {
              // Puxa o jogador em direção ao NPC até pullDistance unidades de distância
              const pullDist = eff.pullDistance || 60;
              const ddx = npc.x - p.x;
              const ddz = npc.z - p.z;
              const d   = Math.sqrt(ddx * ddx + ddz * ddz) || 1;
              if (d > pullDist) {
                p.x = npc.x - (ddx / d) * pullDist;
                p.z = npc.z - (ddz / d) * pullDist;
              }
              this.addEvent({
                type:     'player_pulled',
                playerId: p.id,
                npcId:    npc.id,
                toX:      p.x,
                toZ:      p.z,
              }, mapLevel);
            } else {
              // Remove debuff do mesmo tipo se já existe, depois aplica
              p.activeDebuffs = p.activeDebuffs.filter(d => d.type !== eff.type);
              p.activeDebuffs.push({ type: eff.type, value: eff.value, expiresAt: now + eff.duration });
            }
          }
        }
      }
    }

    this.addEvent({
      type:         'npc_attack_hit',
      npcId:        npc.id,
      attackId:     attack.id,
      shape:        attack.shape,
      x:            targetX,
      z:            targetZ,
      hits,
      effects:      attack.effects || [],
      visualEffect: attack.visualEffect || null,
    }, mapLevel);
  }

  _spawnProjectiles(npc, attack, targetX, targetZ) {
    const count    = attack.count ?? npc.cannonCount ?? 1;
    const spread   = attack.spread || 0.05;
    const baseAng  = Math.atan2(targetX - npc.x, targetZ - npc.z);

    for (let i = 0; i < count; i++) {
      const ang = baseAng + (Math.random() - 0.5) * spread * 2;
      const d   = 80 + Math.random() * 40;
      this.pm.spawn(
        npc,
        npc.x + Math.sin(ang) * d,
        npc.z + Math.cos(ang) * d,
        0,
        attack.damageMult,
        npc.cannonDmg || 0
      );
    }
  }

  // ── Geometria de hit ─────────────────────────────────────────────────────────

  _isHit(player, attack, tx, tz, npc) {
    const px = player.x;
    const pz = player.z;

    switch (attack.shape) {
      case 'circle': {
        const dx = px - tx, dz = pz - tz;
        return dx * dx + dz * dz <= attack.radius * attack.radius;
      }

      case 'cone': {
        const d = dist2D(player, npc);
        if (d > (attack.length || attack.rangeMax)) return false;
        const aimAng    = Math.atan2(tx - npc.x, tz - npc.z);
        const playerAng = Math.atan2(px - npc.x, pz - npc.z);
        let   diff      = Math.abs(playerAng - aimAng);
        if (diff > Math.PI) diff = Math.PI * 2 - diff;
        return diff <= (attack.angle || 0) / 2;
      }

      case 'line': {
        // Projeção do jogador sobre o eixo npc→target
        const dirX = tx - npc.x,  dirZ = tz - npc.z;
        const len  = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
        const uX = dirX / len,   uZ = dirZ / len;  // unit ao longo da linha
        const rX = -uZ,          rZ = uX;           // unit perpendicular
        const relX = px - npc.x, relZ = pz - npc.z;
        const along = relX * uX + relZ * uZ;
        const perp  = Math.abs(relX * rX + relZ * rZ);
        return along >= 0 && along <= len && perp <= (attack.width || 10) / 2;
      }

      case 'targeted_aoe': {
        const dx = px - tx, dz = pz - tz;
        return dx * dx + dz * dz <= attack.radius * attack.radius;
      }

      default:
        return false;
    }
  }

  // ── Tick de auras passivas ────────────────────────────────────────────────────

  tickAuras(npc, allPlayers, mapLevel) {
    if (!npc.auras?.length) return;
    const now = Date.now();
    if (!npc._auraTicks) npc._auraTicks = {};

    for (const auraId of npc.auras) {
      const auraDef = ATTACK_DEFS[auraId];
      if (!auraDef || auraDef.shape !== 'aura') continue;

      const tickRate = auraDef.tickRate || 1000;
      if (now - (npc._auraTicks[auraId] || 0) < tickRate) continue;
      npc._auraTicks[auraId] = now;

      const radius = auraDef.radius || 200;
      const mapPlayers = allPlayers.filter(p => p.mapLevel === mapLevel && !p.dead);
      const hits = [];

      for (const p of mapPlayers) {
        const dx = p.x - npc.x, dz = p.z - npc.z;
        if (dx * dx + dz * dz > radius * radius) continue;

        // Aplica efeitos de debuff
        if (auraDef.effects?.length) {
          if (!p.activeDebuffs) p.activeDebuffs = [];
          for (const eff of auraDef.effects) {
            p.activeDebuffs = p.activeDebuffs.filter(d => d.type !== eff.type);
            p.activeDebuffs.push({ type: eff.type, value: eff.value, expiresAt: now + eff.duration });
          }
          hits.push({ id: p.id });
        }
      }

      if (hits.length) {
        this.addEvent({
          type:     'aura_tick',
          npcId:    npc.id,
          auraId,
          radius,
          effects:  auraDef.effects,
          hits:     hits.map(h => h.id),
        }, mapLevel);
      }
    }
  }

}

module.exports = AttackManager;
