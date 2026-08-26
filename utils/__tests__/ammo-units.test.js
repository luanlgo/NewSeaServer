/**
 * As unidades da tabela de munição.
 *
 * Este arquivo existe porque DOIS campos foram preenchidos na unidade errada e
 * os dois passaram sem erro nenhum:
 *
 *  1. `stunChance: 3` — o campo é uma FRAÇÃO, comparada direto com
 *     Math.random(). Qualquer valor ≥ 1 atordoa 100% das vezes. A bala de luz
 *     ficou travando o jogador em todo acerto, e o jogo não tinha como reclamar:
 *     `Math.random() < 3` é uma expressão perfeitamente válida.
 *
 *  2. `dotTick: 2` — o campo é o INTERVALO entre tiques, em milissegundos, e
 *     recebeu o valor que era para ir na porcentagem de dano. O DoT passou a
 *     tiquetar a cada quadro e a durar `dotDur / dotTick` tiques: a queimadura
 *     de 3 segundos virou 1500 tiques.
 *
 * A defesa não é ler com atenção — é o teste. Cada asserção abaixo trava uma
 * FAIXA plausível para a unidade, então um número na escala errada não chega ao
 * jogo. Quando um valor legítimo sair da faixa, o teste é que tem de mudar, de
 * propósito e com o motivo escrito.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { AMMO_DEFS } = require('../../constants/cannons');

const MUNICOES = Object.entries(AMMO_DEFS);

describe('unidades da AMMO_DEFS', () => {
  it('stunChance é FRAÇÃO (0..1) — nunca uma porcentagem crua', () => {
    for (const [id, a] of MUNICOES) {
      const c = a.stunChance ?? 0;
      expect(c, `${id}.stunChance`).toBeGreaterThanOrEqual(0);
      // O 1 é o limite duro: acima disso o Math.random() nunca perde.
      expect(c, `${id}.stunChance (${c} atordoaria SEMPRE)`).toBeLessThanOrEqual(1);
    }
  });

  it('a bala de luz atordoa em 30% dos acertos', () => {
    expect(AMMO_DEFS.bala_luz.stunChance).toBeCloseTo(0.30, 6);
  });

  it('slow é FRAÇÃO (0..1)', () => {
    for (const [id, a] of MUNICOES) {
      expect(a.slow ?? 0, `${id}.slow`).toBeGreaterThanOrEqual(0);
      expect(a.slow ?? 0, `${id}.slow`).toBeLessThanOrEqual(1);
    }
  });

  it('dotPct é PORCENTAGEM (0..100), não fração', () => {
    for (const [id, a] of MUNICOES) {
      const p = a.dotPct ?? 0;
      expect(p, `${id}.dotPct`).toBeGreaterThanOrEqual(0);
      expect(p, `${id}.dotPct`).toBeLessThanOrEqual(100);
    }
  });

  it('dotTick é INTERVALO em ms — nunca a escala de uma porcentagem', () => {
    for (const [id, a] of MUNICOES) {
      const t = a.dotTick ?? 0;
      if (t === 0) continue;              // 0 = munição sem DoT
      // 100 ms é o tique do próprio laço do servidor: abaixo disso o DoT
      // dispara todo quadro e a duração deixa de significar segundos.
      expect(t, `${id}.dotTick (${t} ms tiquetaria a cada quadro)`).toBeGreaterThanOrEqual(100);
      expect(t, `${id}.dotTick`).toBeLessThanOrEqual(10000);
    }
  });

  it('quem tem dotPct tem tick e duração, e vice-versa', () => {
    for (const [id, a] of MUNICOES) {
      const temDot = (a.dotPct ?? 0) > 0;
      expect((a.dotTick ?? 0) > 0, `${id}: dotPct e dotTick têm de andar juntos`).toBe(temDot);
      expect((a.dotDur ?? 0) > 0, `${id}: dotPct e dotDur têm de andar juntos`).toBe(temDot);
    }
  });

  it('quem atordoa tem duração de atordoamento', () => {
    for (const [id, a] of MUNICOES) {
      if ((a.stunChance ?? 0) > 0) {
        expect(a.stunDur ?? 0, `${id}.stunDur`).toBeGreaterThan(0);
      }
    }
  });

  it('o campo antigo dotDmg não voltou por engano', () => {
    // Ele era um número FIXO de dano. Se reaparecer, o motor vai ignorá-lo em
    // silêncio (hoje ele lê dotPct) e a munição fica sem DoT nenhum.
    for (const [id, a] of MUNICOES) {
      expect(a.dotDmg, `${id}: use dotPct, não dotDmg`).toBeUndefined();
    }
  });
});

// ── O que o tique vale, na prática ───────────────────────────────────────────

describe('dano por tique como fração do golpe', () => {
  const tique = (dano, pct) => Math.max(1, Math.round(dano * pct / 100));

  it('acompanha o golpe em vez de envelhecer', () => {
    const fogo = AMMO_DEFS.bala_fogo.dotPct;
    expect(tique(100, fogo)).toBe(2);        // início de jogo
    expect(tique(50000, fogo)).toBe(1000);   // mapa 11 — o motivo da mudança
  });

  it('o sangue dói mais que o fogo por tique', () => {
    expect(AMMO_DEFS.bala_sangue.dotPct).toBeGreaterThan(AMMO_DEFS.bala_fogo.dotPct);
  });

  it('nunca vira zero contra golpe pequeno', () => {
    expect(tique(1, AMMO_DEFS.bala_fogo.dotPct)).toBe(1);
    expect(tique(0, AMMO_DEFS.bala_fogo.dotPct)).toBe(1);
  });

  it('a queimadura dura o número de tiques que a duração promete', () => {
    const a = AMMO_DEFS.bala_fogo;
    expect(a.dotDur / a.dotTick).toBe(6);    // 3 s a cada 500 ms
  });
});
