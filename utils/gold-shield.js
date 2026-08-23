// utils/gold-shield.js — Escudo de Ouro (r5), num lugar só.
//
// ── Por que um módulo para seis linhas de conta ──────────────────────────────
// O escudo é lido em TODO caminho por onde um jogador toma dano, e cada um vive
// num manager diferente: o tiro (projectile-manager), o ataque em área do bicho
// (attack-manager) e as 34 skills do bestiário (monster-skill-manager). Enquanto
// a conta ficou escrita à mão em cada um, aconteceu o previsível:
//
//   • dois deles traziam 30% de redução e 10% de ouro escritos no código,
//     enquanto constants/relics.js dizia 50% e 10% — os números do dado eram
//     decoração e ninguém percebia ao editá-los;
//   • o terceiro — o bestiário, que é a maior parte do dano que se toma hoje —
//     nunca teve escudo nenhum. Ligar a relíquia e continuar tomando o golpe
//     cheio de uma skill de bicho era o "não está funcionando" do playtest.
//
// Um módulo resolve os dois de uma vez: existe UMA conta, ela lê os números do
// RELIC_DEFS, e um caminho de dano novo só precisa chamar esta função.
//
// ── A conta ──────────────────────────────────────────────────────────────────
// `damageReduction` corta a fração do golpe. `goldCostPct` cobra sobre o dano
// BRUTO, não sobre o que foi bloqueado: é o que dá peso à decisão de deixar uma
// `toggle` ligada durante um combate longo — e uma toggle sem custo crescente
// não tem trava nenhuma, já que ela não entra na recarga por raridade.
'use strict';

const { RELIC_DEFS } = require('../constants/relics');

/** Fração do golpe que o escudo apara e fração do golpe cobrada em ouro. */
function goldShieldParams() {
  const def = RELIC_DEFS.r5 || {};
  return {
    reduction: def.damageReduction != null ? def.damageReduction : 0.20,
    goldPct:   def.goldCostPct    != null ? def.goldCostPct    : 0.05,
  };
}

/**
 * Aplica o escudo a UM golpe já calculado.
 *
 * Debita o ouro no alvo e devolve o dano que sobrou. Quem chama fica
 * responsável só por avisar o cliente — o evento `gold_shield_cost` é o que
 * acende a moeda na bolha, e cada manager tem o próprio jeito de mandar.
 *
 * @returns {{damage:number, blocked:number, goldCost:number}} — `blocked` e
 *          `goldCost` vêm zerados quando o escudo não estava ligado, então dá
 *          para chamar sem checar nada antes.
 */
function applyGoldShield(target, dmg) {
  if (!target || !target.relicGoldShieldActive || !(dmg > 0)) {
    return { damage: dmg, blocked: 0, goldCost: 0 };
  }
  const { reduction, goldPct } = goldShieldParams();
  const blocked  = Math.round(dmg * reduction);
  const goldCost = Math.round(dmg * goldPct);
  let cobrado = 0;
  if (goldCost > 0) {
    // Nunca deixa o ouro negativo: quem está sem nada continua protegido, e o
    // escudo simplesmente para de cobrar. Cortar a proteção junto puniria
    // exatamente quem já quebrou.
    cobrado = Math.min(goldCost, target.gold || 0);
    target.gold = Math.max(0, (target.gold || 0) - cobrado);
  }
  return { damage: Math.max(0, dmg - blocked), blocked, goldCost: cobrado };
}

module.exports = { applyGoldShield, goldShieldParams };
