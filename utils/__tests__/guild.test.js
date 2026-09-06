import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import GuildManager from '../../managers/guild-manager.js';
import JournalManager from '../../managers/journal-manager.js';
import { lootMult } from '../talent-effects.js';
import { recalcMaxHp } from '../talent-logic.js';
import {
  GUILD_CREATE_COST, GUILD_MAX_LEVEL, GUILD_XP_SHARE, GUILD_GOLD_SHARE,
  TAX_MAX_PCT, memberCap, xpToNextLevel, skillUpCost,
} from '../../constants/guilds.js';
import { noteKillGold } from '../helpers.js';

const SRC = JournalManager.SRC;

// ─────────────────────────────────────────────────────────────────────────────
// A guilda mexe em três coisas que não podem escorregar:
//
//   1. OURO DE VERDADE — fundar custa 500 mil, a taxa tira do bolso de quem
//      está offline e o cofre paga as skills. Nenhuma dessas contas pode
//      creditar duas vezes nem sumir com a moeda no meio do caminho.
//   2. UM PIRATA, UMA GUILDA — a filiação é única, e o intervalo entre pedir e
//      ser aceito é onde ela quebraria (entrar em outra guilda enquanto o líder
//      pensa).
//   3. O BÔNUS PRECISA CHEGAR — as skills não valem nada se o lootMult e o
//      recalcMaxHp não as lerem. Isso é testado contra as funções DE VERDADE,
//      não contra uma cópia: o modo de essa feature morrer em silêncio é o
//      bônus existir no dado e ninguém no motor consultá-lo.
// ─────────────────────────────────────────────────────────────────────────────

/** Banco de mentira — guarda guildas, membros e o ouro de quem está offline. */
function makeDb() {
  return {
    guilds:      new Map(),
    members:     new Map(),   // playerName → { guildId, ...m }
    apps:        new Set(),   // `${guildId}|${name}`
    offlineGold: new Map(),   // playerName → ouro no banco
    journal:     [],
    saves:       [],

    async loadGuilds() {
      const out = new Map();
      for (const g of this.guilds.values()) {
        out.set(g.id, { ...g, members: new Map(), applications: new Map() });
      }
      for (const [name, m] of this.members) {
        const g = out.get(m.guildId);
        if (g) g.members.set(name, { ...m });
      }
      for (const key of this.apps) {
        const [gid, name] = key.split('|');
        out.get(gid)?.applications.set(name, Date.now());
      }
      return out;
    },
    async upsertGuild(g) {
      for (const other of this.guilds.values()) {
        if (other.id === g.id) continue;
        if (other.name === g.name || other.tag === g.tag) return false;  // UNIQUE
      }
      this.guilds.set(g.id, {
        id: g.id, name: g.name, tag: g.tag, flag: g.flag, leaderName: g.leaderName,
        gold: g.gold, dobroes: g.dobroes, level: g.level, xp: g.xp,
        taxPct: g.taxPct, skills: { ...g.skills }, island: g.island,
        nextTaxAt: g.nextTaxAt, createdAt: g.createdAt,
      });
      return true;
    },
    async deleteGuild(id) {
      this.guilds.delete(id);
      for (const [n, m] of [...this.members]) if (m.guildId === id) this.members.delete(n);
    },
    async upsertGuildMember(guildId, name, m) { this.members.set(name, { guildId, ...m }); },
    async removeGuildMember(name) { this.members.delete(name); },
    async addGuildApplication(gid, name) { this.apps.add(`${gid}|${name}`); },
    async removeGuildApplication(gid, name) { this.apps.delete(`${gid}|${name}`); },
    async getPlayerGold(name) {
      return this.offlineGold.has(name) ? this.offlineGold.get(name) : null;
    },
    async debitOfflineGold(name, amount) {
      if (!this.offlineGold.has(name)) return 0;
      const cur = this.offlineGold.get(name);
      this.offlineGold.set(name, Math.max(0, cur - amount));
      return amount;
    },
    async addJournal(name, at, kind, data) { this.journal.push({ name, kind, data }); },
    async save(player) { this.saves.push(player.name); },
  };
}

