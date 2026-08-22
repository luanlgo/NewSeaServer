// utils/battle-sim.js — A batalha de abordagem do espólio, em função pura.
//
// ── Por que é uma função pura ────────────────────────────────────────────────
// O relatório de batalha é PERMANENTE e o jogador pode reabri-lo meses depois.
// Se o resultado dependesse do estado do servidor no momento da leitura, dois
// jogadores olhando o mesmo relatório poderiam ver coisas diferentes. Aqui não
// há I/O, não há Date.now() e não há Math.random(): tudo que entra vem nos
// argumentos e o acaso sai de uma SEMENTE que o chamador guarda no relatório.
// Rodar `simulate` de novo com a mesma semente devolve exatamente o mesmo
// resultado — é isso que torna o relatório reconstruível.
//
// ── O modelo ─────────────────────────────────────────────────────────────────
// Inspirado nas batalhas do Tribal Wars: dois exércitos, uma razão de forças,
// e baixas que saem dessa razão em vez de uma porcentagem fixa.
//
//   1. Cada lado soma a força dos piratas (constants/pirates.js explica a conta)
//   2. As auras dos piratas presentes multiplicam a soma do PRÓPRIO lado
//   3. A sorte (±LUCK_SPREAD) desloca a razão
//   4. Quem tem a razão a favor vence
//   5. As baixas de cada lado saem da razão FINAL — quanto mais folgada a
//      vitória, menos gente o vencedor enterra
//   6. Quem morre é sorteado pirata a pirata (menos os `immortal`), com o `survival` de cada um
//      pesando o dado: o couraceiro atravessa derrotas que matam o bucaneiro
'use strict';

const {
  PIRATE_DEFS,
  POWER_HP_WEIGHT, MAX_AURA,
  LOSS_EXP, WINNER_MAX_LOSS, LOSER_MIN_LOSS, LOSER_MAX_LOSS, LUCK_SPREAD,
  DIFFICULTY_TIERS,
} = require('../constants/pirates');

// ── Gerador determinístico (mulberry32) ──────────────────────────────────────
// 32 bits de estado, sequência estável entre versões do Node — ao contrário do
// Math.random(), cuja implementação não é garantida.
function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Semente nova para uma batalha. Só o chamador toca em aleatoriedade real. */
function newSeed() {
  return (Math.random() * 0xFFFFFFFF) >>> 0;
}

function _clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// ── Força de um lado ─────────────────────────────────────────────────────────

/**
 * Soma bruta e auras de uma tripulação.
 * @param {string[]} ids  ids de pirata (repetições contam)
 * @returns {{count:number, rawOff:number, rawDef:number, auraOff:number, auraDef:number}}
 */
function _rawPower(ids) {
  let count = 0, rawOff = 0, rawDef = 0, auraOff = 0, auraDef = 0;
  for (const id of (ids || [])) {
    const d = PIRATE_DEFS[id];
    if (!d) continue;                     // id desconhecido não vira força fantasma
    count  += 1;
    rawOff += (d.atk || 0) + (d.hp || 0) * POWER_HP_WEIGHT;
    rawDef += (d.def || 0) + (d.hp || 0) * POWER_HP_WEIGHT;
    auraOff += d.aura?.off || 0;
    auraDef += d.aura?.def || 0;
  }
  return {
    count, rawOff, rawDef,
    auraOff: _clamp(auraOff, 0, MAX_AURA),
    auraDef: _clamp(auraDef, 0, MAX_AURA),
  };
}

/**
 * Passiva do Capitão Fantasma: só acende quando o lado dele está em menor
 * número. É o pirata comprado para virar a briga perdida — numa tripulação que
 * já é maior ele vale só os atributos.
 */
function _outnumberedBonus(ids, ownCount, foeCount) {
  if (ownCount >= foeCount) return 0;
  let bonus = 0;
  for (const id of (ids || [])) bonus += PIRATE_DEFS[id]?.outnumberedBonus || 0;
  return _clamp(bonus, 0, MAX_AURA);
}

/**
 * Força ofensiva do atacante e defensiva do defensor, já com auras, passivas e
 * os modificadores de talento. É a conta que alimenta tanto a estimativa de
 * dificuldade quanto a batalha de verdade.
 *
 * @param {string[]} attackerIds
 * @param {string[]} defenderIds
 * @param {{attackerOffPct?:number, defenderDefPct?:number}} [mods] frações (0,10 = +10%)
 */
