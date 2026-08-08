/**
 * Testes do gate ⭐ (utils/star-gate.js)
 *
 * Regra: as 8 skills marcadas com `star: true` no bestiário são o ataque forte
 * de cada conjunto. O BICHO só as usa na LUA DE SANGUE e a RELÍQUIA só cai lá —
 * o USO pelo jogador é livre (não há gate de uso a testar aqui).
 *
 * Cobre:
 *  1. As 8 ⭐ estão marcadas no dado (e nada além delas)
 *  2. `star` chega ao ATTACK_DEFS (bicho) e ao RELIC_DEFS (UI)
 *  3. Drop: ⭐ barrada fora da lua, liberada nela; não-⭐ passa sempre
 *  4. Ataque: mesma coisa para a escolha do bicho
 *  5. Conjunto do carangueijo (mapa 1) — o caso que motivou o gate
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { starDropAllowed, starAttackAllowed } = require('../star-gate.js');
const {
  STAR_RELIC_IDS, MONSTER_ATTACK_DEFS, MONSTER_RELIC_DEFS, SKILLS_BY_SOURCE,
  MONSTER_SKILLS,
} = require('../../constants/monster_skills.js');

const NORMAL = false;   // noite comum ou dia — tanto faz
const LUA    = true;    // Lua de Sangue ativa

describe('marcação das ⭐ no bestiário', () => {
  // Quantas ⭐ existem é decisão de design e muda com o balanceamento (a cobra
  // já tem duas). O teste confere a CONSISTÊNCIA, não uma lista fixa.
  const marcadas = Object.values(MONSTER_SKILLS).filter(s => s.star);

  it('o conjunto de ⭐ vem do dado e cobre só relíquias reais', () => {
    expect(STAR_RELIC_IDS.size).toBe(marcadas.length);
    expect(STAR_RELIC_IDS.size).toBeGreaterThan(0);
    for (const id of STAR_RELIC_IDS) expect(MONSTER_RELIC_DEFS[id]).toBeDefined();
  });

  it('nenhum bicho tem SÓ ⭐ no conjunto', () => {
    // Se todas as skills de um bicho fossem ⭐, fora da Lua de Sangue ele não
    // teria ataque nenhum nem relíquia para dropar — o bicho viraria inofensivo
    // e sem recompensa em 99% do tempo.
    for (const [source, ids] of Object.entries(SKILLS_BY_SOURCE)) {
      const normais = ids.filter(id => !STAR_RELIC_IDS.has(id));
      expect(normais.length, `${source} só tem ⭐`).toBeGreaterThan(0);
    }
  });

  it('propaga `star` para o ATTACK_DEFS do bicho e para o RELIC_DEFS', () => {
    const atksStar = Object.values(MONSTER_ATTACK_DEFS).filter(a => a.star);
    expect(atksStar).toHaveLength(marcadas.length);
    expect(MONSTER_RELIC_DEFS.r17.star).toBe(true);   // Fúria da Maré ⭐
    expect(MONSTER_RELIC_DEFS.r14.star).toBe(false);  // Pinça Esmagadora
  });
});

describe('drop: ⭐ só cai na Lua de Sangue', () => {
  it('barra a ⭐ fora da lua e libera nela', () => {
    expect(starDropAllowed('r17', NORMAL)).toBe(false);
    expect(starDropAllowed('r17', LUA)).toBe(true);
  });

  it('não interfere nas relíquias comuns do bestiário', () => {
    for (const id of ['r14', 'r15', 'r16']) {
      expect(starDropAllowed(id, NORMAL)).toBe(true);
      expect(starDropAllowed(id, LUA)).toBe(true);
    }
  });

  it('não interfere nas relíquias base (r1..r13)', () => {
    for (const id of ['r1', 'r5', 'r13']) {
      expect(starDropAllowed(id, NORMAL)).toBe(true);
    }
  });

  it('carangueijo (mapa 1): fora da lua o pool cai de 4 para 3 relíquias', () => {
    const pool = SKILLS_BY_SOURCE['carangueijo'];
    expect(pool).toHaveLength(4);
    expect(pool.filter(id => starDropAllowed(id, NORMAL))).toEqual(['r14', 'r15', 'r16']);
    expect(pool.filter(id => starDropAllowed(id, LUA))).toHaveLength(4);
  });

  it('fora da lua, quem já tem as 3 do carangueijo não recebe a ⭐ por eliminação', () => {
    const owned = new Set(['r14', 'r15', 'r16']);
    const takeable = SKILLS_BY_SOURCE['carangueijo']
      .filter(id => !owned.has(id) && starDropAllowed(id, NORMAL));
    expect(takeable).toEqual([]);   // antes do gate, aqui a ⭐ era 100% garantida
  });
});

describe('ataque: o bicho só usa a ⭐ na Lua de Sangue', () => {
  const furiaDaMare = MONSTER_ATTACK_DEFS['crab_tidal_frenzy']; // ⭐ do mapa 1
  const pinca       = MONSTER_ATTACK_DEFS['crab_claw_slam'];

  it('barra a ⭐ fora da lua e libera nela', () => {
    expect(starAttackAllowed(furiaDaMare, NORMAL)).toBe(false);
    expect(starAttackAllowed(furiaDaMare, LUA)).toBe(true);
  });

  it('deixa os ataques normais passarem sempre', () => {
    expect(starAttackAllowed(pinca, NORMAL)).toBe(true);
    expect(starAttackAllowed(pinca, LUA)).toBe(true);
  });

  it('ataques sem o campo (r1..r13 e ataques antigos) nunca são barrados', () => {
    expect(starAttackAllowed({ id: 'cannon_volley' }, NORMAL)).toBe(true);
    expect(starAttackAllowed(undefined, NORMAL)).toBe(true);
  });

  it('carangueijo fora da lua mantém 3 dos 4 ataques', () => {
    const doCrab = Object.values(MONSTER_ATTACK_DEFS)
      .filter(a => a.skill && a.skill.startsWith('crab_') && !a.skill.includes('boss'));
    expect(doCrab).toHaveLength(4);
    expect(doCrab.filter(a => starAttackAllowed(a, NORMAL))).toHaveLength(3);
  });
});