function makePlayer(id, name, over = {}) {
  return {
    id, name,
    ws: { readyState: 1, OPEN: 1, bufferedAmount: 0, send() {} },
    gold: 1_000_000, dobroes: 500,
    mapXp: 0, mapLevel: 1, dead: false,
    x: 0, z: 0,
    _dbLoaded: true,
    ...over,
  };
}

/** Monta manager + mundo. `sent` acumula toda mensagem que sairia pelo socket. */
async function makeWorld() {
  const db      = makeDb();
  const players = new Map();
  const sent    = [];
  const journal = new JournalManager(db);
  const send    = (ws, msg) => { sent.push(msg); };
  const gm      = new GuildManager(send, players, db, journal, SRC);
  await gm.init();
  return { gm, db, players, sent, journal };
}

function addPlayer(world, id, name, over = {}) {
  const p = makePlayer(id, name, over);
  world.players.set(id, p);
  world.gm.onPlayerJoined(p);
  return p;
}

/** Funda uma guilda e espera o caminho assíncrono do banco terminar. */
async function found(world, player, name = 'Ossos do Ceifador', tag = 'OSSO') {
  world.gm.handleCreate(player, { type: 'guild_create', name, tag, flag: 'proc:12345' });
  await vi.waitFor(() => expect(world.gm.guildOf(player)).toBeTruthy());
  return world.gm.guildOf(player);
}

const lastOf = (sent, type) => [...sent].reverse().find(m => m.type === type);

describe('Guildas — fundação', () => {
  let w;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(() => w.gm.destroy());

  it('cobra os 500 mil e registra o fundador como líder', async () => {
    const p = addPlayer(w, 1, 'Barba Ruiva', { gold: 600_000 });
    const g = await found(w, p);

    expect(p.gold).toBe(600_000 - GUILD_CREATE_COST);
    expect(g.leaderName).toBe('Barba Ruiva');
    expect(g.members.get('Barba Ruiva').role).toBe('leader');
    expect(w.db.guilds.has(g.id)).toBe(true);
    expect(w.db.members.get('Barba Ruiva').guildId).toBe(g.id);
  });

  it('não cobra nada de quem não tem ouro suficiente', async () => {
    const p = addPlayer(w, 1, 'Duro', { gold: GUILD_CREATE_COST - 1 });
    w.gm.handleCreate(p, { type: 'guild_create', name: 'Sem Fundo', tag: 'SF' });

    expect(p.gold).toBe(GUILD_CREATE_COST - 1);
    expect(w.gm.guildOf(p)).toBeNull();
    expect(lastOf(w.sent, 'guild_error')).toBeTruthy();
  });

  // O ouro sai DEPOIS de o banco aceitar. Sem isso, perder a corrida do nome
  // levaria os 500 mil junto — sem guilda e sem ouro.
  it('devolve o jogador intacto quando o nome já foi tomado', async () => {
    const dono   = addPlayer(w, 1, 'Primeiro');
    await found(w, dono, 'Irmandade', 'IRM');

    const azarado = addPlayer(w, 2, 'Segundo', { gold: 900_000 });
    w.gm.handleCreate(azarado, { type: 'guild_create', name: 'Irmandade', tag: 'ZZZ' });

    expect(azarado.gold).toBe(900_000);
    expect(w.gm.guildOf(azarado)).toBeNull();
  });

  it('recusa nome curto, tag comprida e bandeira forjada', async () => {
    const p = addPlayer(w, 1, 'Teste');

    w.gm.handleCreate(p, { type: 'guild_create', name: 'ab', tag: 'OK' });
    expect(w.gm.guildOf(p)).toBeNull();

    w.gm.handleCreate(p, { type: 'guild_create', name: 'Nome Bom', tag: 'LONGADEMAIS' });
    expect(w.gm.guildOf(p)).toBeNull();

    // Caminho arbitrário não pode virar `flag`: o cliente carrega o que estiver
    // ali, e o campo viraria um vetor para mandá-lo abrir qualquer arquivo.
    const g = await found(w, p, 'Nome Bom', 'NB');
    expect(g.flag).toMatch(/^proc:\d+$/);

    w.gm.handleCreate(p, { type: 'guild_create', name: 'x', tag: 'x',
      flag: '../../etc/passwd' });
    expect(w.gm.guildOf(p).flag).toMatch(/^proc:\d+$/);
  });
});

