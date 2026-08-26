/**
 * O que morrer na masmorra bônus custa — e o que NÃO custa.
 *
 * O bug que originou este arquivo: a morte fazia `mapPieces[pieceId] = 0`,
 * zerando o ESTOQUE INTEIRO de peças daquele tipo. Como a entrada já tinha
 * debitado as peças exigidas, a conta saía cobrada duas vezes e ainda levava o
 * excedente junto — quem tinha 45 peças, gastava 30 para entrar e morria,
 * ficava sem nenhuma das 45.
 *
 * A regra correta é a mesma da vitória: o que se consome é a ENTRADA. A
 * diferença entre morrer e vencer está no PRÊMIO, não no bilhete.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { BONUS_DUNGEON_DEFS, WAVE_REWARD_BASE } = require('../../constants/bonus_dungeons');
const { difficultyDef } = require('../../constants/difficulty');

const MAPA = BONUS_DUNGEON_DEFS.bonus_map_1;   // Baía dos Naufragados: 30 peças
const PECA = MAPA.pieceId;

function jogador(pecas) {
  return {
    mapPieces: { [PECA]: pecas },
    bonusMapsUnlocked: [],
    mapFragments: 0,
  };
}

/** Trecho de handleEnterBonusMap: desbloqueia cobrando as peças. */
function entra(p) {
  const donas = (p.mapPieces || {})[PECA] || 0;
  if (donas < MAPA.requiredPieces) return false;
  p.mapPieces[PECA] -= MAPA.requiredPieces;
  p.bonusMapsUnlocked = [...p.bonusMapsUnlocked, MAPA.id];
  return true;
}

/** Trecho do request_respawn para mapa bônus, como está hoje. */
function morre(p) {
  p.bonusMapsUnlocked = (p.bonusMapsUnlocked || []).filter(id => id !== MAPA.id);
}

/** Trecho do sendBonusDungeonComplete que mexe em peças. */
function vence(p) {
  p.bonusMapsUnlocked = (p.bonusMapsUnlocked || []).filter(id => id !== MAPA.id);
}

// ── 1. O caso relatado ───────────────────────────────────────────────────────

describe('morrer na masmorra', () => {
  it('com 45 peças, entrar e morrer deixa as 15 que sobraram', () => {
    const p = jogador(45);
    expect(entra(p)).toBe(true);
    expect(p.mapPieces[PECA]).toBe(15);   // 45 − 30 da entrada
    morre(p);
    expect(p.mapPieces[PECA]).toBe(15);   // a morte NÃO encosta no estoque
  });

  it('a entrada é consumida — o desbloqueio sai', () => {
    const p = jogador(45);
    entra(p);
    expect(p.bonusMapsUnlocked).toContain(MAPA.id);
    morre(p);
    expect(p.bonusMapsUnlocked).not.toContain(MAPA.id);
  });

  it('quem entrou com o mínimo exato fica em zero, não em negativo', () => {
    const p = jogador(30);
    entra(p);
    morre(p);
    expect(p.mapPieces[PECA]).toBe(0);
  });

  it('morrer custa o MESMO bilhete que vencer', () => {
    const morto = jogador(45);
    entra(morto); morre(morto);

    const campeao = jogador(45);
    entra(campeao); vence(campeao);

    expect(morto.mapPieces[PECA]).toBe(campeao.mapPieces[PECA]);
    expect(morto.bonusMapsUnlocked).toEqual(campeao.bonusMapsUnlocked);
  });

  it('morrer duas vezes seguidas não cobra duas entradas', () => {
    const p = jogador(45);
    entra(p);
    morre(p);
    morre(p);   // respawn repetido não pode debitar de novo
    expect(p.mapPieces[PECA]).toBe(15);
  });
});

// ── 2. Fragmentos como recompensa ────────────────────────────────────────────

describe('fragmentos na conclusão', () => {
  it('a tabela de recompensa traz mapFragments', () => {
    expect(WAVE_REWARD_BASE.mapFragments).toBeGreaterThan(0);
  });

  it('escalam com a dificuldade, como os outros recursos', () => {
    const base = WAVE_REWARD_BASE.mapFragments;
    for (const def of [0, 2, 4].map(difficultyDef)) {
      const ganho = Math.round(base * def.rewardMult);
      expect(ganho).toBe(base * def.rewardMult);
    }
    expect(Math.round(base * difficultyDef(4).rewardMult)).toBe(base * 5);
  });

  it('o bônus de concluir vale mais que o que a corrida cata sozinha', () => {
    // 1 fragmento por barco abatido; a masmorra maior tem 40 barcos. Se o
    // bônus fosse menor que isso, concluir pagaria menos que desistir no meio.
    expect(WAVE_REWARD_BASE.mapFragments).toBeGreaterThan(40);
  });
});
