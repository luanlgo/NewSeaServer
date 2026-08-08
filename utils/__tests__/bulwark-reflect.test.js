/**
 * Carapaça Eriçada (r32) — a reflexão funciona mesmo?
 *
 * A relíquia promete duas coisas: 40% menos dano recebido e 30% do que sobra
 * de volta em quem bateu. A implementação existia SÓ no projectile-manager,
 * ou seja, valia contra TIRO e nada mais. Contra as 34 skills de área do
 * bestiário — exatamente o que um kit de tanque deveria aparar — a carapaça
 * não fazia nada: nem mitigação, nem reflexão.
 *
 * Estes testes cobrem os DOIS caminhos de dano do jogo.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AttackManager = require('../../managers/attack-manager.js');
const { ATTACK_DEFS, RELIC_DEFS } = require('../../constants/index.js');

const MAP = 1;
const DEF = RELIC_DEFS.r32;

/** Jogador com a carapaça ligada. */
function comCarapaca(extra = {}) {
  return {
    id: 'p1', x: 0, z: 0, dead: false, hp: 100000, maxHp: 100000, mapLevel: MAP,
    relicBulwarkExpires: Date.now() + 5000,
    relicBulwarkReduction: DEF.damageReduction,
    relicBulwarkReflect: DEF.reflectPct,
    ...extra,
  };
}

function fazerNpc(attackId, hp = 100000) {
  return {
    id: 'npc1', x: 0, z: 0, dead: false, hp, maxHp: hp,
    cannonDmg: 1000, dmgMult: 1,
    attacks: [attackId], _attackCooldowns: {},
  };
}

/** Golpe de área simples e determinístico (cone curto, uma leva só). */
const GOLPE = 'crab_claw_slam';

function bater(jogador) {
  const npc = fazerNpc(GOLPE);
  const ev = [];
  const am = new AttackManager(e => ev.push(e), null);
  am.tryAttack(npc, jogador, [jogador], MAP);
  vi.runAllTimers();
  return { ev, npc };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('a relíquia declara os dois números', () => {
  it('mitigação e reflexão estão no dado', () => {
    expect(DEF.damageReduction).toBeGreaterThan(0);
    expect(DEF.reflectPct).toBeGreaterThan(0);
    expect(DEF.durationMs).toBeGreaterThan(0);
  });
});

describe('contra ataque de ÁREA (o buraco que existia)', () => {
  it('a carapaça reduz o dano recebido', () => {
    const semNada = { id: 'p1', x: 0, z: 0, dead: false, hp: 100000,
                      maxHp: 100000, mapLevel: MAP };
    const semHp0 = semNada.hp;
    bater(semNada);
    const danoNormal = semHp0 - semNada.hp;
    expect(danoNormal, 'o golpe base tem de doer').toBeGreaterThan(0);

    const comCasca = comCarapaca();
    const comHp0 = comCasca.hp;
    bater(comCasca);
    const danoMitigado = comHp0 - comCasca.hp;

    expect(danoMitigado).toBeLessThan(danoNormal);
    // 40% a menos, com folga de arredondamento.
    expect(danoMitigado).toBeCloseTo(danoNormal * (1 - DEF.damageReduction), -1);
  });

  it('devolve dano em quem bateu', () => {
    const jogador = comCarapaca();
    const { ev, npc } = bater(jogador);
    const refletidos = ev.filter(e => e.type === 'bulwark_reflect');
    expect(refletidos.length, 'tem de sair evento de reflexão').toBeGreaterThan(0);
    expect(refletidos[0].targetId).toBe('p1');
    expect(refletidos[0].shooterId).toBe('npc1');
    expect(refletidos[0].dmg).toBeGreaterThan(0);
    expect(npc.hp, 'o bicho tem de perder HP').toBeLessThan(npc.maxHp);
  });

  it('sem a carapaça, nada é devolvido', () => {
    const jogador = { id: 'p1', x: 0, z: 0, dead: false, hp: 100000,
                      maxHp: 100000, mapLevel: MAP };
    const { ev, npc } = bater(jogador);
    expect(ev.filter(e => e.type === 'bulwark_reflect')).toHaveLength(0);
    expect(npc.hp).toBe(npc.maxHp);
  });

  it('carapaça EXPIRADA não vale mais', () => {
    const jogador = comCarapaca({ relicBulwarkExpires: Date.now() - 1 });
    const hp0 = jogador.hp;
    const { ev } = bater(jogador);
    expect(ev.filter(e => e.type === 'bulwark_reflect')).toHaveLength(0);
    // Levou o dano cheio.
    const semNada = { id: 'p2', x: 0, z: 0, dead: false, hp: 100000,
                      maxHp: 100000, mapLevel: MAP };
    const semHp0 = semNada.hp;
    bater(semNada);
    expect(hp0 - jogador.hp).toBe(semHp0 - semNada.hp);
  });

  it('a conta bate: reflexão = 30% do que foi mitigado', () => {
    const jogador = comCarapaca();
    const { ev } = bater(jogador);
    const refl = ev.find(e => e.type === 'bulwark_reflect');
    // dano base do golpe = cannonDmg * damageMult
    const base = 1000 * ATTACK_DEFS[GOLPE].damageMult;
    const mitigado = Math.round(base * DEF.damageReduction);
    expect(refl.dmg).toBe(Math.round(mitigado * DEF.reflectPct));
  });
});

describe('o caminho do TIRO continua valendo', () => {
  it('o projectile-manager também aplica carapaça', () => {
    // Contrato mínimo: o código de reflexão existe naquele arquivo e usa os
    // mesmos campos. Exercitar o hit() inteiro exigiria meio servidor de pé.
    const fs = require('fs');
    const src = fs.readFileSync(
      require.resolve('../../managers/projectile-manager.js'), 'utf8');
    expect(src).toContain('relicBulwarkExpires');
    expect(src).toContain('relicBulwarkReflect');
    expect(src).toContain("type: 'bulwark_reflect'");
  });
});