describe('Guildas — filiação', () => {
  let w, lider, g;
  beforeEach(async () => {
    w = await makeWorld();
    lider = addPlayer(w, 1, 'Lider');
    g = await found(w, lider);
  });
  afterEach(() => w.gm.destroy());

  it('pedido → aceite coloca o pirata na guilda e no banco', () => {
    const novato = addPlayer(w, 2, 'Novato');
    w.gm.handleApply(novato, { guildId: g.id });
    expect(g.applications.has('Novato')).toBe(true);

    w.gm.handleResolveApplication(lider, { playerName: 'Novato', accept: true });
    expect(g.members.has('Novato')).toBe(true);
    expect(g.applications.has('Novato')).toBe(false);
    expect(w.db.members.get('Novato').guildId).toBe(g.id);
  });

  it('recusa não coloca ninguém e limpa o pedido', () => {
    const novato = addPlayer(w, 2, 'Novato');
    w.gm.handleApply(novato, { guildId: g.id });
    w.gm.handleResolveApplication(lider, { playerName: 'Novato', accept: false });

    expect(g.members.has('Novato')).toBe(false);
    expect(g.applications.has('Novato')).toBe(false);
  });

  // A janela entre pedir e ser aceito é onde "um pirata, uma guilda" quebraria.
  it('não aceita quem entrou em outra guilda enquanto o líder pensava', async () => {
    const andarilho = addPlayer(w, 2, 'Andarilho', { gold: 900_000 });
    w.gm.handleApply(andarilho, { guildId: g.id });

    const outra = await found(w, andarilho, 'Outra Casa', 'OC');
    expect(outra).toBeTruthy();

    w.gm.handleResolveApplication(lider, { playerName: 'Andarilho', accept: true });
    expect(g.members.has('Andarilho')).toBe(false);
    expect(w.gm.guildOf(andarilho).id).toBe(outra.id);
  });

  it('só o líder decide quem entra', () => {
    const membro = addPlayer(w, 2, 'Membro');
    w.gm.handleApply(membro, { guildId: g.id });
    w.gm.handleResolveApplication(lider, { playerName: 'Membro', accept: true });

    const forasteiro = addPlayer(w, 3, 'Forasteiro');
    w.gm.handleApply(forasteiro, { guildId: g.id });
    w.gm.handleResolveApplication(membro, { playerName: 'Forasteiro', accept: true });

    expect(g.members.has('Forasteiro')).toBe(false);
  });

  it('a saída do líder dissolve a guilda e solta todo mundo', () => {
    const membro = addPlayer(w, 2, 'Membro');
    w.gm.handleApply(membro, { guildId: g.id });
    w.gm.handleResolveApplication(lider, { playerName: 'Membro', accept: true });

    w.gm.handleLeave(lider);

    expect(w.gm.guildOf(lider)).toBeNull();
    expect(w.gm.guildOf(membro)).toBeNull();
    expect(w.db.guilds.has(g.id)).toBe(false);
  });
});

