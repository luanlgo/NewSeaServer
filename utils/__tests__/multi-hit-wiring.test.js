/**
 * Encanamento do acerto `multi` — do telegraph até o `_isHit`.
 *
 * A geometria das sub-áreas já tinha teste (aimed-ring.test.js) e passava: o
 * `scatter` mirava certo e o `inShape` conferia certo. Mesmo assim NENHUM
 * ataque `multi` acertava ninguém no jogo, e do lado do jogador isso lia como
 * "Esquiva!" toda vez — inclusive parado em cima da marcação.
 *
 * O furo estava ENTRE as duas pontas. O `_resolveAttack` monta um snapshot do
 * cast (`{x, z}`, capturado antes da investida mover o bicho) e o passa ao
 * `_isHit` num parâmetro que se chamava `npc`. O ramo do `multi` lia
 * `npc._castPoints` — que no snapshot não existia. `inShape` recebia
 * `undefined`, caía em `[].some()` e devolvia `false` sempre.
 *
 * Por isso estes testes atravessam o caminho REAL (telegraph → resolve) em vez
 * de exercitar a geometria de novo: era só aí que dava para ver o problema.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AttackManager = require('../../managers/attack-manager.js');
const { ATTACK_DEFS } = require('../../constants/index.js');

const MAP = 1;

/** NPC mínimo, só com o que o caminho de ataque toca. */
function fazerNpc(attackId) {
  return {
    id: 'npc1', x: 0, z: 0, dead: false,
    hp: 1000, maxHp: 1000, cannonDmg: 100, dmgMult: 1,
    attacks: [attackId], _attackCooldowns: {},
  };
}

function fazerJogador(x, z) {
  return { id: 'p1', x, z, dead: false, hp: 1000, maxHp: 1000, mapLevel: MAP };
}

/**
 * Roda o ciclo inteiro de um ataque e devolve os eventos emitidos. O cast e os
 * ticks são agendados com setTimeout — daí os timers falsos.
 */
function atacar(attackId, npc, jogador) {
  const eventos = [];
  const am = new AttackManager((e) => eventos.push(e), null);
  am.tryAttack(npc, jogador, [jogador], MAP);
  vi.runAllTimers();
  return eventos;
}

const hitDoJogador = (eventos) =>
  eventos.filter(e => e.type === 'npc_attack_hit')
         .flatMap(e => e.hits || [])
         .filter(h => h.id === 'p1');

// As seis skills `multi` do bestiário — as duas do caranguejo foram as que o
// jogador reportou, mas o furo era do encanamento e derrubava todas.
// O Cemitério de Naufrágios continua com `shape: 'multi'` no dado, mas desde
// 2026-08-03 NÃO resolve por `points`: virou chuva simulada (uma queda por vez,
// mirada ao vivo — ver wreck-rain.test.js). Fica de fora daqui, e o teste de
// cobertura abaixo sabe disso.
const CHUVA = ['turtle_boss_wreck_field'];

const SKILLS_MULTI = [
  'crab_boss_mortar', 'crab_boss_tentacles', 'wyrm_pustule_burst',
  'charnel_death_mark', 'charnel_brood_hatch',
];

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('todas as skills do bestiário marcadas como `multi` estão na lista', () => {
  it('nenhuma `multi` de fora do conjunto testado', () => {
    const doDef = Object.entries(ATTACK_DEFS)
      .filter(([, d]) => d.shape === 'multi' && !d.dropIntervalMs)
      .map(([id]) => id);
    expect(doDef.sort()).toEqual([...SKILLS_MULTI].sort());
    // E a chuva continua sendo `multi` no dado — se alguém tirar isso, este
    // teste avisa em vez de a skill sumir da conferência em silêncio.
    for (const id of CHUVA) expect(ATTACK_DEFS[id].shape).toBe('multi');
  });
});

