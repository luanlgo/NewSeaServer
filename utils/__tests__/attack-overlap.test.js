/**
 * Um golpe de cada vez — o bicho não pode abrir uma skill por cima de outra
 * que ainda está acontecendo.
 *
 * O guard `npc._currentCast` só cobre o CAST; ele é liberado no fim do
 * `castTime`. O que segura o bicho depois disso é `npc._nextAttackTime`, e ele
 * somava apenas o laço de `ticks`. Duas skills não têm `ticks` nenhum e mesmo
 * assim seguem resolvendo por segundos:
 *
 *   • Orbe Caçadora — voa e corrói por `lifeMs` (4 s);
 *   • Descarga em Cadeia — anuncia um elo por vez, `jumpCastMs` entre eles.
 *
 * As duas ficavam com ocupação ZERO e o bicho abria outra skill no meio delas,
 * que é a poluição visual reportada. Estes testes travam a conta de ocupação
 * e o comportamento no caminho real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AttackManager = require('../../managers/attack-manager.js');
const { ATTACK_DEFS } = require('../../constants/index.js');
const { CHAIN_ID } = require('./chain-fixture.js');

const MAP = 1;
/** Pausa aleatória entre ataques que o manager sempre soma (800–2200 ms). */
const PAUSA_MIN = 800;

function fazerNpc(attackId) {
  return {
    id: 'npc1', x: 0, z: 0, dead: false,
    hp: 1000, maxHp: 1000, cannonDmg: 100, dmgMult: 1,
    attacks: [attackId], _attackCooldowns: {},
  };
}

const fazerJogador = () => ({
  id: 'p1', x: 0, z: 30, dead: false, hp: 100000, maxHp: 100000, mapLevel: MAP,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('busyMs — quanto o golpe ocupa o bicho depois do cast', () => {
  it('golpe único não ocupa nada além do cast', () => {
    expect(AttackManager.busyMs(ATTACK_DEFS.crab_claw_slam)).toBe(0);
  });

  it('canalizada ocupa a janela do 1º ao ÚLTIMO tick', () => {
    const d = ATTACK_DEFS.crab_putrid_spray;
    expect(AttackManager.busyMs(d))
      .toBe((d.ticks.count - 1) * d.ticks.intervalMs);
  });

  it('Orbe Caçadora ocupa a vida inteira da orbe', () => {
    const d = ATTACK_DEFS.drake_hunter_orb;
    expect(d.ticks).toBeUndefined();          // não tem ticks: a armadilha
    expect(AttackManager.busyMs(d)).toBe(d.lifeMs);
  });

  // A cadeia ficou sem dono quando o Rastilho convergiu (2026-09-05) — nenhuma
  // skill do jogo usa `shape: 'chain'` hoje. O def sintético do chain-fixture
  // mantém a geometria coberta em vez de deixar o motor apodrecer calado.
  it('Cadeia ocupa até o último elo', () => {
    const d = ATTACK_DEFS[CHAIN_ID];
    expect(d.ticks).toBeUndefined();
    expect(AttackManager.busyMs(d)).toBe((d.count - 1) * d.jumpCastMs);
  });

  it('nenhum ataque do bestiário fica com ocupação negativa ou NaN', () => {
    for (const [id, d] of Object.entries(ATTACK_DEFS)) {
      const b = AttackManager.busyMs(d);
      expect(Number.isFinite(b), `${id} devolveu ${b}`).toBe(true);
      expect(b, id).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('no caminho real, o bicho fica ocupado enquanto a skill acontece', () => {
  for (const [id, quanto] of [
    ['drake_hunter_orb', d => d.lifeMs],
    [CHAIN_ID,  d => (d.count - 1) * d.jumpCastMs],
    // Uma canalizada comum, para cobrir o caso do laço de `ticks` puro. Era o
    // Campo Estático até ele convergir para o Voltáico, que passou a resolver
    // numa leva só (a carga única é a identidade da skill, não uma poça).
    ['wyrm_boss_maw_vortex', d => (d.ticks.count - 1) * d.ticks.intervalMs],
  ]) {
    it(`${id}: _nextAttackTime cobre a skill inteira`, () => {
      const def = ATTACK_DEFS[id];
      const npc = fazerNpc(id);
      const jogador = fazerJogador();
      const am = new AttackManager(() => {}, null);

      const t0 = Date.now();
      am.tryAttack(npc, jogador, [jogador], MAP);
      // Avança só o cast: é aqui que `_currentCast` é liberado e o bicho
      // voltaria a poder atacar se a conta estivesse errada.
      vi.advanceTimersByTime(def.castTime);

      expect(npc._currentCast, 'o cast termina no castTime').toBeNull();
      const ocupado = npc._nextAttackTime - (t0 + def.castTime);
      expect(ocupado).toBeGreaterThanOrEqual(quanto(def) + PAUSA_MIN);
    });
  }
});

describe('a segunda skill não entra por cima da primeira', () => {
  it('Orbe: o bicho não abre outro cast enquanto a orbe voa', () => {
    const def = ATTACK_DEFS.drake_hunter_orb;
    const npc = fazerNpc('drake_hunter_orb');
    const jogador = fazerJogador();

    const telegraphs = [];
    const am = new AttackManager(
      (e) => { if (e.type === 'npc_telegraph') telegraphs.push(e); }, null);

    // Só a orbe no repertório: a escolha é ALEATÓRIA entre os disponíveis, e
    // deixar dois desde o início fazia o primeiro cast ser o outro ataque.
    am.tryAttack(npc, jogador, [jogador], MAP);
    vi.advanceTimersByTime(def.castTime);
    // Agora sim entra um segundo ataque, pronto e sem cooldown: se houvesse
    // brecha, ele apareceria. (A pinçada alcança 80; o jogador está a 30.)
    npc.attacks = ['drake_hunter_orb', 'crab_claw_slam'];

    // Enquanto a orbe existe, toda tentativa de atacar tem de ser recusada.
    const passos = Math.floor(def.lifeMs / 200);
    for (let i = 0; i < passos; i++) {
      vi.advanceTimersByTime(200);
      am.tryAttack(npc, jogador, [jogador], MAP);
    }

    const novos = telegraphs.filter(t => t.attackId !== 'drake_hunter_orb');
    expect(novos, 'nenhuma skill nova durante o voo da orbe').toHaveLength(0);
  });

  it('Cadeia: nenhum cast novo antes do último elo', () => {
    const def = ATTACK_DEFS[CHAIN_ID];
    const npc = fazerNpc(CHAIN_ID);
    const jogador = fazerJogador();

    const telegraphs = [];
    const am = new AttackManager(
      (e) => { if (e.type === 'npc_telegraph') telegraphs.push(e); }, null);

    am.tryAttack(npc, jogador, [jogador], MAP);
    vi.advanceTimersByTime(def.castTime);
    npc.attacks = [CHAIN_ID, 'crab_claw_slam'];

    const elos = (def.count - 1) * def.jumpCastMs;
    for (let t = 0; t < elos; t += 100) {
      vi.advanceTimersByTime(100);
      am.tryAttack(npc, jogador, [jogador], MAP);
    }

    // Os avisos de elo são do PRÓPRIO ataque (mesmo attackId) — o que não pode
    // aparecer é um attackId diferente.
    const novos = telegraphs.filter(t => t.attackId !== CHAIN_ID);
    expect(novos, 'nenhuma skill nova no meio da cadeia').toHaveLength(0);
  });
});
