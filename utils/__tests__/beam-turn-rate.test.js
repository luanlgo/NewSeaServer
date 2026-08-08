/**
 * Jato do Pescoço — o feixe VARRE, não gruda.
 *
 * O `follow` re-mirava INSTANTANEAMENTE a cada leva: o feixe saltava do ângulo
 * do telegraph para cima do jogador na 1ª leva e colava nele até o fim. Não
 * havia jogada possível — só tomar as 20 levas.
 *
 * Com `turnRate` (rad/s) o pescoço tem inércia: dá para sair contornando
 * enquanto a velocidade lateral do barco (~45 un/s) ganhar da do feixe, que é
 * `turnRate × distância`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AttackManager = require('../../managers/attack-manager.js');
const { ATTACK_DEFS } = require('../../constants/index.js');

const DEF = ATTACK_DEFS.leviathan_neck_beam;
const MAP = 1;

function montar() {
  const npc = { id: 'n1', x: 0, z: 0, dead: false, hp: 1e9, maxHp: 1e9,
                cannonDmg: 100, dmgMult: 1,
                attacks: ['leviathan_neck_beam'], _attackCooldowns: {} };
  const ev = [];
  const am = new AttackManager(e => ev.push(e), null);
  return { npc, ev, am };
}

const miras = (ev) => ev.filter(e => e.type === 'npc_skill_aim')
  .map(e => Math.atan2(e.dirZ, e.dirX));

/** Menor diferença angular entre dois ângulos. */
const delta = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('a skill declara o cap de giro', () => {
  it('turnRate está no dado, em rad/s', () => {
    expect(DEF.turnRate).toBeGreaterThan(0);
    expect(DEF.follow).toBe(true);
  });
});

describe('o feixe não salta para cima do jogador', () => {
  it('a 1ª mira sai da direção do CAST, não do alvo que se moveu', () => {
    const { npc, ev, am } = montar();
    // Alvo na frente (+X) no cast; depois pula para trás (-X).
    const alvo = { id: 'p1', x: 120, z: 0, dead: false,
                   hp: 1e12, maxHp: 1e12, mapLevel: MAP };
    am.tryAttack(npc, alvo, [alvo], MAP);
    alvo.x = -120;                       // salto impossível, só para medir
    vi.advanceTimersByTime(DEF.castTime + 1);

    const m = miras(ev);
    expect(m.length, 'a 1ª leva tem de ter mirado').toBeGreaterThan(0);
    const passo = DEF.turnRate * DEF.ticks.intervalMs / 1000;
    expect(delta(m[0], 0), 'girou mais que o cap numa leva só')
      .toBeLessThanOrEqual(passo + 1e-9);
  });

  it('o giro por leva NUNCA passa do cap', () => {
    const { npc, ev, am } = montar();
    const alvo = { id: 'p1', x: 120, z: 0, dead: false,
                   hp: 1e12, maxHp: 1e12, mapLevel: MAP };
    am.tryAttack(npc, alvo, [alvo], MAP);
    vi.advanceTimersByTime(DEF.castTime + 1);

    // O alvo circula o bicho o tempo todo.
    const passo = DEF.turnRate * DEF.ticks.intervalMs / 1000;
    let anterior = 0;
    for (let k = 0; k < DEF.ticks.count - 1; k++) {
      const a = (k + 1) * 0.9;                    // gira rápido de propósito
      alvo.x = Math.cos(a) * 120;
      alvo.z = Math.sin(a) * 120;
      vi.advanceTimersByTime(DEF.ticks.intervalMs);
      const m = miras(ev);
      const atual = m[m.length - 1];
      expect(delta(atual, anterior), `leva ${k}`).toBeLessThanOrEqual(passo + 1e-9);
      anterior = atual;
    }
  });
});

describe('dá para escapar contornando', () => {
  it('quem circula PERTO sai do feixe; quem fica parado leva', () => {
    // Perto: a velocidade lateral do barco ganha do giro do feixe.
    const perto = 45 / DEF.turnRate * 0.5;        // metade do ponto de empate

    const a = montar();
    const fugindo = { id: 'fug', x: perto, z: 0, dead: false,
                      hp: 1e12, maxHp: 1e12, mapLevel: MAP };
    a.am.tryAttack(a.npc, fugindo, [fugindo], MAP);
    vi.advanceTimersByTime(a.npc ? DEF.castTime + 1 : 0);
    // Contorna na velocidade do barco.
    for (let k = 0; k < DEF.ticks.count - 1; k++) {
      const ang = (45 / perto) * ((k + 1) * DEF.ticks.intervalMs / 1000);
      fugindo.x = Math.cos(ang) * perto;
      fugindo.z = Math.sin(ang) * perto;
      vi.advanceTimersByTime(DEF.ticks.intervalMs);
    }
    const levouFugindo = a.ev.filter(e => e.type === 'npc_attack_hit')
      .flatMap(e => e.hits || []).filter(h => h.id === 'fug').length;

    const b = montar();
    const parado = { id: 'par', x: perto, z: 0, dead: false,
                     hp: 1e12, maxHp: 1e12, mapLevel: MAP };
    b.am.tryAttack(b.npc, parado, [parado], MAP);
    vi.runAllTimers();
    const levouParado = b.ev.filter(e => e.type === 'npc_attack_hit')
      .flatMap(e => e.hits || []).filter(h => h.id === 'par').length;

    expect(levouParado, 'parado tem de levar as levas').toBeGreaterThan(0);
    expect(levouFugindo, 'contornando tem de levar MENOS que parado')
      .toBeLessThan(levouParado);
  });
});
