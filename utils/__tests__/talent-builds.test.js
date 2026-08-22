// Builds salvas nos 3 slots de árvore.
//
// O risco desta feature não é a UI, é a ECONOMIA: aplicar uma build reseta e
// recoloca a árvore, e um erro de contagem aqui vira ponto de talento de graça.
// Estes testes seguram exatamente isso — o total de pontos antes e depois tem
// de bater sempre.
import { describe, it, expect } from 'vitest';
import { buildCost, validateBuild, applyBuild, snapshotBuild } from '../talent-logic.js';
import talents from '../../constants/talents.js';

const { TALENT_DEFS, RING_GATE } = talents;

/** Alguns ids reais para montar cenários sem chumbar nome de talento no teste. */
function idsDaArvore(tree, ring) {
  return Object.entries(TALENT_DEFS)
    .filter(([, d]) => d.tree === tree && (d.ring || 0) === ring)
    .map(([id]) => id);
}

const ARVORE = TALENT_DEFS[Object.keys(TALENT_DEFS)[0]].tree;
const ANEL0  = idsDaArvore(ARVORE, 0);
const ANEL1  = idsDaArvore(ARVORE, 1);

function jogador(nodes = {}, pontosLivres = 0) {
  const gasto = Object.values(nodes).reduce((a, b) => a + b, 0);
  return {
    talents: { ...nodes, totalSpent: gasto },
    talentPoints: pontosLivres,
  };
}

describe('buildCost', () => {
  it('soma os níveis e ignora lixo', () => {
    expect(buildCost({ a: 3, b: 2 })).toBe(5);
    expect(buildCost({ a: -1, b: 'x', c: 2 })).toBe(2);
    expect(buildCost(null)).toBe(0);
  });
});

describe('snapshotBuild', () => {
  it('fotografa só os nós com nível, sem o totalSpent', () => {
    const p = jogador({ [ANEL0[0]]: 3 });
    const snap = snapshotBuild(p, TALENT_DEFS);
    expect(snap).toEqual({ [ANEL0[0]]: 3 });
    expect(snap.totalSpent).toBeUndefined();
  });
});

describe('validateBuild', () => {
  it('aceita uma build que cabe nos pontos disponíveis', () => {
    const p = jogador({ [ANEL0[0]]: 5 });          // 5 gastos, 0 livres
    expect(validateBuild(p, { [ANEL0[1]]: 5 }, { talentDefs: TALENT_DEFS })).toBeNull();
  });

  it('recusa build mais cara que os pontos que o jogador tem', () => {
    const p = jogador({ [ANEL0[0]]: 2 });
    const erro = validateBuild(p, { [ANEL0[0]]: 9 }, { talentDefs: TALENT_DEFS });
    expect(erro).toMatch(/pontos/);
  });

  it('recusa nível acima do máximo do talento', () => {
    const id  = ANEL0[0];
    const max = TALENT_DEFS[id].max;
    const p   = jogador({}, 999);
    expect(validateBuild(p, { [id]: max + 1 }, { talentDefs: TALENT_DEFS })).toMatch(/nível/);
  });

  it('recusa nó de anel externo sem os pontos de gate na própria árvore', () => {
    const alvo = ANEL1[0];
    const p    = jogador({}, 999);
    const erro = validateBuild(p, { [alvo]: 1 }, { talentDefs: TALENT_DEFS, ringGate: RING_GATE });
    expect(erro).toMatch(/pontos em/);
  });

  it('aceita o mesmo nó quando a própria build paga o gate', () => {
    const alvo  = ANEL1[0];
    const need  = RING_GATE[1] || 0;
    const nodes = { [alvo]: 1 };
    // Enche o anel 0 da mesma árvore até cobrir o gate.
    let falta = need;
    for (const id of ANEL0) {
      if (falta <= 0) break;
      const n = Math.min(TALENT_DEFS[id].max, falta);
      nodes[id] = n;
      falta -= n;
    }
    const p = jogador({}, 999);
    expect(validateBuild(p, nodes, { talentDefs: TALENT_DEFS, ringGate: RING_GATE })).toBeNull();
  });

  it('ignora talento que não existe mais em vez de recusar a build inteira', () => {
    const p = jogador({}, 10);
    expect(validateBuild(p, { talento_que_saiu_do_jogo: 3, [ANEL0[0]]: 2 },
      { talentDefs: TALENT_DEFS })).toBeNull();
  });

  it('slot vazio não é build', () => {
    expect(validateBuild(jogador(), null, { talentDefs: TALENT_DEFS })).toMatch(/vazio/i);
  });
});

describe('applyBuild — a conta de pontos fecha', () => {
  it('troca a árvore inteira mantendo o total de pontos', () => {
    const antes = { [ANEL0[0]]: 4, [ANEL0[1]]: 3 };   // 7 gastos
    const p = jogador(antes, 2);                       // + 2 livres = 9 no total
    applyBuild(p, { [ANEL0[2]]: 5 }, TALENT_DEFS);
    expect(p.talents.totalSpent).toBe(5);
    expect(p.talentPoints).toBe(4);                    // 9 − 5
    expect(p.talents[ANEL0[0]]).toBe(0);               // o que saiu foi zerado
    expect(p.talents[ANEL0[2]]).toBe(5);
  });

  it('aplicar e voltar devolve exatamente a árvore original', () => {
    const original = { [ANEL0[0]]: 4, [ANEL0[1]]: 3 };
    const p = jogador(original, 0);
    const snap = snapshotBuild(p, TALENT_DEFS);

    applyBuild(p, { [ANEL0[2]]: 2 }, TALENT_DEFS);
    applyBuild(p, snap, TALENT_DEFS);

    expect(snapshotBuild(p, TALENT_DEFS)).toEqual(original);
    expect(p.talents.totalSpent).toBe(7);
    expect(p.talentPoints).toBe(0);
  });

  it('nunca cria ponto: total disponível é invariante', () => {
    const p = jogador({ [ANEL0[0]]: 6 }, 3);
    const disponivel = p.talents.totalSpent + p.talentPoints;
    for (const nodes of [{ [ANEL0[1]]: 9 }, {}, { [ANEL0[0]]: 1, [ANEL0[1]]: 1 }]) {
      applyBuild(p, nodes, TALENT_DEFS);
      expect(p.talents.totalSpent + p.talentPoints).toBe(disponivel);
    }
  });

  it('corta nível acima do máximo em vez de gastar a mais', () => {
    const id  = ANEL0[0];
    const max = TALENT_DEFS[id].max;
    const p   = jogador({}, 999);
    applyBuild(p, { [id]: max + 5 }, TALENT_DEFS);
    expect(p.talents[id]).toBe(max);
    expect(p.talents.totalSpent).toBe(max);
  });
});
