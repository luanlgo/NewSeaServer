// utils/talent-logic.js
// Lógica pura de talentos — sem I/O, sem WebSocket, sem DB.
// Importada por server.js (via wrappers) e pelos testes.

'use strict';

/**
 * XP mínimo para a n-ésima compra de talento (0-indexed).
 *
 * A TAXA de crescimento cai pela metade a cada `band` compras, mas só até o
 * PISO: 1ª faixa +10% por compra, 2ª +5%, e da 3ª em diante fica em +2,5% para
 * sempre.
 *
 * O piso é o ponto todo. Sem ele a taxa continuava caindo (1,25%, 0,625%…) e a
 * série geométrica CONVERGIA: o requisito parava de crescer em ~1,16 milhão por
 * volta da compra 800 e o incremento virava zero — as últimas ~400 compras da
 * árvore não tinham gate de XP nenhum. Com a taxa travada em 2,5%, o custo
 * compõe para sempre e nunca fica de graça.
 *
 * O outro extremo também já foi testado e é pior: com a exponencial pura de
 * +10% a 40ª compra pedia 22 mil, a 80ª 1 MILHÃO e a 120ª 46 milhões — a árvore
 * virava um muro em 15% dela.
 *
 * A conta é feita por FAIXA, não nível a nível: `totalSpent` pode ser grande e
 * um laço por compra seria desperdício em algo chamado a cada abertura de UI.
 */
function calcXpRequired(totalSpent, xpBase, xpGrowth, xpCap = Infinity, band = TALENT_BAND) {
  const n = Math.max(0, Math.floor(totalSpent));
  const taxaBase = Math.max(0, xpGrowth - 1);
  let req = xpBase;
  let restante = n;
  let faixa = 0;
  while (restante > 0) {
    const k = Math.min(restante, band);
    // Depois do piso a taxa é constante, então o resto todo cabe numa potência
    // só — sem isto o laço giraria 30 vezes à toa para totalSpent grande.
    const expoente = Math.min(faixa, TALENT_XP_DECAY_FLOOR);
    if (expoente === TALENT_XP_DECAY_FLOOR) {
      req *= Math.pow(1 + taxaBase / Math.pow(2, expoente), restante);
      break;
    }
    req *= Math.pow(1 + taxaBase / Math.pow(2, expoente), k);
    restante -= k;
    faixa++;
  }
  return Math.min(Math.floor(req), xpCap);
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

// ── Retorno decrescente do talento ───────────────────────────────────────────
// A cada TALENT_BAND níveis DO MESMO TALENTO, o nível seguinte rende metade:
// 1–40 integral, 41–80 pela metade, 81–120 um quarto, e assim por diante.
//
// Por que por NÍVEL DO NÓ e não pelo total investido na árvore — tentei o total
// primeiro e está errado: com o rendimento médio caindo conforme se investe, o
// stat vira `nominal × eficiência`, e como os talentos têm `perLevel` diferentes
// entre si, comprar um talento barato quando o nominal já é grande DIMINUI o
// resultado. Medido: 1200 pontos rendiam menos que 800. Um ponto gasto não pode
// piorar o barco, então a curva não pode ser um orçamento compartilhado — ela
// tem de morar dentro de cada talento, onde nada interfere em nada.
//
// A soma geométrica converge em 2×BAND: um nó vale, no limite, 80 níveis
// "cheios". É o teto suave que substitui o número que crescia sem fim.
//
// ⚠️ Com TALENT_MAX = 10 esta curva NUNCA entra em ação — nenhum nó chega perto
// de 40. Ela só passa a valer se o teto por nó subir (ou sair). É esse o número
// a mexer, e é o mesmo que decide se "1% por nível" tem limite ou não.
const TALENT_BAND = 40;

// Índice da faixa em que o decaimento da TAXA DE XP para de cair (só o XP — o
// retorno do talento acima continua decaindo sem piso).
//
// 0 → faixa 1 (compras 1–40)   taxa cheia,  +10% por compra
// 1 → faixa 2 (compras 41–80)  metade,      +5%
// 2 → faixa 3 (81 em diante)   um quarto,   +2,5% PARA SEMPRE
//
// Sem o piso a série converge e o requisito de XP PARA de crescer por volta da
// compra 800 — o fim da árvore ficava sem gate. Este é o número a mexer se a
// progressão tardia parecer curta ou longa demais.
const TALENT_XP_DECAY_FLOOR = 2;

/**
 * Níveis EFETIVOS de UM talento no nível `level`: a 1ª faixa vale integral, a
 * 2ª metade, a 3ª um quarto, e assim por diante.
 *
 * É monotônica por construção — subir de nível sempre soma algo positivo — e
 * depende só do próprio nó, então um talento nunca mexe no valor de outro.
 */
function effectiveTalentLevels(level, band = TALENT_BAND) {
  let restante = Math.max(0, Math.floor(level));
  let mult = 1;
  let efetivo = 0;
  while (restante > 0 && mult > 1e-9) {
    const n = Math.min(restante, band);
    efetivo  += n * mult;
    restante -= n;
    mult     /= 2;
  }
  return efetivo;
}

/** Rendimento médio do nível deste talento (1.0 dentro da 1ª faixa). */
function talentEfficiency(level, band = TALENT_BAND) {
  const n = Math.max(0, Math.floor(level));
  if (n <= 0) return 1;
  return effectiveTalentLevels(n, band) / n;
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
    tal[def.stat] = (tal[def.stat] || 0) + effectiveTalentLevels(lvl) * def.perLevel;
  }
  return tal;
}

