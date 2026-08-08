/**
 * Carapaça Eriçada no caminho do TIRO — reflete SEMPRE, e o quanto promete.
 *
 * Relato do jogador: "reflete apenas o primeiro tiro, o resto não faz nada, e
 * o dano refletido está fixo em 1". Este arquivo exercita o `hit()` de verdade,
 * tiro a tiro, para separar o que é bug do que é percepção.
 *
 * O `projectile-manager` puxa o `db-manager` no topo, que tenta abrir conexão
 * ao subir. Por isso o módulo é substituído no `require.cache` ANTES do import
 * — só `db.save` é usado aqui, e um no-op serve.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const dbPath = require.resolve('../../managers/db-manager.js');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, children: [], paths: [],
  exports: { save: () => {} },
};

const ProjectileManager = require('../../managers/projectile-manager.js');
const { MAP_DEFS, RELIC_DEFS, AMMO_DEFS } = require('../../constants/index.js');

const DEF = RELIC_DEFS.r32;
const MAP = 2;                       // mapa amarelo: PvE normal, sem regra de zona

let pm, eventos, players, npcs, bicho, jogador;

function novoTiro() {
  return {
    id: 'proj' + Math.random(), ownerId: 'n1', ownerIsNPC: true,
    ammoType: 'bala_ferro', cannonDmg: bicho.cannonDmg,
    damageMultiplier: 1.0, isCrit: false,
    hitTargets: new Set(), piercing: false, dead: false, mapLevel: MAP,
  };
}

/** Um tiro do bicho no jogador. Devolve o que aconteceu. */
function atirar() {
  const hpJogador = jogador.hp, hpBicho = bicho.hp;
  const antes = eventos.length;
  const p = novoTiro();
  pm.projectiles.set(p.id, p);
  pm.hit(p, jogador, false);
  const refl = eventos.slice(antes).filter(e => e.type === 'bulwark_reflect');
  return {
    levou: hpJogador - jogador.hp,
    devolveu: hpBicho - bicho.hp,
    evento: refl[0] || null,
  };
}

beforeEach(() => {
  eventos = [];
  players = new Map();
  npcs = new Map();
  pm = new ProjectileManager({ clients: new Set() }, players, npcs, null, null, MAP_DEFS);
  pm._broadcastToMap = (_lvl, e) => eventos.push(e);
  pm.projectiles = new Map();

  bicho = { id: 'n1', isNPC: true, dead: false, hp: 1e9, maxHp: 1e9,
            x: 0, z: 0, mapLevel: MAP, cannonDmg: 800 };
  npcs.set('n1', bicho);

  jogador = { id: 'p1', dead: false, hp: 1e9, maxHp: 1e9, x: 10, z: 0, mapLevel: MAP,
              ws: { readyState: 1, send() {} },
              relicBulwarkExpires: Date.now() + 5000,
              relicBulwarkReduction: DEF.damageReduction,
              relicBulwarkReflect: DEF.reflectPct };
  players.set('p1', jogador);
});

describe('reflete em TODOS os tiros, não só no primeiro', () => {
  it('cinco tiros seguidos, cinco reflexões', () => {
    const rodadas = [];
    for (let i = 0; i < 5; i++) rodadas.push(atirar());
    for (const [i, r] of rodadas.entries()) {
      expect(r.evento, `tiro ${i + 1} não refletiu`).toBeTruthy();
      expect(r.devolveu, `tiro ${i + 1} não tirou HP do bicho`).toBeGreaterThan(0);
    }
  });

  it('todos devolvem o MESMO valor (nada decai a cada tiro)', () => {
    const vals = [];
    for (let i = 0; i < 5; i++) vals.push(atirar().evento.dmg);
    expect(new Set(vals).size, `valores: ${vals}`).toBe(1);
  });
});

describe('o valor refletido é o que a relíquia promete', () => {
  it('não é 1 fixo — escala com o dano do golpe', () => {
    const fraco = atirar().evento.dmg;
    bicho.cannonDmg = 8000;                    // 10x mais forte
    const forte = atirar().evento.dmg;
    expect(fraco).toBeGreaterThan(1);
    expect(forte).toBeGreaterThan(fraco * 5);
  });

  it('reflexão = reflectPct do que foi MITIGADO', () => {
    // Dano cheio, sem carapaça, para saber a base.
    delete jogador.relicBulwarkExpires;
    const semCasca = atirar().levou;
    expect(semCasca).toBeGreaterThan(0);

    jogador.relicBulwarkExpires = Date.now() + 5000;
    const r = atirar();
    const mitigado = Math.round(semCasca * DEF.damageReduction);
    expect(r.levou).toBe(semCasca - mitigado);
    expect(r.evento.dmg).toBe(Math.round(mitigado * DEF.reflectPct));
  });

  it('o evento aponta quem levou e quem devolveu', () => {
    const r = atirar();
    expect(r.evento.targetId).toBe('p1');
    expect(r.evento.shooterId).toBe('n1');
    expect(r.evento.hp).toBe(bicho.hp);
  });
});

describe('limites', () => {
  it('expirada, não reflete mais', () => {
    jogador.relicBulwarkExpires = Date.now() - 1;
    const r = atirar();
    expect(r.evento).toBeNull();
    expect(r.devolveu).toBe(0);
  });

  it('a munição base é pequena — o grosso do dano vem do canhão do bicho', () => {
    // Justifica por que o valor refletido pareceria "1" com um bicho fraco:
    // sem cannonDmg, o tiro inteiro vale `ammo.damage`.
    expect(AMMO_DEFS.bala_ferro.damage).toBeLessThan(20);
    bicho.cannonDmg = 0;
    const r = atirar();
    expect(r.evento === null || r.evento.dmg <= 2).toBe(true);
  });
});
