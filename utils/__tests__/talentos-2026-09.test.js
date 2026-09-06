/**
 * A leva de talentos de 09/2026 — as mecânicas NOVAS, rodando de verdade.
 *
 * O talent-wiring prova que cada stat vira número, e o talent-callsites prova
 * que alguém no jogo lê esse número. Nenhum dos dois roda o código: eles leem o
 * arquivo. É por isso que este existe — foi um `status.noteHit` sem o require
 * correspondente no server.js que passou pelos dois e só apareceria no primeiro
 * uso de relíquia com Barreira Arcana comprada.
 *
 * Cobre: o escudo de absorção, a sequência de acertos, o bloqueio, o Casco
 * Duplo, a família de cura e os dois nós da Mesa de Exploração.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// O db-manager abre conexão ao subir — substituído no cache ANTES do import,
// mesmo truque do cannon-accuracy.test.js.
const dbPath = require.resolve('../../managers/db-manager.js');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, children: [], paths: [],
  exports: { save: () => {} },
};

const ProjectileManager = require('../../managers/projectile-manager.js');
const { MAP_DEFS } = require('../../constants/index.js');
const shield = require('../shield.js');
const fx     = require('../talent-effects.js');
const tl     = require('../talent-logic.js');
const { TALENT_DEFS } = require('../../constants/talents.js');

const MAP = 2;
const ALVO = { x: 0, z: 100 };

/** Jogador com os talentos pedidos já agregados em `tal`. */
function jogador(talentos = {}, extra = {}) {
  const p = {
    id: 'p1', name: 'p1', dead: false, hp: 1000, maxHp: 1000, x: 0, z: 0,
    mapLevel: MAP, mana: 0, maxMana: 10,
    activeShip: 'fragata', skills: {}, shipIslandUpgrades: {},
    ws: { readyState: 1, OPEN: 1, bufferedAmount: 0, send: () => {} },
    cannons: ['c1', 'c1', 'c1', 'c1'],
    inventory: { ammo: {} }, currentAmmo: 'bala_ferro',
    cannonDamage: 100, cannonRange: 200, cannonCooldownMax: 10,
    ...extra,
    talents: talentos,
  };
  tl.applyTalentBonuses(p, TALENT_DEFS);
  return p;
}

