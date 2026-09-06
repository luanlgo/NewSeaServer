/**
 * A trégua de 30 s de quem acabou de renascer — e as três brechas por onde ela
 * vazava, achadas no relato do playtest: "a Bocarra Torácica está me matando
 * duas vezes; morro, aperto reviver e morro em seguida".
 *
 * ── Por que o `dead` não bastava ────────────────────────────────────────────
 * As skills de várias levas escolhem o alvo UMA vez e depois disparam N
 * `setTimeout` guardando a referência dele. O guarda de cada leva era
 * `if (alvo.dead) return` — e `dead` volta a ser `false` no instante em que o
 * jogador aperta reviver. As levas que faltavam caíam no barco recém-nascido,
 * que tem 10% da vida. Duas mordidas bastavam.
 *
 * A trégua é o que distingue "ainda está sendo mastigado" de "já morreu e
 * voltou". O `dead` sozinho não distingue: ele é o mesmo `false` nas duas.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const MonsterSkillManager = require('../../managers/monster-skill-manager.js');
const AttackManager       = require('../../managers/attack-manager.js');
const { RELIC_DEFS, ATTACK_DEFS } = require('../../constants/index.js');
const { isInvincible, isSafeAfterRespawn, isUntouchable } = require('../invincibility.js');

const MAP = 1;
const TREGUA_MS = 30000;

function fazerVitima(x = 0, z = 20) {
  return { id: 'v1', x, z, dead: false, hp: 1000, maxHp: 1000, mapLevel: MAP,
           mana: 60, maxMana: 60, ws: { readyState: 1, OPEN: 1, bufferedAmount: 0, send() {} } };
}

/** Morreu e apertou reviver: é assim que o server.js devolve o jogador. */
function reviver(v) {
  v.dead      = false;
  v.hp        = Math.floor(v.maxHp * 0.10);
  v.dots      = [];
  v.safeUntil = Date.now() + TREGUA_MS;
  return v.hp;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// ═════════════════════════════════════════════════════════════════════════════
describe('as duas janelas em que nada machuca', () => {
  it('a trégua vale enquanto o prazo não vence', () => {
    const p = { safeUntil: Date.now() + 1000 };
    expect(isSafeAfterRespawn(p)).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(isSafeAfterRespawn(p)).toBe(false);
  });

  it('sem o campo, ninguém está de trégua', () => {
    expect(isSafeAfterRespawn({})).toBe(false);
    expect(isSafeAfterRespawn(null)).toBe(false);
  });

  it('`isUntouchable` cobre a bolha E a trégua', () => {
    const bolha  = { relicInvincibleExpires: Date.now() + 500 };
    const tregua = { safeUntil: Date.now() + 500 };
    expect(isInvincible(bolha)).toBe(true);
    expect(isUntouchable(bolha)).toBe(true);
    expect(isInvincible(tregua), 'trégua não é a bolha da r2').toBe(false);
    expect(isUntouchable(tregua)).toBe(true);
    expect(isUntouchable({})).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Bocarra Torácica — a face de RELÍQUIA', () => {
  function motor(vitima) {
    const eventos = [];
    const msm = new MonsterSkillManager({
      projectileManager: { npcs: new Map() },
      players: new Map([[vitima.id, vitima]]),
      wallManager: { addWall: () => {} },
      addEvent: (e) => eventos.push(e),
      sendTo: () => {},
      relicDamageFor: () => 120,
      // Espelha o `relicCanHitPlayer` do server.js, trégua inclusa.
      relicCanHitPlayer: (c, t) => t.id !== c.id && !t.dead && !isSafeAfterRespawn(t),
      grantSkillXp: () => {},
      getMapManagerFor: () => null,
      onNpcDamaged: () => {},
      onPlayerKilled: () => {},
      clampToMap: () => {},
    });
    return { msm, eventos };
  }

  const lancador = () => ({ id: 'c1', x: 0, z: 0, hp: 1e9, maxHp: 1e9, mapLevel: MAP,
                            dead: false, rotation: 0, cannonDamage: 100, cannonCount: 4,
                            mana: 99, maxMana: 99 });

  it('as levas que faltavam NÃO caem em quem reviveu no meio da mordida', () => {
    const v = fazerVitima(0, 10);
    const { msm } = motor(v);
    const def = RELIC_DEFS.r48;

    msm.cast(lancador(), def, v.x, v.z, {});
    vi.advanceTimersByTime(def.castMs + 10);
    expect(v._swallowedBy, 'não engoliu ninguém').toBe('c1');

    // Duas mordidas e a vítima afunda.
    vi.advanceTimersByTime(def.ticks.intervalMs * 2 + 10);
    expect(v.hp, 'as mordidas não doeram').toBeLessThan(1000);
    v.dead = true;

    // Aperta reviver com a bocarra ainda mastigando.
    const hpVivo = reviver(v);
    vi.runAllTimers();

    expect(v.hp, 'morreu de novo na mesma mordida — a trégua vazou').toBe(hpVivo);
  });

  it('sem a trégua, as levas continuam doendo (o teste sabe medir)', () => {
    // Guarda-corpo do próprio teste: se este caso parar de ver dano, é sinal de
    // que a montagem quebrou e o caso de cima estaria passando por engano.
    const v = fazerVitima(0, 10);
    const { msm } = motor(v);
    const def = RELIC_DEFS.r48;

    msm.cast(lancador(), def, v.x, v.z, {});
    vi.advanceTimersByTime(def.castMs + 10);
    const antes = v.hp;
    vi.advanceTimersByTime(def.ticks.intervalMs + 10);
    expect(v.hp).toBeLessThan(antes);
  });

  it('quem está de trégua não é sequer escolhido como presa', () => {
    const v = fazerVitima(0, 10);
    v.safeUntil = Date.now() + TREGUA_MS;
    const { msm } = motor(v);

    msm.cast(lancador(), RELIC_DEFS.r48, v.x, v.z, {});
    vi.runAllTimers();

    expect(v._swallowedBy, 'engoliu quem estava em trégua').toBeUndefined();
    expect(v.hp).toBe(1000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Bocarra Torácica — a face de BICHO', () => {
  function bicho() {
    const ev = [];
    const npcs = new Map();
    const npc = { id: 'n1', x: 0, z: 0, dead: false, hp: 1e9, maxHp: 1e9, mapLevel: MAP,
                  cannonDmg: 100, dmgMult: 1, rotation: 0,
                  attacks: ['alien_maw_engulf'], _attackCooldowns: {} };
    npcs.set(npc.id, npc);
    const am = new AttackManager(e => ev.push(e), { npcs });
    return { npc, am, ev };
  }

  it('as levas que faltavam NÃO caem em quem reviveu no meio da mordida', () => {
    const { npc, am } = bicho();
    const def = ATTACK_DEFS.alien_maw_engulf;
    const v = fazerVitima(0, 20);

    am.tryAttack(npc, v, [v], MAP);
    vi.advanceTimersByTime(def.castTime + 10);
    expect(v._swallowedBy, 'não engoliu').toBe(npc.id);

    vi.advanceTimersByTime(def.ticks.intervalMs * 2 + 10);
    expect(v.hp).toBeLessThan(1000);
    v.dead = true;

    const hpVivo = reviver(v);
    vi.runAllTimers();

    expect(v.hp, 'morreu de novo na mesma mordida — a trégua vazou').toBe(hpVivo);
  });

  it('quem está de trégua não é escolhido como presa', () => {
    const { npc, am } = bicho();
    const def = ATTACK_DEFS.alien_maw_engulf;
    const v = fazerVitima(0, 20);
    v.safeUntil = Date.now() + TREGUA_MS;

    am.tryAttack(npc, v, [v], MAP);
    vi.advanceTimersByTime(def.castTime + 10);
    vi.runAllTimers();

    expect(v._swallowedBy).toBeUndefined();
    expect(v.hp).toBe(1000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('o funil de dano do bestiário', () => {
  it('recusa o golpe e anuncia bloqueio quando o alvo está de trégua', () => {
    // Este é o conserto que vale para as 34 relíquias de uma vez: qualquer
    // caminho que chegue ao `_damage` para na trégua, mesmo tendo escolhido o
    // alvo antes de ele morrer.
    const eventos = [];
    const v = fazerVitima();
    const msm = new MonsterSkillManager({
      projectileManager: { npcs: new Map() },
      players: new Map([[v.id, v]]),
      wallManager: { addWall: () => {} },
      addEvent: (e) => eventos.push(e),
      sendTo: () => {},
      relicDamageFor: () => 500,
      relicCanHitPlayer: () => true,
      grantSkillXp: () => {},
      getMapManagerFor: () => null,
      onNpcDamaged: () => {},
      onPlayerKilled: () => {},
      clampToMap: () => {},
    });

    v.safeUntil = Date.now() + TREGUA_MS;
    const h = msm._damage({ id: 'c1' }, { e: v, isNPC: false }, 500);

    expect(h.dmg, 'o golpe passou pela trégua').toBe(0);
    expect(h.blocked).toBe(true);
    expect(v.hp).toBe(1000);
    expect(eventos.some(e => e.type === 'shield_block'),
      'o cliente não foi avisado de que o golpe foi aparado').toBe(true);
  });

  it('fora da trégua o mesmo golpe entra', () => {
    const v = fazerVitima();
    const msm = new MonsterSkillManager({
      projectileManager: { npcs: new Map() },
      players: new Map([[v.id, v]]),
      wallManager: { addWall: () => {} },
      addEvent: () => {},
      sendTo: () => {},
      relicDamageFor: () => 500,
      relicCanHitPlayer: () => true,
      grantSkillXp: () => {},
      getMapManagerFor: () => null,
      onNpcDamaged: () => {},
      onPlayerKilled: () => {},
      clampToMap: () => {},
    });
    const h = msm._damage({ id: 'c1' }, { e: v, isNPC: false }, 500);
    expect(h.dmg).toBe(500);
    expect(v.hp).toBe(500);
  });
});
