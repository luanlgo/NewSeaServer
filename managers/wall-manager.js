// managers/wall-manager.js
// Registro de obstáculos TEMPORÁRIOS (ex.: muro de pedra de uma relíquia) —
// mesma forma {shape:'box', x, z, hw, hh, rot} dos colliders de ilha, mas
// dinâmica (com expiração) em vez de fixa no MAP_DEF.
//
// Consultado pelo MESMO ponto de colisão que já protege contra ilhas
// (utils/collision.js `pushOutOfWalls`), injetado em player-manager e em
// cada instância de NPC manager — igual ao partyManager (ver server.js) —
// pra jogador e NPC respeitarem o muro exatamente igual.
'use strict';

class WallManager {
  constructor() {
    this.wallsByMap = new Map(); // mapLevel(Number) -> Array<{id, x, z, hw, hh, rot, expiresAt}>
  }

  /** Registra um muro retangular temporário no mapa `mapLevel`. */
  addWall(mapLevel, { id, x, z, hw, hh, rot, durationMs }) {
    const list = this.wallsByMap.get(mapLevel) || [];
    list.push({ id, x, z, hw, hh, rot, expiresAt: Date.now() + durationMs });
    this.wallsByMap.set(mapLevel, list);
  }

  /** Remove um muro antes do tempo (ex.: caster desconectou no meio da duração). */
  removeWall(mapLevel, id) {
    const list = this.wallsByMap.get(mapLevel);
    if (!list) return;
    this.wallsByMap.set(mapLevel, list.filter(w => w.id !== id));
  }

  /**
   * Muros ativos no mapa — filtra expirados nesta própria chamada, sem
   * timer de limpeza separado (mesmo padrão de `slowExpires`/`stunExpires`
   * sendo checados no loop de movimento em vez de agendados individualmente).
   */
  getActive(mapLevel) {
    const list = this.wallsByMap.get(mapLevel);
    if (!list || list.length === 0) return list || [];
    const now = Date.now();
    const active = list.filter(w => w.expiresAt > now);
    if (active.length !== list.length) this.wallsByMap.set(mapLevel, active);
    return active;
  }
}

module.exports = WallManager;