describe('o telegraph e a resolução leem os MESMOS pontos', () => {
  for (const id of SKILLS_MULTI) {
    it(`${id}: os pontos anunciados sobrevivem até o _isHit`, () => {
      const npc = fazerNpc(id);
      const eventos = atacar(id, npc, fazerJogador(0, 40));

      const tele = eventos.find(e => e.type === 'npc_telegraph');
      expect(tele, 'o telegraph precisa sair').toBeTruthy();
      expect(Array.isArray(tele.points), 'multi anuncia sub-áreas').toBe(true);
      expect(tele.points.length).toBeGreaterThan(0);

      // O snapshot do cast é o que o `_isHit` recebe; se ele perder os pontos,
      // o `inShape` cai em `[].some()` e o ataque vira inofensivo.
      const snapshot = { x: npc.x, z: npc.z, _castPoints: npc._castPoints };
      expect(snapshot._castPoints).toEqual(tele.points);
    });
  }
});

describe('quem está DENTRO de uma sub-área leva o golpe', () => {
  for (const id of SKILLS_MULTI) {
    it(`${id}: parado em cima de um ponto anunciado, toma dano`, () => {
      const def = ATTACK_DEFS[id];
      const npc = fazerNpc(id);
      // Posição do jogador decidida DEPOIS do telegraph seria trapaça (os
      // pontos são relativos ao alvo no momento do cast). Então: ataca uma vez
      // só, e o jogador fica exatamente no centro de uma sub-área sorteada —
      // que é o caso do "parado em cima" que o jogador relatou.
      const eventos = [];
      const am = new AttackManager((e) => eventos.push(e), null);
      const jogador = fazerJogador(0, 0);
      am.tryAttack(npc, jogador, [jogador], MAP);

      const tele = eventos.find(e => e.type === 'npc_telegraph');
      const alvo = tele.points[0];
      jogador.x = tele.x + alvo.x;
      jogador.z = tele.z + alvo.z;

      vi.runAllTimers();

      const meus = hitDoJogador(eventos);
      expect(meus.length, 'deveria ter sido atingido pelo menos uma vez')
        .toBeGreaterThan(0);
      expect(meus[0].dmg).toBeGreaterThan(0);
      expect(def.radius).toBeGreaterThan(0);
    });
  }
});

describe('quem está FORA de todas as sub-áreas escapa', () => {
  for (const id of SKILLS_MULTI) {
    it(`${id}: longe da marcação, não toma nada`, () => {
      const npc = fazerNpc(id);
      const eventos = [];
      const am = new AttackManager((e) => eventos.push(e), null);
      const jogador = fazerJogador(0, 0);
      am.tryAttack(npc, jogador, [jogador], MAP);

      const tele = eventos.find(e => e.type === 'npc_telegraph');
      // Bem além do espalhamento + raio: nenhuma sub-área alcança.
      const fora = (ATTACK_DEFS[id].spread || 100) + (ATTACK_DEFS[id].radius || 20) + 500;
      jogador.x = tele.x + fora;
      jogador.z = tele.z + fora;

      vi.runAllTimers();

      expect(hitDoJogador(eventos)).toHaveLength(0);
    });
  }
});

describe('aimed_ring: o golpe mirado do caranguejo não perdoa quem fica parado', () => {
  for (const id of ['crab_boss_mortar', 'crab_boss_tentacles']) {
    it(`${id}: parado onde o cast começou, SEMPRE leva`, () => {
      // 30 rodadas porque a brecha do anel gira a cada uso — o obus mirado é
      // que garante o acerto no centro, e é ele que estava sem efeito.
      for (let i = 0; i < 30; i++) {
        const jogador = fazerJogador(0, 0);
        const eventos = atacar(id, fazerNpc(id), jogador);
        expect(hitDoJogador(eventos).length,
          `rodada ${i}: parado no centro tem que levar`).toBeGreaterThan(0);
      }
    });
  }
});