describe('Guildas — cofre e skills', () => {
  let w, lider, g;
  beforeEach(async () => {
    w = await makeWorld();
    lider = addPlayer(w, 1, 'Lider', { dobroes: 10_000 });
    g = await found(w, lider);
  });
  afterEach(() => w.gm.destroy());

  it('doação move dobrão do bolso para o cofre e conta como contribuição', () => {
    w.gm.handleDonate(lider, { dobroes: 400 });

    expect(lider.dobroes).toBe(9_600);
    expect(g.dobroes).toBe(400);
    expect(g.members.get('Lider').contribDobroes).toBe(400);
  });

  it('não deixa doar o que não se tem', () => {
    w.gm.handleDonate(lider, { dobroes: 999_999 });
    expect(g.dobroes).toBe(0);
    expect(lider.dobroes).toBe(10_000);
  });

  it('o nível da guilda é o teto das skills', () => {
    g.gold = 99_000_000; g.dobroes = 99_000;
    expect(g.level).toBe(1);

    w.gm.handleSkillUp(lider, { skillId: 'guild_gold_pct' });
    expect(g.skills.guild_gold_pct).toBe(1);

    // Nível 1 de guilda ⇒ skill não passa de 1 por mais rico que o cofre esteja.
    w.gm.handleSkillUp(lider, { skillId: 'guild_gold_pct' });
    expect(g.skills.guild_gold_pct).toBe(1);

    g.level = 5;
    w.gm.handleSkillUp(lider, { skillId: 'guild_gold_pct' });
    expect(g.skills.guild_gold_pct).toBe(2);
  });

  it('cobra o custo do cofre e recusa quando falta', () => {
    g.level = 10;
    const custo = skillUpCost('guild_gold_pct', 0);
    g.gold = custo.gold; g.dobroes = custo.dobroes;

    w.gm.handleSkillUp(lider, { skillId: 'guild_gold_pct' });
    expect(g.gold).toBe(0);
    expect(g.dobroes).toBe(0);

    w.gm.handleSkillUp(lider, { skillId: 'guild_gold_pct' });
    expect(g.skills.guild_gold_pct).toBe(1);   // cofre vazio: não subiu
  });

  it('só o líder investe o cofre', () => {
    const membro = addPlayer(w, 2, 'Membro');
    w.gm.handleApply(membro, { guildId: g.id });
    w.gm.handleResolveApplication(lider, { playerName: 'Membro', accept: true });

    g.level = 10; g.gold = 99_000_000; g.dobroes = 99_000;
    w.gm.handleSkillUp(membro, { skillId: 'guild_gold_pct' });
    expect(g.skills.guild_gold_pct).toBeUndefined();
  });

  it('a taxa fica presa no teto de 5%', () => {
    w.gm.handleSetTax(lider, { taxPct: 0.9 });
    expect(g.taxPct).toBe(TAX_MAX_PCT);

    w.gm.handleSetTax(lider, { taxPct: -1 });
    expect(g.taxPct).toBe(0);
  });
});