// ═════════════════════════════════════════════════════════════════════════════
describe('escudo de absorção', () => {
  it('fica na FRENTE da vida e devolve só o que sobrou', () => {
    const p = jogador();
    shield.grant(p, 300, 8000);
    const r = shield.absorb(p, 500);
    expect(r.absorbed).toBe(300);
    expect(r.dmg).toBe(200);
    expect(r.broke).toBe(true);
    expect(shield.shieldHp(p)).toBe(0);
  });

  it('golpe menor que o escudo não fura', () => {
    const p = jogador();
    shield.grant(p, 300, 8000);
    const r = shield.absorb(p, 120);
    expect(r.dmg).toBe(0);
    expect(r.broke).toBe(false);
    expect(shield.shieldHp(p)).toBe(180);
  });

  it('vence sozinho — não é uma segunda barra de vida permanente', () => {
    const p = jogador();
    const t0 = 1_700_000_000_000;
    shield.grant(p, 300, 8000, t0);
    expect(shield.shieldHp(p, t0 + 7999)).toBe(300);
    expect(shield.shieldHp(p, t0 + 8001)).toBe(0);
  });

  it('escudos NÃO se somam — o maior manda e o prazo renova', () => {
    // Sem esta regra, encadear relíquia barata empilharia escudo até virar
    // vida infinita.
    const p = jogador();
    shield.grant(p, 300, 8000);
    shield.grant(p, 100, 8000);
    expect(shield.shieldHp(p)).toBe(300);
    shield.grant(p, 500, 8000);
    expect(shield.shieldHp(p)).toBe(500);
  });

  it('avisa o dono, que é a metade que faltava', () => {
    // A queixa do playtest não foi "o escudo é fraco", foi "nem percebi esse
    // escudo": o servidor somava no hp e nada aparecia na tela.
    const recados = [];
    shield.setNotifier((_e, msg) => recados.push(msg.type));
    const p = jogador();
    shield.grant(p, 200, 8000);
    shield.absorb(p, 50);
    shield.absorb(p, 999);
    shield.setNotifier(null);
    expect(recados).toEqual(['shield_up', 'shield_hit', 'shield_down']);
  });

  it('a Barreira Arcana escala com a vida máxima', () => {
    const p = jogador({ def_barreira: 10 }, { maxHp: 4000 });
    expect(fx.relicShieldAmount(p)).toBe(400);   // 10% de 4000
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Casco Duplo (escudo ao cair abaixo de 20%)', () => {
  const T0 = 1_700_000_000_000;

  it('dispara ao CRUZAR o limiar, não a cada golpe abaixo dele', () => {
    const p = jogador({ def_cascoliso: 10 }, { hp: 150, maxHp: 1000 });
    expect(fx.lowHpShieldAmount(p, T0)).toBe(100);       // 10% de 1000
    expect(fx.lowHpShieldAmount(p, T0 + 1)).toBe(0);     // já disparou
  });

  it('rearma quando a vida volta acima de 20%', () => {
    const p = jogador({ def_cascoliso: 10 }, { hp: 150, maxHp: 1000 });
    expect(fx.lowHpShieldAmount(p, T0)).toBe(100);
    p.hp = 900;
    expect(fx.lowHpShieldAmount(p, T0 + 100)).toBe(0);   // acima do limiar: rearma
    p.hp = 100;
    // Mesmo rearmado, o piso de tempo segura: oscilar em torno de 20% não pode
    // virar escudo infinito.
    expect(fx.lowHpShieldAmount(p, T0 + 200)).toBe(0);
    expect(fx.lowHpShieldAmount(p, T0 + fx.LOW_HP_SHIELD_MS * 3)).toBe(100);
  });

  it('sem o talento não dispara nunca', () => {
    const p = jogador({}, { hp: 50, maxHp: 1000 });
    expect(fx.lowHpShieldAmount(p, T0)).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('sequência de acertos (Cadência Mortal e Broca Corsária)', () => {
  let pm, players, npcs;

  beforeEach(() => {
    players = new Map();
    npcs    = new Map();
    pm = new ProjectileManager({ clients: new Set() }, players, npcs, null, null, MAP_DEFS);
    pm._broadcastToMap = () => {};
    pm.projectiles = new Map();
  });

  it('o tiro que ACERTA soma pilha e o que ERRA zera', () => {
    const p = jogador({ atk_rastro: 10 }, { cannonAccuracy: 1 });
    players.set('p1', p);
    pm.spawnSalvo(p, ALVO.x, ALVO.z);
    expect(p._streakStacks).toBe(4);            // 4 canhões, mira 100%

    p.cannonAccuracy = 0;
    pm.spawnSalvo(p, ALVO.x, ALVO.z);
    expect(p._streakStacks, 'errar tem de zerar a sequência').toBe(0);
  });

  it('cada nó conta até o PRÓPRIO teto, não a pilha crua', () => {
    // 3 níveis = teto 6. Com 50 pilhas na conta, o nó só pode valer 6.
    const p = jogador({ atk_rastro: 3 }, { _streakStacks: 50 });
    expect(fx.streakStacks(p, 'streak_damage_stacks')).toBe(6);
    expect(fx.outgoingDamageMult(p, {})).toBeCloseTo(1 + 6 * 0.02, 6);
  });

  it('no talento cheio a sequência vale +40% de dano', () => {
    const p = jogador({ atk_rastro: 10 }, { _streakStacks: 99 });
    expect(fx.outgoingDamageMult(p, {})).toBeCloseTo(1.40, 6);
  });

  it('a Broca lê a MESMA pilha e vira perfuração', () => {
    const p = jogador({ atk_bordolivre: 10 }, { _streakStacks: 99 });
    expect(fx.armorPen(p)).toBeCloseTo(0.40, 6);
  });

  it('as duas perfurações somam (Bala Perfurante + Ponta de Aço)', () => {
    const p = jogador({ atk_perfurante: 10, atk_investida: 10 });
    expect(fx.armorPen(p)).toBeCloseTo(0.15 + 0.20, 6);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('as reduções novas e o bloqueio', () => {
  it('Anteparo bloqueia 5% no talento cheio', () => {
    expect(fx.blockChance(jogador({ def_anteparo: 10 }))).toBeCloseTo(0.05, 6);
    expect(fx.blockChance(jogador())).toBe(0);
  });

  it('Escudo de Assédio só vale contra TORRE', () => {
    const p = jogador({ def_ancoragem: 10 });
    expect(fx.damageReduction(p, { fromTower: true })).toBeCloseTo(0.20, 6);
    expect(fx.damageReduction(p, { fromNPC: true })).toBeCloseTo(0, 6);
  });

  it('Guarda de Bordada só vale contra NAVIO de NPC', () => {
    const p = jogador({ def_marchare: 10 });
    expect(fx.damageReduction(p, { fromNpcShip: true })).toBeCloseTo(0.10, 6);
    expect(fx.damageReduction(p, { fromNPC: true })).toBeCloseTo(0, 6);
  });

  it('Maresia Purificadora só vale em dano CONTÍNUO', () => {
    const p = jogador({ def_maresia: 10 });
    expect(fx.damageReduction(p, { isDot: true })).toBeCloseTo(0.05, 6);
    expect(fx.damageReduction(p, {})).toBeCloseTo(0, 6);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('a família de cura', () => {
  const T0 = 1_700_000_000_000;
  const FORA = { lastCombatTime: T0 - fx.OUT_OF_COMBAT_MS - 1 };

  it('os três nós somam, e o de fora de combate só fora dele', () => {
    const p = jogador({ def_calafate: 10, def_recuperacao: 10, def_reparo: 10 }, FORA);
    expect(fx.healingReceivedMult(p, T0)).toBeCloseTo(1.50, 6);
    p.lastCombatTime = T0;
    expect(fx.healingReceivedMult(p, T0)).toBeCloseTo(1.30, 6);
  });

  it('sobrou UMA regeneração: as Bombas de Porão, abaixo de 40%', () => {
    const p = jogador({ def_bombeamento: 10 }, { hp: 300, maxHp: 1000, ...FORA });
    expect(fx.hpRegenPerSec(p, T0)).toBeCloseTo(30, 6);
    p.hp = 900;
    expect(fx.hpRegenPerSec(p, T0)).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Mesa de Exploração e renascimento', () => {
  it('Garimpeiro multiplica e Escavação Profunda sorteia rolagem extra', () => {
    expect(fx.explorationLootMult(jogador({ res_colheita: 10 }))).toBeCloseTo(1.10, 6);
    expect(fx.explorationDoubleChance(jogador({ res_porao: 10 }))).toBeCloseTo(0.10, 6);
    expect(fx.fragmentExtraChance(jogador({ res_ventoproprio: 10 }))).toBeCloseTo(0.30, 6);
  });

  it('Volta por Cima levanta a vida do renascimento a partir dos 10% de base', () => {
    expect(fx.respawnHpFrac(jogador())).toBeCloseTo(0.10, 6);
    expect(fx.respawnHpFrac(jogador({ def_retorno: 10 }))).toBeCloseTo(0.40, 6);
  });

  it('Trégua soma segundos inteiros no período seguro', () => {
    expect(fx.respawnImmunityBonus(jogador({ def_tregua: 10 }))).toBe(10000);
  });

  it('Vínculo Selvagem corta a recarga da relíquia do pet em segundos', () => {
    expect(fx.petRelicCooldownReduction(jogador({ res_lamparina: 10 }))).toBe(5000);
    expect(fx.petXpMult(jogador({ res_impulso: 10 }))).toBeCloseTo(1.10, 6);
  });
});
