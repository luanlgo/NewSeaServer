// managers/fleet-event-manager.js — Evento "Frota de Caçadores"
//
// Ciclo: agenda → anúncio global (fleet_incoming, announceMs de antecedência)
// → spawn no mapa alvo → caçada → fim por abate total (fleet_defeated),
// retirada por tempo (fleet_retreat) ou mapa esvaziado/limpo (silencioso).
//
// Os navios são NPCs REGULARES (isFleetShip=true, noRespawn=true) dentro do
// NPCManager do mapa alvo: perseguição, canhões, colisão, snapshot e morte
// reaproveitam 100% o pipeline existente. A única costura extra é o bounty,
// pago via hook _onNpcKill do projectile-manager (server.js chama
// onFleetShipKilled) — assim TODO caminho de dano (projétil, DoT, aura)
// converge no mesmo pagamento.
//
// Escolha do mapa: sorteio entre FLEET_EVENT.maps que tenham jogador vivo.
// Sem candidatos → nova tentativa em 1 min. O tamanho da frota congela no
// anúncio (sizeForPlayers) — quem chegar depois do aviso não encolhe o evento.

const { uid, rand, broadcast, sendTo } = require('../utils/helpers');
const { FLEET_EVENT } = require('../constants');
const db = require('./db-manager');

class FleetEventManager {
  /**
   * @param {Function} getMapManager  (level) => NPCManager|null — resolve o manager do mapa
   * @param {Function} addEvent       (event, mapLevel) => void — buffer de eventos por mapa
   */
  constructor(wss, players, mapDefs, getMapManager, addEvent) {
    this.wss           = wss;
    this.players       = players;
    this.mapDefs       = mapDefs || {};
    this.getMapManager = getMapManager;
    this.addEvent      = addEvent;

    this._nextAttemptAt = Date.now() + FLEET_EVENT.firstDelayMs;
    this._pending       = null;  // { mapLevel, count, at }
    this.active         = null;  // { mapLevel, shipIds:Set, total, startedAt }
  }

  _alivePlayersOnMap(lvl) {
    let n = 0;
    this.players.forEach(p => {
      if (p && !p.dead && (p.mapLevel || 1) === lvl) n++;
    });
    return n;
  }

  // Média de abates de NPC dos jogadores vivos no mapa — dirige a escala da frota
  _avgKillsOnMap(lvl) {
    let sum = 0, n = 0;
    this.players.forEach(p => {
      if (p && !p.dead && (p.mapLevel || 1) === lvl) { sum += (p.npcKills || 0); n++; }
    });
    return n > 0 ? sum / n : 0;
  }

  _scheduleNext(now) {
    this._nextAttemptAt = now + FLEET_EVENT.intervalMs
      + Math.round(rand(-FLEET_EVENT.jitterMs, FLEET_EVENT.jitterMs));
  }