describe('Guildas — o bônus chega ao motor', () => {
  let w, lider, g;
  beforeEach(async () => {
    w = await makeWorld();
    lider = addPlayer(w, 1, 'Lider');
    g = await found(w, lider);
    g.level = GUILD_MAX_LEVEL;
  });
  afterEach(() => w.gm.destroy());

  /** Sobe uma skill enchendo o cofre na marra — o preço é assunto de outro teste. */
  function upa(id, vezes) {
    for (let i = 0; i < vezes; i++) {
      g.gold = 9e9; g.dobroes = 9e6;
      w.gm.handleSkillUp(lider, { skillId: id });
    }
  }

  // ── As skills pararam de tocar a ficha do jogador (2026-09-06) ────────────
  // Três delas (+% de ouro, dobrão e XP para todo membro) e mais o Casco da
  // Irmandade davam poder DIRETO a quem entrasse numa guilda grande. Foram
  // aposentadas: o eixo virou fortalecer a irmandade. Estes testes travam a
  // porta por onde elas voltariam sem ninguém perceber — o `lootMult` e o
  // `recalcMaxHp` são os dois funis por onde poder de jogador passa.
  it('nenhuma skill de guilda mexe no espólio do membro', () => {
    upa('guild_gold_pct', 3);
    upa('guild_xp_pct', 2);
    for (const kind of ['gold', 'dobrao', 'xp', 'xp_boss']) {
      expect(lootMult(lider, kind), `${kind} recebeu bônus de guilda`).toBe(1.0);
    }
  });

  it('nenhuma skill de guilda mexe na vida do membro', () => {
    const SHIPS = { fragata: { hp: 1000 } };
    lider.activeShip = 'fragata';
    upa('guild_gold_pct', 4);
    upa('tower_hp_pct', 4);
    recalcMaxHp(lider, SHIPS, {}, null);
    expect(lider.maxHp, 'a guilda voltou a somar vida').toBe(1000);
  });

  it('quem não tem guilda continua em 1,0', () => {
    const solitario = addPlayer(w, 9, 'Solitario');
    expect(lootMult(solitario, 'gold')).toBe(1.0);
    expect(lootMult(solitario, 'xp')).toBe(1.0);
  });

  // ── O que elas viraram ───────────────────────────────────────────────────
  it('Crônica da Irmandade engorda a fatia de XP que vai para a GUILDA', () => {
    // Mede a CONTRIBUIÇÃO do membro, não `g.xp`: a guilda deste teste está no
    // nível máximo (é o que permite comprar skill), e lá o `_addGuildXp` zera
    // o XP de propósito — no teto ele não acumula. A contribuição é o mesmo
    // número, e sobrevive.
    const ficha = () => g.members.get('Lider');
    ficha().contribXp = 0;
    lider._guildXpMark = 0; lider.mapXp = 100_000;
    w.gm._creditXp(lider);
    const semSkill = ficha().contribXp;
    expect(semSkill, 'a fatia base não creditou').toBeGreaterThan(0);

    upa('guild_xp_pct', 5);                      // +50%
    ficha().contribXp = 0;
    lider._guildXpMark = 0; lider.mapXp = 100_000;
    w.gm._creditXp(lider);
    expect(ficha().contribXp / semSkill).toBeCloseTo(1.5, 2);
  });

  it('Quinhão do Cofre engorda a fatia de ouro que vai para o COFRE', () => {
    g.gold = 0;
    lider._killGold = 100_000;
    w.gm._creditGold(lider);
    const semSkill = g.gold;
    expect(semSkill, 'a fatia base não creditou').toBeGreaterThan(0);

    upa('guild_gold_pct', 5);                    // +50%
    g.gold = 0;
    lider._killGold = 100_000;
    w.gm._creditGold(lider);
    expect(g.gold / semSkill).toBeCloseTo(1.5, 2);
  });

  it('a fatia NÃO sai do bolso de quem caçou', () => {
    // É o que separa "a guilda cresce junto" de "a guilda cobra pedágio".
    lider.gold = 500_000;
    lider._killGold = 100_000;
    upa('guild_gold_pct', 10);
    w.gm._creditGold(lider);
    expect(lider.gold, 'o cofre descontou do membro').toBe(500_000);
  });

  // ── A devolução do que foi gasto nas aposentadas ─────────────────────────
  // Guildas compraram essas skills com as regras de ontem. Apagar a linha do
  // catálogo sem devolver faria o cofre gasto sumir em silêncio — o nível
  // continuaria salvo no JSON e viraria uma chave que ninguém lê.
  it('devolve ao cofre o que foi gasto nas skills aposentadas', () => {
    g.gold = 0; g.dobroes = 0;
    g.skills = { gold_pct: 3, member_hp_pct: 1, tower_hp_pct: 2 };

    w.gm._devolverSkillsAposentadas();

    // gold_pct nv3 = 200k × (1+2+3) = 1,2 M | member_hp_pct nv1 = 300k
    expect(g.gold).toBe(1_500_000);
    expect(g.dobroes).toBe(50 * 6 + 100);
    // A chave morta some; a que continua no catálogo fica intocada.
    expect(g.skills.gold_pct).toBeUndefined();
    expect(g.skills.member_hp_pct).toBeUndefined();
    expect(g.skills.tower_hp_pct).toBe(2);
  });

  it('a devolução roda uma vez só — ela apaga o próprio gatilho', () => {
    g.gold = 0; g.dobroes = 0;
    g.skills = { xp_pct: 2 };
    w.gm._devolverSkillsAposentadas();
    const primeira = g.gold;
    expect(primeira).toBeGreaterThan(0);

    w.gm._devolverSkillsAposentadas();
    expect(g.gold, 'devolveu de novo no boot seguinte').toBe(primeira);
  });

  it('guilda que nunca comprou uma aposentada não é tocada', () => {
    g.gold = 1234; g.dobroes = 7;
    g.skills = { tower_dmg_pct: 1 };
    w.gm._devolverSkillsAposentadas();
    expect(g.gold).toBe(1234);
    expect(g.dobroes).toBe(7);
    expect(g.skills).toEqual({ tower_dmg_pct: 1 });
  });

  it('as skills de torre são guardadas mesmo sem torre no jogo', () => {
    upa('tower_hp_pct', 3);
    upa('tower_dmg_pct', 2);
    const b = w.gm.bonusFor(lider);
    expect(b.tower_hp_pct).toBeCloseTo(0.30, 5);
    expect(b.tower_dmg_pct).toBeCloseTo(0.10, 5);
  });

  it('sair da guilda apaga o bônus na hora', () => {
    upa('tower_hp_pct', 3);
    expect(w.gm.bonusFor(lider).tower_hp_pct).toBeCloseTo(0.30, 5);

    w.gm.handleLeave(lider);   // líder sai ⇒ dissolve
    expect(w.gm.bonusFor(lider).tower_hp_pct).toBe(0);
  });
});

