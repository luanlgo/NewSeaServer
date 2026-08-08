// utils/star-gate.js — A regra da ⭐ num lugar só.
//
// ⭐ é o ataque forte de cada conjunto do bestiário (8 das 34 skills). No mapa 1
// isso significava um carangueijo abrindo Fúria da Maré em cima de quem acabou
// de zarpar — e, como o sorteio de drop dentro do conjunto do bicho é UNIFORME
// (a raridade não pesa ali), a relíquia forte também caía cedo demais.
//
// O gate é a LUA DE SANGUE: evento global sorteado uma vez por anoitecer, com
// `BLOOD_MOON_CHANCE` de chance, válido até o amanhecer. É de propósito raro —
// a ⭐ é para ser a lembrança de uma noite específica, não parte da rotina.
//
// Vale para o BICHO e para o DROP. O USO da relíquia pelo jogador é livre:
// quem conquistou a ⭐ usa quando quiser.
'use strict';

const worldState = require('./world-state');
const { STAR_RELIC_IDS } = require('../constants/monster_skills');

/** A relíquia pode entrar no sorteio de drop agora? */
function starDropAllowed(relicId, bloodMoon = worldState.isBloodMoon()) {
  return !STAR_RELIC_IDS.has(relicId) || bloodMoon;
}

/** O bicho pode escolher este ataque agora? (`atk.star` vem do ATTACK_DEFS) */
function starAttackAllowed(atk, bloodMoon = worldState.isBloodMoon()) {
  return !(atk && atk.star) || bloodMoon;
}

module.exports = { starDropAllowed, starAttackAllowed };
