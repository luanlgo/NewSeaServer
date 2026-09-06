// ─────────────────────────────────────────────────────────────────────────────
// A prateleira da Loja Geral (Ilha do Comércio)
//
// O balcão é declarativo: `SHOP.gerais` é a única lista a tocar, e o handler
// `buy_general_item` cobra e credita sem caso especial por item. O que NÃO é
// óbvio nessa lista é ONDE cada item é guardado:
//
//   • consumível (comida de pet, RUN) → `player.inventory[id]`
//   • recurso de ofício (chapa, pó de ouro, pólvora) → `player[id]`, que é
//     COLUNA do jogador no banco (iron_plates, gold_dust, gunpowder)
//
// Trocar os dois não dá erro nenhum: a compra "funciona", o ouro sai, o número
// sobe — num estoque paralelo que a Mesa de Exploração e as masmorras não
// enxergam. O jogador compra dez chapas e o upgrade continua dizendo que ele
// não tem chapa nenhuma.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { SHOP } = require('../../constants/index.js');

/** Os campos que o painel do cliente lê de cada linha da prateleira. */
const CAMPOS = ['id', 'name', 'icon', 'price', 'currency'];

describe('Loja Geral — a prateleira', () => {
  it('toda linha tem o que a vitrine precisa desenhar', () => {
    expect(SHOP.gerais.length).toBeGreaterThan(0);
    for (const item of SHOP.gerais) {
      for (const campo of CAMPOS) {
        expect(item[campo], `${item.id}.${campo}`).toBeDefined();
      }
      expect(item.price).toBeGreaterThan(0);
      expect(['gold', 'dobrao']).toContain(item.currency);
    }
  });

  it('o lookup do handler cobre a prateleira inteira', () => {
    for (const item of SHOP.gerais) {
      expect(SHOP.geraisMap[item.id]).toBe(item);
    }
  });

  it('os recursos de ofício estão à venda pelo preço combinado', () => {
    // Chapa e pó viraram DOBRÃO em 09/2026 (decisão do Luang): em ouro eles
    // eram a torneira barata do sistema que a Mesa de Exploração deveria
    // alimentar. A pólvora ficou em ouro — ela é consumo de salva, não
    // material de ofício.
    const preco = {
      ironPlates: { price: 500,  currency: 'dobrao' },
      goldDust:   { price: 100,  currency: 'dobrao' },
      gunpowder:  { price: 1000, currency: 'gold'   },
    };
    for (const [id, esperado] of Object.entries(preco)) {
      const item = SHOP.geraisMap[id];
      expect(item, `${id} não está na prateleira`).toBeTruthy();
      expect(item.price, `${id}: preço`).toBe(esperado.price);
      expect(item.currency, `${id}: moeda`).toBe(esperado.currency);
    }
  });

  // O handler cobra em `player.dobroes`, mas a ficha do item diz `dobrao` — os
  // dois nomes são diferentes de propósito (um é o campo do jogador, o outro é
  // a moeda). Se a ficha ganhasse um terceiro nome, a compra sairia de graça:
  // `player['dobrao']` é undefined, `undefined || 0` é 0, e 0 >= 0 passa.
  it('a moeda de todo item é um dos dois nomes que o handler entende', () => {
    for (const item of SHOP.gerais) {
      expect(['gold', 'dobrao'], `${item.id} com moeda desconhecida`).toContain(item.currency);
    }
  });

  // O campo que decide o destino do estoque. Sem ele o recurso cairia em
  // `player.inventory` e viraria um segundo estoque invisível.
  it('recurso de ofício é marcado como recurso; consumível não é', () => {
    for (const id of ['ironPlates', 'goldDust', 'gunpowder']) {
      expect(SHOP.geraisMap[id].resource, `${id} precisa de resource: true`).toBe(true);
    }
    for (const id of ['uva', 'run']) {
      expect(SHOP.geraisMap[id].resource, `${id} não é recurso`).toBeFalsy();
    }
  });

  // O `id` do recurso é o NOME DO CAMPO do jogador — é assim que o handler
  // credita (`player[item.id]`) e é assim que a Mesa de Exploração já os
  // chamava. Um id novo aqui que não seja um campo existente credita numa
  // propriedade que ninguém lê.
  it('o id do recurso é o mesmo campo que a exploração credita', () => {
    const { EXPLORATION_REWARDS } = require('../../constants/exploration.js');
    const daExploracao = new Set(
      EXPLORATION_REWARDS.filter(l => l.type === 'resource').map(l => l.id));
    for (const item of SHOP.gerais.filter(g => g.resource)) {
      expect(daExploracao.has(item.id),
        `"${item.id}" não é um recurso conhecido da exploração`).toBe(true);
    }
  });

  // A prateleira é o contrato com o cliente: o painel não conhece item nenhum
  // pelo nome e desenha o que vier. Um id repetido silenciosamente esconderia
  // uma das duas linhas no `geraisMap`.
  it('nenhum id repetido', () => {
    const ids = SHOP.gerais.map(g => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