describe('Guildas — contribuição amostrada (XP e ouro)', () => {
  let w, lider, g;
  beforeEach(async () => {
    w = await makeWorld();
    lider = addPlayer(w, 1, 'Lider');
    g = await found(w, lider);
  });
  afterEach(() => w.gm.destroy());

  // O XP que o membro já tinha ANTES não conta: senão um veterano subiria a
  // guilda inteira no primeiro login depois de entrar nela.
  it('só o XP ganho depois de entrar conta', () => {
    const veterano = addPlayer(w, 2, 'Veterano', { mapXp: 8_000_000 });
    w.gm.handleApply(veterano, { guildId: g.id });
    w.gm.handleResolveApplication(lider, { playerName: 'Veterano', accept: true });

    w.gm._sweepContrib();
    expect(g.xp).toBe(0);

    veterano.mapXp += 100_000;
    w.gm._sweepContrib();
    expect(g.xp).toBe(Math.floor(100_000 * GUILD_XP_SHARE));
    expect(g.members.get('Veterano').contribXp).toBe(Math.floor(100_000 * GUILD_XP_SHARE));
  });

  it('não credita duas vezes o mesmo XP', () => {
    lider.mapXp += 50_000;
    w.gm._sweepContrib();
    const depois = g.xp;
    w.gm._sweepContrib();
    expect(g.xp).toBe(depois);
  });

  // O PVP transfere 5% do XP do morto para o matador — o delta fica negativo.
  it('perder XP no mar não tira XP da guilda', () => {
    lider.mapXp += 40_000;
    w.gm._sweepContrib();
    const depois = g.xp;

    lider.mapXp -= 30_000;
    w.gm._sweepContrib();
    expect(g.xp).toBe(depois);
  });

  it('sobe de nível quando o XP passa da conta, e para no 25', () => {
    lider.mapXp += Math.ceil(xpToNextLevel(1) / GUILD_XP_SHARE) + 10;
    w.gm._sweepContrib();
    expect(g.level).toBe(2);

    g.level = GUILD_MAX_LEVEL;
    lider.mapXp += 50_000_000;
    w.gm._sweepContrib();
    expect(g.level).toBe(GUILD_MAX_LEVEL);
    expect(g.xp).toBe(0);
  });

  it('o XP pendente é fechado quando o jogador desconecta', () => {
    lider.mapXp += 90_000;
    w.gm.onPlayerLeft(lider);
    expect(g.xp).toBe(Math.floor(90_000 * GUILD_XP_SHARE));
  });

  // ── Ouro de abate ─────────────────────────────────────────────────────────
  // Mesma lógica do XP, e é por isso que mora no mesmo describe. O que muda é a
  // fonte: um acumulador que só cresce (noteKillGold), porque `player.gold` é
  // SALDO e sobe e desce o dia inteiro.

  it('o ouro de abate rende ao cofre sem sair do bolso do membro', () => {
    lider.gold = 500_000;
    noteKillGold(lider, 80_000);
    w.gm._sweepContrib();

    expect(g.gold).toBe(Math.floor(80_000 * GUILD_GOLD_SHARE));
    expect(g.members.get('Lider').contribGold).toBe(Math.floor(80_000 * GUILD_GOLD_SHARE));
    expect(lider.gold).toBe(500_000);   // o membro não paga nada
  });

  it('não credita duas vezes o mesmo abate', () => {
    noteKillGold(lider, 40_000);
    w.gm._sweepContrib();
    const depois = g.gold;
    w.gm._sweepContrib();
    expect(g.gold).toBe(depois);
  });

  // O modo silencioso de isto quebrar: amostrar `player.gold` em vez do
  // acumulador. Aí sacar do banco viraria contribuição e comprar um canhão
  // viraria dívida.
  it('mexer no saldo sem matar nada não rende nada ao cofre', () => {
    lider.gold = 10_000_000;          // sacou do banco
    w.gm._sweepContrib();
    expect(g.gold).toBe(0);

    lider.gold = 1_000;               // gastou tudo
    w.gm._sweepContrib();
    expect(g.gold).toBe(0);
  });

  it('o ouro acumulado ANTES de entrar na guilda não conta', () => {
    const veterano = addPlayer(w, 2, 'Veterano');
    noteKillGold(veterano, 5_000_000);          // caçou a vida toda sozinho
    w.gm.handleApply(veterano, { guildId: g.id });
    w.gm.handleResolveApplication(lider, { playerName: 'Veterano', accept: true });

    w.gm._sweepContrib();
    expect(g.gold).toBe(0);

    noteKillGold(veterano, 60_000);
    w.gm._sweepContrib();
    expect(g.gold).toBe(Math.floor(60_000 * GUILD_GOLD_SHARE));
  });

  it('o ouro pendente é fechado quando o jogador desconecta', () => {
    noteKillGold(lider, 70_000);
    w.gm.onPlayerLeft(lider);
    expect(g.gold).toBe(Math.floor(70_000 * GUILD_GOLD_SHARE));
  });

  // As duas contas na MESMA saída. O jeito de isto quebrar é escrever
  // `creditaXp(p) || creditaOuro(p)` para descobrir a guilda tocada: o `||`
  // curto-circuita e o segundo lado nunca roda quando o primeiro rende algo.
  it('desconectar fecha o XP E o ouro, não um ou outro', () => {
    lider.mapXp += 90_000;
    noteKillGold(lider, 70_000);
    w.gm.onPlayerLeft(lider);

    expect(g.xp).toBe(Math.floor(90_000 * GUILD_XP_SHARE));
    expect(g.gold).toBe(Math.floor(70_000 * GUILD_GOLD_SHARE));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A curva de nível é a régua do sistema inteiro (skills, vagas, alíquota do
// imposto). Um degrau barato no começo transforma os 25 níveis numa tabela de
// progresso qualquer — e nada no jogo reclama se ele ficar barato.
// ─────────────────────────────────────────────────────────────────────────────
describe('Guildas — a curva de nível é cara de propósito', () => {
  it('o primeiro nível custa 100 mil de XP de guilda', () => {
    expect(xpToNextLevel(1)).toBe(100_000);
  });

  it('cada degrau é 25% mais caro que o anterior', () => {
    for (let lvl = 1; lvl < GUILD_MAX_LEVEL - 1; lvl++) {
      expect(xpToNextLevel(lvl + 1) / xpToNextLevel(lvl)).toBeCloseTo(1.25, 2);
    }
  });

  // 84,3 milhões de XP de GUILDA — com GUILD_XP_SHARE em 10%, são 843 milhões
  // de XP caçado pelos membros somados. O número existe para que uma queda
  // acidental (voltar aos 25.000 de antes, que dariam 21 milhões) apareça como
  // falha em vez de passar despercebida.
  it('o caminho inteiro até o 25 passa de 80 milhões de XP de guilda', () => {
    let total = 0;
    for (let lvl = 1; lvl < GUILD_MAX_LEVEL; lvl++) total += xpToNextLevel(lvl);
    expect(total).toBeGreaterThan(80_000_000);
  });
});

describe('Guildas — taxa diária', () => {
  let w, lider, g;
  beforeEach(async () => {
    w = await makeWorld();
    lider = addPlayer(w, 1, 'Lider', { gold: 1_000_000 });
    g = await found(w, lider);
  });
  afterEach(() => w.gm.destroy());

  it('cobra de quem está online, na memória', async () => {
    w.gm.handleSetTax(lider, { taxPct: 0.05 });
    lider.gold = 1_000_000;
    g.nextTaxAt = Date.now() - 1;

    await w.gm._sweepTax();

    expect(lider.gold).toBe(950_000);
    expect(g.gold).toBe(50_000);
    expect(g.members.get('Lider').contribGold).toBe(50_000);
  });

  // O ouro de quem está offline só existe no banco: cobrar na memória de uma
  // cópia que não existe seria cobrar de ninguém.
  it('cobra de quem está offline direto no banco', async () => {
    const ausente = addPlayer(w, 2, 'Ausente');
    w.gm.handleApply(ausente, { guildId: g.id });
    w.gm.handleResolveApplication(lider, { playerName: 'Ausente', accept: true });

    w.players.delete(2);                       // desconectou
    w.db.offlineGold.set('Ausente', 200_000);

    w.gm.handleSetTax(lider, { taxPct: 0.05 });
    lider.gold = 0;
    g.nextTaxAt = Date.now() - 1;

    await w.gm._sweepTax();

    expect(w.db.offlineGold.get('Ausente')).toBe(190_000);
    expect(g.gold).toBe(10_000);
  });

  it('taxa em 0% não mexe em ninguém', async () => {
    lider.gold = 777_000;
    g.taxPct = 0;
    g.nextTaxAt = Date.now() - 1;

    await w.gm._sweepTax();

    expect(lider.gold).toBe(777_000);
    expect(g.gold).toBe(0);
  });

  // Reagendar ANTES de cobrar é o que impede a varredura de 5 em 5 minutos
  // cobrar o dia inteiro de uma guilda cuja hora passou.
  it('não cobra duas vezes na mesma janela', async () => {
    w.gm.handleSetTax(lider, { taxPct: 0.05 });
    lider.gold = 1_000_000;
    g.nextTaxAt = Date.now() - 1;

    await w.gm._sweepTax();
    await w.gm._sweepTax();

    expect(lider.gold).toBe(950_000);
    expect(g.gold).toBe(50_000);
  });
});

describe('Guildas — persistência e consultas', () => {
  let w;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(() => w.gm.destroy());

  it('sobrevive a um restart do servidor', async () => {
    const lider = addPlayer(w, 1, 'Lider', { dobroes: 5_000 });
    const g = await found(w, lider, 'Ossos', 'OSS');
    const membro = addPlayer(w, 2, 'Membro');
    w.gm.handleApply(membro, { guildId: g.id });
    w.gm.handleResolveApplication(lider, { playerName: 'Membro', accept: true });
    w.gm.handleDonate(lider, { dobroes: 1_200 });
    g.level = 6;
    await w.db.upsertGuild(g);

    // Servidor reinicia: manager novo, MESMO banco.
    const players2 = new Map();
    const gm2 = new GuildManager(() => {}, players2, w.db, new JournalManager(w.db), SRC);
    await gm2.init();

    const g2 = gm2.guildOfName('Lider');
    expect(g2).toBeTruthy();
    expect(g2.name).toBe('Ossos');
    expect(g2.tag).toBe('OSS');
    expect(g2.dobroes).toBe(1_200);
    expect(g2.level).toBe(6);
    expect(g2.members.has('Membro')).toBe(true);
    expect(gm2.areGuildMates('Lider', 'Membro')).toBe(true);
  });

  it('busca combina nome e tag, e ignora o resto', async () => {
    const a = addPlayer(w, 1, 'A');
    const b = addPlayer(w, 2, 'B');
    await found(w, a, 'Ossos do Ceifador', 'OSSO');
    await found(w, b, 'Corsários do Sul', 'SUL');

    w.gm.handleSearch(a, { q: 'ceif' });
    expect(lastOf(w.sent, 'guild_search_result').guilds.map(x => x.tag)).toEqual(['OSSO']);

    w.gm.handleSearch(a, { q: 'sul' });
    expect(lastOf(w.sent, 'guild_search_result').guilds.map(x => x.tag)).toEqual(['SUL']);

    // Busca vazia lista tudo — é o que faz a aba abrir mostrando algo.
    w.gm.handleSearch(a, { q: '' });
    expect(lastOf(w.sent, 'guild_search_result').guilds.length).toBe(2);
  });

  it('membros da guilda no mesmo mapa alimentam o minimapa', async () => {
    const lider = addPlayer(w, 1, 'Lider');
    const g = await found(w, lider);
    const perto = addPlayer(w, 2, 'Perto',  { mapLevel: 1, x: 50, z: 50 });
    const longe = addPlayer(w, 3, 'Longe',  { mapLevel: 4 });
    for (const p of [perto, longe]) {
      w.gm.handleApply(p, { guildId: g.id });
      w.gm.handleResolveApplication(lider, { playerName: p.name, accept: true });
    }

    const naZona = w.gm.getGuildMembersInZone(lider, 1);
    expect(naZona.map(p => p.name)).toEqual(['Perto']);

    // Quem já é blip de GRUPO sai da lista — senão o mesmo barco sairia em duas cores.
    expect(w.gm.getGuildMembersInZone(lider, 1, new Set([2]))).toEqual([]);
  });

  it('a vaga da guilda cresce com o nível', () => {
    expect(memberCap(1)).toBe(20);
    expect(memberCap(GUILD_MAX_LEVEL)).toBe(45);
  });
});
