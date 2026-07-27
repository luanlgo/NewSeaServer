// utils/world-state.js — Estado GLOBAL do mundo compartilhado entre o server.js
// e os managers.
//
// Vive num módulo próprio (e não numa referência injetada) porque os managers de
// mapa são criados sob demanda em ensureManagersForMap(): injetar em cada um
// significaria lembrar de fazê-lo em todo mapa novo, e um esquecimento daria um
// bug silencioso — o mapa esquecido simplesmente ignoraria o evento.
'use strict';

let _bloodMoonActive = false;
let _bloodMoonMult   = 1;

/** Liga/desliga a Lua de Sangue. `mult` só vale enquanto ela estiver ativa. */
function setBloodMoon(active, mult) {
  _bloodMoonActive = !!active;
  _bloodMoonMult   = _bloodMoonActive ? (mult || 1) : 1;
}

/**
 * Multiplicador do evento: 1 quando não há lua, 2 ou 3 durante a Lua de Sangue.
 * Multiplica os ATRIBUTOS de NPCs/bosses por cima da dificuldade do jogador, e
 * a RECOMPENSA pelo mesmo fator.
 */
function bloodMoonFactor() {
  return _bloodMoonActive ? _bloodMoonMult : 1;
}

function isBloodMoon() {
  return _bloodMoonActive;
}

module.exports = { setBloodMoon, bloodMoonFactor, isBloodMoon };
