/**
 * Bala de Cura no caminho do TIRO.
 *
 * Relato do playtest: "estou atirando com a bala de cura em outro jogador, mapa
 * amarelo, e não está curando o target". A causa era a regra antiga — só curava
 * quem estava no MESMO GRUPO —, e fora do grupo o `hit()` saía sem dano e sem
 * cura: do lado de quem atirava, absolutamente nada acontecia.
 *
 * É a pior forma de um bug se apresentar (silêncio), então ela ganhou guarda.
 * O que este arquivo trava:
 *   · cura QUALQUER jogador, com ou sem grupo;
 *   · nunca causa dano, nem no alvo mais hostil;
 *   · não cura NPC (a bala é entre jogadores);
 *   · o valor acompanha o poder de fogo de quem atirou, não os 5 HP fixos.
 *
 * Mesmo truque do bulwark-projectile: o `projectile-manager` puxa o
 * `db-manager` no topo, que tenta abrir conexão ao subir.
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
const { MAP_DEFS, AMMO_DEFS } = require('../../constants/index.js');

const MAP = 2;   // amarelo — PvP liberado, que é onde o relato aconteceu

let pm, eventos, players, npcs, atirador, alvo, bicho;

function jogador(id, x) {
  return {
    id, dead: false, hp: 1000, maxHp: 100000, x, z: 0, mapLevel: MAP,
    cannonDamage: 900, tal: {}, talents: {},
    ws: { readyState: 1, send() {} },
  };
}

/** Um tiro de bala de cura do `atirador` em `quem`. Devolve o que mudou. */
function curar(quem, alvoEhNPC = false) {
  const antesHp = quem.hp;
  const antesEv = eventos.length;
  const p = {
    id: 'proj' + Math.random(), ownerId: atirador.id, ownerIsNPC: false,
    ammoType: 'bala_cura', cannonDmg: atirador.cannonDamage,
    damageMultiplier: 1.0, isCrit: false,
    hitTargets: new Set(), piercing: false, dead: false, mapLevel: MAP,
  };
  pm.projectiles.set(p.id, p);
  pm.hit(p, quem, alvoEhNPC);
  return {
    delta: quem.hp - antesHp,
    evento: eventos.slice(antesEv).find(e => e.type === 'heal') || null,
  };
}

beforeEach(() => {
  eventos = [];
  players = new Map();
  npcs = new Map();
  pm = new ProjectileManager({ clients: new Set() }, players, npcs, null, null, MAP_DEFS);
  pm._broadcastToMap = (_lvl, e) => eventos.push(e);
  pm.projectiles = new Map();

  atirador = jogador('p1', 0);
  alvo     = jogador('p2', 10);
  players.set(atirador.id, atirador);
  players.set(alvo.id, alvo);

  bicho = { id: 'n1', isNPC: true, dead: false, hp: 1000, maxHp: 100000,
            x: 20, z: 0, mapLevel: MAP };
  npcs.set(bicho.id, bicho);
});

describe('bala de cura', () => {
  it('cura um jogador de FORA do grupo', () => {
    // Sem partyManager nenhum: é o cenário do relato, dois estranhos no mapa 2.
    const r = curar(alvo);
    expect(r.delta).toBeGreaterThan(0);
    expect(r.evento).not.toBeNull();
    expect(r.evento.targetId).toBe(alvo.id);
    expect(r.evento.amount).toBe(r.delta);
  });

  it('cura igual com o grupo montado — a regra deixou de olhar para isso', () => {
    const semGrupo = curar(alvo).delta;
    alvo.hp = 1000;
    pm.partyManager = { areAllies: () => true };
    expect(curar(alvo).delta).toBe(semGrupo);
  });

  it('nunca causa dano, mesmo em quem não é aliado', () => {
    pm.partyManager = { areAllies: () => false };
    expect(curar(alvo).delta).toBeGreaterThan(0);
  });

  // ── Contra BICHO ela continua sendo um tiro normal ────────────────────────
  // Isto não é o que o nome sugere e vale saber: o ramo da cura só pega alvo
  // JOGADOR, então um tiro de bala_cura num monstro cai no caminho de dano
  // comum. E `damage: 0` na tabela de munição significa "sem bônus de munição",
  // não "sem dano" — o dano do canhão entra por fora (`baseDmg = ammo.damage +
  // proj.cannonDmg`).
  //
  // Consequência prática: carregar a Bala de Cura custa 5 pontos de dano em
  // relação à Bala de Ferro e nada mais. O teste trava o comportamento ATUAL,
  // sem opinar — se um dia ela tiver de ser inofensiva também contra bicho, é
  // aqui que o número muda.
  it('em NPC não cura, e o tiro vale o dano de canhão normal', () => {
    const r = curar(bicho, true);
    expect(r.evento).toBeNull();
    expect(r.delta).toBe(-(atirador.cannonDamage + AMMO_DEFS.bala_cura.damage));
  });

  it('o valor acompanha o poder de fogo, não os 5 HP fixos', () => {
    const mult  = AMMO_DEFS.bala_cura.healMult;
    const forte = curar(alvo).delta;
    expect(forte).toBe(Math.round(atirador.cannonDamage * mult));

    // Canhão fraco cai no piso do `healAmount`, e não em zero.
    alvo.hp = 1000;
    atirador.cannonDamage = 0;
    expect(curar(alvo).delta).toBe(AMMO_DEFS.bala_cura.healAmount);
  });

  it('não passa do HP máximo', () => {
    alvo.hp = alvo.maxHp - 1;
    expect(curar(alvo).delta).toBe(1);
  });
});
