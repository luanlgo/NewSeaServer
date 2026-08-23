/**
 * O pagamento do chefe: um bolo só, dividido entre quem ainda está no jogo.
 *
 * Duas coisas quebravam em silêncio aqui, e as duas apareciam para o jogador
 * como "às vezes recebo menos" — sem nada na tela explicando por quê:
 *
 *   1. o intervalo de dobrão era sorteado DENTRO do pagamento de cada agressor.
 *      Como o chefe do mapa 6 paga entre 10.000 e 20.000, dois capitães com
 *      exatamente o mesmo dano levavam valores que diferiam pelo dobro, e a
 *      soma do que saiu não batia com o total anunciado na morte;
 *
 *   2. quem bateu no chefe e saiu do jogo antes de ele morrer continuava no
 *      DENOMINADOR do rateio. A parte dele não era paga a ninguém — só
 *      encolhia a de quem ficou.
 *
 * Morrer NÃO é sair: o jogador morto continua na sala, continua no `_damageMap`
 * e recebe a parte dele normalmente. O último teste é o que prova isso, porque
 * é exatamente a dúvida que abriu esta investigação.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// O boss-manager puxa o db-manager no topo, que abre conexão ao subir. O save
// precisa devolver promessa: o manager encadeia `.catch()` no retorno.
const dbPath = require.resolve('../../managers/db-manager.js');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, children: [], paths: [],
  exports: { save: () => Promise.resolve() },
};

const BossManager = require('../../managers/boss-manager.js');
const { MAP_DEFS } = require('../../constants/index.js');

/** Mapa 6 — o chefe de intervalo mais largo (10k–20k), onde o sorteio aparece. */
const ZONA     = 6;
const BOSS_DEF = MAP_DEFS[ZONA].boss;

function makePlayer(id) {
  return {
    id, name: `Cap${id}`,
    ws: { readyState: 1, send: () => {} },
    gold: 0, dobroes: 0, mapFragments: 0, mapXp: 0, mapLevel: ZONA,
    tal: {},
  };
}

function makeBoss(dmgPairs) {
  return {
    id: 'boss-teste',
    name: BOSS_DEF.name,
    rarity: (BOSS_DEF.rarities || [{ id: 'normal' }])[0].id,
    mapLevel: ZONA,
    diffMult: 1,
    bloodMult: 1,
    _dobraoMin: BOSS_DEF.dobraoMin,
    _dobraoMax: BOSS_DEF.dobraoMax,
    _damageMap: new Map(dmgPairs),
  };
}

let players, npcs, bm, ledgers;

beforeEach(() => {
  players = new Map();
  npcs    = new Map();
  ledgers = [];
  bm = new BossManager({ clients: [] }, players, npcs, ZONA);
  bm.journal = {
    ledger: (player, source, deltas, extra) => ledgers.push({ name: player.name, source, deltas, extra }),
  };
});

afterEach(() => { vi.restoreAllMocks(); });

/** Math.random que devolve valores DIFERENTES a cada chamada. Com um sorteio
 *  por jogador os dois pagamentos divergem; com um sorteio só, não. */
function randomAlternado() {
  const seq = [0.02, 0.97, 0.05, 0.93];
  let i = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => seq[i++ % seq.length]);
}

describe('o bolo é sorteado uma vez por morte', () => {
  it('dano igual → dobrão igual, mesmo com o sorteio variando', () => {
    const a = makePlayer(1), b = makePlayer(2);
    players.set(1, a); players.set(2, b);
    const boss = makeBoss([[1, 500], [2, 500]]);
    npcs.set(boss.id, boss);

    randomAlternado();
    bm.onBossDead(boss, 1);

    expect(a.dobroes).toBe(b.dobroes);
    expect(a.dobroes).toBeGreaterThan(0);
  });

  it('o que os agressores recebem soma o bolo, não um bolo por cabeça', () => {
    const a = makePlayer(1), b = makePlayer(2);
    players.set(1, a); players.set(2, b);
    const boss = makeBoss([[1, 750], [2, 250]]);
    npcs.set(boss.id, boss);

    randomAlternado();
    bm.onBossDead(boss, 1);

    // O teto do intervalo × raridade é o máximo que o chefe pode pagar por
    // morte. Com um sorteio por jogador a soma passava disso.
    const rar  = (BOSS_DEF.rarities || []).find(r => r.id === boss.rarity) || { rewardMult: 1 };
    const teto = Math.round(BOSS_DEF.dobraoMax * (rar.rewardMult || 1));
    expect(a.dobroes + b.dobroes).toBeLessThanOrEqual(teto + 1); // +1: arredondamento das partes
    expect(a.dobroes).toBeGreaterThan(b.dobroes);                // 75% do dano leva mais
  });
});

