/**
 * Cemitério de Naufrágios — chuva perseguindo, não salva sorteada.
 *
 * As 6 quedas simultâneas eram um sorteio: raio 30 sobre espalhamento 200 quase
 * nunca punia quem ficava parado, e não havia decisão nenhuma para tomar.
 * Agora cai uma por vez, mirada em ONDE O ALVO ESTÁ naquele instante, com
 * `dropWarnMs` de aviso — parar é a pior escolha, e os destroços vão fechando
 * a arena em volta de quem correu em linha reta.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AttackManager = require('../../managers/attack-manager.js');
const { ATTACK_DEFS } = require('../../constants/index.js');

const DEF = ATTACK_DEFS.turtle_boss_wreck_field;

function fakeWallManager() {
  const walls = [];
  return { walls, addWall: (lvl, w) => walls.push({ lvl, ...w }) };
}

function montar() {
  const npc = { id: 'n1', x: 0, z: 0, dead: false, hp: 1e9, maxHp: 1e9,
                cannonDmg: 100, dmgMult: 1,
                attacks: ['turtle_boss_wreck_field'], _attackCooldowns: {} };
  const ev = [];
  const am = new AttackManager(e => ev.push(e), null);
  am.wallManager = fakeWallManager();
  return { npc, ev, am };
}

const quedas = (ev) => ev.filter(e => e.type === 'monster_skill_obstacles');
const avisos = (ev) => ev.filter(e => e.type === 'npc_telegraph' && e.dropIndex != null);
const danoEm = (ev, id) => ev.filter(e => e.type === 'npc_attack_hit')
  .flatMap(e => e.hits || []).filter(h => h.id === id).length;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('a skill virou chuva', () => {
  it('tem intervalo e janela de aviso no dado', () => {
    expect(DEF.dropIntervalMs).toBeGreaterThan(0);
    expect(DEF.dropWarnMs).toBeGreaterThan(0);
    expect(DEF.dropWarnMs).toBeLessThan(DEF.dropIntervalMs);
  });

  it('o cast principal NÃO carrega o vfx (senão o cliente toca as 6 de uma vez)', () => {
    const { npc, ev, am } = montar();
    const p = { id: 'p1', x: 0, z: 60, dead: false, hp: 1e12, maxHp: 1e12, mapLevel: 1 };
    am.tryAttack(npc, p, [p], 1);
    const cast = ev.find(e => e.type === 'npc_telegraph' && e.dropIndex == null);
    expect(cast.vfx).toBeNull();
  });

  it('cai UMA por vez, no ritmo pedido', () => {
    const { npc, ev, am } = montar();
    const p = { id: 'p1', x: 0, z: 60, dead: false, hp: 1e12, maxHp: 1e12, mapLevel: 1 };
    am.tryAttack(npc, p, [p], 1);

    vi.advanceTimersByTime(DEF.castTime + DEF.dropWarnMs + 10);
    expect(quedas(ev).length, 'só a 1ª caiu').toBe(1);

    vi.advanceTimersByTime(DEF.dropIntervalMs);
    expect(quedas(ev).length, 'a 2ª caiu um intervalo depois').toBe(2);

    vi.runAllTimers();
    expect(quedas(ev).length).toBe(DEF.count);
    expect(avisos(ev).length, 'cada queda tem aviso próprio').toBe(DEF.count);
  });

  it('cada aviso vem com UMA peça, não o campo inteiro', () => {
    const { npc, ev, am } = montar();
    const p = { id: 'p1', x: 0, z: 60, dead: false, hp: 1e12, maxHp: 1e12, mapLevel: 1 };
    am.tryAttack(npc, p, [p], 1);
    vi.runAllTimers();
    for (const a of avisos(ev)) {
      expect(a.count).toBe(1);
      expect(a.vfx).toBe(DEF.vfx);
      expect(a.duration).toBe(DEF.dropWarnMs);
      // Sem `spread: 0` a skill sorteia o ponto dela dentro de `spread_radius`
      // e a marcação de impacto aparece longe de onde a peça cai.
      expect(a.spread, 'a queda tem de ficar PRESA ao ponto anunciado').toBe(0);
      expect(a.radius).toBe(DEF.radius);
    }
  });
});

describe('persegue o alvo', () => {
  it('cada queda mira onde o alvo ESTÁ, não onde estava', () => {
    const { npc, ev, am } = montar();
    const p = { id: 'p1', x: 0, z: 60, dead: false, hp: 1e12, maxHp: 1e12, mapLevel: 1 };
    am.tryAttack(npc, p, [p], 1);

    const posicoes = [];
    for (let i = 0; i < DEF.count; i++) {
      p.x = i * 40;                       // o jogador navega entre as quedas
      vi.advanceTimersByTime(i === 0 ? DEF.castTime + 1 : DEF.dropIntervalMs);
      const a = avisos(ev)[i];
      if (a) posicoes.push(a.x);
    }
    // Os avisos seguiram o movimento em vez de repetir o mesmo ponto.
    expect(new Set(posicoes).size).toBeGreaterThan(1);
  });

  it('quem FICA PARADO leva (era o defeito: parar era seguro)', () => {
    const { npc, ev, am } = montar();
    const p = { id: 'p1', x: 0, z: 60, dead: false, hp: 1e12, maxHp: 1e12, mapLevel: 1 };
    am.tryAttack(npc, p, [p], 1);
    vi.runAllTimers();
    expect(danoEm(ev, 'p1')).toBe(DEF.count);
  });

  it('quem SAI da marcação a tempo escapa daquela queda', () => {
    const { npc, ev, am } = montar();
    const p = { id: 'p1', x: 0, z: 60, dead: false, hp: 1e12, maxHp: 1e12, mapLevel: 1 };
    am.tryAttack(npc, p, [p], 1);
    // Deixa a 1ª queda ser ANUNCIADA e foge antes de ela cair.
    vi.advanceTimersByTime(DEF.castTime + 1);
    expect(avisos(ev).length).toBe(1);
    p.x = DEF.radius * 6;
    vi.advanceTimersByTime(DEF.dropWarnMs + 10);
    expect(danoEm(ev, 'p1'), 'saiu a tempo da 1ª').toBe(0);
  });
});

describe('os destroços viram obstáculo de verdade', () => {
  it('cada queda registra pedra no wallManager', () => {
    const { npc, ev, am } = montar();
    const p = { id: 'p1', x: 0, z: 60, dead: false, hp: 1e12, maxHp: 1e12, mapLevel: 1 };
    am.tryAttack(npc, p, [p], 1);
    vi.runAllTimers();
    expect(am.wallManager.walls.length).toBe(DEF.count);
    for (const w of am.wallManager.walls) {
      expect(w.hw).toBe(DEF.obstacleRadius);
      expect(w.durationMs).toBe(DEF.holdMs);
    }
    expect(quedas(ev).length).toBe(DEF.count);
  });

  it('a pedra nasce ONDE o destroço caiu', () => {
    const { npc, ev, am } = montar();
    const p = { id: 'p1', x: 0, z: 60, dead: false, hp: 1e12, maxHp: 1e12, mapLevel: 1 };
    am.tryAttack(npc, p, [p], 1);
    vi.advanceTimersByTime(DEF.castTime + DEF.dropWarnMs + 10);
    const q = quedas(ev)[0];
    const w = am.wallManager.walls[0];
    expect(w.x).toBeCloseTo(q.originX, 5);
    expect(w.z).toBeCloseTo(q.originZ, 5);
  });
});

describe('ocupação', () => {
  it('o bicho fica ocupado a chuva inteira', () => {
    const esperado = (DEF.count - 1) * DEF.dropIntervalMs + DEF.dropWarnMs;
    expect(AttackManager.busyMs(DEF)).toBeGreaterThanOrEqual(esperado);
  });
});
