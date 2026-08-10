// utils/talent-logic.js
// Lógica pura de talentos — sem I/O, sem WebSocket, sem DB.
// Importada por server.js (via wrappers) e pelos testes.

'use strict';

/**
 * XP mínimo para a n-ésima compra de talento (0-indexed).
 * Fórmula: min(floor(xpBase * xpGrowth^totalSpent), xpCap)
 * O teto evita que a exponencial exploda nos últimos pontos (1.3^40 ≈ 14,4M).
 */
function calcXpRequired(totalSpent, xpBase, xpGrowth, xpCap = Infinity) {
  return Math.min(Math.floor(xpBase * Math.pow(xpGrowth, totalSpent)), xpCap);
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
 * Soma os níveis investidos por chave de `stat`.
 *
 * São 120 talentos em 4 árvores e cada um declara um `stat` próprio, então
 * ninguém consulta talento por id: o resto do servidor lê `player.tal[stat]`.
 * O valor já sai na unidade exibida na UI (unit 'pct' → pontos percentuais),
 * quem consome é que divide por 100.
 *
 * @returns {Object<string, number>} mapa stat → total acumulado
 */
function aggregateTalentStats(player, talentDefs) {
  const levels = player.talents || {};
  const tal = {};
  for (const [id, def] of Object.entries(talentDefs)) {
    const lvl = levels[id] || 0;
    if (!lvl) continue;
    tal[def.stat] = (tal[def.stat] || 0) + lvl * def.perLevel;
  }
  return tal;
}

/** Total de um único stat, sem precisar do mapa inteiro. */
function sumTalentStat(player, talentDefs, statKey) {
  const levels = player.talents || {};
  let total = 0;
  for (const [id, def] of Object.entries(talentDefs)) {
    if (def.stat !== statKey) continue;
    total += (levels[id] || 0) * def.perLevel;
  }
  return total;
}

/**
 * Aplica os bônus de talento no objeto player.
 *
 * Preenche `player.tal` (mapa stat → total) e projeta nos campos que o resto do
 * servidor já lia antes das árvores novas (talentDamageBonus, talentGoldBonus…).
 * Os stats sem campo dedicado ainda não têm efeito — ver `wired` em
 * constants/talents.js.
 */
function applyTalentBonuses(player, talentDefs) {
  const tal = aggregateTalentStats(player, talentDefs);
  player.tal = tal;

  const pct = (k) => (tal[k] || 0) / 100;

  player.talentDefenseBonus   = pct('damage_reduction_pct');
  player.talentCannonBonus    = tal.cannon_slots || 0;
  player.talentDamageBonus    = pct('damage_pct');
  player.talentRelicBonus     = pct('relic_damage_pct');
  player.talentGoldBonus      = pct('gold_drop_pct');
  player.talentDobraoBonus    = pct('dobrao_drop_pct');
  player.talentXpBonus        = pct('xp_drop_pct');
  // Chance EXTRA de crítico de relíquia (soma à base).
  player.talentRelicCritBonus = pct('relic_crit_chance');
  // Multiplicador da regeneração de mana (1.0 = sem bônus).
  player.talentManaRegenBonus = pct('mana_regen_pct');
}

/**
 * Recalcula player.maxHp levando em conta navio, skill vida, talento HP e upgrades da ilha.
 */
function recalcMaxHp(player, shipDefs, talentDefs) {
  const shipDef    = shipDefs[player.activeShip] || shipDefs.fragata;
  const skillHpPct = player.skills?.vida ? (player.skills.vida.level - 1) / 100 : 0;
  const talentFlat = sumTalentStat(player, talentDefs, 'max_hp_flat')
                   + sumTalentStat(player, talentDefs, 'max_hp_flat_2');
  // Casco Reforçado e Coração do Abismo somam PERCENTUAL da vida base do navio
  // — não do total já somado, senão o flat do Casco de Ferro seria multiplicado
  // duas vezes e os dois talentos se potencializariam sem que o texto prometa.
  const talentPct  = (sumTalentStat(player, talentDefs, 'max_hp_pct')
                    + sumTalentStat(player, talentDefs, 'abyssal_heart_pct')) / 100;
  const hpLevel    = player.shipIslandUpgrades?.hp ?? 0;
  const islandHp   = Math.round(hpLevel * shipDef.hp * 0.05); // +5% do HP base do navio por nível
  player.maxHp = Math.floor(shipDef.hp * (1 + skillHpPct + talentPct)) + talentFlat + islandHp;
}

/**
 * Converte um player do sistema antigo (10 talentos de até 5 níveis) para as
 * árvores novas. Os valores por nível mudaram, então converter os níveis
 * desbalancearia o build: zera os ids antigos e devolve o total como pontos
 * livres, que o jogador redistribui onde quiser.
 *
 * Idempotente — depois da primeira passada não sobra id antigo para migrar.
 *
 * @returns {number} quantos pontos foram devolvidos (0 = nada a fazer)
 */
function migrateLegacyTalents(player, legacyMap) {
  const talents = player.talents;
  if (!talents) return 0;

  let refund = 0;
  let found  = false;
  for (const legacyId of Object.keys(legacyMap)) {
    if (!(legacyId in talents)) continue;
    found = true;
    refund += talents[legacyId] || 0;
    delete talents[legacyId];
  }
  if (!found) return 0;

  talents.totalSpent  = 0;
  player.talentPoints = (player.talentPoints || 0) + refund;
  return refund;
}

/**
 * Valida uma compra de talento.
 * Retorna uma string de erro, ou null se a compra é válida.
 * Não faz nenhum I/O — apenas lê o estado do player e retorna.
 */
function validateBuyTalent(player, talentId, { talentDefs, costTiers, xpBase, xpGrowth, xpCap = Infinity, ringGate = null }) {
  const tDef = talentDefs[talentId];
  if (!tDef) return 'Talento inválido.';

  const talents    = player.talents || {};
  const curLevel   = talents[talentId]    || 0;
  const totalSpent = talents.totalSpent   || 0;

  if (curLevel >= tDef.max) return `${tDef.name} já está no nível máximo!`;

  // Gate de anel: os anéis externos só abrem com pontos investidos NA MESMA
  // árvore. Sem isso um jogador novo compraria o capstone direto.
  if (ringGate && tDef.ring > 0) {
    const need = ringGate[tDef.ring] || 0;
    const spentInTree = countTreeSpent(player, talentDefs, tDef.tree);
    if (spentInTree < need) {
      return `Investe ${need} pontos em ${tDef.tree} para abrir este anel (tem ${spentInTree}).`;
    }
  }

  const xpReq = calcXpRequired(totalSpent, xpBase, xpGrowth, xpCap);
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

/** Quantos pontos o jogador investiu numa árvore específica. */
function countTreeSpent(player, talentDefs, tree) {
  const levels = player.talents || {};
  let total = 0;
  for (const [id, def] of Object.entries(talentDefs)) {
    if (def.tree !== tree) continue;
    total += levels[id] || 0;
  }
  return total;
}

module.exports = {
  calcXpRequired,
  getCostTier,
  aggregateTalentStats,
  sumTalentStat,
  countTreeSpent,
  applyTalentBonuses,
  recalcMaxHp,
  migrateLegacyTalents,
  validateBuyTalent,
};
