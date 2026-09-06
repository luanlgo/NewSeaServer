// utils/sonar-sweep.js — o ladrilho de uma onda que VARRE (Sonar do Abismo).
//
// ── O buraco na borda ───────────────────────────────────────────────────────
// A onda do Sonar corre de 0 até `radius` em `expandMs` e machuca quem a faixa
// (`band`) atravessa. Os dois simuladores — o do bicho (attack-manager) e o da
// relíquia (monster-skill-manager) — amostravam essa corrida por um relógio:
// um tique a cada `expandMs × band / radius`, e a leva era DESCARTADA quando
// passava de `expandMs`. Com 260 un de raio, faixa de 30 e 3,2 s de expansão o
// passo dá 369 ms, que não divide 3200 — a última amostra de cada onda caía
// onde a divisão deixasse:
//
//     onda 0 → frente para em 239,9  (cobre até 254,9)
//     onda 1 → frente para em 232,3  (cobre até 247,3)
//     onda 2 → frente para em 254,7  (cobre até 269,7)
//     onda 3 → frente para em 247,2  (cobre até 262,2)
//
// Ou seja: quem estava parado NA BORDA (260) só era alcançado pelas ondas 2 e
// 3, e escapava do golpe inteiro sempre que o vão girasse na direção dele
// nessas duas — ~4% dos lançamentos. As paredes passavam por cima do barco na
// tela e não acontecia nada.
//
// ── O ladrilho ──────────────────────────────────────────────────────────────
// Aqui a onda não é amostrada por relógio, é LADRILHADA: são
// `ceil(radius / band)` faixas encostadas, e a frente é medida no CENTRO de
// cada uma (band/2, 3·band/2, …). A faixa k cobre exatamente [k·band,
// (k+1)·band], então a união cobre [0, radius] inteiro — sem buraco em lugar
// nenhum e, em particular, com a última faixa passando pela borda.
//
// O RITMO continua o mesmo de antes (uma faixa por `stepMs`), só que com meia
// faixa de defasagem: a amostra k sai em `stepMs × (k + 0.5)`, que é
// exatamente o instante em que a frente DESENHADA está no centro da faixa k.
// Dano e desenho seguem correndo juntos.
'use strict';

/**
 * @param {Object} def — a skill (precisa de `expandMs`, `radius`, `band`).
 * @returns {{steps:number, stepMs:number, fronts:number[], timeAt:Function, endMs:number}}
 *   `fronts[k]`  distância da frente na amostra k
 *   `timeAt(k)`  quando a amostra k sai, contado do lançamento DAQUELA onda
 *   `endMs`      instante da última amostra
 */
function sonarSweep(def) {
  const expand = def.expandMs || 1600;
  const radius = def.radius   || 90;
  const band   = def.band     || 20;
  const steps  = Math.max(1, Math.ceil(radius / Math.max(band, 1)));
  const stepMs = Math.max(60, Math.round((expand * band) / Math.max(radius, 1)));
  const fronts = [];
  // O `min` só existe para configurações em que a última faixa transbordaria o
  // raio (`radius` não múltiplo de `band` com sobra abaixo de meia faixa). Com
  // os dados de hoje — 260/30 e 95/11 — ele nunca entra.
  for (let k = 0; k < steps; k++) fronts.push(Math.min(band * (k + 0.5), radius));
  return {
    steps,
    stepMs,
    fronts,
    timeAt: (k) => stepMs * (k + 0.5),
    endMs:  stepMs * (steps - 0.5),
  };
}

module.exports = { sonarSweep };
