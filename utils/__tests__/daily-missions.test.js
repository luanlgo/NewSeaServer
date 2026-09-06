/**
 * Missões do dia — o bloco que vive na coluna JSON `daily_missions`.
 *
 * O que estes testes seguram é UMA regra: a recompensa já paga não pode voltar a
 * ser coletável. Ela quase caiu duas vezes, por motivos diferentes —
 *
 *   1. até 01/09 não havia coluna no banco: os handlers chamavam `db.save` e o
 *      código PARECIA persistir, mas todo restart zerava `claimed`;
 *   2. até 04/09 o `buildDailyMissions` refazia o sorteio a cada chamada e
 *      mandava por cima do pool salvo. Editar `constants/missions.js` mudava o
 *      sorteio da MESMA data, e a poda (`delete progress[id]`) levava junto a
 *      marca de coletada.
 *
 * O (1) é o db-manager quem segura; aqui mora o (2).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const dm = require('../daily-missions.js');
const { DAILY_MISSIONS, DAILY_MISSION_COUNT } = require('../../constants/missions.js');

const HOJE = dm.todayDateStr();

/** Um jogador com o bloco do dia já montado. */
function jogador() {
  const p = {};
  dm.buildDailyMissions(p);
  return p;
}

afterEach(() => vi.restoreAllMocks());

