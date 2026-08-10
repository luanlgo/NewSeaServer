/**
 * As relíquias do bestiário na mão do JOGADOR.
 *
 * A suíte existente cobre bem o lado do BICHO (chain-and-orb, wreck-rain,
 * crown-spin, tide-wall). O lado da relíquia tinha os mesmos golpes resolvendo
 * por caminhos diferentes — e foi ali que playtest achou quatro que "não faziam
 * nada":
 *
 *   • Coroa de Espinhos — a coroa gira em volta de QUEM LANÇOU (é o que o
 *     desenho faz e o que o bicho faz), mas o motor centrava no cursor.
 *   • Descarga em Cadeia — o alcance de engate do 1º elo era o raio de DANO
 *     (5 un): tinha de clicar em cima do centro do bicho.
 *   • Orbe Caçadora — `special: 'orb'` não tinha implementação: o dano era um
 *     círculo em cima do próprio barco enquanto o desenho voava.
 *   • Cemitério de Naufrágios — as seis quedas de uma vez em pontos sorteados,
 *     em vez da chuva mirada que o bicho usa.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const MonsterSkillManager = require('../../managers/monster-skill-manager.js');
const { RELIC_DEFS } = require('../../constants/relics.js');

const MAP = 1;

function fazerJogador(x = 0, z = 0) {
  return {
    id: 'p1', x, z, hp: 100000, maxHp: 100000, mapLevel: MAP, dead: false,
    rotation: 0, cannonDamage: 100, cannonCount: 4, cannonRange: 120,
  };
}

function fazerNpc(id, x, z) {
  return { id, x, z, hp: 100000, maxHp: 100000, mapLevel: MAP, dead: false };
}

/** ctx mínimo: o motor só precisa de alvos, do relógio e de onde despejar eventos. */
function fazerMotor(npcs = []) {
  const eventos = [];
  const paredes = [];
  const mapa = new Map(npcs.map(n => [n.id, n]));
  const msm = new MonsterSkillManager({
    projectileManager: { npcs: mapa },
    players: new Map(),
    wallManager: { addWall: (lvl, w) => paredes.push({ lvl, ...w }) },
    addEvent: (e) => eventos.push(e),
    sendTo: () => {},
    relicDamageFor: () => 100,
    relicCanHitPlayer: () => false,      // sem PvP nestes testes
    grantSkillXp: () => {},
    getMapManagerFor: () => null,
    onNpcDamaged: () => {},
    clampToMap: () => {},
  });
  return { msm, eventos, paredes };
}

const dano = (eventos) => eventos
  .filter(e => e.type === 'monster_skill_strike')
  .flatMap(e => e.hits || []);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Coroa de Espinhos — a coroa gira em volta do lançador', () => {
  it('acerta quem está colado no barco, mesmo mirando longe', () => {
    const perto = fazerNpc('perto', 30, 0);
    const { msm, eventos } = fazerMotor([perto]);
    const p = fazerJogador(0, 0);
    // Mira lá longe: com a origem no cursor, o dano cairia a 300 un daqui.
    msm.cast(p, RELIC_DEFS.r26, 300, 0, {});
    vi.runAllTimers();
    expect(dano(eventos).some(h => h.id === 'perto')).toBe(true);
  });

  it('o desenho e o dano nascem no mesmo ponto (origem = o barco)', () => {
    const { msm, eventos } = fazerMotor([]);
    const p = fazerJogador(50, -20);
    msm.cast(p, RELIC_DEFS.r26, 300, 0, {});
    const cast = eventos.find(e => e.type === 'monster_skill_cast');
    expect(cast.originX).toBe(50);
    expect(cast.originZ).toBe(-20);
  });
});