  // ── Tick (chamado pelo game loop) ───────────────────────────────────────────
  update(now) {
    // 1. Spawn agendado venceu
    if (this._pending && now >= this._pending.at) {
      const p = this._pending;
      this._pending = null;
      this._spawn(p, now);
      return;
    }

    // 2. Frota ativa — verifica retirada por tempo ou fim silencioso
    if (this.active) {
      const mgr = this.getMapManager(this.active.mapLevel);
      const aliveIds = (mgr && !mgr.destroyed)
        ? [...this.active.shipIds].filter(id => mgr.npcs.has(id))
        : [];

      if (aliveIds.length === 0) {
        // Mapa foi limpo/destruído com a frota dentro (fleet_defeated é
        // responsabilidade do onFleetShipKilled) — encerra sem alarde.
        this.active = null;
        this._scheduleNext(now);
        return;
      }

      if (now - this.active.startedAt >= FLEET_EVENT.durationMs) {
        for (const id of aliveIds) mgr.npcs.delete(id);
        this.addEvent({ type: 'fleet_retreat', mapLevel: this.active.mapLevel },
          this.active.mapLevel);
        console.log(`🏴‍☠️ [Fleet] frota recuou do mapa ${this.active.mapLevel} (tempo esgotado)`);
        this.active = null;
        this._scheduleNext(now);
      }
      return;
    }

    // 3. Sem frota nem anúncio — tenta iniciar novo evento
    if (!this._pending && now >= this._nextAttemptAt) {
      const candidates = FLEET_EVENT.maps.filter(l => this._alivePlayersOnMap(l) > 0);
      if (candidates.length === 0) {
        this._nextAttemptAt = now + 60 * 1000; // ninguém online nos mapas — tenta em 1 min
        return;
      }
      const mapLevel = candidates[Math.floor(Math.random() * candidates.length)];
      const count    = FLEET_EVENT.sizeForPlayers(this._alivePlayersOnMap(mapLevel));

      broadcast(this.wss, {
        type:       'fleet_incoming',
        mapLevel,
        shipCount:  count,
        spawnDelay: FLEET_EVENT.announceMs,
      });
      this._pending       = { mapLevel, count, at: now + FLEET_EVENT.announceMs };
      this._nextAttemptAt = Infinity; // re-agendado quando o evento terminar
      console.log(`🏴‍☠️ [Fleet] anúncio: ${count} navio(s) rumo ao mapa ${mapLevel} em ${FLEET_EVENT.announceMs / 1000}s`);
    }
  }

  // ── Spawn da frota no mapa alvo ─────────────────────────────────────────────
  _spawn({ mapLevel, count }, now) {
    const mgr = this.getMapManager(mapLevel);
    if (!mgr || mgr.destroyed) {
      // Mapa esvaziou durante o anúncio e o manager foi limpo — cancela
      console.warn(`🏴‍☠️ [Fleet] spawn cancelado: sem manager no mapa ${mapLevel}`);
      this._scheduleNext(now);
      return;
    }

    const mapSize  = (this.mapDefs[mapLevel] || {}).size || 1200;
    // Escala = baseline do mapa × fator dinâmico pela média de abates no mapa.
    // Congela no spawn e viaja com cada navio (npc.fleetScale) para o bounty
    // usar exatamente o mesmo multiplicador que dimensionou hp/dano.
    const avgKills = this._avgKillsOnMap(mapLevel);
    const killMult = FLEET_EVENT.scaleForKills(avgKills);
    const scaleMul = (FLEET_EVENT.mapScale[mapLevel] || 1) * killMult;
    const keys     = FLEET_EVENT.formations[count - 1] || FLEET_EVENT.formations[0];

    // Frota entra pela borda, em linha perpendicular à direção do centro
    const ang  = Math.random() * Math.PI * 2;
    const cx   = Math.sin(ang) * mapSize * 0.42;
    const cz   = Math.cos(ang) * mapSize * 0.42;
    const perp = ang + Math.PI / 2;

    const shipIds = new Set();
    keys.forEach((key, i) => {
      const def    = FLEET_EVENT.ships[key];
      if (!def) return;
      const id     = uid();
      const offset = (i - (keys.length - 1) / 2) * 70; // 70u entre navios
      const hp     = Math.round(def.baseHp * scaleMul);
      const npc = {
        id,
        name:        def.name,
        mapLevel,
        x:           cx + Math.sin(perp) * offset,
        y:           0,
        z:           cz + Math.cos(perp) * offset,
        rotation:    ang + Math.PI, // aponta para o centro do mapa
        hp, maxHp: hp, baseHp: hp,
        speed:       0.5,
        targetId:    null,
        dead:        false,
        isNPC:       true,
        isFleetShip: true,
        fleetKey:    key,
        fleetScale:  scaleMul,   // congelado no spawn — usado no bounty
        noRespawn:   true,   // respawnScaled remove e nunca re-spawna
        stunExpires: 0,
        slowMult:    1,
        slowExpires: 0,
        dots:        [],
        usesCannons: true,
        cannonCount:  def.cannonCount,
        cannonSpread: def.cannonSpread,
        cannonRange:  def.cannonRange,
        fireInterval: def.fireInterval,
        cannonDmg:   Math.round(def.baseDamage * scaleMul),
        baseDmg:     Math.round(def.baseDamage * scaleMul),
        ammoType:    'bala_ferro',
        hitRadius:   def.hitRadius,
        npcModel:    def.model,
        npcScale:    def.scale,
        npcYOffset:  def.yOffset,
        npcRotOffset: def.rotOffset,
        npcHullColor: 0x1a1024,
        npcSailColor: 0x3d2b55,
        npcFlagColor: 0x120a1a,
        relicDropChance: 0,
        attacks:          [],
        _attackCooldowns: {},
        _currentCast:     null,
        _castTimer:       null,
        _nextCannonShot:  0,
        // Stats do evento são fixos por mapa — npc-manager pula o rescale de
        // dificuldade para isFleetShip; os campos abaixo mantêm o contrato.
        _scaledForDiff:   1,
        diffMult:         1,
        diffIdx:          0,
        _lastRescaleTime: 0,
        _lastDamageTime:  0,
        _cachedNearest:   null,
        _cachedNearestDist: Infinity,
        _targetCacheTime:   0,
        _lastRegenBroadcast: 0,
        _lastAuraTick:       0,
      };
      mgr.npcs.set(id, npc);
      shipIds.add(id);
    });

    if (shipIds.size === 0) {
      this._scheduleNext(now);
      return;
    }

    this.active = { mapLevel, shipIds, total: shipIds.size, startedAt: now };
    this.addEvent({ type: 'fleet_spawned', mapLevel, shipCount: shipIds.size }, mapLevel);
    console.log(`🏴‍☠️ [Fleet] ${shipIds.size} navio(s) spawnados no mapa ${mapLevel} ` +
      `(scale ×${scaleMul.toFixed(2)} = map ${FLEET_EVENT.mapScale[mapLevel]} × kills ${killMult.toFixed(2)} @ avg ${avgKills.toFixed(0)})`);
  }