function powers(attackerIds, defenderIds, mods = {}) {
  const A = _rawPower(attackerIds);
  const D = _rawPower(defenderIds);

  const aOut = _outnumberedBonus(attackerIds, A.count, D.count);
  const dOut = _outnumberedBonus(defenderIds, D.count, A.count);

  const attack  = A.rawOff * (1 + A.auraOff + aOut) * (1 + (mods.attackerOffPct || 0));
  const defense = D.rawDef * (1 + D.auraDef + dOut) * (1 + (mods.defenderDefPct || 0));

  return {
    attack, defense,
    attackerCount: A.count, defenderCount: D.count,
    // Razão de forças. Defensor sem ninguém a bordo = abordagem sem oposição:
    // Infinity aqui viraria NaN lá na frente, então vira uma vantagem enorme
    // mas finita, que o modelo de baixas sabe tratar (quase nenhuma).
    ratio: defense > 0 ? attack / defense : (attack > 0 ? 999 : 1),
  };
}

// ── Dificuldade estimada (o farol 🟢🟡🔴) ────────────────────────────────────

/** Tier de dificuldade de uma razão de forças. Sempre devolve um tier. */
function difficultyOf(ratio) {
  for (const t of DIFFICULTY_TIERS) {
    if (ratio >= t.minRatio) return t;
  }
  return DIFFICULTY_TIERS[DIFFICULTY_TIERS.length - 1];
}

/**
 * O que o jogador vê ANTES de abordar: cor, id e a razão. Nunca a composição
 * inimiga — o espólio informa o risco, não o conteúdo.
 */
function estimate(attackerIds, defenderIds, mods = {}) {
  const p = powers(attackerIds, defenderIds, mods);
  const tier = difficultyOf(p.ratio);
  return {
    difficulty:      tier.id,
    difficultyColor: tier.color,
    ratio:           Number(p.ratio.toFixed(3)),
    attackerCount:   p.attackerCount,
    defenderCount:   p.defenderCount,
  };
}

// ── Baixas ───────────────────────────────────────────────────────────────────

/**
 * Fração de baixas de cada lado a partir da vantagem de quem venceu.
 * A tabela comentada em constants/pirates.js mostra os valores.
 */
function _lossFractions(winnerAdvantage) {
  const r = Math.max(1, winnerAdvantage);
  const q = Math.pow(1 / r, LOSS_EXP);          // 1 no empate → 0 na goleada
  return {
    winner: WINNER_MAX_LOSS * q,
    loser:  LOSER_MIN_LOSS + (LOSER_MAX_LOSS - LOSER_MIN_LOSS) * (1 - q),
  };
}

/**
 * Sorteia quem morre, pirata a pirata.
 *
 * Cada um rola contra `lossFrac × survival`, então a COMPOSIÇÃO muda o número
 * de mortos e não só quem são: uma tripulação de couraceiros (survival 0,45)
 * atravessa a mesma derrota que dizima uma de bucaneiros (1,35). Uma tabela de
 * "morrem X% dos piratas" não conseguiria expressar isso.
 *
 * `immortal` sai do sorteio por completo: o Curandeiro Elite não é um pirata com
 * `survival` muito baixo, é um que NÃO MORRE. A diferença aparece justamente na
 * derrota desesperada, onde `lossFrac` chega a 0,95 e qualquer `survival` finito
 * viraria caixão. É a razão de existir dele: comprado uma vez, atravessa todas
 * as abordagens — inclusive as perdidas — e é o único investimento em tripulação
 * que o jogador nunca vê evaporar.
 *
 * `floorOne` fecha o buraco do lado DERROTADO: com uma tripulação pequena de
 * couraceiros (survival 0,45) a sequência de dados pode não matar ninguém, e um
 * relatório de derrota sem um único caixão não se explica para o jogador. Quem
 * perde enterra pelo menos um — o mais frágil da tripulação, que é o mesmo
 * critério que o sorteio usa. Mas o piso não fura a imortalidade: uma tripulação
 * só de Curandeiros Elite perde a batalha e volta inteira, e é isso mesmo.
 *
 * @returns {{dead:string[], alive:string[]}}
 */
