import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import PirateManager  from '../../managers/pirate-manager.js';
import SpoilManager   from '../../managers/spoil-manager.js';
import JournalManager from '../../managers/journal-manager.js';
import battle         from '../battle-sim.js';
import pirateConsts   from '../../constants/pirates.js';

const { PIRATE_DEFS, pirateCapacityFor } = pirateConsts;

// ─────────────────────────────────────────────────────────────────────────────
// O espólio de abordagem é a única mecânica do jogo em que o jogador APOSTA
// coisas que não voltam: os piratas mortos saem do alistamento para sempre e o
// ouro do destroço só existe uma vez. Um saque que credita duas vezes ou uma
// abordagem que se repete até dar certo não são bugs de acabamento — são
// impressoras de recurso. Este arquivo existe para provar que as portas fecham.
// ─────────────────────────────────────────────────────────────────────────────

/** Socket de mentira que guarda o que o servidor mandaria para o cliente. */
function makeWs(sink) {
  return { readyState: 1, OPEN: 1, bufferedAmount: 0,
           send: (s) => sink.push(JSON.parse(s)) };
}

function makeDb(state) {
  let seq = 100;
  return {
    save: async () => {},
    addJournal: async (name, at, kind, data, reportId) => {
      state.journal.push({ name, kind, data, reportId });
    },
    saveBattleReport: async (r) => { state.reports[++seq] = r; return seq; },
    updateBattleReportLoot: async (id, looted) => { state.reports[id].resourcesLooted = looted; },
    getBattleReport: async (id) => state.reports[id] || null,
    getJournal: async () => state.journal,
  };
}

/** Um `await` de nada: deixa as promessas do relatório assentarem. */
const settle = () => new Promise(r => setTimeout(r, 20));

