/**
 * Retorno decrescente do talento: a cada 40 níveis DO MESMO nó, o nível
 * seguinte rende metade (1–40 integral, 41–80 ½, 81–120 ¼, e por aí vai).
 *
 * Por que dentro do nó e não no total investido na árvore: a primeira versão
 * escalava pelo total, e nesse modelo o stat vira `nominal × eficiência`. Como
 * os talentos têm `perLevel` diferentes, comprar um talento barato com o
 * nominal já grande DIMINUÍA o resultado — medido, 1200 pontos rendiam menos
 * que 800. Um ponto gasto não pode piorar o barco. Dentro do nó a curva é
 * monotônica por construção e nenhum talento mexe no valor de outro; o último
 * teste daqui é justamente o que reprovou o modelo antigo.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  aggregateTalentStats, sumTalentStat,
  effectiveTalentLevels, talentEfficiency, TALENT_BAND,
} = require('../../utils/talent-logic.js');
const { TALENT_DEFS, TALENT_MAX } = require('../../constants/talents.js');

const UM_ID = Object.keys(TALENT_DEFS)[0];
const UM_DEF = TALENT_DEFS[UM_ID];

describe('a curva: metade a cada faixa', () => {
  it('dentro da 1ª faixa o nível vale integral', () => {
    for (const n of [1, 10, 39, 40]) {
      expect(talentEfficiency(n), `nível ${n}`).toBeCloseTo(1.0, 6);
      expect(effectiveTalentLevels(n)).toBeCloseTo(n, 6);
    }
  });

  it('o nível MARGINAL cai pela metade a cada faixa', () => {
    const marginal = (n) => effectiveTalentLevels(n + 1) - effectiveTalentLevels(n);
    expect(marginal(10),  '1–40').toBeCloseTo(1.0,     6);
    expect(marginal(50),  '41–80').toBeCloseTo(0.5,    6);
    expect(marginal(90),  '81–120').toBeCloseTo(0.25,  6);
    expect(marginal(130), '121–160').toBeCloseTo(0.125, 6);
  });

  it('os degraus batem com a tabela pedida', () => {
    expect(effectiveTalentLevels(40)).toBeCloseTo(40, 6);    // 40 × 1
    expect(effectiveTalentLevels(80)).toBeCloseTo(60, 6);    // + 40 × ½
    expect(effectiveTalentLevels(120)).toBeCloseTo(70, 6);   // + 40 × ¼
    expect(effectiveTalentLevels(160)).toBeCloseTo(75, 6);   // + 40 × ⅛
  });

  it('converge em 2×faixa — um nó vale no máximo 80 níveis cheios', () => {
    expect(effectiveTalentLevels(100000)).toBeLessThanOrEqual(2 * TALENT_BAND + 1e-6);
    expect(effectiveTalentLevels(4000)).toBeCloseTo(2 * TALENT_BAND, 1);
  });

  it('nunca é negativa nem estoura com entrada esquisita', () => {
    expect(talentEfficiency(0)).toBe(1);
    expect(talentEfficiency(-5)).toBe(1);
    expect(effectiveTalentLevels(0)).toBe(0);
    expect(effectiveTalentLevels(-9)).toBe(0);
  });
});

describe('a curva chega nos stats', () => {
  const comNivel = (lvl) => ({ talents: { [UM_ID]: lvl } });

  it('até 40 o stat sai igual ao nominal', () => {
    const tal = aggregateTalentStats(comNivel(40), TALENT_DEFS);
    expect(tal[UM_DEF.stat]).toBeCloseTo(40 * UM_DEF.perLevel, 6);
  });

  it('em 120 o stat vale 70 níveis, não 120', () => {
    const tal = aggregateTalentStats(comNivel(120), TALENT_DEFS);
    expect(tal[UM_DEF.stat]).toBeCloseTo(70 * UM_DEF.perLevel, 6);
  });

  it('sumTalentStat concorda com aggregateTalentStats', () => {
    const p = comNivel(95);
    const tal = aggregateTalentStats(p, TALENT_DEFS);
    expect(sumTalentStat(p, TALENT_DEFS, UM_DEF.stat)).toBeCloseTo(tal[UM_DEF.stat], 6);
  });

  it('subir de nível NUNCA reduz o stat — foi isto que reprovou o modelo antigo', () => {
    let anterior = -1;
    for (let lvl = 0; lvl <= 400; lvl += 7) {
      const tal = aggregateTalentStats(comNivel(lvl), TALENT_DEFS);
      const v = tal[UM_DEF.stat] || 0;
      expect(v, `nível ${lvl} rendeu menos que o anterior`).toBeGreaterThanOrEqual(anterior);
      anterior = v;
    }
  });

  it('um talento não mexe no valor de outro', () => {
    const soUm   = aggregateTalentStats({ talents: { [UM_ID]: 60 } }, TALENT_DEFS);
    const outros = Object.keys(TALENT_DEFS).slice(1, 30);
    const cheio  = { talents: { [UM_ID]: 60 } };
    for (const id of outros) cheio.talents[id] = 10;
    const comVizinhos = aggregateTalentStats(cheio, TALENT_DEFS);
    expect(comVizinhos[UM_DEF.stat]).toBeCloseTo(soUm[UM_DEF.stat], 6);
  });
});

describe('o teto por nó é quem decide se a curva vale hoje', () => {
  it('com TALENT_MAX abaixo da faixa, a curva fica inerte por enquanto', () => {
    // Documenta o estado atual em vez de escondê-lo: no jogo de hoje nenhum nó
    // chega a 40, então nada muda até o teto subir. Se alguém subir o
    // TALENT_MAX acima da faixa, este teste avisa que a curva entrou em ação.
    if (TALENT_MAX <= TALENT_BAND) {
      const tal = aggregateTalentStats({ talents: { [UM_ID]: TALENT_MAX } }, TALENT_DEFS);
      expect(tal[UM_DEF.stat]).toBeCloseTo(TALENT_MAX * UM_DEF.perLevel, 6);
    } else {
      const tal = aggregateTalentStats({ talents: { [UM_ID]: TALENT_MAX } }, TALENT_DEFS);
      expect(tal[UM_DEF.stat]).toBeLessThan(TALENT_MAX * UM_DEF.perLevel);
    }
  });
});
