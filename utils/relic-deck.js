// utils/relic-deck.js — o deck de relíquias é POSICIONAL, não uma fila.
//
// O índice É a tecla: 0=Q, 1=E, 2=R, 3=botão direito. Buraco no meio é um estado
// legítimo — dá para andar só com a do E, e nada deve escorregar para preencher.
//
// Isso aqui existe porque o deck era tratado como lista densa: equipar fazia
// `splice(pos, 0, id)` (INSERE e empurra o resto uma casa para o lado) e
// desequipar fazia `splice(pos, 1)` (puxa todas de volta). O jogador arrastava
// uma relíquia para o primeiro slot e via as teclas das outras mudarem sozinhas.
//
// Funções puras de propósito: o handler do server.js só valida posse e persiste.
'use strict';

/** Deck com exatamente `max` posições, `null` no vazio. Aceita lixo/undefined. */
function normalizeDeck(deck, max) {
  const out = new Array(Math.max(0, max | 0)).fill(null);
  const src = Array.isArray(deck) ? deck : [];
  for (let i = 0; i < out.length && i < src.length; i++) out[i] = src[i] || null;
  return out;
}

/** Índice da primeira tecla livre, ou -1 se o deck está cheio. */
function firstFreeSlot(deck, max) {
  return normalizeDeck(deck, max).findIndex(x => !x);
}

/**
 * Põe `instanceId` na tecla `pos`.
 *   • já equipada noutra tecla → MOVE (nunca duplica);
 *   • destino ocupado e origem conhecida → TROCA as duas;
 *   • destino ocupado vindo do inventário → a de lá sai do deck.
 * Devolve um deck novo (não mexe no que recebeu).
 */
function equipAt(deck, max, instanceId, pos) {
  const out = normalizeDeck(deck, max);
  if (!instanceId || pos == null || pos < 0 || pos >= out.length) return out;
  const prev = out.indexOf(instanceId);
  if (prev !== -1) out[prev] = null;
  const ocupante = out[pos];
  out[pos] = instanceId;
  if (ocupante && ocupante !== instanceId && prev !== -1) out[prev] = ocupante;
  return out;
}

/** Esvazia A TECLA `pos` — as outras não se mexem. */
function unequipAt(deck, max, pos) {
  const out = normalizeDeck(deck, max);
  if (pos == null || pos < 0 || pos >= out.length) return out;
  out[pos] = null;
  return out;
}

module.exports = { normalizeDeck, firstFreeSlot, equipAt, unequipAt };
