/**
 * Pontaria Mortal — o crítico do canhão (upgrade `cr` do c6).
 *
 * Substituiu o "+30 de Alcance", que se sabotava: a dispersão cresce com a
 * distância (min(12, max(3, dist×0.08))) contra um raio de acerto de 8, então
 * atirar dos 150 un comprados acertava MENOS da metade da salva.
 *
 * O crítico já existia no motor e NUNCA acontecia: `isCrit` só era sorteado
 * dentro do bloco de homing, cuja única fonte é `PIRATE_DEFS[].critChance` — e
 * os dois piratas do jogo são healers com 0. Estes testes cobrem a fonte nova
 * (o canhão), o multiplicador próprio (×2, e não os 1.5 do homing) e o aviso
 * que o cliente usa para desenhar o número dourado.
 *
 * Mesmo truque do bulwark-projectile: o `db-manager` é substituído no
 * require.cache ANTES do import, senão ele tenta abrir conexão ao subir.
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
const { MAP_DEFS } = require('../../constants/index.js');

const MAP = 2;
const UPG = (MAP_DEFS[3].market.items[0].cannonUpgrades || [])
  .find(u => u.id === 'cannon_crit_upgrade');

let pm, eventos, players, npcs, bicho, jogador;

function tiro(extra = {}) {
  return {
    id: 'proj' + Math.random(), ownerId: 'p1', ownerIsNPC: false,
    ammoType: 'bala_ferro', cannonDmg: 100,
    damageMultiplier: 1.0, isCrit: false,
    hitTargets: new Set(), piercing: false, dead: false, mapLevel: MAP,
    ...extra,
  };
}

/**
 * Um tiro do jogador no bicho. Devolve o dano e o evento de acerto.
 * O `hit()` só ACUMULA no lote (uma mensagem por alvo por tick), então o
 * flush é chamado à mão — é ele que emite o `hit` com o `crit`.
 */
function atirar(extra = {}) {
  const hpAntes = bicho.hp;
  const antes = eventos.length;
  const p = tiro(extra);
  pm.projectiles.set(p.id, p);
  pm.hit(p, bicho, true);
  pm._flushHitBatch(Date.now());
  const hits = eventos.slice(antes).filter(e => e.type === 'hit');
  return { dano: hpAntes - bicho.hp, hit: hits[0] || null };
}

beforeEach(() => {
  eventos = [];
  players = new Map();
  npcs = new Map();
  pm = new ProjectileManager({ clients: new Set() }, players, npcs, null, null, MAP_DEFS);
  pm._broadcastToMap = (_lvl, e) => eventos.push(e);
  pm.projectiles = new Map();

  bicho = { id: 'n1', isNPC: true, dead: false, hp: 1e9, maxHp: 1e9,
            x: 10, z: 0, mapLevel: MAP };
  npcs.set('n1', bicho);

  jogador = { id: 'p1', dead: false, hp: 1e9, maxHp: 1e9, x: 0, z: 0, mapLevel: MAP,
              ws: { readyState: 1, send() {} }, cannons: ['c6'], inventory: { ammo: {} },
              currentAmmo: 'bala_ferro', cannonDamage: 100 };
  players.set('p1', jogador);
});

describe('o dado do upgrade', () => {
  it('existe e substitui o alcance', () => {
    expect(UPG).toBeDefined();
    expect(UPG.field).toBe('cr');
    expect(UPG.critChance).toBe(0.20);
    // ×2 e não 1.5: com 20% de chance, 1.5 daria +10% de média — EXATAMENTE o
    // upgrade de Dano, que é comprado JUNTO com este e não no lugar dele.
    expect(UPG.critMult).toBe(2.0);
    const ids = MAP_DEFS[3].market.items[0].cannonUpgrades.map(u => u.id);
    expect(ids).not.toContain('cannon_range_upgrade');
  });

  it('custa mais que o upgrade de dano, porque vale mais', () => {
    const dano = MAP_DEFS[3].market.items[0].cannonUpgrades
      .find(u => u.id === 'cannon_damage_upgrade');
    expect(UPG.price).toBeGreaterThan(dano.price);
  });
});

describe('o crítico no acerto', () => {
  it('dobra o dano com o multiplicador do canhão', () => {
    const normal = atirar().dano;
    bicho.hp = 1e9;
    const critico = atirar({ isCrit: true, critMult: 2.0 }).dano;
    expect(critico).toBe(normal * 2);
  });

  it('sem critMult próprio, cai no 1.5 do homing (compatibilidade)', () => {
    const normal = atirar().dano;
    bicho.hp = 1e9;
    const critico = atirar({ isCrit: true }).dano;
    expect(critico).toBe(Math.round(normal * 1.5));
  });

  it('avisa o cliente QUAL número foi crítico', () => {
    expect(atirar({ isCrit: true, critMult: 2.0 }).hit.crit).toBe(true);
    expect(atirar().hit.crit).toBe(false);
  });
});

describe('o sorteio no disparo', () => {
  function sortear(chance, n = 400) {
    jogador.cannonCritChance = chance;
    jogador.cannonCritMult   = 2.0;
    let crits = 0;
    for (let i = 0; i < n; i++) {
      const p = pm.spawn(jogador, 30, 0, 0, 1.0, 100);
      if (p.isCrit) crits++;
      pm.projectiles.delete(p.id);
    }
    return crits / n;
  }

  it('não sai crítico sem o upgrade', () => {
    expect(sortear(0)).toBe(0);
  });

  it('sai sempre com chance 1', () => {
    expect(sortear(1)).toBe(1);
  });

  it('fica perto da chance anunciada', () => {
    const taxa = sortear(0.20, 2000);
    expect(taxa).toBeGreaterThan(0.15);
    expect(taxa).toBeLessThan(0.25);
  });

  it('o projétil carrega o multiplicador do canhão', () => {
    jogador.cannonCritChance = 1;
    jogador.cannonCritMult   = 2.0;
    const p = pm.spawn(jogador, 30, 0, 0, 1.0, 100);
    expect(p.critMult).toBe(2.0);
  });

  it('bicho não critica — a fonte é o canhão do jogador', () => {
    const npcAtirador = { id: 'n1', isNPC: true, x: 0, z: 0, mapLevel: MAP,
                          cannonCritChance: 1, cannons: [], inventory: {} };
    const p = pm.spawn(npcAtirador, 30, 0, 0, 1.0, 100);
    expect(!!p.isCrit).toBe(false);
  });
});
