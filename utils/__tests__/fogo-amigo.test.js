/**
 * Fogo amigo: companheiro de GRUPO e de GUILDA não é alvo.
 *
 * Pedido de 2026-09-06: "em grupo não dar dano em aliado, e as relíquias de
 * target não podem ir em membros do grupo; membros da guilda a mesma coisa".
 *
 * São duas promessas diferentes e o teste cobre as duas:
 *   1. DANO — o tiro e a área não machucam quem é do mesmo lado;
 *   2. MIRA — o aliado deixa de ser CANDIDATO, então uma relíquia de alvo único
 *      passa por cima dele e pega quem está atrás.
 *
 * A segunda é a que o pedido tornou explícita e a que é fácil errar: dá para
 * zerar o dano e ainda assim deixar o arpão "gastar" o tiro no companheiro.
 *
 * Mesmo truque do heal-ammo: o projectile-manager puxa o db-manager no topo, e
 * ele tenta abrir conexão ao subir.
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
const { isAlly }        = require('../allies.js');
const { MAP_DEFS }      = require('../../constants/index.js');

const MAP = 3;   // amarelo: PvP liberado. É onde o fogo amigo existiria — no
                 // verde o dano entre jogadores já está desligado, e o teste
                 // passaria sem provar nada.

// ── Managers de mentira, com a MESMA assinatura dos de verdade ──────────────
const grupoDe   = (...ids)   => ({ areAllies:     (a, b) => ids.includes(a) && ids.includes(b) });
const guildaDe  = (...nomes) => ({ areGuildMates: (a, b) => a !== b && nomes.includes(a) && nomes.includes(b) });

function jogador(id, nome, x) {
  return {
    id, name: nome, dead: false, hp: 100000, maxHp: 100000, x, z: 0,
    mapLevel: MAP, cannonDamage: 900, tal: {}, talents: {},
    ws: { readyState: 1, send() {} },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
describe('isAlly — quem está do meu lado', () => {
  const a = jogador('p1', 'Ana',  0);
  const b = jogador('p2', 'Beto', 10);

  it('mesmo GRUPO', () => {
    expect(isAlly(a, b, grupoDe('p1', 'p2'), null)).toBe(true);
  });

  it('mesma GUILDA', () => {
    expect(isAlly(a, b, null, guildaDe('Ana', 'Beto'))).toBe(true);
  });

  it('nenhum dos dois — estranhos continuam sendo alvo', () => {
    expect(isAlly(a, b, grupoDe('p1'), guildaDe('Ana'))).toBe(false);
  });

  it('sem manager nenhum não explode: responde "sem lado"', () => {
    expect(isAlly(a, b)).toBe(false);
    expect(isAlly(a, b, {}, {})).toBe(false);
  });

  it('ninguém é aliado de SI MESMO', () => {
    // Os dois chamadores usam a resposta para PULAR o alvo — dizer `true` aqui
    // faria o lançador sumir das próprias áreas, que é outra regra.
    expect(isAlly(a, a, grupoDe('p1'), guildaDe('Ana'))).toBe(false);
  });

  it('jogador ausente não vira aliado por acidente', () => {
    expect(isAlly(a, null, grupoDe('p1', 'p2'))).toBe(false);
    expect(isAlly(null, b, grupoDe('p1', 'p2'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('canhão — o tiro no aliado', () => {
  let pm, eventos, players, atirador, amigo, estranho;

  function atirar(quem, ammo = 'bala_ferro') {
    const antes = quem.hp;
    const p = {
      id: 'proj' + Math.random(), ownerId: atirador.id, ownerIsNPC: false,
      ammoType: ammo, cannonDmg: atirador.cannonDamage,
      damageMultiplier: 1.0, isCrit: false,
      hitTargets: new Set(), piercing: false, dead: false, mapLevel: MAP,
    };
    pm.projectiles.set(p.id, p);
    pm.hit(p, quem, false);
    return { dano: antes - quem.hp, consumido: p.dead, hp: quem.hp };
  }

  beforeEach(() => {
    eventos = [];
    players = new Map();
    pm = new ProjectileManager({ clients: new Set() }, players, new Map(), null, null, MAP_DEFS);
    pm._broadcastToMap = (_lvl, e) => eventos.push(e);
    pm.projectiles = new Map();

    atirador = jogador('p1', 'Ana',   0);
    amigo    = jogador('p2', 'Beto', 10);
    estranho = jogador('p3', 'Caio', 20);
    for (const p of [atirador, amigo, estranho]) players.set(p.id, p);
  });

  it('companheiro de GRUPO não leva dano', () => {
    pm.partyManager = grupoDe('p1', 'p2');
    expect(atirar(amigo).dano).toBe(0);
  });

  it('companheiro de GUILDA não leva dano', () => {
    pm.guildManager = guildaDe('Ana', 'Beto');
    expect(atirar(amigo).dano).toBe(0);
  });

  it('estranho continua levando — a regra não desligou o PvP', () => {
    pm.partyManager  = grupoDe('p1', 'p2');
    pm.guildManager  = guildaDe('Ana', 'Beto');
    expect(atirar(estranho).dano).toBeGreaterThan(0);
  });

  it('o projétil ATRAVESSA o aliado em vez de morrer nele', () => {
    // A parte que não é óbvia. Consumir o tiro no companheiro faria dele um
    // escudo que come as suas próprias salvas — numa briga em linha, o aliado
    // na frente anularia o seu dano sem levar nada.
    pm.partyManager = grupoDe('p1', 'p2');
    const r = atirar(amigo);
    expect(r.dano).toBe(0);
    expect(r.consumido, 'o tiro foi consumido no aliado').toBe(false);
    expect(pm.projectiles.size, 'o projétil saiu de cena no aliado').toBe(1);
  });

  it('a bala de CURA continua chegando no aliado', () => {
    // O ponto cego natural desta mudança: "não acerta aliado" não pode virar
    // "não cura aliado", que é justamente o uso da bala.
    pm.partyManager = grupoDe('p1', 'p2');
    pm.guildManager = guildaDe('Ana', 'Beto');
    amigo.hp = 1000;
    const r = atirar(amigo, 'bala_cura');
    expect(r.hp, 'a bala de cura parou no portão de fogo amigo')
      .toBeGreaterThan(1000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// O portão das RELÍQUIAS mora no server.js (`relicCanHitPlayer`), que não é
// importável em teste — ele sobe o servidor inteiro. O que dá para travar aqui
// é a COMPOSIÇÃO: reproduzir o portão com as mesmas peças e provar que a mira
// de alvo único pula o aliado em vez de gastar o tiro nele.
describe('relíquia de alvo único — o aliado não é candidato', () => {
  // Cópia fiel da ordem do server.js. Se a de lá mudar, este espelho continua
  // provando o comportamento pedido; o guarda de que os dois não divergiram é
  // o teste de código-fonte logo abaixo.
  function podeAcertar(caster, alvo, party, guilda) {
    if (!alvo || alvo.dead) return false;
    if (alvo.id === caster.id) return false;
    if ((alvo.mapLevel || 1) !== (caster.mapLevel || 1)) return false;
    if (isAlly(caster, alvo, party, guilda)) return false;
    return (MAP_DEFS[alvo.mapLevel || 1] || {}).pvpZone !== 'green';
  }

  it('o arpão passa POR CIMA do companheiro e fisga quem está atrás', () => {
    const ana  = jogador('p1', 'Ana',   0);
    const beto = jogador('p2', 'Beto', 10);   // aliado, mais perto
    const caio = jogador('p3', 'Caio', 20);   // inimigo, mais longe
    const party = grupoDe('p1', 'p2');

    // Varre a linha e fica com o PRIMEIRO aprovado — é o que o server.js faz.
    const alvo = [beto, caio]
      .sort((x, y) => x.x - y.x)
      .find(p => podeAcertar(ana, p, party, null));

    expect(alvo, 'ninguém foi fisgado').toBeDefined();
    expect(alvo.id, 'o arpão gastou o tiro no companheiro').toBe('p3');
  });

  it('uma área não conta grupo nem guilda na lista de atingidos', () => {
    const ana  = jogador('p1', 'Ana',   0);
    const beto = jogador('p2', 'Beto', 10);   // grupo
    const dora = jogador('p4', 'Dora', 12);   // guilda
    const caio = jogador('p3', 'Caio', 20);   // estranho

    const atingidos = [beto, dora, caio]
      .filter(p => podeAcertar(ana, p, grupoDe('p1', 'p2'), guildaDe('Ana', 'Dora')))
      .map(p => p.id);

    expect(atingidos).toEqual(['p3']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Guarda de fiação: os dois portões TÊM de consultar o isAlly. Zerar o dano num
// e esquecer o outro é exatamente o defeito que este pedido veio corrigir, e ele
// não dá erro nenhum — só continua machucando o amigo por um caminho só.
describe('os dois portões estão ligados no mesmo módulo', () => {
  const fs   = require('fs');
  const path = require('path');
  const raiz = path.resolve(__dirname, '..', '..');
  const ler  = f => fs.readFileSync(path.join(raiz, f), 'utf8');

  it('projectile-manager.hit consulta isAlly', () => {
    const src = ler('managers/projectile-manager.js');
    expect(src, 'sem require de utils/allies').toContain("require('../utils/allies')");
    expect(src, 'o portão do canhão não chama isAlly')
      .toMatch(/isAlly\(\s*_atirador,\s*target,\s*this\.partyManager,\s*this\.guildManager\s*\)/);
  });

  it('relicCanHitPlayer consulta isAlly', () => {
    const src = ler('server.js');
    expect(src, 'sem require de utils/allies').toContain("require('./utils/allies')");
    const corpo = src.slice(src.indexOf('function relicCanHitPlayer'));
    expect(corpo.slice(0, corpo.indexOf('\n}')),
      'o portão das relíquias não chama isAlly')
      .toMatch(/isAlly\(caster, target, partyManager, guildManager\)/);
  });

  it('o guildManager chega no projectile-manager', () => {
    // `isAlly` trata manager ausente como "sem lado", então esquecer a injeção
    // deixaria o tiro acertando companheiro de guilda EM SILÊNCIO.
    expect(ler('server.js')).toContain('projectileManager.guildManager = guildManager;');
  });
});
