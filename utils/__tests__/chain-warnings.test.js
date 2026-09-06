/**
 * Descarga em Cadeia — TODO elo tem aviso próprio antes de bater.
 *
 * Relato do jogador: "só tem cast no primeiro uso, depois disso recebo dano do
 * raio sem chance de desvio". O servidor de fato anuncia cada salto — mas o
 * aviso ia com `vfx: 'drake_chain_arc'`, e o cliente lê `vfx` como "toca a
 * skill inteira", não como "desenhe um círculo aqui". Resultado: a animação da
 * cadeia era reproduzida de novo e o CÍRCULO de aviso nunca aparecia.
 *
 * Estes testes travam o contrato do sub-evento: círculo, sem `vfx`, com janela
 * de esquiva de verdade — que é o que o cliente precisa para desenhar a
 * marcação genérica.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AttackManager = require('../../managers/attack-manager.js');
const { ATTACK_DEFS } = require('../../constants/index.js');

const MAP = 1;
// A cadeia ficou sem dono quando o Rastilho convergiu (2026-09-05) — nenhuma
// skill do jogo usa `shape: 'chain'` hoje. O def sintético do chain-fixture
// mantém a geometria coberta em vez de deixar o motor apodrecer calado.
const { CHAIN_ID, CHAIN_DEF: DEF } = require('./chain-fixture.js');

function fazerNpc() {
  return {
    id: 'npc1', x: 0, z: 0, dead: false,
    hp: 1000, maxHp: 1000, cannonDmg: 100, dmgMult: 1,
    attacks: [CHAIN_ID], _attackCooldowns: {},
  };
}

/** Fila de alvos em linha, cada um dentro do `jumpRange` do anterior. */
function fazerAlvos(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `p${i}`, x: 0, z: 40 + i * (DEF.jumpRange - 10),
      dead: false, hp: 100000, maxHp: 100000, mapLevel: MAP,
    });
  }
  return out;
}

/** Roda o ataque inteiro e devolve os eventos na ordem. */
function atacar(jogadores) {
  const eventos = [];
  const am = new AttackManager((e) => eventos.push(e), null);
  am.tryAttack(fazerNpc(), jogadores[0], jogadores, MAP);
  vi.runAllTimers();
  return eventos;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('cada salto é anunciado antes de bater', () => {
  it('com 4 alvos enfileirados, saem 3 avisos de elo', () => {
    const eventos = atacar(fazerAlvos(4));
    const avisos = eventos.filter(e => e.type === 'npc_telegraph' && e.chainLink != null);
    // O 1º elo é anunciado pelo telegraph do CAST; os 3 saltos seguintes têm
    // cada um o seu.
    expect(avisos).toHaveLength(DEF.count - 1);
    expect(avisos.map(a => a.chainLink)).toEqual([1, 2, 3]);
  });

  it('a cadeia para onde não há mais ninguém por perto', () => {
    const eventos = atacar(fazerAlvos(2));
    const avisos = eventos.filter(e => e.type === 'npc_telegraph' && e.chainLink != null);
    expect(avisos).toHaveLength(1);
  });
});

describe('o aviso de elo é um CÍRCULO genérico, não a skill inteira', () => {
  const avisos = () =>
    atacar(fazerAlvos(4)).filter(e => e.type === 'npc_telegraph' && e.chainLink != null);

  it('sem `vfx`: mandar a pasta da skill faz o cliente reproduzir a animação toda', () => {
    for (const a of avisos()) {
      expect(a.vfx, `elo ${a.chainLink} não pode carregar vfx`).toBeNull();
    }
  });

  it('shape circle e raio = raio de dano do elo', () => {
    for (const a of avisos()) {
      expect(a.shape).toBe('circle');
      expect(a.radius).toBe(DEF.radius);
    }
  });

  it('janela de esquiva real antes de o elo bater', () => {
    for (const a of avisos()) {
      expect(a.duration).toBe(DEF.jumpCastMs);
      expect(a.duration).toBeGreaterThan(0);
    }
  });

  it('o aviso aponta o ALVO do próximo elo, não o bicho', () => {
    const alvos = fazerAlvos(4);
    const eventos = atacar(alvos);
    const avisos2 = eventos.filter(e => e.type === 'npc_telegraph' && e.chainLink != null);
    for (const a of avisos2) {
      const bate = alvos.some(p => Math.hypot(p.x - a.x, p.z - a.z) < 0.001);
      expect(bate, `elo ${a.chainLink} anunciado em (${a.x},${a.z})`).toBe(true);
    }
  });
});

describe('quem sai do círculo anunciado escapa', () => {
  it('o elo só machuca quem está dentro do raio no momento em que bate', () => {
    const alvos = fazerAlvos(2);
    const eventos = [];
    const am = new AttackManager((e) => eventos.push(e), null);
    am.tryAttack(fazerNpc(), alvos[0], alvos, MAP);

    // Deixa o cast resolver o 1º elo e anunciar o 2º.
    vi.advanceTimersByTime(DEF.castTime + 1);
    const aviso = eventos.find(e => e.type === 'npc_telegraph' && e.chainLink === 1);
    expect(aviso, 'o 2º elo tem de ter sido anunciado').toBeTruthy();

    // O alvo do 2º elo foge para bem longe do ponto anunciado.
    alvos[1].x = aviso.x + DEF.radius * 10;
    vi.runAllTimers();

    const levou = eventos
      .filter(e => e.type === 'npc_attack_hit')
      .flatMap(e => e.hits || [])
      .some(h => h.id === alvos[1].id);
    expect(levou, 'quem saiu do círculo não pode levar').toBe(false);
  });
});
