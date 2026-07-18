// managers/mission-boat-manager.js — Barco de Missões
//
// Um único barco NPC (não-combatente) que navega em rota circular pelos mapas
// 1→2→3→4→1… Fica DWELL_MS em cada mapa e então "parte" para o próximo.
// Quando qualquer jogador chega a STOP_RADIUS, o barco para de navegar e o
// cliente mostra o botão "Missões"; quando todos se afastam além de
// RESUME_RADIUS ele retoma a rota (e a partida para o próximo mapa, se o
// dwell já venceu, só acontece sem ninguém por perto).
//
// Broadcast: server.js inclui `missionBoat: snapshotFor(zone)` na mensagem
// `state` dos jogadores do mapa onde o barco está. Ausência do campo = sem
// barco neste mapa (o cliente remove o nó).

const { pushOutOfIslands } = require('../utils/collision');

const ROUTE_MAPS     = [1, 2, 3, 4];
const DWELL_MS       = 4 * 60 * 1000; // tempo mínimo em cada mapa
const STOP_RADIUS    = 90;            // jogador a essa distância → barco para
const RESUME_RADIUS  = 120;           // todos além disso → barco retoma a rota
const INTERACT_RADIUS = 80;           // raio em que o cliente mostra o botão
const WAYPOINT_COUNT = 10;            // pontos da rota circular
const WAYPOINT_REACH = 30;            // distância para considerar waypoint atingido
const WAYPOINT_TIMEOUT_MS = 45000;    // anti-stall: pula waypoint inalcançável
const CRUISE_SPEED   = 0.38;          // mesma escala dos NPCs (× dt × 30 u/s)
const TURN_RATE      = 0.05;          // rad por tick de correção de rumo

class MissionBoatManager {
  constructor(players, mapDefs) {
    this.players = players;
    this.mapDefs = mapDefs || {};

    this._routeIdx    = 0;                       // índice em ROUTE_MAPS
    this._waypoints   = [];
    this._wpIdx       = 0;
    this._wpStartedAt = Date.now();
    this._arrivedAt   = Date.now();              // quando entrou no mapa atual
    this._stopped     = false;

    this.boat = {
      x: 0, z: 0,
      rotation: 0,
      mapLevel: ROUTE_MAPS[0],
      speed: 0,
    };
    this._enterMap(ROUTE_MAPS[0], Date.now());
  }

  // ── Rota ────────────────────────────────────────────────────────────────────
  // `now` vem do game loop — nunca misturar com Date.now() aqui dentro, senão
  // dwell/timeout quebram se os relógios divergirem.
  _enterMap(level, now) {
    const mapDef  = this.mapDefs[level] || {};
    const mapSize = mapDef.size || 1200;
    // Círculo em torno do centro; raio folgado para não raspar as ilhas centrais
    const r = mapSize * 0.30;
    this._waypoints = [];
    for (let i = 0; i < WAYPOINT_COUNT; i++) {
      const a = (i / WAYPOINT_COUNT) * Math.PI * 2;
      this._waypoints.push({ x: Math.sin(a) * r, z: Math.cos(a) * r });
    }
    this._wpIdx       = 0;
    this._wpStartedAt = now;
    this._arrivedAt   = now;
    this.boat.mapLevel = level;
    this.boat.x = this._waypoints[0].x;
    this.boat.z = this._waypoints[0].z;
    // Sai da ilha se o ponto inicial calhar dentro de uma
    pushOutOfIslands(this.boat, mapDef, 14);
    // Aponta para o próximo waypoint
    const next = this._waypoints[1];
    this.boat.rotation = Math.atan2(next.x - this.boat.x, next.z - this.boat.z);
    this._wpIdx = 1;
    console.log(`[MissionBoat] chegou ao mapa ${level} (${mapDef.name || '?'})`);
  }

  _nextMap(now) {
    this._routeIdx = (this._routeIdx + 1) % ROUTE_MAPS.length;
    this._enterMap(ROUTE_MAPS[this._routeIdx], now);
  }

  // ── Proximidade de jogadores ────────────────────────────────────────────────
  _nearestPlayerDist() {
    let best = Infinity;
    this.players.forEach(p => {
      if (!p || p.dead) return;
      if ((p.mapLevel || 1) !== this.boat.mapLevel) return;
      const dx = p.x - this.boat.x;
      const dz = p.z - this.boat.z;
      const d  = Math.sqrt(dx * dx + dz * dz);
      if (d < best) best = d;
    });
    return best;
  }

  // ── Tick (chamado pelo game loop) ───────────────────────────────────────────
  update(now, dt) {
    const nearest = this._nearestPlayerDist();

    // Histerese parar/retomar
    if (this._stopped) {
      if (nearest > RESUME_RADIUS) this._stopped = false;
    } else if (nearest <= STOP_RADIUS) {
      this._stopped = true;
    }

    if (this._stopped) {
      this.boat.speed = Math.max(this.boat.speed - 0.04, 0);
      if (this.boat.speed <= 0) return;
    }

    // Dwell vencido e ninguém por perto → parte para o próximo mapa
    if (now - this._arrivedAt >= DWELL_MS && nearest > RESUME_RADIUS) {
      this._nextMap(now);
      return;
    }

    const wp = this._waypoints[this._wpIdx];
    if (!wp) return;
    const dx = wp.x - this.boat.x;
    const dz = wp.z - this.boat.z;
    const d  = Math.sqrt(dx * dx + dz * dz);

    if (d <= WAYPOINT_REACH || now - this._wpStartedAt > WAYPOINT_TIMEOUT_MS) {
      this._wpIdx       = (this._wpIdx + 1) % this._waypoints.length;
      this._wpStartedAt = now;
      return;
    }

    // Curva suave em direção ao waypoint (mesma convenção dos NPCs)
    const desired = Math.atan2(dx, dz);
    let diff = desired - this.boat.rotation;
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.boat.rotation += Math.max(-TURN_RATE, Math.min(TURN_RATE, diff));

    if (!this._stopped) {
      this.boat.speed = Math.min(this.boat.speed + 0.02, CRUISE_SPEED);
    }
    this.boat.x += Math.sin(this.boat.rotation) * this.boat.speed * dt * 30;
    this.boat.z += Math.cos(this.boat.rotation) * this.boat.speed * dt * 30;

    // Nunca atravessa ilhas (mesmo push-out de jogadores/NPCs)
    pushOutOfIslands(this.boat, this.mapDefs[this.boat.mapLevel], 14);
  }

  // ── Snapshot para o state da zona ───────────────────────────────────────────
  /** @returns {Object|null} dados do barco se ele está nesta zona, senão null */
  snapshotFor(zone) {
    if (zone !== this.boat.mapLevel) return null;
    return {
      x:              Math.round(this.boat.x * 10) / 10,
      z:              Math.round(this.boat.z * 10) / 10,
      rotation:       Math.round(this.boat.rotation * 1000) / 1000,
      stopped:        this._stopped,
      interactRadius: INTERACT_RADIUS,
    };
  }

  /** true se o jogador está no mesmo mapa e dentro do raio de interação. */
  isPlayerNear(player, slack = 1.5) {
    if (!player || (player.mapLevel || 1) !== this.boat.mapLevel) return false;
    const dx = player.x - this.boat.x;
    const dz = player.z - this.boat.z;
    return Math.sqrt(dx * dx + dz * dz) <= INTERACT_RADIUS * slack;
  }
}

module.exports = MissionBoatManager;
