// utils/aura-burn.js — Aura Mortal (r10): a marca que o pulso deixa.
//
// ── Por que a aura precisava de mais do que um pulso ─────────────────────────
// Até 2026-08-22 a Aura Mortal era o lendário mais barato de entender e o mais
// decepcionante de usar: um círculo em volta do casco que tirava um pedaço de
// vida a cada 300 ms. O inimigo entrava, levava, saía — e nada tinha
// acontecido. Não havia decisão nenhuma nem de quem lança nem de quem toma, e
// era isso o "parece faltar algo".
//
// O conserto não é dano maior. É fazer o TEMPO DE EXPOSIÇÃO virar a moeda:
// cada leva acende uma PILHA de queimadura em quem está dentro, e a pilha
//
//   • continua queimando depois que o alvo sai do raio (`burnStackMs`), então
//     escapar deixa de zerar a conta — vira uma dívida que se paga correndo;
//   • deixa o alvo mais LENTO a cada pilha (`slowPerStack`, teto `slowMaxPct`),
//     e é aqui que a espiral aparece: quanto mais tempo você ficou perto, mais
//     devagar você sai, e mais tempo você fica perto.
//
// Quem está de fora continua tendo saída — sair cedo é barato. O que a aura
// cobra é a hesitação.
//
// ── Por que reaproveitar `e.dots` em vez de um laço próprio ─────────────────
// O jogo já tem um sistema de dano contínuo completo (`processDots` no
// server.js): ele tica, avisa o cliente com número e barra, e resolve a MORTE
// por queimadura com recompensa, respawn e save. Uma segunda implementação
// teria de repetir tudo isso — e é exatamente o tipo de cópia que já divergiu
// no Escudo de Ouro. A pilha só reescreve a entrada de DoT que ela mesma
// plantou (marcada por `src: 'aura'`), então nunca briga com fogo de canhão.
'use strict';

/**
 * Acende (ou renova) uma pilha de queimadura em `e`, vinda da aura de `owner`.
 *
 * @param {object} e        alvo (jogador ou NPC)
 * @param {object} owner    dono da aura — vira o `ownerId` do DoT, para o abate
 *                          por queimadura creditar a quem lançou
 * @param {object} def      RELIC_DEFS.r10 (burnStackMs/burnMaxStacks/burnPct/…)
 * @param {number} salvo    dano de uma salva do lançador — a base do `burnPct`
 * @param {number} now
 * @returns {number} pilhas depois desta leva (0 = a aura não tem queimadura)
 */
function applyAuraBurn(e, owner, def, salvo, now = Date.now()) {
  const maxStacks = def.burnMaxStacks || 0;
  if (!maxStacks || !(def.burnPct > 0)) return 0;

  const dur = def.burnStackMs || 4000;
  // A contagem MORRE junto com a última pilha: sem isto, sair da aura por dez
  // segundos e voltar continuaria de onde parou, e o teto seria alcançado num
  // segundo uso qualquer.
  const marca = (e._auraBurn && e._auraBurn.until > now && e._auraBurn.ownerId === owner.id)
    ? e._auraBurn
    : { stacks: 0, until: 0, ownerId: owner.id };

  marca.stacks = Math.min(maxStacks, marca.stacks + 1);
  marca.until  = now + dur;
  e._auraBurn  = marca;

  // ── O DoT ────────────────────────────────────────────────────────────────
  // Um tique por segundo, com dano proporcional às pilhas. Substitui a entrada
  // anterior da própria aura em vez de empilhar entradas: cinco pilhas são um
  // DoT cinco vezes mais forte, não cinco DoTs correndo em paralelo (que
  // ticariam em momentos diferentes e virariam uma metralhadora de números).
  if (!e.dots) e.dots = [];
  e.dots = e.dots.filter(d => d.src !== 'aura');
  const porTique = Math.max(1, Math.round(salvo * def.burnPct * marca.stacks));
  e.dots.push({
    dmg: porTique, tick: 1000, dur, next: now + 1000,
    ownerId: owner.id, effect: 'fire', src: 'aura',
  });

  // ── O slow ───────────────────────────────────────────────────────────────
  // Mesma convenção do resto do jogo (`_applyCC`): o slow não empilha com
  // outros, vale o PIOR. Chefe leva slow normalmente — é a única forma de CC
  // que a convenção do projeto permite nele.
  if (def.slowPerStack > 0) {
    const pct = Math.min(def.slowMaxPct || 0.4, marca.stacks * def.slowPerStack);
    e.slowMult    = Math.min(e.slowMult || 1, 1 - pct);
    e.slowExpires = Math.max(e.slowExpires || 0, marca.until);
  }

  return marca.stacks;
}

module.exports = { applyAuraBurn };
