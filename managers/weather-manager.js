// managers/weather-manager.js — Clima dinâmico SINCRONIZADO por mapa
//
// O servidor é a autoridade do clima: cada mapa tem um estado que cicla com o
// tempo (pesos + duração por estado), e esse estado vai no `state` de todos os
// jogadores do mapa — assim TODOS no mesmo mapa veem o mesmo clima. O cliente
// só aplica visualmente (scripts/weather_system.gd) e interpola suave.
//
// O ciclo é LAZY: só avança quando `get(level)` é chamado (isto é, quando há
// jogador no mapa e o `state` está sendo montado). Mapas vazios não gastam CPU
// e "congelam" no último estado até alguém voltar.
//
// Os pesos/durações espelham STATES de scripts/weather_system.gd
// (≈ 80% limpo / 10% chuva / 5% tempestade / 5% neblina).

'use strict';

// weight = peso na escolha do próximo clima | min/max = duração do estado (s)
const WEATHER_STATES = {
  clear: { weight: 16, min: 120, max: 300 },
  fog:   { weight: 1,  min: 45,  max: 90  },
  rain:  { weight: 2,  min: 40,  max: 80  },
  storm: { weight: 1,  min: 30,  max: 60  },
};
const WEATHER_KEYS  = Object.keys(WEATHER_STATES);
const WEIGHT_TOTAL  = WEATHER_KEYS.reduce((s, k) => s + WEATHER_STATES[k].weight, 0);

class WeatherManager {
  /**
   * @param {Object} mapDefs  — MAP_DEFS (usa o campo `weather` como PONTO DE
   *                            PARTIDA/tema de cada mapa; depois cicla)
   */
  constructor(mapDefs) {
    this.mapDefs = mapDefs || {};
    this._maps   = new Map(); // level → { state, changeAt }
  }

  _rand(min, max) { return min + Math.random() * (max - min); }

  _weightedPick() {
    let r = Math.random() * WEIGHT_TOTAL;
    for (const k of WEATHER_KEYS) {
      r -= WEATHER_STATES[k].weight;
      if (r <= 0) return k;
    }
    return 'clear';
  }

  _pickNext(current) {
    let pick = this._weightedPick();
    if (pick === current) pick = this._weightedPick(); // evita repetir logo em seguida
    return pick;
  }

  // Estado inicial de um mapa: parte do `weather` do MAP_DEF (tema) e agenda a
  // 1ª troca para daqui a `min..max` — assim ninguém que acabou de entrar vê o
  // clima trocar no mesmo instante.
  _ensure(level, now) {
    let e = this._maps.get(level);
    if (!e) {
      const start = String((this.mapDefs[level] || {}).weather || 'clear').toLowerCase();
      const key   = WEATHER_STATES[start] ? start : 'clear';
      const st    = WEATHER_STATES[key];
      e = { state: key, changeAt: now + this._rand(st.min, st.max) * 1000 };
      this._maps.set(level, e);
    }
    return e;
  }

  /**
   * Clima atual do mapa (string: clear|fog|rain|storm). Avança o ciclo se a
   * duração do estado venceu. Idempotente dentro do mesmo tick (a troca empurra
   * changeAt para o futuro, então múltiplas chamadas no mesmo tick não ciclam 2x).
   */
  get(level, now = Date.now()) {
    const e = this._ensure(level, now);
    if (now >= e.changeAt) {
      e.state = this._pickNext(e.state);
      const st = WEATHER_STATES[e.state] || WEATHER_STATES.clear;
      e.changeAt = now + this._rand(st.min, st.max) * 1000;
      console.log(`🌦️  [Weather] mapa ${level} → ${e.state}`);
    }
    return e.state;
  }
}

module.exports = WeatherManager;
module.exports.WEATHER_STATES = WEATHER_STATES;