describe('espólio de abordagem', () => {
  let sent, state, players, pirates, spoils, events, atacante, vitima;

  beforeEach(() => {
    sent    = [];
    state   = { journal: [], reports: {} };
    players = new Map();
    events  = [];
    const db = makeDb(state);
    const journal = new JournalManager(db);
    pirates = new PirateManager(players, db);
    spoils  = new SpoilManager(null, (e, lvl) => events.push({ lvl, ...e }), players, db, journal, pirates);

    const mk = (id, name, ship, roster) => {
      const p = {
        id, name, ws: makeWs(sent), x: 0, z: 0, mapLevel: 11,
        gold: 10000, dobroes: 0, activeShip: ship,
        inventory: { pirates: roster.slice(), run: 5 },
        pirates: [], talents: {}, tal: {},
      };
      players.set(id, p);
      return p;
    };

    atacante = mk('1', 'Atacante', 'frigate',
      ['bucaneiro', 'bucaneiro', 'bucaneiro', 'marujo', 'marujo', 'couraceiro', 'contramestre', 'capitao_fantasma']);
    vitima = mk('2', 'Vitima', 'sloop', ['marujo', 'marujo', 'fuzileiro', 'healer']);

    pirates.handleBoard(atacante, { pirates: atacante.inventory.pirates });
    pirates.handleBoard(vitima,   { pirates: vitima.inventory.pirates });
    sent.length = 0;
  });

  afterEach(() => pirates.destroy());

  // ── Porão ─────────────────────────────────────────────────────────────────

  it('o embarque respeita a capacidade de peso do navio', () => {
    const cap = pirates.capacityOf(atacante);
    expect(cap).toBe(pirateCapacityFor('frigate'));
    expect(pirates.weightOf(atacante)).toBeLessThanOrEqual(cap);
  });

  it('não dá para embarcar mais cópias do que o jogador possui', () => {
    pirates.handleBoard(vitima, { pirates: Array(10).fill('fuzileiro') });
    expect(vitima.pirates).toEqual(['fuzileiro']);   // possui exatamente um
  });

  it('id de pirata inventado é ignorado', () => {
    pirates.handleBoard(vitima, { pirates: ['pirata_lendario_falso', 'marujo'] });
    expect(vitima.pirates).toEqual(['marujo']);
  });

  it('trocar para um navio menor desembarca o excedente', () => {
    atacante.activeShip = 'fragata';
    const cortados = pirates.refreshCapacity(atacante);
    expect(cortados).toBeGreaterThan(0);
    expect(pirates.weightOf(atacante)).toBeLessThanOrEqual(pirates.capacityOf(atacante));
  });

  // ── RUN ───────────────────────────────────────────────────────────────────

  it('sem RUN a tripulação não aborda', () => {
    atacante.inventory.run = 0;
    pirates._refreshActive(atacante);
    const s = spawnSpoil();
    sent.length = 0;
    spoils.handleRaid(atacante, s);
    expect(sent.find(m => m.type === 'spoil_error')?.reason).toMatch(/RUN/);
    expect(sent.find(m => m.type === 'spoil_raid_result')).toBeUndefined();
  });

  // ── Zona ──────────────────────────────────────────────────────────────────

  it('não nasce espólio fora de zona Red', () => {
    vitima.mapLevel = 4;   // amarela
    expect(spoils.onPlayerDeath(vitima, 1000)).toBe(false);
    expect(spoils.spoils.size).toBe(0);
  });

  // ── Fluxo ─────────────────────────────────────────────────────────────────

  function spawnSpoil(gold = 1000) {
    spoils.onPlayerDeath(vitima, gold);
    return [...spoils.spoils.keys()].at(-1);
  }

  /** Deixa o atacante com uma tripulação que PERDE — para testar a derrota. */
  function enfraqueceAtacante() {
    pirates.handleBoard(atacante, { pirates: ['marujo'] });
  }

  it('a inspeção informa a dificuldade sem entregar os piratas inimigos', () => {
    const s = spawnSpoil();
    sent.length = 0;
    spoils.handleInspect(atacante, s);
    const info = sent.find(m => m.type === 'spoil_info');
    expect(['facil', 'medio', 'dificil']).toContain(info.difficulty);
    expect(['green', 'yellow', 'red']).toContain(info.difficultyColor);
    // A composição inimiga não pode vazar em campo nenhum da mensagem.
    expect(JSON.stringify(info)).not.toContain('fuzileiro');
  });

  // O jogador aposta sem ver a mesa: o butim é a surpresa que paga a abordagem.
  // Não basta o cliente deixar de desenhar o número — ele não pode CHEGAR, ou um
  // cliente modificado leria o ouro e a decisão viraria uma conta de padaria.
  it('a inspeção não conta quanto tem dentro do destroço', () => {
    const s = spawnSpoil(987654);
    sent.length = 0;
    spoils.handleInspect(atacante, s);
    const info = sent.find(m => m.type === 'spoil_info');
    expect(info.resources).toBeUndefined();
    expect(JSON.stringify(info)).not.toContain('987654');
    expect(JSON.stringify(info)).not.toContain('gold');
  });

  it('não se saqueia o próprio naufrágio', () => {
    const s = spawnSpoil();
    sent.length = 0;
    spoils.handleInspect(vitima, s);
    expect(sent.find(m => m.type === 'spoil_error')?.reason).toMatch(/próprio/);
  });

  it('longe do destroço nada acontece', () => {
    const s = spawnSpoil();
    atacante.x = 5000;
    sent.length = 0;
    spoils.handleRaid(atacante, s);
    expect(sent.find(m => m.type === 'spoil_error')?.reason).toMatch(/Aproxime/);
  });

  // Vencer e saquear são o MESMO gesto: não existe estado intermediário em que o
  // jogador venceu e o espólio ainda está no mar esperando um segundo clique.
  it('vencer a abordagem saqueia no mesmo instante', () => {
    const s = spawnSpoil(1000);
    const antes = atacante.gold;
    sent.length = 0;
    spoils.handleRaid(atacante, s);

    const res = sent.find(m => m.type === 'spoil_raid_result');
    expect(res.won).toBe(true);
    expect(res.looted.gold).toBeGreaterThan(0);
    expect(atacante.gold).toBe(antes + res.looted.gold);
    expect(spoils.spoils.size, 'o destroço tem de sumir do mar').toBe(0);
    expect(events.some(e => e.type === 'spoil_removed' && e.looted === true)).toBe(true);
  });

  it('perder não rende saque, e o destroço continua no mar', () => {
    const s = spawnSpoil(1000);
    enfraqueceAtacante();
    const antes = atacante.gold;
    sent.length = 0;
    spoils.handleRaid(atacante, s);

    const res = sent.find(m => m.type === 'spoil_raid_result');
    expect(res.won).toBe(false);
    expect(res.looted).toBeNull();
    expect(atacante.gold).toBe(antes);
    expect(spoils.spoils.has(s), 'quem perde deixa o espólio para o próximo').toBe(true);
  });

  it('uma abordagem por jogador, ganhando ou perdendo', () => {
    const s = spawnSpoil();
    enfraqueceAtacante();          // perde, então o espólio sobrevive à 1ª tentativa
    spoils.handleRaid(atacante, s);
    sent.length = 0;
    spoils.handleRaid(atacante, s);
    expect(sent.find(m => m.type === 'spoil_error')).toBeDefined();
    expect(sent.find(m => m.type === 'spoil_raid_result')).toBeUndefined();
  });

  it('dois raids no mesmo tique creditam uma vez só', () => {
    const s = spawnSpoil();
    const antes = atacante.gold;

    sent.length = 0;
    spoils.handleRaid(atacante, s);
    spoils.handleRaid(atacante, s);   // sem await no meio: é a janela do exploit

    const saques = sent.filter(m => m.type === 'spoil_raid_result' && m.looted);
    expect(saques).toHaveLength(1);
    expect(atacante.gold).toBe(antes + saques[0].looted.gold);
    expect(spoils.spoils.size).toBe(0);
  });

  it('o saque automático ainda anexa o butim ao relatório', async () => {
    const s = spawnSpoil();
    // O saque acontece SEMPRE dentro da janela em que o INSERT do relatório
    // ainda está no ar — agora é a regra, não mais o clique apressado.
    spoils.handleRaid(atacante, s);
    await settle();

    const rep = Object.values(state.reports)[0];
    expect(rep.resourcesLooted, 'o saque não chegou ao relatório').toBeTruthy();
    expect(rep.resourcesLooted.gold).toBeGreaterThan(0);
    // E a linha do Diário aponta para o relatório, não para lugar nenhum.
    const linha = state.journal.find(j => j.kind === 'spoil_looted' && j.name === 'Atacante');
    expect(linha.reportId).toBeTruthy();
  });

  it('espólio expirado não é saqueável', () => {
    const s = spawnSpoil();
    spoils.spoils.get(s).expiresAt = Date.now() - 1;
    spoils.update(Date.now());
    expect(spoils.spoils.size).toBe(0);
    expect(events.some(e => e.type === 'spoil_removed' && e.looted === false)).toBe(true);
  });

  // ── Mortes permanentes ────────────────────────────────────────────────────

  it('os piratas mortos saem do alistamento para sempre', () => {
    const s = spawnSpoil();
    const antes = atacante.inventory.pirates.length;
    sent.length = 0;
    spoils.handleRaid(atacante, s);
    const res = sent.find(m => m.type === 'spoil_raid_result');
    expect(atacante.inventory.pirates).toHaveLength(antes - res.myDeaths);
    expect(atacante.pirates).toHaveLength(antes - res.myDeaths);
  });

  // Quem fica guardando o destroço é exatamente quem sobreviveu — é assim que a
  // defesa se desgasta a cada abordagem rechaçada e o próximo abordador encontra
  // um alvo mais fraco. Contar "morreu pelo menos um" seria instável: uma defesa
  // que vence com folga pode não perder ninguém, e isso é correto.
  it('o defensor que fica é o que sobreviveu à abordagem', () => {
    const s = spawnSpoil();
    enfraqueceAtacante();          // perdendo, o espólio fica no mar
    sent.length = 0;
    spoils.handleRaid(atacante, s);
    const res = sent.find(m => m.type === 'spoil_raid_result');
    expect(spoils.spoils.get(s).defenders).toHaveLength(res.enemySurvivors);
  });

  // ── Curandeiro Elite ──────────────────────────────────────────────────────

  // O único pirata que não morre. A prova tem de ser na DERROTA feia, que é onde
  // `lossFrac` chega perto de 0,95 e qualquer `survival` finito viraria caixão.
  it('o curandeiro elite atravessa a pior das derrotas', () => {
    const s = spawnSpoil();
    atacante.inventory.pirates = ['healer_elite', 'healer_elite', 'marujo'];
    pirates.handleBoard(atacante, { pirates: atacante.inventory.pirates });
    // Um defensor esmagador: a derrota é certa e as baixas vão ao teto.
    spoils.spoils.get(s).defenders = Array(30).fill('capitao_fantasma');

    sent.length = 0;
    spoils.handleRaid(atacante, s);
    const res = sent.find(m => m.type === 'spoil_raid_result');
    expect(res.won).toBe(false);
    expect(atacante.inventory.pirates.filter(p => p === 'healer_elite')).toHaveLength(2);
  });

  it('uma tripulação só de curandeiros elite perde inteira em pé', () => {
    const s = spawnSpoil();
    atacante.inventory.pirates = ['healer_elite', 'healer_elite'];
    pirates.handleBoard(atacante, { pirates: atacante.inventory.pirates });
    spoils.spoils.get(s).defenders = Array(30).fill('capitao_fantasma');

    sent.length = 0;
    spoils.handleRaid(atacante, s);
    const res = sent.find(m => m.type === 'spoil_raid_result');
    expect(res.won).toBe(false);
    // O piso de "quem perde enterra pelo menos um" NÃO fura a imortalidade.
    expect(res.myDeaths).toBe(0);
    expect(atacante.inventory.pirates).toHaveLength(2);
  });

  // ── Relatório ─────────────────────────────────────────────────────────────

  it('o relatório grava tudo que explica o resultado e não muda depois', async () => {
    const s = spawnSpoil();
    spoils.handleRaid(atacante, s);
    await settle();

    const rep = Object.values(state.reports)[0];
    expect(rep).toBeDefined();
    for (const campo of ['at', 'seed', 'attackerName', 'defenderName', 'won',
                         'difficulty', 'attackPower', 'defensePower', 'finalRatio']) {
      expect(rep[campo], `relatório sem ${campo}`).toBeDefined();
    }
    expect(rep.attacker.deaths + rep.attacker.survivors).toBe(rep.attacker.count);
    expect(rep.defender.deaths + rep.defender.survivors).toBe(rep.defender.count);
    // Campo de guilda reservado, presente e vazio (Guildas não existem ainda).
    expect(rep).toHaveProperty('guildName');

    // A semente reconstrói a mesma batalha — é o que torna o relatório estável.
    const refeita = battle.simulate({
      attackerIds: rep.attacker.used.flatMap(u => Array(u.n).fill(u.id)),
      defenderIds: rep.defender.used.flatMap(u => Array(u.n).fill(u.id)),
      seed: rep.seed,
      mods: { attackerOffPct: 0, attackerCasualtyPct: 0, defenderDefPct: 0 },
    });
    expect(refeita.attackerWon).toBe(rep.won);
    expect(refeita.attacker.deaths).toBe(rep.attacker.deaths);
    expect(refeita.defender.deaths).toBe(rep.defender.deaths);
  });

  it('o Diário registra a batalha e o saque dos dois lados', async () => {
    const s = spawnSpoil();
    spoils.handleRaid(atacante, s);
    await settle();

    const kinds = state.journal.map(j => j.kind);
    expect(kinds).toContain('spoil_created');
    expect(kinds).toContain('spoil_battle');
    expect(kinds).toContain('spoil_looted');
    // O dono afundado também fica sabendo, mesmo offline.
    expect(state.journal.some(j => j.name === 'Vitima' && j.kind === 'spoil_looted')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A fórmula em si: as baixas têm de sair da razão de forças, não de uma
// porcentagem fixa. É a promessa que o jogador lê no farol de dificuldade.
// ─────────────────────────────────────────────────────────────────────────────
describe('modelo de baixas', () => {
  const crew = (id, n) => Array(n).fill(id);

  it('vitória folgada custa pouco; vitória apertada custa caro', () => {
    const folgada  = battle.simulate({ attackerIds: crew('marujo', 40), defenderIds: crew('marujo', 4),  seed: 1 });
    const apertada = battle.simulate({ attackerIds: crew('marujo', 11), defenderIds: crew('marujo', 10), seed: 1 });
    expect(folgada.attacker.lossPct).toBeLessThan(apertada.attacker.lossPct);
    expect(folgada.attacker.lossPct).toBeLessThan(10);
  });

  it('derrota desesperada enterra perto de 95%', () => {
    const r = battle.simulate({ attackerIds: crew('marujo', 2), defenderIds: crew('marujo', 60), seed: 7 });
    expect(r.attackerWon).toBe(false);
    expect(r.attacker.lossPct).toBeGreaterThan(90);
  });

  it('quem perde sempre enterra alguém', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const r = battle.simulate({ attackerIds: crew('couraceiro', 3), defenderIds: crew('couraceiro', 40), seed });
      expect(r.attackerWon).toBe(false);
      expect(r.attacker.deaths).toBeGreaterThan(0);
    }
  });

  it('o tanque atravessa a derrota que dizima o atacante frágil', () => {
    let tanque = 0, fragil = 0;
    for (let seed = 1; seed <= 200; seed++) {
      tanque += battle.simulate({ attackerIds: crew('couraceiro', 10), defenderIds: crew('marujo', 90), seed }).attacker.deaths;
      fragil += battle.simulate({ attackerIds: crew('bucaneiro', 10), defenderIds: crew('marujo', 90), seed }).attacker.deaths;
    }
    expect(tanque).toBeLessThan(fragil);
    expect(PIRATE_DEFS.couraceiro.survival).toBeLessThan(PIRATE_DEFS.bucaneiro.survival);
  });

  it('mesma semente, mesmo resultado — sempre', () => {
    const args = { attackerIds: crew('marujo', 20), defenderIds: crew('fuzileiro', 9), seed: 4242 };
    expect(JSON.stringify(battle.simulate(args))).toBe(JSON.stringify(battle.simulate(args)));
  });

  it('o farol de dificuldade acompanha a razão de forças', () => {
    expect(battle.estimate(crew('marujo', 40), crew('marujo', 4)).difficultyColor).toBe('green');
    expect(battle.estimate(crew('marujo', 10), crew('marujo', 10)).difficultyColor).toBe('yellow');
    expect(battle.estimate(crew('marujo', 3),  crew('marujo', 40)).difficultyColor).toBe('red');
  });

  it('os talentos de abordagem inclinam a briga a favor do atacante', () => {
    const base = { attackerIds: crew('marujo', 10), defenderIds: crew('marujo', 11), seed: 99 };
    const sem  = battle.simulate(base);
    const com  = battle.simulate({ ...base, mods: { attackerOffPct: 0.40, attackerCasualtyPct: 0.30 } });
    expect(com.finalRatio).toBeGreaterThan(sem.finalRatio);
    expect(com.attacker.deaths).toBeLessThanOrEqual(sem.attacker.deaths);
  });
});