describe('o rateio só conta quem ainda está no jogo', () => {
  it('agressor que saiu não encolhe a parte de quem ficou', () => {
    const b = makePlayer(2);
    players.set(2, b); // o jogador 1 bateu e desconectou: não está mais na sala
    const boss = makeBoss([[1, 500], [2, 500]]);
    npcs.set(boss.id, boss);

    bm.onBossDead(boss, 2);

    const sozinho = makePlayer(3);
    players.set(3, sozinho);
    const boss3 = makeBoss([[3, 500]]);
    npcs.set(boss3.id, boss3);
    bm.onBossDead(boss3, 3);

    // Os dois levaram a parte CHEIA (share = 1). O valor exato varia com o
    // sorteio; o que importa é que o fantasma não cortou o do primeiro pela
    // metade — antes desta correção `b` levava ~50% do que `sozinho` levou.
    expect(b.dobroes).toBeGreaterThan(BOSS_DEF.dobraoMin * 0.9);
  });

  it('todos os agressores saíram → o matador leva o bolo', () => {
    const k = makePlayer(9);
    players.set(9, k);
    const boss = makeBoss([[1, 300], [2, 700]]); // nenhum dos dois está na sala
    npcs.set(boss.id, boss);

    bm.onBossDead(boss, 9);

    expect(k.dobroes).toBeGreaterThan(0);
  });
});

describe('morrer não tira o capitão do rateio', () => {
  it('quem morreu durante a luta continua recebendo a parte do seu dano', () => {
    const vivo = makePlayer(1), morto = makePlayer(2);
    morto.dead = true;
    morto.hp   = 0;
    players.set(1, vivo); players.set(2, morto);
    const boss = makeBoss([[1, 500], [2, 500]]);
    npcs.set(boss.id, boss);

    bm.onBossDead(boss, 1);

    expect(morto.dobroes).toBe(vivo.dobroes);
    expect(morto.dobroes).toBeGreaterThan(0);
  });
});

describe('o Diário recebe a linha do chefe', () => {
  it('cada agressor pago vira uma entrada de extrato com a fonte "boss"', () => {
    const a = makePlayer(1), b = makePlayer(2);
    players.set(1, a); players.set(2, b);
    const boss = makeBoss([[1, 500], [2, 500]]);
    npcs.set(boss.id, boss);

    bm.onBossDead(boss, 1);

    expect(ledgers).toHaveLength(2);
    for (const l of ledgers) {
      expect(l.source).toBe('boss');
      expect(l.deltas.dobroes).toBeGreaterThan(0);
      expect(l.extra.target).toBe(boss.name);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E a razão de o Diário nunca ter mostrado o chefe do mapa 6.
//
// Um BossManager não nasce só na subida do servidor: os mapas 3+ criam o deles
// em ensureRegularManager, e os mapas 1 e 2 são destruídos depois de 5 minutos
// vazios e recriados quando alguém volta. Só os DOIS primeiros recebiam
// `journal`. Como o boss-manager chama `this.journal?.ledger(...)`, o chefe
// pagava e sumia do extrato sem erro nenhum no log — e a missão diária de
// chefes, que depende de `_onBossKill`, parava junto.
//
// Esta varredura é estática de propósito: o bug não estava em nenhum dos
// caminhos que um teste de unidade exercita, estava no ponto de CRIAÇÃO que
// ninguém lembrou de atualizar. Um `new BossManager` solto volta a quebrar as
// duas coisas.
// ─────────────────────────────────────────────────────────────────────────────
describe('todo BossManager criado sai ligado ao Diário', () => {
  it('nenhum `new BossManager` escapa do wireBossManager', async () => {
    const fs   = await import('node:fs');
    const path = await import('node:path');
    const server = fs.readFileSync(
      path.resolve(import.meta.dirname, '..', '..', 'server.js'), 'utf8');

    const soltos = server.split('\n')
      .map((linha, i) => ({ n: i + 1, linha }))
      // Comentários citam a chamada; só o código conta.
      .filter(({ linha }) => !/^\s*(\*|\/\/)/.test(linha))
      .filter(({ linha }) => /new BossManager\(/.test(linha))
      .filter(({ linha }) => !/wireBossManager\(new BossManager\(/.test(linha))
      // As duas declarações do topo são ligadas nas linhas seguintes, onde o
      // `let` já existe (elas são reatribuídas em ensureManagersForMap).
      .filter(({ linha }) => !/^let\s+bossManager2?\s+=/.test(linha.trim()));

    expect(soltos.map(s => `server.js:${s.n}`)).toEqual([]);
  });

  it('wireBossManager entrega journal, partyManager e os callbacks de missão', async () => {
    const fs   = await import('node:fs');
    const path = await import('node:path');
    const server = fs.readFileSync(
      path.resolve(import.meta.dirname, '..', '..', 'server.js'), 'utf8');

    const corpo = server.slice(server.indexOf('function wireBossManager('));
    const fim   = corpo.indexOf('\n}');
    const fn    = corpo.slice(0, fim);

    for (const dep of ['journal', 'partyManager', '_onBossKill', '_onBossAssist']) {
      expect(fn).toContain(`boss.${dep}`);
    }
  });
});