// ═════════════════════════════════════════════════════════════════════════════
describe('o sorteio do dia', () => {
  it('é o mesmo para a mesma data e muda de um dia para o outro', () => {
    const a = dm.getDailyMissionPool('2026-09-04').map(m => m.id);
    const b = dm.getDailyMissionPool('2026-09-04').map(m => m.id);
    const c = dm.getDailyMissionPool('2026-09-05').map(m => m.id);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('sorteia DAILY_MISSION_COUNT missões, todas do catálogo, sem repetir', () => {
    const ids = dm.getDailyMissionPool(HOJE).map(m => m.id);
    expect(ids).toHaveLength(DAILY_MISSION_COUNT);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(DAILY_MISSIONS.some(m => m.id === id)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('o bloco do jogador', () => {
  it('nasce zerado, com a data de hoje e um progresso por missão', () => {
    const p = jogador();
    expect(p.dailyMissions.date).toBe(HOJE);
    expect(p.dailyMissions.pool).toHaveLength(DAILY_MISSION_COUNT);
    expect(p.dailyMissions.activeMission).toBeNull();
    for (const id of p.dailyMissions.pool) {
      expect(p.dailyMissions.progress[id]).toBe(0);
      expect(p.dailyMissions.claimed[id]).toBe(false);
    }
  });

  it('vira o dia zerando progresso E coletadas', () => {
    const p = jogador();
    const id = p.dailyMissions.pool[0];
    p.dailyMissions.progress[id] = 99;
    p.dailyMissions.claimed[id] = true;
    p.dailyMissions.date = '2001-01-01';
    dm.buildDailyMissions(p);
    expect(p.dailyMissions.date).toBe(HOJE);
    for (const k of p.dailyMissions.pool) expect(p.dailyMissions.claimed[k]).toBe(false);
  });

  it('bloco torto vindo do banco vira null em vez de derrubar o login', () => {
    expect(dm.sanitizeDailyMissions(null)).toBeNull();
    expect(dm.sanitizeDailyMissions('lixo')).toBeNull();
    expect(dm.sanitizeDailyMissions({ date: HOJE })).toBeNull();   // sem pool
    const ok = dm.sanitizeDailyMissions({ date: HOJE, pool: ['hunt_100'], progress: 7 });
    expect(ok.progress).toEqual({});    // tipo errado vira objeto vazio
    expect(ok.claimed).toEqual({});
    // E o build aceita esse bloco saneado sem explodir.
    const p = { dailyMissions: ok };
    expect(() => dm.buildDailyMissions(p)).not.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('o pool GRAVADO manda no resto do dia', () => {
  it('não refaz o sorteio por cima do que o jogador já tem', () => {
    const p = jogador();
    const meu = [...p.dailyMissions.pool];
    p.dailyMissions.progress[meu[0]] = 5;
    dm.buildDailyMissions(p);
    expect(p.dailyMissions.pool, 'o pool do jogador foi trocado no meio do dia').toEqual(meu);
    expect(p.dailyMissions.progress[meu[0]]).toBe(5);
  });

  it('a marca de COLETADA sobrevive a uma missão sair do quadro', () => {
    // Este é o caso que devolvia dinheiro: a missão paga saía do pool, a poda
    // apagava `claimed`, e se ela voltasse era coletável de novo.
    const p = jogador();
    const pago = p.dailyMissions.pool[0];
    p.dailyMissions.claimed[pago] = true;
    p.dailyMissions.progress[pago] = 999;

    // Tira a missão do quadro à força — o que uma edição do catálogo fazia.
    p.dailyMissions.pool = p.dailyMissions.pool.filter(id => id !== pago);
    dm.buildDailyMissions(p);

    expect(p.dailyMissions.claimed[pago], 'a marca de coletada sumiu — pagaria de novo')
      .toBe(true);
  });

  it('missão NÃO coletada que sai do quadro é podada de vez', () => {
    const p = jogador();
    const solta = p.dailyMissions.pool[0];
    p.dailyMissions.progress[solta] = 3;
    p.dailyMissions.pool = p.dailyMissions.pool.filter(id => id !== solta);
    dm.buildDailyMissions(p);
    // Ela pode voltar pelo completar-do-sorteio; o que não pode é ficar
    // pendurada com progresso fantasma FORA do quadro.
    if (!p.dailyMissions.pool.includes(solta)) {
      expect(p.dailyMissions.progress[solta]).toBeUndefined();
      expect(p.dailyMissions.claimed[solta]).toBeUndefined();
    }
  });

  it('id que sumiu do catálogo é descartado e o buraco é completado', () => {
    const p = jogador();
    p.dailyMissions.pool = ['missao_que_nao_existe_mais', ...p.dailyMissions.pool.slice(1)];
    const lista = dm.buildDailyMissions(p);
    expect(p.dailyMissions.pool).not.toContain('missao_que_nao_existe_mais');
    expect(p.dailyMissions.pool).toHaveLength(DAILY_MISSION_COUNT);
    expect(lista).toHaveLength(DAILY_MISSION_COUNT);
    for (const m of lista) expect(m.id).toBeTruthy();
  });

  it('a missão ativa que sai do quadro é solta', () => {
    const p = jogador();
    p.dailyMissions.activeMission = 'missao_que_nao_existe_mais';
    dm.buildDailyMissions(p);
    expect(p.dailyMissions.activeMission).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('a ficha vem do CATÁLOGO, não do sorteio do dia', () => {
  it('missionDefById acha missão que não está no sorteio de hoje', () => {
    const hoje = new Set(dm.getDailyMissionPool(HOJE).map(m => m.id));
    const fora = DAILY_MISSIONS.find(m => !hoje.has(m.id));
    expect(fora, 'catálogo pequeno demais para o teste').toBeTruthy();
    // Era aqui que o progresso pararia em silêncio: procurar no sorteio do dia
    // devolve undefined para a missão que o jogador carrega do pool salvo.
    expect(dm.missionDefById(fora.id)).toBeTruthy();
    expect(dm.missionDefById(fora.id).target).toBe(fora.target);
    expect(dm.missionDefById('nao_existe')).toBeNull();
  });

  it('isMissionInPlayerPool é a checagem de posse', () => {
    const p = jogador();
    expect(dm.isMissionInPlayerPool(p, p.dailyMissions.pool[0])).toBe(true);
    expect(dm.isMissionInPlayerPool(p, 'nao_existe')).toBe(false);
    expect(dm.isMissionInPlayerPool({}, 'hunt_100')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('a ficha das missões do catálogo', () => {
  it('toda missão tem id único, stat, alvo positivo e recompensa', () => {
    const vistos = new Set();
    for (const m of DAILY_MISSIONS) {
      expect(vistos.has(m.id), 'id repetido: ' + m.id).toBe(false);
      vistos.add(m.id);
      expect(typeof m.stat, m.id + ' sem stat').toBe('string');
      expect(m.target, m.id + ' com alvo não positivo').toBeGreaterThan(0);
      const r = m.reward || {};
      expect((r.gold || 0) + (r.dobrao || 0), m.id + ' sem recompensa').toBeGreaterThan(0);
    }
  });

  it('o catálogo é maior que o sorteio — senão o dia nunca varia', () => {
    expect(DAILY_MISSIONS.length).toBeGreaterThan(DAILY_MISSION_COUNT);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('missão que não pode ser concluída é pior que missão difícil', () => {
  const RAIZ = path.join(__dirname, '..', '..');
  const FONTES = [
    'server.js',
    'managers/projectile-manager.js',
    'managers/pet-manager.js',
    'managers/wreck-manager.js',
  ].map(f => fs.readFileSync(path.join(RAIZ, f), 'utf8')).join(' ');

  it('todo `stat` do catálogo tem quem o progrida', () => {
    // Missão cujo stat ninguém incrementa fica em 0/N o dia inteiro, sem erro
    // nenhum — o jogador só vê uma barra que não anda. Foi assim que
    // 'kill_elite' viveu no pool sem progredir, e é o que este guarda impede
    // agora que cinco ganchos novos entraram (bestiário, pets, masmorra,
    // naufrágio, Zona Vermelha).
    const orfas = DAILY_MISSIONS
      .filter(m => !FONTES.includes(`'${m.stat}'`))
      .map(m => `${m.id} (${m.stat})`);
    expect(orfas, 'stat que ninguém progride').toEqual([]);
  });

  it('o alvo do chefe mundial cabe na vida dele', () => {
    // O pool antigo pedia 200.000 de dano num chefe de 25.000 de vida: oito
    // vezes o corpo inteiro. A missão existia desde o começo e NUNCA foi
    // concluída por ninguém — e não dava erro, porque impossível e difícil têm
    // exatamente a mesma cara para quem está jogando.
    //
    // A conta é contra a vida REAL: o dano acumula entre aparições no mesmo
    // dia, então o teto justo é algumas mortes dele, não um número redondo.
    const { WORLD_BOSS_DEF } = require('../../constants');
    const missao = DAILY_MISSIONS.find(m => m.stat === 'worldBossDamage');
    if (!missao) return;
    const vida = WORLD_BOSS_DEF[0].baseHp;
    expect(missao.target, 'o alvo passa de 3 chefes mundiais inteiros')
      .toBeLessThanOrEqual(vida * 3);
  });

  it('nenhuma missão pede mais do que um dia inteiro de jogo', () => {
    // Não é balanceamento fino, é sanidade: alvo absurdo é o mesmo bug do
    // chefe mundial com outra roupa. Os tetos saem do que o mapa mais rico
    // entrega hoje (ver a régua no cabeçalho de constants/missions.js).
    const TETO = {
      npcKills: 400, perfectKills: 40, damageBlocked: 10_000_000,
      eliteKills: 20, relicDrops: 6, relicsUsed: 150, bossKills: 6,
      bossAssists: 10, bonusDungeons: 3, fragmentUse: 100, islandsVisited: 8,
      distanceSailed: 100_000, boatVisit: 1, petCaptures: 2, pvpKills: 6,
      wrecksLooted: 8, goldEarned: 5_000_000, itemsBought: 15,
      missionsCompleted: 2, worldBossDamage: 100_000,
    };
    for (const m of DAILY_MISSIONS) {
      const teto = TETO[m.stat];
      expect(teto, `${m.id}: stat '${m.stat}' sem teto declarado no teste`).toBeDefined();
      expect(m.target, `${m.id} pede ${m.target} de ${m.stat}`).toBeLessThanOrEqual(teto);
    }
  });

  it('toda missão paga algo, e numa moeda só', () => {
    for (const m of DAILY_MISSIONS) {
      const moedas = ['gold', 'dobrao'].filter(k => (m.reward || {})[k] > 0);
      expect(moedas.length, `${m.id}: recompensa vazia ou em duas moedas`).toBe(1);
    }
  });
});
