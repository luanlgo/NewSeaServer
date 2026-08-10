/**
 * Deck de relíquias POSICIONAL.
 *
 * Reportado em playtest: arrastar uma relíquia para o primeiro slot EMPURRAVA as
 * outras, como fila. A causa era `splice(pos, 0, id)` no equipar e
 * `splice(pos, 1)` no desequipar — as duas operações de LISTA, quando o deck é
 * um chaveiro: índice 0 é o Q, 1 é o E, 2 é o R, 3 é o botão direito, e um
 * buraco no meio é um estado legítimo (dá para andar só com a do E).
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { normalizeDeck, firstFreeSlot, equipAt, unequipAt } = require('../relic-deck.js');

const MAX = 4;

describe('normalizeDeck', () => {
  it('sempre devolve o chaveiro inteiro, com null no vazio', () => {
    expect(normalizeDeck(['a'], MAX)).toEqual(['a', null, null, null]);
    expect(normalizeDeck(null, MAX)).toEqual([null, null, null, null]);
    expect(normalizeDeck(['a', 'b', 'c', 'd', 'e'], MAX)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('preserva o BURACO (era o que o filter(Boolean) do login comia)', () => {
    expect(normalizeDeck([null, 'b', null, null], MAX)).toEqual([null, 'b', null, null]);
  });
});

describe('equipar não empurra ninguém', () => {
  it('equipar no Q com E e R ocupados deixa E e R onde estavam', () => {
    const antes = [null, 'e', 'r', null];
    expect(equipAt(antes, MAX, 'q', 0)).toEqual(['q', 'e', 'r', null]);
  });

  it('dá para equipar SÓ no E (o resto continua vazio)', () => {
    expect(equipAt([null, null, null, null], MAX, 'x', 1)).toEqual([null, 'x', null, null]);
  });

  it('mover de tecla não duplica — sai da antiga', () => {
    expect(equipAt(['a', null, null, null], MAX, 'a', 2)).toEqual([null, null, 'a', null]);
  });

  it('soltar em cima de uma equipada TROCA as duas', () => {
    expect(equipAt(['a', 'b', null, null], MAX, 'a', 1)).toEqual(['b', 'a', null, null]);
  });

  it('soltar do inventário em slot ocupado substitui', () => {
    expect(equipAt(['a', null, null, null], MAX, 'novo', 0)).toEqual(['novo', null, null, null]);
  });

  it('não escreve fora do chaveiro', () => {
    expect(equipAt([], MAX, 'a', 9)).toEqual([null, null, null, null]);
    expect(equipAt([], MAX, 'a', -1)).toEqual([null, null, null, null]);
  });

  it('não muta o deck recebido', () => {
    const antes = ['a', null, null, null];
    equipAt(antes, MAX, 'b', 1);
    expect(antes).toEqual(['a', null, null, null]);
  });
});

describe('desequipar esvazia só a tecla', () => {
  it('tirar do Q não puxa o E para o lugar dele', () => {
    expect(unequipAt(['q', 'e', 'r', null], MAX, 0)).toEqual([null, 'e', 'r', null]);
  });

  it('posição inválida não mexe em nada', () => {
    expect(unequipAt(['q', null, null, null], MAX, 7)).toEqual(['q', null, null, null]);
  });
});

describe('firstFreeSlot (auto-equipar do tutorial)', () => {
  it('acha o primeiro buraco', () => {
    expect(firstFreeSlot(['a', null, 'c', null], MAX)).toBe(1);
  });

  it('deck de nulls conta como VAZIO (era o `length === 0` que falhava)', () => {
    expect(firstFreeSlot([null, null, null, null], MAX)).toBe(0);
  });

  it('deck cheio devolve -1', () => {
    expect(firstFreeSlot(['a', 'b', 'c', 'd'], MAX)).toBe(-1);
  });
});