function _rollCasualties(ids, lossFrac, rng, casualtyMult = 1, floorOne = false) {
  const dead = [];
  const alive = [];
  for (const id of (ids || [])) {
    if (PIRATE_DEFS[id]?.immortal) { alive.push(id); continue; }
    const survival = PIRATE_DEFS[id]?.survival ?? 1.0;
    const chance   = _clamp(lossFrac * survival * casualtyMult, 0, 0.99);
    if (rng() < chance) dead.push(id);
    else alive.push(id);
  }
  if (floorOne && dead.length === 0) {
    const mortais = alive
      .map((id, i) => ({ i, s: PIRATE_DEFS[id]?.survival ?? 1.0 }))
      .filter(e => !PIRATE_DEFS[alive[e.i]]?.immortal);
    if (mortais.length > 0) {
      let pior = mortais[0];
      for (const e of mortais) if (e.s > pior.s) pior = e;
      dead.push(alive.splice(pior.i, 1)[0]);
    }
  }
  return { dead, alive };
}

// ── A batalha ────────────────────────────────────────────────────────────────

/**
 * Resolve uma abordagem. Determinística: mesma entrada + mesma semente = mesmo
 * resultado, sempre.
 *
 * @param {object}   input
 * @param {string[]} input.attackerIds  piratas embarcados no atacante
 * @param {string[]} input.defenderIds  piratas que estavam no barco afundado
 * @param {number}   input.seed         semente registrada no relatório
 * @param {object}   [input.mods]       modificadores (talentos):
 *        attackerOffPct        +% na ofensiva do atacante
 *        defenderDefPct        +% na defensiva do defensor
 *        attackerCasualtyPct   −% nas baixas do atacante (0,20 = 20% menos)
 * @returns {object} resultado completo, pronto para virar relatório
 */
function simulate({ attackerIds, defenderIds, seed, mods = {} }) {
  const rng = makeRng(seed);

  const base = powers(attackerIds, defenderIds, mods);
  const tier = difficultyOf(base.ratio);

  // Sorte: ±LUCK_SPREAD sobre a razão. Sai da mesma semente, então entra no
  // relatório junto com todo o resto.
  const luck  = 1 + (rng() * 2 - 1) * LUCK_SPREAD;
  const ratio = base.ratio * luck;

  const attackerWon = ratio >= 1;
  // Vantagem de quem venceu, sempre ≥ 1 — é o eixo da tabela de baixas.
  const advantage = attackerWon ? ratio : (ratio > 0 ? 1 / ratio : 999);
  const frac = _lossFractions(advantage);

  const attackerLossFrac = attackerWon ? frac.winner : frac.loser;
  const defenderLossFrac = attackerWon ? frac.loser  : frac.winner;

  // Só o atacante tem dono online para carregar talentos de redução de baixas.
  const attackerCasualtyMult = _clamp(1 - (mods.attackerCasualtyPct || 0), 0.2, 1);

  const atk = _rollCasualties(attackerIds, attackerLossFrac, rng, attackerCasualtyMult, !attackerWon);
  const def = _rollCasualties(defenderIds, defenderLossFrac, rng, 1, attackerWon);

  return {
    seed,
    attackerWon,
    difficulty:      tier.id,
    difficultyColor: tier.color,

    attackPower:  Number(base.attack.toFixed(1)),
    defensePower: Number(base.defense.toFixed(1)),
    baseRatio:    Number(base.ratio.toFixed(3)),
    luck:         Number(luck.toFixed(3)),
    finalRatio:   Number(ratio.toFixed(3)),

    attacker: {
      used:      (attackerIds || []).slice(),
      count:     (attackerIds || []).length,
      dead:      atk.dead,
      survivors: atk.alive,
      deaths:    atk.dead.length,
      lossPct:   Number((attackerLossFrac * 100).toFixed(1)),
    },
    defender: {
      used:      (defenderIds || []).slice(),
      count:     (defenderIds || []).length,
      dead:      def.dead,
      survivors: def.alive,
      deaths:    def.dead.length,
      lossPct:   Number((defenderLossFrac * 100).toFixed(1)),
    },
  };
}

module.exports = {
  makeRng, newSeed,
  powers, difficultyOf, estimate, simulate,
};