describe('Descarga em Cadeia — engata com a mira do jogo', () => {
  it('pega o bicho com o cursor fora do centro dele', () => {
    const alvo = fazerNpc('alvo', 0, 100);
    const { msm, eventos } = fazerMotor([alvo]);
    // Clique 30 un fora do centro: é a mira normal de quem clica no casco.
    msm.cast(fazerJogador(), RELIC_DEFS.r36, 0, 130, {});
    vi.runAllTimers();
    expect(dano(eventos).some(h => h.id === 'alvo')).toBe(true);
  });

  it('o raio de DANO continua pequeno — engate não é área', () => {
    expect(RELIC_DEFS.r36.seekRadius).toBeGreaterThan(RELIC_DEFS.r36.radius);
  });

  it('salta para o vizinho dentro do jumpRange', () => {
    const a = fazerNpc('a', 0, 100);
    const b = fazerNpc('b', 40, 120);            // ~45 un de A
    const { msm, eventos } = fazerMotor([a, b]);
    msm.cast(fazerJogador(), RELIC_DEFS.r36, 0, 100, {});
    vi.runAllTimers();
    const ids = dano(eventos).map(h => h.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
  });
});

describe('Orbe Caçadora — a orbe que se vê é a que machuca', () => {
  it('viaja e estoura EM CIMA do alvo, não no lançador', () => {
    const alvo = fazerNpc('alvo', 0, 120);
    const { msm, eventos } = fazerMotor([alvo]);
    msm.cast(fazerJogador(0, 0), RELIC_DEFS.r37, 0, 120, {});
    vi.runAllTimers();

    const fim = eventos.find(e => e.type === 'relic_orb_end');
    expect(fim).toBeDefined();
    expect(Math.hypot(fim.x - alvo.x, fim.z - alvo.z)).toBeLessThan(5);
    expect(dano(eventos).some(h => h.id === 'alvo')).toBe(true);
  });

  it('transmite a posição a cada leva (o desenho segue o dano)', () => {
    const { msm, eventos } = fazerMotor([fazerNpc('alvo', 0, 160)]);
    msm.cast(fazerJogador(0, 0), RELIC_DEFS.r37, 0, 160, {});
    vi.runAllTimers();
    const passos = eventos.filter(e => e.type === 'relic_orb_move');
    expect(passos.length).toBeGreaterThan(1);
    // Cada passo sai mais longe do lançador — a orbe ANDA.
    const d = passos.map(e => Math.hypot(e.x, e.z));
    expect(d[d.length - 1]).toBeGreaterThan(d[0]);
  });

  it('sem ninguém para caçar, ela expira sem bater no dono', () => {
    const { msm, eventos } = fazerMotor([]);
    const p = fazerJogador(0, 0);
    msm.cast(p, RELIC_DEFS.r37, 0, 60, {});
    vi.runAllTimers();
    expect(dano(eventos)).toHaveLength(0);
  });
});

describe('Cemitério de Naufrágios — chuva mirada, não confete', () => {
  it('cai uma de cada vez, cada uma em cima do alvo do momento', () => {
    const alvo = fazerNpc('alvo', 0, 60);
    const { msm, eventos, paredes } = fazerMotor([alvo]);
    const def = RELIC_DEFS.r33;

    msm.cast(fazerJogador(), def, 0, 60, {});
    // 1ª queda anunciada e resolvida…
    vi.advanceTimersByTime(def.castMs + def.dropWarnMs + 10);
    const primeira = paredes.length;
    expect(primeira).toBe(1);

    // …e o alvo se mexe antes da 2ª: a queda seguinte tem de ir ATRÁS dele.
    alvo.x = 90;
    vi.advanceTimersByTime(def.dropIntervalMs);
    const anuncios = eventos.filter(e => e.type === 'monster_skill_cast');
    expect(anuncios.length).toBeGreaterThan(1);
    expect(anuncios[anuncios.length - 1].originX).toBeCloseTo(90, 0);

    vi.runAllTimers();
    expect(paredes.length).toBe(def.count);       // um destroço por queda
  });

  it('cada queda anuncia UM destroço (não o campo inteiro)', () => {
    const { msm, eventos } = fazerMotor([fazerNpc('alvo', 0, 60)]);
    msm.cast(fazerJogador(), RELIC_DEFS.r33, 0, 60, {});
    vi.runAllTimers();
    for (const e of eventos.filter(x => x.type === 'monster_skill_cast')) {
      expect(e.params.count).toBe(1);
      expect(e.params.spread).toBe(0);
    }
  });
});

describe('Alcance colado no canhão', () => {
  it('Laços e Jato alcançam o que o canhão alcança', () => {
    for (const id of ['r23', 'r30']) {
      const alvo = fazerNpc('alvo', 0, 110);      // além do length fixo do dado
      const { msm, eventos } = fazerMotor([alvo]);
      const p = fazerJogador(0, 0);               // cannonRange 120
      msm.cast(p, RELIC_DEFS[id], 0, 110, {});
      vi.runAllTimers();
      expect(dano(eventos).some(h => h.id === 'alvo'), id).toBe(true);
    }
  });

  it('o cliente recebe o alcance ESTENDIDO, não o do dado', () => {
    const { msm, eventos } = fazerMotor([]);
    msm.cast(fazerJogador(), RELIC_DEFS.r30, 0, 110, {});
    const cast = eventos.find(e => e.type === 'monster_skill_cast');
    expect(cast.params.length).toBe(120);
  });
});

describe('Muralha de Maré', () => {
  it('a onda alcança o dobro do que alcançava', () => {
    expect(RELIC_DEFS.r31.length).toBe(200);
  });

  it('machuca quem está no fim do percurso', () => {
    const longe = fazerNpc('longe', 0, 190);
    const { msm, eventos } = fazerMotor([longe]);
    msm.cast(fazerJogador(), RELIC_DEFS.r31, 0, 190, {});
    vi.runAllTimers();
    expect(dano(eventos).some(h => h.id === 'longe')).toBe(true);
  });
});
