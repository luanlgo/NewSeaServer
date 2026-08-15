/**
 * Carapaça Eriçada na casca do BICHO (leviathan_shell_bulwark).
 *
 * O `special: 'bulwark'` só existia do lado da RELÍQUIA. Na mão do leviatã-
 * tartaruga ele caía na resolução comum de área e virava duas coisas erradas
 * ao mesmo tempo:
 *
 *   • um círculo de raio 70 que tirava 1 de vida de quem estivesse perto — o
 *     piso `Math.max(1, …)` fabricando dano onde o dado diz `damageMult: 0`.
 *     Era o "tomo 1 de dano fixo e depois mais nada" do playtest;
 *   • nenhum buff: o bicho eriçava as placas no desenho e seguia tomando dano
 *     cheio, sem mitigar e sem devolver nada. O guard `!isNPC` no
 *     projectile-manager ainda descartava a carapaça dele no caminho do tiro.
 *
 * O irmão deste arquivo é bulwark-projectile.test.js, que cobre a mesma
 * carapaça no JOGADOR.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// projectile-manager puxa o db-manager no topo, que abre conexão ao subir.
const dbPath = require.resolve('../../managers/db-manager.js');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, children: [], paths: [],
  exports: { save: () => {} },
};

const AttackManager     = require('../../managers/attack-manager.js');
const ProjectileManager = require('../../managers/projectile-manager.js');
const { ATTACK_DEFS, MAP_DEFS } = require('../../constants/index.js');

const DEF = ATTACK_DEFS.leviathan_shell_bulwark;
const MAP = 2;

function montarBicho() {
  const eventos = [];
  const npcs = new Map();
  const npc = {
    id: 'tarta', x: 0, z: 0, dead: false, hp: 1e9, maxHp: 1e9, mapLevel: MAP,
    cannonDmg: 400, dmgMult: 1,
    attacks: ['leviathan_shell_bulwark'], _attackCooldowns: {},
  };
  npcs.set(npc.id, npc);
  const am = new AttackManager(e => eventos.push(e), { npcs });
  return { npc, npcs, eventos, am };
}

const fazerAlvo = () => ({
  id: 'p1', x: 0, z: 30, dead: false, hp: 10000, maxHp: 10000, mapLevel: MAP,
});

/** Roda o cast inteiro (telegraph → resolução). */
function conjurar(am, npc, p) {
  am.tryAttack(npc, p, [p], MAP);
  vi.runAllTimers();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('o dado diz que não machuca', () => {
  it('damageMult é 0 — a skill é buff, não ataque', () => {
    expect(DEF.damageMult).toBe(0);
  });

  it('quem está no raio não perde vida (nem o 1 do piso)', () => {
    const { npc, am } = montarBicho();
    const p = fazerAlvo();
    conjurar(am, npc, p);
    expect(p.hp, 'a carapaça tirou vida de quem estava perto').toBe(p.maxHp);
  });

  it('o acerto anunciado, se houver, vem com dano 0', () => {
    const { npc, am, eventos } = montarBicho();
    const p = fazerAlvo();
    conjurar(am, npc, p);
    for (const h of eventos.filter(e => e.type === 'npc_attack_hit')
                           .flatMap(e => e.hits || [])) {
      expect(h.dmg).toBe(0);
    }
  });
});

describe('as placas sobem no PRÓPRIO bicho', () => {
  it('o buff fica gravado nele, com os números do dado', () => {
    const { npc, am } = montarBicho();
    conjurar(am, npc, fazerAlvo());
    expect(npc.relicBulwarkExpires).toBeGreaterThan(Date.now());
    expect(npc.relicBulwarkReduction).toBe(DEF.damageReduction);
    expect(npc.relicBulwarkReflect).toBe(DEF.reflectPct);
  });

  it('o mapa é avisado, senão o cliente não desenha nada', () => {
    const { npc, am, eventos } = montarBicho();
    conjurar(am, npc, fazerAlvo());
    const fx = eventos.find(e => e.type === 'relic_effect' && e.effect === 'bulwark');
    expect(fx).toBeDefined();
    expect(fx.casterId).toBe(npc.id);
    expect(fx.duration).toBe(DEF.durationMs);
  });
});

describe('com as placas de pé, o tiro do jogador é mitigado e VOLTA', () => {
  let pm, eventos, players, npcs, bicho, jogador;

  beforeEach(() => {
    eventos = [];
    players = new Map();
    npcs    = new Map();
    pm = new ProjectileManager({ clients: new Set() }, players, npcs, null, null, MAP_DEFS);
    pm._broadcastToMap = (_lvl, e) => eventos.push(e);
    pm.projectiles = new Map();

    bicho = { id: 'n1', isNPC: true, dead: false, hp: 1e9, maxHp: 1e9,
              x: 0, z: 0, mapLevel: MAP, cannonDmg: 0 };
    npcs.set('n1', bicho);

    jogador = { id: 'p1', dead: false, hp: 1e9, maxHp: 1e9, x: 10, z: 0, mapLevel: MAP,
                cannonDmg: 800, ws: { readyState: 1, send() {} } };
    players.set('p1', jogador);
  });

  /** Um tiro do JOGADOR no bicho. */
  function atirarNoBicho() {
    const hpBicho = bicho.hp, hpJogador = jogador.hp;
    const antes = eventos.length;
    const p = { id: 'proj' + Math.random(), ownerId: 'p1', ownerIsNPC: false,
                ammoType: 'bala_ferro', cannonDmg: 800, damageMultiplier: 1.0,
                isCrit: false, hitTargets: new Set(), piercing: false,
                dead: false, mapLevel: MAP };
    pm.projectiles.set(p.id, p);
    pm.hit(p, bicho, true);
    return {
      levou:    hpBicho - bicho.hp,
      devolveu: hpJogador - jogador.hp,
      evento:   eventos.slice(antes).find(e => e.type === 'bulwark_reflect') || null,
    };
  }

  it('sem carapaça: dano cheio e nada volta', () => {
    const r = atirarNoBicho();
    expect(r.levou).toBeGreaterThan(0);
    expect(r.devolveu).toBe(0);
    expect(r.evento).toBeNull();
  });

  it('com carapaça: o bicho leva MENOS e o atirador leva o troco', () => {
    const cheio = atirarNoBicho().levou;

    bicho.relicBulwarkExpires   = Date.now() + 5000;
    bicho.relicBulwarkReduction = DEF.damageReduction;
    bicho.relicBulwarkReflect   = DEF.reflectPct;

    const r = atirarNoBicho();
    expect(r.levou, 'a carapaça não mitigou').toBeLessThan(cheio);
    expect(r.devolveu, 'nada voltou para quem atirou').toBeGreaterThan(0);
    expect(r.evento).toBeTruthy();
    expect(r.evento.shooterId).toBe('p1');

    // O troco é reflectPct do que foi MITIGADO, não do golpe inteiro.
    const mitigado = Math.round(cheio * DEF.damageReduction);
    expect(r.evento.dmg).toBe(Math.round(mitigado * DEF.reflectPct));
  });

  it('depois de expirar, volta ao dano cheio', () => {
    const cheio = atirarNoBicho().levou;
    bicho.relicBulwarkExpires   = Date.now() - 1;      // já venceu
    bicho.relicBulwarkReduction = DEF.damageReduction;
    bicho.relicBulwarkReflect   = DEF.reflectPct;
    const r = atirarNoBicho();
    expect(r.levou).toBe(cheio);
    expect(r.evento).toBeNull();
  });
});