  // ── Bounty — chamado pelo hook _onNpcKill (todo caminho de dano) ────────────
  onFleetShipKilled(killer, npc) {
    if (!this.active || !this.active.shipIds.has(npc.id)) return;
    this.active.shipIds.delete(npc.id);

    const def      = FLEET_EVENT.ships[npc.fleetKey] || {};
    const scaleMul = npc.fleetScale || FLEET_EVENT.mapScale[npc.mapLevel] || 1;
    const gold     = Math.round((def.bounty?.gold   || 0) * scaleMul);
    const dobrao   = Math.round((def.bounty?.dobrao || 0) * scaleMul);

    if (killer) {
      killer.gold    = (killer.gold    || 0) + gold;
      killer.dobroes = (killer.dobroes || 0) + dobrao;
      db.save(killer, true).catch(e => console.error('[Fleet] save error:', e));
      sendTo(killer.ws, {
        type:    'currency_update',
        gold:    killer.gold,
        dobroes: killer.dobroes,
        reward:  { type: 'dobrao', amount: dobrao },
      });
    }

    const remaining = this.active.shipIds.size;
    this.addEvent({
      type:       remaining === 0 ? 'fleet_defeated' : 'fleet_ship_sunk',
      mapLevel:   npc.mapLevel,
      shipName:   npc.name,
      killerName: killer?.name || '?',
      remaining,
      bounty:     { gold, dobrao },
    }, npc.mapLevel);
    console.log(`🏴‍☠️ [Fleet] ${npc.name} afundado por ${killer?.name || '?'} (+${gold}g +${dobrao}d) — restam ${remaining}`);

    if (remaining === 0) {
      this.active = null;
      this._scheduleNext(Date.now());
    }
  }

  destroy() {
    this.players = null;
    this.wss = null;
    this.active = null;
    this._pending = null;
  }
}

module.exports = FleetEventManager;
