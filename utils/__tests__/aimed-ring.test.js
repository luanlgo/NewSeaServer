/**
 * Testes do padrão `aimed_ring` (MonsterSkillManager.scatter/aimedRing)
 *
 * O espalhamento aleatório tinha um buraco no meio: `sqrt(0.15 + …)` impede
 * qualquer sub-área de nascer a menos de 0,387×spread do centro. Como o
 * espalhamento é centrado NO ALVO, esse buraco (69,7 un no morteiro) era MAIOR
 * que o raio de dano (38) — ficar parado era matematicamente invulnerável e
 * andar era o que fazia tomar dano. O padrão novo mira a primeira sub-área no
 * alvo e fecha as outras num anel com uma brecha.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const M = require('../../managers/monster-skill-manager.js');
const { ATTACK_DEFS, RELIC_DEFS } = require('../../constants/index.js');

const dist = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);
const CENTRO = { x: 0, z: 0 };

describe('o buraco do padrão antigo (a regressão que motivou tudo)', () => {
  it('o espalhamento aleatório nunca cobre o centro', () => {
    const pts = M.scatter(6, 180);                       // sem def: padrão antigo
    const maisPerto = Math.min(...pts.map(p => dist(p, CENTRO)));
    expect(maisPerto).toBeGreaterThan(180 * Math.sqrt(0.15) - 0.001);
    expect(maisPerto).toBeGreaterThan(38);               // > raio de dano = zona franca
  });
});

describe('padrão aimed_ring', () => {
  const def = { count: 6, spread: 62, radius: 38, gapAngle: 90, pattern: 'aimed_ring' };

  it('a primeira sub-área cai EM CIMA do alvo', () => {
    for (let i = 0; i < 50; i++) {
      expect(M.scatter(def.count, def.spread, def)[0]).toEqual({ x: 0, z: 0 });
    }
  });

  it('as demais formam um anel no raio pedido', () => {
    const pts = M.scatter(def.count, def.spread, def);
    expect(pts).toHaveLength(6);
    for (const p of pts.slice(1)) {
      expect(dist(p, CENTRO)).toBeCloseTo(def.spread, 5);
    }
  });

  it('deixa UMA brecha, com a largura pedida', () => {
    const angs = M.scatter(def.count, def.spread, def)
      .slice(1).map(p => Math.atan2(p.z, p.x)).sort((a, b) => a - b);
    const vaos = angs.map((a, i) => {
      let d = angs[(i + 1) % angs.length] - a;
      if (d < 0) d += Math.PI * 2;
      return (d * 180) / Math.PI;
    }).sort((a, b) => b - a);
    expect(vaos[0]).toBeCloseTo(def.gapAngle, 0);   // a brecha
    expect(vaos[1]).toBeLessThan(def.gapAngle);     // e só ela é grande
  });

  it('a brecha muda de lugar a cada uso (não dá pra decorar o lado)', () => {
    const lados = new Set();
    for (let i = 0; i < 40; i++) {
      const pts = M.scatter(def.count, def.spread, def);
      lados.add(Math.round(Math.atan2(pts[1].z, pts[1].x) * 4));
    }
    expect(lados.size).toBeGreaterThan(5);
  });

  it('quem fica parado no centro é SEMPRE atingido', () => {
    for (let i = 0; i < 200; i++) {
      const pts = M.scatter(def.count, def.spread, def);
      expect(pts.some(p => dist(p, CENTRO) <= def.radius)).toBe(true);
    }
  });

  it('não deixa anel oco: a área do centro emenda na do anel', () => {
    // Sem a emenda existiria uma órbita segura entre o obus central e o anel.
    expect(def.spread - def.radius).toBeLessThanOrEqual(def.radius);
  });
});

describe('as duas skills do boss usam o padrão', () => {
  for (const [id, relicId] of [['crab_boss_mortar', 'r19'], ['crab_boss_tentacles', 'r20']]) {
    it(`${id}: bicho e relíquia com a MESMA regra`, () => {
      expect(ATTACK_DEFS[id].pattern).toBe('aimed_ring');
      expect(RELIC_DEFS[relicId].pattern).toBe('aimed_ring');
      expect(ATTACK_DEFS[id].gapAngle).toBe(RELIC_DEFS[relicId].gapAngle);
    });

    it(`${id}: parado no alvo leva o golpe (bicho e relíquia)`, () => {
      for (const d of [ATTACK_DEFS[id], RELIC_DEFS[relicId]]) {
        const pts = M.scatter(d.count, d.spread, d);
        expect(pts.some(p => dist(p, CENTRO) <= d.radius)).toBe(true);
      }
    });
  }
});

describe('as outras skills `multi` não foram afetadas', () => {
  // O Cemitério de Naufrágios SAIU desta lista em 2026-08-03: com spread 200 e
  // raio 30, o buraco central de 77 un deixava quem ficava parado imune com
  // 47 un de folga — o mesmo defeito do morteiro. Ver o describe abaixo.
  // As Pústulas saíram desta lista em 2026-08-03: viraram `sealed_ring` (anel
  // de veneno com abrigo no miolo — ver poison-ring.test.js). O buraco central
  // delas deixou de ser defeito e passou a ser a MECÂNICA.
  it('crânio e ninhada seguem no espalhamento aleatório', () => {
    for (const id of ['charnel_death_mark', 'charnel_brood_hatch']) {
      expect(ATTACK_DEFS[id].pattern).toBeNull();
      const pts = M.scatter(ATTACK_DEFS[id].count, ATTACK_DEFS[id].spread, ATTACK_DEFS[id]);
      expect(pts.every(p => dist(p, CENTRO) > 0)).toBe(true);   // nenhuma mirada no centro
    }
  });
});

describe('Cemitério de Naufrágios: virou CHUVA (2026-08-03)', () => {
  // Passou por aimed_ring por poucas horas e foi além: em vez de 6 quedas
  // simultâneas, cai uma por vez mirada ao vivo (ver wreck-rain.test.js).
  // Espalhamento nenhum resolve o problema de "parar é seguro" tão bem quanto
  // simplesmente mirar em quem está parado.
  it('não usa mais padrão de espalhamento — o simulador decide os pontos', () => {
    expect(ATTACK_DEFS.turtle_boss_wreck_field.pattern).toBeNull();
    expect(ATTACK_DEFS.turtle_boss_wreck_field.dropIntervalMs).toBeGreaterThan(0);
  });
});

describe('as que AINDA têm buraco central (dívida conhecida)', () => {
  // Não são bug de código, são números: quem fica parado no centro destas duas
  // continua imune. Fica aferido aqui para a decisão ser consciente, não um
  // esquecimento — mudar o padrão delas altera o caráter das skills.
  it('a ninhada deixa o centro descoberto', () => {
    for (const id of ['charnel_brood_hatch']) {
      const d = ATTACK_DEFS[id];
      const buraco = d.spread * Math.sqrt(0.15);
      expect(buraco, `${id} passou a cobrir o centro — revisar este teste`)
        .toBeGreaterThan(d.radius);
    }
  });
});
