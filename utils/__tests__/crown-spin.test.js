/**
 * Coroa de Espinhos — o dano tem de girar JUNTO com o desenho.
 *
 * A coroa gira durante a salva inteira (o desenho roda a `spinSpeed` do começo
 * ao fim). O caminho do BICHO congelava o ângulo em `castTime`: o dano ficava
 * parado na posição da 1ª leva enquanto a coroa desenhada continuava rodando.
 *
 * Com raios de 22° em intervalos de 60°, bastavam ~4 levas para o dano cair
 * exatamente na BRECHA que o jogador estava usando — a leitura da skill ("existe
 * brecha entre eles, acompanhe o giro") virava armadilha.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AttackManager = require('../../managers/attack-manager.js');
const M = require('../../managers/monster-skill-manager.js');
const { ATTACK_DEFS } = require('../../constants/index.js');

const DEF = ATTACK_DEFS.wyrm_boss_spine_crown;
const am = new AttackManager(() => {}, null);

/** Onde o DESENHO põe o centro do raio `i` na leva `k` (rad). */
function centroDesenhado(i, k, mira) {
  const t = (DEF.castTime + k * DEF.ticks.intervalMs) / 1000;
  return mira + (Math.PI * 2 * i) / DEF.rayCount + DEF.spinSpeed * t;
}

/** O bicho acerta quem está nesse ângulo, nessa leva? */
function levaDoBicho(ang, k, mira, dist = DEF.length * 0.5) {
  const cast = { x: 0, z: 0 };
  const tx = Math.cos(mira) * 100, tz = Math.sin(mira) * 100;
  const alvo = { id: 'p', x: Math.cos(ang) * dist, z: Math.sin(ang) * dist };
  return am._isHit(alvo, { ...DEF, _tickIndex: k }, tx, tz, cast);
}

describe('a skill declara a coroa', () => {
  it('tem raios, abertura e velocidade de giro', () => {
    expect(DEF.rayCount).toBeGreaterThan(1);
    expect(DEF.angle).toBeGreaterThan(0);
    expect(DEF.spinSpeed).toBeGreaterThan(0);
    // Se a abertura chegar ao intervalo, não existe brecha nenhuma.
    expect(DEF.angle).toBeLessThan(360 / DEF.rayCount);
  });
});

describe('o dano segue o giro do desenho', () => {
  const mira = 0.7;   // direção qualquer do cast

  it('em TODA leva, quem está no centro de um raio desenhado leva', () => {
    for (let k = 0; k < DEF.ticks.count; k++) {
      for (let i = 0; i < DEF.rayCount; i++) {
        const ang = centroDesenhado(i, k, mira);
        expect(levaDoBicho(ang, k, mira), `leva ${k}, raio ${i}`).toBe(true);
      }
    }
  });

  it('em TODA leva, quem está na brecha entre dois raios NÃO leva', () => {
    const meioDoVao = Math.PI / DEF.rayCount;   // meio caminho entre centros
    for (let k = 0; k < DEF.ticks.count; k++) {
      const ang = centroDesenhado(0, k, mira) + meioDoVao;
      expect(levaDoBicho(ang, k, mira), `leva ${k}`).toBe(false);
    }
  });

  it('o ângulo do dano REALMENTE muda ao longo da salva', () => {
    // Se congelasse, a mesma direção daria o mesmo resultado em toda leva.
    //
    // A leva escolhida NÃO pode ser a última por acaso: ao fim da salva a coroa
    // gira ~55°, quase o intervalo inteiro (60°), e a mesma direção volta a
    // cair DENTRO do raio seguinte. Procura-se a leva cuja rotação acumulada
    // chega mais perto de MEIO intervalo — aí sim é brecha.
    const slot = (Math.PI * 2) / DEF.rayCount;
    let melhor = 1, erro = Infinity;
    for (let k = 1; k < DEF.ticks.count; k++) {
      const girou = DEF.spinSpeed * (k * DEF.ticks.intervalMs) / 1000;
      const e = Math.abs((girou % slot) - slot / 2);
      if (e < erro) { erro = e; melhor = k; }
    }

    const ang = centroDesenhado(0, 0, mira);
    expect(levaDoBicho(ang, 0, mira), 'na 1ª leva é raio').toBe(true);
    expect(levaDoBicho(ang, melhor, mira),
      `na leva ${melhor} a coroa girou meio intervalo: virou brecha`).toBe(false);
  });

  it('fora do alcance não leva, em nenhuma leva', () => {
    for (let k = 0; k < DEF.ticks.count; k++) {
      const ang = centroDesenhado(0, k, mira);
      expect(levaDoBicho(ang, k, mira, DEF.length + 40)).toBe(false);
    }
  });
});

describe('bicho e relíquia giram igual', () => {
  it('crownSpin é a mesma conta nos dois caminhos', () => {
    const mira = 1.1;
    for (let k = 0; k < DEF.ticks.count; k += 3) {
      const t = (DEF.castTime + k * DEF.ticks.intervalMs) / 1000;
      const esperado = M.crownSpin(DEF, t, Math.cos(mira), Math.sin(mira));
      // O ramo do bicho monta o mesmo tSec a partir de `_tickIndex`.
      const stepMs = DEF.ticks.intervalMs;
      const tBicho = (DEF.castTime + k * stepMs) / 1000;
      expect(M.crownSpin(DEF, tBicho, Math.cos(mira), Math.sin(mira)))
        .toBeCloseTo(esperado, 9);
    }
  });
});
