import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ── Por que este teste existe ─────────────────────────────────────────────────
// Vida máxima, slots de canhão e mana máxima derivam dos talentos, e a conta
// estava COPIADA em cinco caminhos: login, restauração e ativação de navio
// bônus, compra de talento, reset e troca de navio. Cada cópia esquecia uma
// parcela diferente, e o jogador perdia o efeito sem nenhum erro aparecer —
// trocar de navio zerava o Reservatório Arcano, os navios bônus ignoravam o
// Casco Reforçado, e comprar um talento de vida percentual não fazia nada até
// o próximo login.
//
// Nenhum teste de unidade pega isso: cada função isolada está certa; o que está
// errado é QUEM não a chama. Então a checagem é na fonte mesmo — se alguém
// escrever a conta à mão de novo, este teste acusa antes de virar bug de jogo.

const SERVER_JS = fs.readFileSync(
  path.resolve(import.meta.dirname, '..', '..', 'server.js'), 'utf8',
);

/** Linhas de código (sem comentários nem strings óbvias) que casam com o padrão. */
function linhasQueCasam(re) {
  return SERVER_JS.split(/\r?\n/)
    .map((linha, i) => ({ n: i + 1, linha }))
    .filter(({ linha }) => {
      const limpa = linha.trim();
      if (limpa.startsWith('//') || limpa.startsWith('*')) return false;
      return re.test(linha);
    });
}

describe('stats derivados de talento têm uma fonte só', () => {
  it('refreshTalentDerived existe e é o ponto único', () => {
    expect(SERVER_JS).toMatch(/function refreshTalentDerived\(/);
  });

  it('maxMana só é atribuído dentro de refreshTalentDerived', () => {
    const atribuicoes = linhasQueCasam(/player\.maxMana\s*=/);
    // A única atribuição legítima é a de dentro da função unificada; qualquer
    // outra é uma cópia que vai esquecer o fx.maxManaBonus mais cedo ou mais tarde.
    expect(
      atribuicoes.map(l => `${l.n}: ${l.linha.trim()}`),
      'maxMana atribuído fora de refreshTalentDerived',
    ).toHaveLength(1);
    expect(atribuicoes[0].linha).toMatch(/maxManaBonus/);
  });

  it('maxCannons só é atribuído dentro de refreshTalentDerived', () => {
    const atribuicoes = linhasQueCasam(/player\.maxCannons\s*=/);
    expect(
      atribuicoes.map(l => `${l.n}: ${l.linha.trim()}`),
      'maxCannons atribuído fora de refreshTalentDerived',
    ).toHaveLength(2);   // regular e navio bônus, os dois dentro da função
  });

  it('ninguém mais escreve a fórmula do maxHp à mão', () => {
    // A fórmula tem uma assinatura própria: multiplicar o HP base pelo bônus de
    // skill. Fora do talent-logic isso não pode aparecer.
    const manuais = linhasQueCasam(/player\.maxHp\s*=\s*Math\.floor\(/);
    expect(
      manuais.map(l => `${l.n}: ${l.linha.trim()}`),
      'maxHp calculado à mão — use recalcMaxHp/refreshTalentDerived',
    ).toHaveLength(0);
  });

  it('todo caminho que troca de navio passa por refreshTalentDerived', () => {
    // Um `activeShip = ` novo sem refresh logo em seguida é exatamente o bug da
    // troca de navio. Confere que cada atribuição tem a chamada por perto.
    const linhas = SERVER_JS.split(/\r?\n/);
    const trocas = [];
    linhas.forEach((linha, i) => {
      if (/player\.activeShip\s*=/.test(linha) && !linha.trim().startsWith('//')) {
        trocas.push(i);
      }
    });
    expect(trocas.length).toBeGreaterThan(0);

    // Janela larga porque no login a troca e o refresh ficam a ~40 linhas de
    // distância, com o carregamento do DB no meio. É guarda-corpo, não prova:
    // pega "trocou e nunca recalculou", não garante a ordem exata.
    for (const i of trocas) {
      const janela = linhas.slice(i, i + 60).join('\n');
      expect(
        janela,
        `activeShip trocado na linha ${i + 1} sem refreshTalentDerived logo depois`,
      ).toMatch(/refreshTalentDerived\(/);
    }
  });

  it('talent_update leva os stats derivados para o cliente', () => {
    // Recalcular no servidor e não mandar dá exatamente a mesma sensação de
    // "o talento não entrou em vigor".
    const blocos = SERVER_JS.split("type:         'talent_update'").slice(1);
    expect(blocos.length).toBe(3);   // compra, devolução (clique direito) e reset
    for (const bloco of blocos) {
      const payload = bloco.slice(0, 600);
      for (const campo of ['maxHp', 'hp', 'maxCannons', 'maxMana', 'mana']) {
        expect(payload, `talent_update sem ${campo}`).toContain(`${campo}:`);
      }
    }
  });
});
