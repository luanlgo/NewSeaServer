/**
 * Testes da Descarga em Cadeia e da Orbe Caçadora (lado do BICHO)
 *
 * Ambas eram promessas do VFX que o servidor não cumpria:
 *  • `chain` não tinha lógica de pulo nenhuma — o `_isHit` testava UM círculo de
 *    radius+jumpRange (110 un) e todo mundo levava junto, instantâneo e sem
 *    falloff. Agora cada elo é MARCADO e só bate `jumpCastMs` depois.
 *  • `special: 'orb'` não tinha implementação — o servidor batia um círculo no
 *    ponto do cast. Agora a orbe é movida pelo servidor, corrói por leva e
 *    estoura com atordoamento ao alcançar.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AttackManager = require('../../managers/attack-manager.js');
const { ATTACK_DEFS, RELIC_DEFS } = require('../../constants/index.js');

const CHAIN = 'drake_chain_arc';
const ORB   = 'drake_hunter_orb';

function makeNpc() {
  return {
    id: 'npc1', x: 0, z: 0, hp: 9999, cannonDmg: 100, dead: false,
    attacks: [CHAIN, ORB], _attackCooldowns: {},
    npcModel: '/models/monster/cobra.glb',
  };
}
function makePlayer(id, x, z) {
  return { id, x, z, hp: 100000, maxHp: 100000, mapLevel: 1, dead: false };
}
function makeManager(npc) {
  const events = [];
  const am = new AttackManager((e) => events.push(e), null);
  am.pm = { npcs: new Map([[npc.id, npc]]) };
  return { am, events };
}

describe('Descarga em Cadeia — um pulo de cada vez', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const def = () => ATTACK_DEFS[CHAIN];

  it('anuncia cada pulo antes de bater', () => {
    const npc = makeNpc();
    const a = makePlayer('a', 0, 40);
    const b = makePlayer('b', 0, 100);          // dentro do jumpRange (90) de A
    const { am, events } = makeManager(npc);

    am._beginCast(npc, def(), a, [a, b], 1);
    vi.advanceTimersByTime(def().castTime);

    expect(a.hp).toBeLessThan(100000);          // 1º elo caiu
    expect(b.hp).toBe(100000);                  // o 2º ainda é só aviso

    const aviso = events.filter(e => e.type === 'npc_telegraph' && e.chainLink === 1).pop();
    expect(aviso).toBeDefined();
    expect(aviso.x).toBeCloseTo(b.x, 5);
    expect(aviso.z).toBeCloseTo(b.z, 5);
    expect(aviso.duration).toBe(def().jumpCastMs);

    vi.advanceTimersByTime(def().jumpCastMs);
    expect(b.hp).toBeLessThan(100000);          // agora sim
  });

  it('quem sai do ponto marcado ESCAPA do pulo', () => {
    const npc = makeNpc();
    const a = makePlayer('a', 0, 40);
    const b = makePlayer('b', 0, 100);
    const { am } = makeManager(npc);

    am._beginCast(npc, def(), a, [a, b], 1);
    vi.advanceTimersByTime(def().castTime);

    b.x = 500; b.z = 500;                        // fugiu da marcação
    vi.advanceTimersByTime(def().jumpCastMs + 50);

    expect(b.hp).toBe(100000);
  });

  it('o dano cai por falloff a cada elo', () => {
    const npc = makeNpc();
    const a = makePlayer('a', 0, 40);
    const b = makePlayer('b', 0, 100);
    const { am } = makeManager(npc);

    am._beginCast(npc, def(), a, [a, b], 1);
    vi.advanceTimersByTime(def().castTime);
    const danoA = 100000 - a.hp;
    vi.advanceTimersByTime(def().jumpCastMs);
    const danoB = 100000 - b.hp;

    expect(danoB).toBe(Math.floor(danoA * def().falloff));
  });

  it('ninguém leva duas vezes na mesma cadeia', () => {
    const npc = makeNpc();
    const a = makePlayer('a', 0, 40);
    const b = makePlayer('b', 0, 100);
    const { am } = makeManager(npc);

    am._beginCast(npc, def(), a, [a, b], 1);
    vi.advanceTimersByTime(def().castTime);
    const hpA = a.hp;
    vi.advanceTimersByTime(def().jumpCastMs * def().count + 500);

    expect(a.hp).toBe(hpA);
  });

  it('sem ninguém por perto a cadeia morre no 1º elo', () => {
    const npc = makeNpc();
    const a = makePlayer('a', 0, 40);
    const longe = makePlayer('longe', 0, 900);
    const { am, events } = makeManager(npc);

    am._beginCast(npc, def(), a, [a, longe], 1);
    vi.advanceTimersByTime(def().castTime + 5000);

    expect(longe.hp).toBe(100000);
    expect(events.filter(e => e.type === 'npc_telegraph' && e.chainLink)).toHaveLength(0);
  });
});

describe('Orbe Caçadora — ameaça móvel', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const def = () => ATTACK_DEFS[ORB];

  it('subiu para épico', () => {
    expect(RELIC_DEFS.r37.rarity).toBe('épico');
  });

  it('persegue o alvo VIVO (a orbe anda atrás de quem se move)', () => {
    const npc = makeNpc();
    const p = makePlayer('p', 0, 300);
    const { am, events } = makeManager(npc);

    am._beginCast(npc, def(), p, [p], 1);
    vi.advanceTimersByTime(def().castTime + def().orbTickMs);
    const primeira = events.filter(e => e.type === 'npc_orb_move').pop();
    expect(primeira).toBeDefined();

    p.x = 300; p.z = 300;                      // o alvo desvia para o lado
    vi.advanceTimersByTime(def().orbTickMs * 3);
    const depois = events.filter(e => e.type === 'npc_orb_move').pop();

    expect(depois.x).toBeGreaterThan(primeira.x);   // a orbe curvou atrás dele
  });

  // Alvo a 40 un: dentro do raio da orbe (45) e fora do alcance de captura no
  // primeiro passo (a orbe anda 22 por leva) — assim dá para medir a CORROSÃO
  // isolada, antes de o estouro entrar na conta.
  it('corrói por leva quem está dentro dela', () => {
    const npc = makeNpc();
    const p = makePlayer('p', 0, 40);
    const { am } = makeManager(npc);

    am._beginCast(npc, def(), p, [p], 1);
    vi.advanceTimersByTime(def().castTime);     // 1ª leva sai junto com o fim do cast
    const apos1 = p.hp;
    expect(apos1).toBeLessThan(100000);

    const porLeva = Math.floor(npc.cannonDmg * def().damageMult * def().orbTickPct);
    expect(100000 - apos1).toBe(porLeva);
  });

  it('ao alcançar, estoura com dano cheio e ATORDOA', () => {
    const npc = makeNpc();
    const p = makePlayer('p', 0, 60);
    const { am, events } = makeManager(npc);

    expect(def().cc.stunMs).toBe(1000);
    am._beginCast(npc, def(), p, [p], 1);
    vi.advanceTimersByTime(def().castTime + def().lifeMs + def().orbTickMs);

    expect(p.stunExpires).toBeGreaterThan(0);
    expect(events.some(e => e.type === 'npc_orb_end')).toBe(true);
  });

  it('a corrosão NÃO atordoa — só o estouro', () => {
    const npc = makeNpc();
    const p = makePlayer('p', 0, 40);
    const { am } = makeManager(npc);

    am._beginCast(npc, def(), p, [p], 1);
    vi.advanceTimersByTime(def().castTime);     // só a 1ª leva, antes do estouro

    expect(p.hp).toBeLessThan(100000);
    expect(p.stunExpires).toBeUndefined();
  });

  it('a orbe morre junto com o bicho', () => {
    const npc = makeNpc();
    const p = makePlayer('p', 0, 300);
    const { am, events } = makeManager(npc);

    am._beginCast(npc, def(), p, [p], 1);
    vi.advanceTimersByTime(def().castTime + def().orbTickMs);
    const antes = events.filter(e => e.type === 'npc_orb_move').length;

    npc.dead = true;
    vi.advanceTimersByTime(def().lifeMs);

    expect(events.filter(e => e.type === 'npc_orb_move').length).toBe(antes);
  });
});