/** Total de um único stat, sem precisar do mapa inteiro. */
function sumTalentStat(player, talentDefs, statKey) {
  const levels = player.talents || {};
  let total = 0;
  for (const [id, def] of Object.entries(talentDefs)) {
    if (def.stat !== statKey) continue;
    total += effectiveTalentLevels(levels[id] || 0) * def.perLevel;
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
 *
 * `baseHpOverride` existe para os navios BÔNUS, cujo HP não vem do SHIP_DEFS.
 * Antes eles repetiam esta conta à mão em dois lugares e as cópias ficaram para
 * trás quando o Casco Reforçado passou a somar percentual: quem estava num
 * navio bônus perdia os dois talentos percentuais de vida sem aviso.
 */
function recalcMaxHp(player, shipDefs, talentDefs, baseHpOverride = null) {
  const shipDef    = baseHpOverride != null
    ? { hp: baseHpOverride }
    : (shipDefs[player.activeShip] || shipDefs.fragata);
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
  // O Casco da Irmandade (skill de guilda que somava vida máxima a todo membro)
  // foi aposentado em 2026-09-06: as skills da guilda passaram a fortalecer a
  // GUILDA, não a ficha de quem entra nela. Ver constants/guilds.js.
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
 * Devolve os pontos de talentos que SAÍRAM do jogo.
 *
 * Quando um talento é aposentado de `constants/talents.js`, o id continua no
 * `player.talents` de quem o comprou. `aggregateTalentStats` ignora ids que não
 * estão mais nas árvores, então esses pontos parariam de fazer efeito — mas
 * continuariam contando em `totalSpent`, encarecendo todas as compras
 * seguintes. O jogador pagaria para sempre por um bônus que não recebe mais.
 *
 * Aqui os pontos voltam como `talentPoints` livres (mesmo desfecho do reset) e
 * saem do `totalSpent`, para o preço da próxima compra voltar ao lugar certo.
 *
 * Idempotente: depois da primeira passada não sobra id órfão.
 *
 * @returns {number} pontos devolvidos (0 = nada a fazer)
 */
function refundRemovedTalents(player, talentDefs) {
  const talents = player.talents;
  if (!talents) return 0;

  let refund = 0;
  for (const id of Object.keys(talents)) {
    if (id === 'totalSpent') continue;
    if (talentDefs[id]) continue;
    refund += talents[id] || 0;
    delete talents[id];
  }
  if (refund <= 0) return 0;

  talents.totalSpent  = Math.max(0, (talents.totalSpent || 0) - refund);
  player.talentPoints = (player.talentPoints || 0) + refund;
  return refund;
}

/**
 * Valida uma compra de talento.
 * Retorna uma string de erro, ou null se a compra é válida.
 * Não faz nenhum I/O — apenas lê o estado do player e retorna.
 */
/**
 * Valida a DEVOLUÇÃO de um ponto (clique direito no nó).
 * Retorna string de erro, ou null se pode devolver.
 *
 * O caso interessante é o gate: tirar um ponto pode derrubar a árvore abaixo do
 * mínimo de um anel externo onde o jogador JÁ investiu. Deixar passar criaria um
 * estado que o próprio servidor recusaria montar do zero — um nó de anel 5 ativo
 * numa árvore com 99 pontos. Então bloqueia e diz qual nó está segurando.
 */
function validateRefundTalent(player, talentId, { talentDefs, ringGate = null }) {
  const tDef = talentDefs[talentId];
  if (!tDef) return 'Talento inválido.';

  const levels = player.talents || {};
  if ((levels[talentId] || 0) <= 0) return `${tDef.name} não tem ponto para devolver.`;

  if (!ringGate) return null;

  const depois = countTreeSpent(player, talentDefs, tDef.tree) - 1;
  for (const [id, def] of Object.entries(talentDefs)) {
    if (def.tree !== tDef.tree || def.ring === 0) continue;
    if ((levels[id] || 0) <= 0) continue;
    const gate = ringGate[def.ring] || 0;
    if (depois >= gate) continue;

    // O anel de `def` fecharia. Tudo bem se quem está saindo é dali para FORA —
    // é assim que se desmonta um ramo, de fora para dentro, e cada passo é
    // progresso. Bloquear também esse caso travaria o jogador de vez: parado no
    // limite exato do gate, nenhum ponto da árvore poderia mais sair, nem os do
    // próprio anel externo.
    if (tDef.ring >= def.ring) continue;

    return `Tire ${def.name} primeiro: precisa de ${gate} pontos em ${tDef.tree} e sobrariam ${depois}.`;
  }
  return null;
}

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

// ── Builds salvas (os 3 slots de árvore) ─────────────────────────────────────
// Trocar de build já era possível: resetar devolve TODOS os pontos gastos como
// `talentPoints` livres, e gastar ponto livre não custa moeda. O que faltava era
// não ter de reconstruir a árvore nó por nó — dezenas de cliques para voltar a
// uma configuração que o jogador já tinha. Por isso o slot guarda só o mapa de
// níveis: aplicar é resetar e recolocar, e o preço continua sendo zero, como no
// reset. Nada aqui abre torneira de moeda.

/** Soma dos níveis de uma build (quantos pontos ela custa). */
function buildCost(nodes) {
  let total = 0;
  for (const v of Object.values(nodes || {})) total += Math.max(0, Math.floor(Number(v) || 0));
  return total;
}

/**
 * A build pode ser aplicada a este jogador? Devolve string de erro ou null.
 *
 * Valida o estado FINAL, não o caminho: nó existe, nível dentro do máximo,
 * pontos suficientes e gate de anel satisfeito pelo próprio conteúdo da build.
 * Como `applyBuild` recoloca em ordem de anel, um estado final válido nunca
 * passa por um intermediário inválido.
 */
function validateBuild(player, nodes, { talentDefs, ringGate = null }) {
  if (!nodes || typeof nodes !== 'object') return 'Slot vazio.';

  const limpos = {};
  for (const [id, lvl] of Object.entries(nodes)) {
    const n = Math.floor(Number(lvl) || 0);
    if (n <= 0) continue;
    const def = talentDefs[id];
    // Talento que saiu do jogo desde que a build foi salva: ignora em silêncio,
    // do mesmo jeito que `refundRemovedTalents` faz com a árvore em uso.
    if (!def) continue;
    if (n > def.max) return `${def.name} não vai além do nível ${def.max}.`;
    limpos[id] = n;
  }

  const custo      = buildCost(limpos);
  const disponivel = (player.talents?.totalSpent || 0) + (player.talentPoints || 0);
  if (custo > disponivel) {
    return `Esta build pede ${custo} pontos e você tem ${disponivel}.`;
  }

  if (ringGate) {
    const gastoPorArvore = {};
    for (const [id, n] of Object.entries(limpos)) {
      const t = talentDefs[id].tree;
      gastoPorArvore[t] = (gastoPorArvore[t] || 0) + n;
    }
    for (const [id, _n] of Object.entries(limpos)) {
      const def = talentDefs[id];
      if (!def.ring) continue;
      const need = ringGate[def.ring] || 0;
      if ((gastoPorArvore[def.tree] || 0) < need) {
        return `${def.name} precisa de ${need} pontos em ${def.tree}.`;
      }
    }
  }
  return null;
}

/**
 * Zera a árvore e recoloca a build. Devolve os pontos livres que sobraram.
 * NÃO valida — chame `validateBuild` antes.
 */
function applyBuild(player, nodes, talentDefs) {
  const disponivel = (player.talents?.totalSpent || 0) + (player.talentPoints || 0);

  if (!player.talents) player.talents = { totalSpent: 0 };
  for (const key of Object.keys(talentDefs)) player.talents[key] = 0;

  // Ordem de anel: o de dentro paga o gate do de fora.
  const ids = Object.keys(nodes)
    .filter(id => talentDefs[id] && Math.floor(Number(nodes[id]) || 0) > 0)
    .sort((a, b) => (talentDefs[a].ring || 0) - (talentDefs[b].ring || 0));

  let gasto = 0;
  for (const id of ids) {
    const n = Math.min(Math.floor(Number(nodes[id])), talentDefs[id].max);
    player.talents[id] = n;
    gasto += n;
  }
  player.talents.totalSpent = gasto;
  player.talentPoints       = Math.max(0, disponivel - gasto);
  return player.talentPoints;
}

/** Fotografia da árvore em uso, pronta para guardar num slot. */
function snapshotBuild(player, talentDefs) {
  const nodes = {};
  for (const id of Object.keys(talentDefs)) {
    const n = Math.floor(Number(player.talents?.[id]) || 0);
    if (n > 0) nodes[id] = n;
  }
  return nodes;
}

module.exports = {
  calcXpRequired,
  getCostTier,
  buildCost,
  validateBuild,
  applyBuild,
  snapshotBuild,
  aggregateTalentStats,
  sumTalentStat,
  countTreeSpent,
  applyTalentBonuses,
  recalcMaxHp,
  migrateLegacyTalents,
  refundRemovedTalents,
  validateBuyTalent,
  validateRefundTalent,
  // Curva de retorno decrescente — exportada para o teste e para o gerador do
  // cliente, que precisa mostrar exatamente o número que o servidor aplica.
  TALENT_BAND,
  TALENT_XP_DECAY_FLOOR,
  effectiveTalentLevels,
  talentEfficiency,
};
