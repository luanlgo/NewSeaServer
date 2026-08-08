/**
 * Pústulas Virulentas — CERCO, não chuvisco.
 *
 * Eram 5 poças sorteadas num disco de 140: com raio 24 o acerto era quase nulo
 * e não havia decisão nenhuma para tomar. Agora as poças formam um anel FECHADO
 * e o miolo é abrigo — o inverso do morteiro. Ficar parado no centro passa a
 * ser o certo, e o problema é que o veneno CRESCE e o abrigo encolhe.
 *
 * Dois invariantes que o desenho promete e o dano tem de cumprir:
 *   1. o anel não pode ter VÃO (senão dá para sair de graça);
 *   2. o miolo tem de ser seguro no começo e sumir no fim.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const M = require('../../managers/monster-skill-manager.js');
const { ATTACK_DEFS, RELIC_DEFS } = require('../../constants/index.js');

const NPC   = ATTACK_DEFS.wyrm_pustule_burst;
const RELIC = RELIC_DEFS.r24;

const em = (x, z) => ({ x, z, id: 'p' });

/** Está dentro do veneno na leva `k`? */
function noVeneno(def, pts, x, z, k = 0) {
  const atk = { ...def, _tickIndex: k, _tickCount: def.ticks.count };
  return M.inShape(atk, 'multi', 0, 0, 0, 0, pts, em(x, z));
}

describe('as duas faces usam o anel selado', () => {
  for (const [nome, def] of [['bicho', NPC], ['relíquia', RELIC]]) {
    it(`${nome}: pattern sealed_ring`, () => {
      expect(def.pattern).toBe('sealed_ring');
    });

    it(`${nome}: count suficiente para o anel FECHAR`, () => {
      // Condição geométrica: 2·π·spread/count ≤ 2·radius.
      const minimo = (Math.PI * def.spread) / def.radius;
      expect(def.count, `precisa de ao menos ${minimo.toFixed(1)} poças`)
        .toBeGreaterThanOrEqual(Math.ceil(minimo));
    });
  }
});

describe('o anel não tem vão por onde escapar de graça', () => {
  for (const [nome, def] of [['bicho', NPC], ['relíquia', RELIC]]) {
    it(`${nome}: toda direção do anel machuca`, () => {
      const pts = M.scatter(def.count, def.spread, def);
      // Varre a circunferência do anel de grau em grau.
      for (let g = 0; g < 360; g += 1) {
        const a = (g * Math.PI) / 180;
        const x = Math.cos(a) * def.spread;
        const z = Math.sin(a) * def.spread;
        expect(noVeneno(def, pts, x, z), `vão em ${g}°`).toBe(true);
      }
    });
  }
});

describe('o miolo é abrigo — e some', () => {
  it('no começo, o centro é seguro', () => {
    const pts = M.scatter(NPC.count, NPC.spread, NPC);
    expect(noVeneno(NPC, pts, 0, 0, 0)).toBe(false);
  });

  it('quem sai atravessando o anel PAGA', () => {
    const pts = M.scatter(NPC.count, NPC.spread, NPC);
    // Caminho do centro para fora: em algum ponto tem de doer.
    let pagou = false;
    for (let d = 0; d <= NPC.spread * 2; d += 4) {
      if (noVeneno(NPC, pts, d, 0, 0)) { pagou = true; break; }
    }
    expect(pagou, 'dava para sair sem encostar no veneno').toBe(true);
  });

  it('bem longe do anel não machuca', () => {
    const pts = M.scatter(NPC.count, NPC.spread, NPC);
    const fora = NPC.spread + NPC.radius * NPC.growth + 30;
    expect(noVeneno(NPC, pts, fora, 0, NPC.ticks.count - 1)).toBe(false);
  });

  it('o abrigo ENCOLHE com o crescimento das poças', () => {
    const pts = M.scatter(NPC.count, NPC.spread, NPC);
    const borda = NPC.spread - NPC.radius - 2;   // logo dentro do abrigo inicial
    expect(noVeneno(NPC, pts, borda, 0, 0), 'na 1ª leva ainda é abrigo').toBe(false);
    expect(noVeneno(NPC, pts, borda, 0, NPC.ticks.count - 1),
      'na última leva o veneno já tomou esse ponto').toBe(true);
  });
});

describe('growth vale no DANO, não só no desenho', () => {
  it('a poça que machuca cresce junto com a pintada', () => {
    const def = { radius: 10, growth: 2.0, ticks: { count: 5 } };
    const pts = [{ x: 0, z: 0 }];
    const p = (k) => M.inShape({ ...def, _tickIndex: k, _tickCount: 5 },
      'multi', 0, 0, 0, 0, pts, em(15, 0));
    expect(p(0), 'a 15 un, fora do raio inicial de 10').toBe(false);
    expect(p(4), 'na última leva o raio chegou a 20').toBe(true);
  });

  it('sem `growth` nada muda entre as levas', () => {
    const def = { radius: 10, ticks: { count: 5 } };
    const pts = [{ x: 0, z: 0 }];
    const p = (k) => M.inShape({ ...def, _tickIndex: k, _tickCount: 5 },
      'multi', 0, 0, 0, 0, pts, em(15, 0));
    expect(p(0)).toBe(false);
    expect(p(4)).toBe(false);
  });
});

describe('alcances do Verme', () => {
  it('o Bote alcança mais que a Investida do caranguejo', () => {
    expect(ATTACK_DEFS.wyrm_maw_lunge.length)
      .toBeGreaterThan(ATTACK_DEFS.crab_burrow_rush.length);
  });

  it('`rangeMax` acompanha o `length` (senão o bicho não casta de longe)', () => {
    for (const id of ['wyrm_maw_lunge', 'wyrm_palp_snare']) {
      const d = ATTACK_DEFS[id];
      expect(d.rangeMax, `${id}: alcance maior que a distância de cast`)
        .toBeGreaterThanOrEqual(d.length);
    }
  });
});
