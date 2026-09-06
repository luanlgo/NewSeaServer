/**
 * Faixas de patente do ranking PVP (utils/pvp-rank.js).
 *
 * O que este arquivo protege: as faixas são a ÚNICA fonte da medalha — o cliente
 * Godot não recalcula nada, só desenha a faixa que recebe. Uma borda errada aqui
 * (o 5º caindo na faixa 5, o 51º ganhando medalha) sai muda dos dois lados,
 * porque medalha errada e medalha certa têm exatamente a mesma cara.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { tierOfRank, rankInList, FAIXAS, ULTIMA_POSICAO } = require('../pvp-rank.js');

describe('as bordas de cada faixa', () => {
  // [posição, faixa esperada] — as duas pontas de cada intervalo pedido.
  const ESPERADO = [
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4], [5, 4],
    [6, 5], [10, 5],
    [11, 6], [25, 6],
    [26, 7], [50, 7],
  ];

  for (const [rank, faixa] of ESPERADO) {
    it(`o ${rank}º usa a medalha ${faixa}`, () => {
      expect(tierOfRank(rank)).toBe(faixa);
    });
  }

  it('não há buraco nem sobreposição entre as faixas', () => {
    for (let r = 1; r <= ULTIMA_POSICAO; r++) {
      const t = tierOfRank(r);
      expect(t, `posição ${r}`).toBeGreaterThanOrEqual(1);
      expect(t, `posição ${r}`).toBeLessThanOrEqual(FAIXAS.length);
    }
  });

  it('a faixa nunca piora quando a posição melhora', () => {
    for (let r = 2; r <= ULTIMA_POSICAO; r++) {
      expect(tierOfRank(r), `posição ${r}`).toBeGreaterThanOrEqual(tierOfRank(r - 1));
    }
  });
});

describe('quem NÃO tem medalha', () => {
  it('o 51º em diante fica sem', () => {
    expect(tierOfRank(51)).toBe(0);
    expect(tierOfRank(9999)).toBe(0);
  });

  // O ranking de PVP filtra `pvp_kills > 0`, então quem nunca abateu ninguém
  // sequer entra na lista e chega aqui como posição 0.
  it('posição 0 (fora da lista) fica sem', () => {
    expect(tierOfRank(0)).toBe(0);
  });

  it('lixo não vira medalha', () => {
    expect(tierOfRank(-3)).toBe(0);
    expect(tierOfRank(NaN)).toBe(0);
    expect(tierOfRank(undefined)).toBe(0);
    expect(tierOfRank(null)).toBe(0);
    expect(tierOfRank('primeiro')).toBe(0);
  });

  it('posição fracionária não escorrega para a faixa de cima', () => {
    expect(tierOfRank(5.5)).toBe(5);   // ainda não é 6º
  });
});

describe('posição dentro da lista de ranking', () => {
  const LISTA = [
    { name: 'Barba Negra', value: 90 },
    { name: 'Anne',        value: 40 },
    { name: 'adm',         value: 1  },
  ];

  it('devolve a posição 1-based', () => {
    expect(rankInList(LISTA, 'Barba Negra')).toBe(1);
    expect(rankInList(LISTA, 'adm')).toBe(3);
  });

  it('quem não está na lista dá 0, e 0 não tem medalha', () => {
    expect(rankInList(LISTA, 'Ninguém')).toBe(0);
    expect(tierOfRank(rankInList(LISTA, 'Ninguém'))).toBe(0);
  });

  // O nome vem do MySQL, que casa SEM caixa — mas a lista e o `player.name` saem
  // os dois do mesmo campo, então a comparação aqui é exata de propósito. O
  // teste existe para deixar isso escrito: se um dia o ranking passar a
  // normalizar o nome, esta expectativa é a que quebra primeiro.
  it('a comparação de nome é exata', () => {
    expect(rankInList(LISTA, 'anne')).toBe(0);
  });

  it('lista vazia ou ausente não explode', () => {
    expect(rankInList([], 'adm')).toBe(0);
    expect(rankInList(null, 'adm')).toBe(0);
    expect(rankInList(LISTA, '')).toBe(0);
  });
});
