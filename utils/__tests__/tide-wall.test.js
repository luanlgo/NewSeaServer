/**
 * Muralha de Maré — o dano é a onda CHEGANDO, não o cast terminando.
 *
 * Era um `line` comum: o corredor inteiro (260 un) resolvia de uma vez no fim
 * do cast. Quem estava no fim do trajeto levava enquanto a parede ainda estava
 * saindo do bicho — o desenho mostrava uma onda viajando e o dano já tinha
 * acontecido todo.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AttackManager = require('../../managers/attack-manager.js');
const { ATTACK_DEFS } = require('../../constants/index.js');

const DEF = ATTACK_DEFS.leviathan_tide_wall;

function cenario(zAlvo) {
  const npc = { id: 'n1', x: 0, z: 0, dead: false, hp: 1e9, maxHp: 1e9,
                cannonDmg: 100, dmgMult: 1,
                attacks: ['leviathan_tide_wall'], _attackCooldowns: {} };
  // A onda avança no eixo bicho→alvo; o alvo do cast define a direção (+Z).
  const alvo = { id: 'alvo', x: 0, z: zAlvo, dead: false,
                 hp: 1e12, maxHp: 1e12, mapLevel: 1 };
  const ev = [];
  const am = new AttackManager(e => ev.push(e), null);
  return { npc, alvo, ev, am };
}

const acertosDe = (ev, id) => ev.filter(e => e.type === 'npc_attack_hit')
  .flatMap(e => e.hits || []).filter(h => h.id === id).length;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('a skill é uma onda que viaja', () => {
  it('está marcada como tidewall e tem tempo de viagem', () => {
    expect(DEF.special).toBe('tidewall');
    expect(DEF.travelMs).toBeGreaterThan(0);
    expect(DEF.band).toBeGreaterThan(0);
  });

  it('a ocupação do bicho cobre a viagem da onda', () => {
    expect(AttackManager.busyMs(DEF)).toBeGreaterThanOrEqual(DEF.travelMs);
  });
});

describe('quem está longe só leva quando a onda CHEGA', () => {
  it('no fim do cast, quem está lá na frente ainda não levou', () => {
    const longe = DEF.length * 0.9;
    const { npc, alvo, ev, am } = cenario(longe);
    am.tryAttack(npc, alvo, [alvo], 1);
    vi.advanceTimersByTime(DEF.castTime + 1);
    expect(acertosDe(ev, 'alvo'), 'a onda mal saiu — não pode ter batido').toBe(0);
  });

  it('depois da viagem inteira, levou', () => {
    const longe = DEF.length * 0.9;
    const { npc, alvo, ev, am } = cenario(longe);
    am.tryAttack(npc, alvo, [alvo], 1);
    vi.runAllTimers();
    expect(acertosDe(ev, 'alvo')).toBeGreaterThan(0);
  });

  it('quem está perto leva ANTES de quem está longe', () => {
    const npc = { id: 'n1', x: 0, z: 0, dead: false, hp: 1e9, maxHp: 1e9,
                  cannonDmg: 100, dmgMult: 1,
                  attacks: ['leviathan_tide_wall'], _attackCooldowns: {} };
    const alvo  = { id: 'alvo',  x: 0, z: DEF.length * 0.9, dead: false,
                    hp: 1e12, maxHp: 1e12, mapLevel: 1 };
    const perto = { id: 'perto', x: 0, z: DEF.length * 0.15, dead: false,
                    hp: 1e12, maxHp: 1e12, mapLevel: 1 };
    const ev = [];
    const am = new AttackManager(e => ev.push(e), null);
    am.tryAttack(npc, alvo, [alvo, perto], 1);

    // Metade da viagem: a frente já passou pelo perto, não pelo longe.
    vi.advanceTimersByTime(DEF.castTime + DEF.travelMs * 0.5);
    expect(acertosDe(ev, 'perto'), 'perto já levou').toBeGreaterThan(0);
    expect(acertosDe(ev, 'alvo'), 'longe ainda não').toBe(0);

    vi.runAllTimers();
    expect(acertosDe(ev, 'alvo'), 'no fim, levou').toBeGreaterThan(0);
  });
});

describe('limites', () => {
  it('cada um leva a onda UMA vez (o dano total não inflou)', () => {
    const { npc, alvo, ev, am } = cenario(DEF.length * 0.5);
    am.tryAttack(npc, alvo, [alvo], 1);
    vi.runAllTimers();
    expect(acertosDe(ev, 'alvo')).toBe(1);
  });

  it('fora da largura lateral não leva', () => {
    const npc = { id: 'n1', x: 0, z: 0, dead: false, hp: 1e9, maxHp: 1e9,
                  cannonDmg: 100, dmgMult: 1,
                  attacks: ['leviathan_tide_wall'], _attackCooldowns: {} };
    const alvo = { id: 'alvo', x: 0, z: DEF.length * 0.5, dead: false,
                   hp: 1e12, maxHp: 1e12, mapLevel: 1 };
    const lado = { id: 'lado', x: DEF.width, z: DEF.length * 0.5, dead: false,
                   hp: 1e12, maxHp: 1e12, mapLevel: 1 };
    const ev = [];
    const am = new AttackManager(e => ev.push(e), null);
    am.tryAttack(npc, alvo, [alvo, lado], 1);
    vi.runAllTimers();
    expect(acertosDe(ev, 'lado')).toBe(0);
  });

  it('além do alcance da onda, ninguém leva', () => {
    const npc = { id: 'n1', x: 0, z: 0, dead: false, hp: 1e9, maxHp: 1e9,
                  cannonDmg: 100, dmgMult: 1,
                  attacks: ['leviathan_tide_wall'], _attackCooldowns: {} };
    const alvo  = { id: 'alvo',  x: 0, z: DEF.length * 0.5, dead: false,
                    hp: 1e12, maxHp: 1e12, mapLevel: 1 };
    const atras = { id: 'atras', x: 0, z: DEF.length + DEF.band * 2, dead: false,
                    hp: 1e12, maxHp: 1e12, mapLevel: 1 };
    const ev = [];
    const am = new AttackManager(e => ev.push(e), null);
    am.tryAttack(npc, alvo, [alvo, atras], 1);
    vi.runAllTimers();
    expect(acertosDe(ev, 'atras')).toBe(0);
  });
});
