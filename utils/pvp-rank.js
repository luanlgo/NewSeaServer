/**
 * Patente do ranking PVP — a medalha que o jogador usa ao lado do globo de vida.
 *
 * A posição no ranking de `pvp_kills` vira uma das SETE faixas de patente. As
 * faixas não são lineares de propósito: o topo é nominal (1º, 2º e 3º têm cada
 * um a sua) e a base é larga, porque o que interessa é a distância até o topo,
 * não a diferença entre o 40º e o 41º.
 *
 * A conversão mora aqui, e não nos dois lados, porque o cliente NÃO recalcula:
 * o servidor manda a faixa pronta em `pvp_rank`. Uma tabela dessas duplicada no
 * Godot seria a quarta cópia de catálogo do projeto a divergir em silêncio
 * depois de um rebalanceamento.
 *
 * Faixa 0 = sem medalha. É o caso de quem está fora do top 50 e também de quem
 * nunca matou ninguém — o ranking de PVP filtra `pvp_kills > 0`, então esses
 * sequer entram na lista.
 */

// [faixa, última posição que ainda pertence a ela]
const FAIXAS = [
  [1,  1],   // o campeão
  [2,  2],
  [3,  3],
  [4,  5],
  [5, 10],
  [6, 25],
  [7, 50],
];

const SEM_MEDALHA = 0;
const ULTIMA_POSICAO = FAIXAS[FAIXAS.length - 1][1];

/**
 * Faixa de patente (1–7) de uma posição do ranking; 0 se não há medalha.
 * `rank` é 1-based, como o que o painel de ranking mostra.
 */
function tierOfRank(rank) {
  const r = Number(rank);
  if (!Number.isFinite(r) || r < 1) return SEM_MEDALHA;
  for (const [faixa, ate] of FAIXAS) {
    if (r <= ate) return faixa;
  }
  return SEM_MEDALHA;
}

/**
 * Posição de um jogador na lista de ranking já ordenada (1-based), ou 0 se ele
 * não está nela. A lista é a que `db.getRankings().pvp_kills` devolve.
 */
function rankInList(list, name) {
  if (!Array.isArray(list) || !name) return 0;
  const i = list.findIndex(e => e && e.name === name);
  return i >= 0 ? i + 1 : 0;
}

module.exports = { tierOfRank, rankInList, FAIXAS, ULTIMA_POSICAO, SEM_MEDALHA };
