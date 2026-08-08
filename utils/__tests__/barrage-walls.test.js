/**
 * Barragem Rolante do BICHO ergue pedra de verdade.
 *
 * `wallPerStep` só existia no monster-skill-manager (o caminho da RELÍQUIA).
 * No cast de bicho a barragem pintava faixas e mais nada: não bloqueava, não
 * empurrava, e o cliente nunca recebia `monster_skill_obstacles` para levantar
 * as malhas 3D — daí "a parede não está sendo invocada".
 *
 * O mesmo golpe tem de bloquear igual nas duas mãos, senão ele empurra quando
 * o jogador lança e é atravessado quando o bicho lança.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AttackManager = require('../../managers/attack-manager.js');
const { ATTACK_DEFS } = require('../../constants/index.js');

const MAP = 1;
const DEF = ATTACK_DEFS.drake_boss_creeping_barrage;

/** wallManager de mentira: só guarda o que mandaram registrar. */
function fakeWallManager() {
  const walls = [];
  return { walls, addWall: (lvl, w) => walls.push({ lvl, ...w }) };
}

function fazerNpc() {
  return {
    id: 'npc1', x: 0, z: 0, dead: false,
    hp: 1000, maxHp: 1000, cannonDmg: 100, dmgMult: 1,
    attacks: ['drake_boss_creeping_barrage'], _attackCooldowns: {},
  };
}

const fazerJogador = () => ({
  id: 'p1', x: 0, z: 120, dead: false, hp: 100000, maxHp: 100000, mapLevel: MAP,
});

function atacar(comWallManager = true) {
  const eventos = [];
  const wm = fakeWallManager();
  const am = new AttackManager((e) => eventos.push(e), null);
  if (comWallManager) am.wallManager = wm;
  const npc = fazerNpc();
  const jogador = fazerJogador();
  am.tryAttack(npc, jogador, [jogador], MAP);
  vi.runAllTimers();
  return { eventos, wm };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('a skill está marcada para erguer parede por passo', () => {
  it('wallPerStep chega no ATTACK_DEFS do bicho', () => {
    expect(DEF.wallPerStep).toBe(true);
    expect(DEF.stepCount).toBeGreaterThan(0);
    expect(DEF.obstacleRadius).toBeGreaterThan(0);
    expect(DEF.holdMs).toBeGreaterThan(0);
  });
});

describe('cada passo ergue pedra e avisa o cliente', () => {
  it('sai um monster_skill_obstacles por passo', () => {
    const { eventos } = atacar();
    const obs = eventos.filter(e => e.type === 'monster_skill_obstacles');
    expect(obs).toHaveLength(DEF.stepCount);
  });

  it('o evento traz os pontos, o raio e o tempo de vida da pedra', () => {
    const { eventos } = atacar();
    for (const e of eventos.filter(x => x.type === 'monster_skill_obstacles')) {
      expect(Array.isArray(e.points)).toBe(true);
      expect(e.points.length).toBeGreaterThan(2);
      expect(e.radius).toBe(DEF.obstacleRadius);
      expect(e.holdMs).toBe(DEF.holdMs);
      expect(e.npcId).toBe('npc1');
    }
  });

  it('as pedras entram no wallManager (é o que bloqueia de verdade)', () => {
    const { wm } = atacar();
    expect(wm.walls.length).toBeGreaterThan(0);
    for (const w of wm.walls) {
      expect(w.lvl).toBe(MAP);
      expect(w.durationMs).toBe(DEF.holdMs);
      expect(w.hw).toBe(DEF.obstacleRadius);
    }
  });

  it('as paredes AVANÇAM: cada passo fica mais longe do bicho', () => {
    const { eventos } = atacar();
    const dists = eventos
      .filter(e => e.type === 'monster_skill_obstacles')
      // ponto do meio de cada parede = distância daquele passo
      .map(e => {
        const m = e.points[Math.floor(e.points.length / 2)];
        return Math.hypot(m.x, m.z);
      });
    for (let i = 1; i < dists.length; i++) {
      expect(dists[i], `passo ${i} tem de estar mais longe que o ${i - 1}`)
        .toBeGreaterThan(dists[i - 1]);
    }
    expect(dists[0]).toBeCloseTo(DEF.firstDistance, 0);
  });

  it('a parede cobre a largura lateral anunciada', () => {
    const { eventos } = atacar();
    const e = eventos.find(x => x.type === 'monster_skill_obstacles');
    // O jogador está em +Z, então a parede se estende no eixo X.
    const larguras = e.points.map(p => Math.abs(p.x));
    expect(Math.max(...larguras)).toBeCloseTo(DEF.width / 2, 0);
  });
});

describe('sem wallManager injetado, não quebra', () => {
  it('o ataque roda e só não ergue pedra', () => {
    const { eventos } = atacar(false);
    expect(eventos.filter(e => e.type === 'monster_skill_obstacles')).toHaveLength(0);
    // O golpe em si continua acontecendo.
    expect(eventos.some(e => e.type === 'npc_attack_hit')).toBe(true);
  });
});
