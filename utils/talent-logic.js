// utils/talent-logic.js
// Lógica pura de talentos — sem I/O, sem WebSocket, sem DB.
// Importada por server.js (via wrappers) e pelos testes.

'use strict';

/**
 * XP mínimo para a n-ésima compra de talento (0-indexed).
 * Fórmula: floor(xpBase * xpGrowth^totalSpent)
 */
function calcXpRequired(totalSpent, xpBase, xpGrowth) {
  return Math.floor(xpBase * Math.pow(xpGrowth, totalSpent));
}

/**
 * Retorna o tier de custo ativo para `totalSpent` compras realizadas.
 * Se totalSpent ultrapassar todos os tiers, retorna o último.
 */
function getCostTier(totalSpent, costTiers) {
  for (const tier of costTiers) {
    if (totalSpent < tier.upTo) return tier;
  }
  return costTiers[costTiers.length - 1];
}

/**
 * Aplica os bônus de talento no objeto player.
 * Modifica as propriedades talentDefenseBonus, talentCannonBonus, etc.
 */
function applyTalentBonuses(player, talentDefs) {
  const t = player.talents || {};
  player.talentDefenseBonus = (t.defesa      || 0) * (talentDefs.defesa?.perLevel      || 300) / 10000;
  player.talentCannonBonus  = (t.canhoes     || 0) * (talentDefs.canhoes?.perLevel     || 2);
  player.talentDamageBonus  = (t.dano        || 0) * (talentDefs.dano?.perLevel        || 2)   / 100;
  player.talentRelicBonus   = (t.dano_relic  || 0) * (talentDefs.dano_relic?.perLevel  || 3)   / 100;
  player.talentGoldBonus    = (t.riqueza     || 0) * (talentDefs.riqueza?.perLevel     || 3)   / 100;
  player.talentDobraoBonus  = (t.ganancioso  || 0) * (talentDefs.ganancioso?.perLevel  || 3)   / 100;
  player.talentXpBonus      = (t.mestre      || 0) * (talentDefs.mestre?.perLevel      || 5)   / 100;
}

/**
 * Recalcula player.maxHp levando em conta navio, skill vida, talento HP e upgrades da ilha.
 */
function recalcMaxHp(player, shipDefs, talentDefs) {
  const shipDef    = shipDefs[player.activeShip] || shipDefs.fragata;
  const skillHpPct = player.skills?.vida ? (player.skills.vida.level - 1) / 100 : 0;
  const talentFlat = (player.talents?.hp || 0) * (talentDefs.hp?.perLevel || 500);
  const hpLevel    = player.shipIslandUpgrades?.hp ?? 0;
  const islandHp   = hpLevel * 1000;
  player.maxHp = Math.floor(shipDef.hp * (1 + skillHpPct)) + talentFlat + islandHp;
}

/**
 * Valida uma compra de talento.
 * Retorna uma string de erro, ou null se a compra é válida.
 * Não faz nenhum I/O — apenas lê o estado do player e retorna.
 */
function validateBuyTalent(player, talentId, { talentDefs, costTiers, xpBase, xpGrowth }) {
  const tDef = talentDefs[talentId];
  if (!tDef) return 'Talento inválido.';

  const talents    = player.talents || {};
  const curLevel   = talents[talentId]    || 0;
  const totalSpent = talents.totalSpent   || 0;

  if (curLevel >= tDef.max) return `${tDef.name} já está no nível máximo!`;

  const xpReq = calcXpRequired(totalSpent, xpBase, xpGrowth);
  if ((player.mapXp || 0) < xpReq) {
    return `XP insuficiente! Necessário: ${xpReq.toLocaleString()} XP de mapa`;
  }

  // Ponto gratuito (de reset) tem prioridade — sem cheque de moeda
  if ((player.talentPoints || 0) > 0) return null;

  const tier = getCostTier(totalSpent, costTiers);
  if (tier.currency === 'gold' && (player.gold || 0) < tier.cost) {
    return `Ouro insuficiente! Necessário: ${tier.cost}`;
  }
  if (tier.currency === 'dobrao' && (player.dobroes || 0) < tier.cost) {
    return `Dobrões insuficientes! Necessário: ${tier.cost}`;
  }

  return null; // sem erro
}

module.exports = { calcXpRequired, getCostTier, applyTalentBonuses, recalcMaxHp, validateBuyTalent };
