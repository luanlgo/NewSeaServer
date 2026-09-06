import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import IslandManager from '../../managers/island-manager.js';
import TaxBoatManager from '../../managers/tax-boat-manager.js';
import JournalManager from '../../managers/journal-manager.js';
import { MAP_DEFS } from '../../constants/maps.js';
import { NPC_SHIP_HULLS } from '../../constants/npc_ships.js';
import {
  TOWER_TYPES, TOWER_PROD, TOWER_SLOTS, TOWER_RANGE, TOWER_FIRE_MS, TOWER_RESPAWN_MS,
  REPAIR_CALM_MS, REPAIR_PCT_PER_MIN, repairGoldPerHp,
  GRACE_MS, ASSAULT_WINDOW_MS, taxPctFor, towerSlotPos, rollTowerType,
  ISLAND_DEFS, ACTION_VENUE, TAX_BOAT_HP, weekKey, nextEventAt,
  FORCE_EVENT_TEST_POT, islandHull,
} from '../../constants/islands.js';
import { pushOutOfIslands } from '../collision.js';

const SRC = JournalManager.SRC;

// ─────────────────────────────────────────────────────────────────────────────
// A ilha move três coisas que não podem escorregar:
//
//   1. OURO DE VERDADE — o cofre da guilda paga torre e reparo, o imposto sai
//      do bolso de quem compra e a coleta paga um monte de gente de uma vez.
//   2. A POSSE — cinco torres caídas decidem quem manda numa praça econômica do
//      jogo por uma semana. Errar o ranking é entregar a ilha à guilda errada.
//   3. O DANO QUE ATRAVESSA A MORTE — no evento da coleta o jogador MORRE e o
//      dano dele tem de continuar contando. É a promessa mais fácil de quebrar
//      do sistema inteiro, porque o id da entidade não sobrevive ao respawn.
//
// Os testes perseguem essas três, e o modo silencioso de cada uma falhar.
// ─────────────────────────────────────────────────────────────────────────────

/** Banco de mentira: guarda ilhas e o ouro de quem está offline. */
function makeDb() {
  return {
    ilhas:       new Map(),
    guildas:     new Map(),
    offlineGold: new Map(),
    journal:     [],

    async loadIslands() {
      const out = new Map();
      for (const [id, i] of this.ilhas) out.set(id, JSON.parse(JSON.stringify(i)));
      return out;
    },
    async upsertIsland(i) {
      this.ilhas.set(i.id, JSON.parse(JSON.stringify({ ...i, def: undefined })));
    },
    async upsertGuild(g) { this.guildas.set(g.id, g); },
    async creditOfflineGold(name, amount) {
      this.offlineGold.set(name, (this.offlineGold.get(name) || 0) + amount);
      return amount;
    },
    async debitOfflineGold() { return 0; },
    async getPlayerGold(name) { return this.offlineGold.get(name) ?? null; },
    async addJournal(name, at, kind, data) { this.journal.push({ name, kind, data }); },
    async save() {},
  };
}

/**
 * GuildManager de mentira com a MESMA superfície que o IslandManager consome:
 * `guilds` (Map), `guildOf(player)` e `bonusFor(player)`. Usar o real aqui
 * arrastaria o banco de guildas para dentro de um teste de ilha.
 */
function makeGuilds() {
  return {
    guilds: new Map(),
    _porJogador: new Map(),   // nome → guildId

    criar(id, tag, name, leaderName, over = {}) {
      const g = {
        id, tag, name, leaderName,
        gold: 0, dobroes: 0, level: 1, skills: {},
        members: new Map([[leaderName, { role: 'leader' }]]),
        ...over,
      };
      this.guilds.set(id, g);
      this._porJogador.set(leaderName, id);
      return g;
    },
    entrar(guildId, nome) {
      this.guilds.get(guildId).members.set(nome, { role: 'member' });
      this._porJogador.set(nome, guildId);
    },
    guildOf(player) {
      const id = player && this._porJogador.get(player.name);
      return id ? this.guilds.get(id) : null;
    },
    bonusFor(player) {
      const g = this.guildOf(player);
      const zero = { gold_pct: 0, dobrao_pct: 0, xp_pct: 0, member_hp_pct: 0,
                     tower_hp_pct: 0, tower_dmg_pct: 0, tax_boat_pct: 0 };
      if (!g) return zero;
      return {
        ...zero,
        tower_hp_pct:  (g.skills.tower_hp_pct  || 0) * 0.10,
        tower_dmg_pct: (g.skills.tower_dmg_pct || 0) * 0.05,
        tax_boat_pct:  (g.skills.tax_boat_pct  || 0) * 0.10,
      };
    },
  };
}

function makePlayer(id, name, over = {}) {
  return {
    id, name,
    ws: { readyState: 1, OPEN: 1, bufferedAmount: 0, send() {} },
    gold: 1_000_000, dobroes: 1_000,
    hp: 500_000, maxHp: 500_000,
    x: 0, z: 0, mapLevel: 12, dead: false, _dbLoaded: true,
    ...over,
  };
}

let _uid = 1;

async function makeWorld(dbExistente = null) {
  const db      = dbExistente || makeDb();
  const players = new Map();
  const sent    = [];
  const eventos = [];
  const guilds  = makeGuilds();
  const journal = new JournalManager(db);
  const send    = (ws, msg) => sent.push(msg);

  const im = new IslandManager(send, (e, m) => eventos.push({ ...e, _map: m }),
                               players, db, guilds, journal, SRC);
  const tb = new TaxBoatManager(send, (e, m) => eventos.push({ ...e, _map: m }),
                                players, db, im, guilds, journal, SRC, MAP_DEFS);
  im.taxBoat = tb;

  const extra = new Map();
  for (const mgr of [im, tb]) {
    mgr.uid = () => _uid++;
    mgr.registerEntity   = (id, ent) => extra.set(id, ent);
    mgr.unregisterEntity = (id) => extra.delete(id);
  }
  await im.init();
  return { im, tb, db, players, sent, eventos, guilds, extra };
}

function addPlayer(w, id, name, over = {}) {
  const p = makePlayer(id, name, over);
  w.players.set(id, p);
  return p;
}

/** Derruba a torre `slot` creditando todo o dano a `quem`. */
function derrubar(w, ilha, slot, quem) {
  const ent = w.im._towerEntity(ilha.id, slot);
  if (!ent) return;
  w.im.recordTowerDamage(ent, quem, ent.hp);
  ent.hp = 0;
  w.im.onTowerDestroyed(ent, quem);
}

const ilhaDe = (w, id = 1) => w.im.islands.get(id);
const ultimo = (sent, type) => [...sent].reverse().find(m => m.type === type);

describe('Ilhas — estado inicial', () => {
  let w;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(() => { w.im.destroy(); w.tb.destroy(); });

  it('as três ilhas nascem neutras com 5 torres no mar', () => {
    expect(w.im.islands.size).toBe(3);
    for (const ilha of w.im.islands.values()) {
      expect(ilha.state).toBe('neutral');
      expect(ilha.ownerGuildId).toBeNull();
      expect(ilha.towers.length).toBe(TOWER_SLOTS);
      expect(ilha.towers.every(t => !t.dead)).toBe(true);
    }
    expect(w.extra.size).toBe(3 * TOWER_SLOTS);
  });

  it('cada ilha governa uma praça e mora no mapa dela', () => {
    const porMapa = [...w.im.islands.values()].map(i => [i.mapLevel, i.def.venue]);
    expect(porMapa).toEqual([[12, 'farol'], [13, 'mercado'], [14, 'banco']]);
  });

  it('as torres ficam nos cinco postos fixos em volta do centro', () => {
    const ilha = ilhaDe(w);
    for (let i = 0; i < TOWER_SLOTS; i++) {
      const ent = w.im._towerEntity(ilha.id, i);
      const esperado = towerSlotPos(i);
      expect(ent.x).toBeCloseTo(esperado.x, 3);
      expect(ent.z).toBeCloseTo(esperado.z, 3);
    }
  });

  it('o sorteio respeita 60/30/10', () => {
    const c = { fraca: 0, media: 0, forte: 0 };
    for (let i = 0; i < 20000; i++) c[rollTowerType()]++;
    expect(c.fraca / 20000).toBeCloseTo(0.60, 1);
    expect(c.media / 20000).toBeCloseTo(0.30, 1);
    expect(c.forte / 20000).toBeCloseTo(0.10, 1);
  });

  it('sobrevive a um restart do servidor', async () => {
    const ilha = ilhaDe(w);
    ilha.taxPot = 777_000;
    ilha.towers[0].hp = 123;
    await w.db.upsertIsland(ilha);

    // Servidor reinicia: managers novos, MESMO banco.
    const w2 = await makeWorld(w.db);
    const i2 = w2.im.islands.get(1);
    expect(i2.taxPot).toBe(777_000);
    expect(i2.towers[0].hp).toBe(123);
    w2.im.destroy(); w2.tb.destroy();
  });
});

describe('Ilhas — as torres atirando', () => {
  let w, ilha;
  beforeEach(async () => { w = await makeWorld(); ilha = ilhaDe(w); });
  afterEach(() => { w.im.destroy(); w.tb.destroy(); });

  it('acerta quem entra no alcance e ignora quem fica fora', () => {
    const pos = towerSlotPos(0);
    const dentro = addPlayer(w, 1, 'Perto', { x: pos.x, z: pos.z + TOWER_RANGE - 10 });
    const fora   = addPlayer(w, 2, 'Longe', { x: pos.x, z: pos.z + TOWER_RANGE + 50 });
    const hpD = dentro.hp, hpF = fora.hp;

    w.im._tickTowers(Date.now());

    expect(dentro.hp).toBeLessThan(hpD);
    expect(fora.hp).toBe(hpF);
  });

  it('respeita a cadência — não dispara duas vezes no mesmo instante', () => {
    const pos = towerSlotPos(0);
    const p = addPlayer(w, 1, 'Alvo', { x: pos.x, z: pos.z + 20 });
    const t0 = Date.now();

    w.im._tickTowers(t0);
    const depoisDoPrimeiro = p.hp;
    w.im._tickTowers(t0 + 100);
    expect(p.hp).toBe(depoisDoPrimeiro);

    w.im._tickTowers(t0 + TOWER_FIRE_MS + 1);
    expect(p.hp).toBeLessThan(depoisDoPrimeiro);
  });

  // "As torres NÃO atacam membros da guilda dona" — e a torre NEUTRA não poupa
  // ninguém. São as duas metades da mesma regra.
  it('torre da guilda poupa a dona; torre neutra não poupa ninguém', () => {
    const pos = towerSlotPos(0);
    const dono = addPlayer(w, 1, 'Dono', { x: pos.x, z: pos.z + 20 });
    w.guilds.criar('g1', 'AAA', 'Guilda A', 'Dono');

    // Neutra: bate mesmo em quem tem guilda.
    w.im._tickTowers(Date.now());
    expect(dono.hp).toBeLessThan(dono.maxHp);

    // Agora a ilha é dela — e a mesma torre passa a poupá-lo.
    ilha.ownerGuildId = 'g1';
    for (const t of w.im.towers.values()) { t.ownerGuildId = 'g1'; t._nextShot = 0; }
    const hp = dono.hp;
    w.im._tickTowers(Date.now() + TOWER_FIRE_MS * 2);
    expect(dono.hp).toBe(hp);
  });

  it('mira o alvo MAIS PRÓXIMO', () => {
    const pos = towerSlotPos(0);
    const perto = addPlayer(w, 1, 'Perto', { x: pos.x, z: pos.z + 20 });
    const meio  = addPlayer(w, 2, 'Meio',  { x: pos.x, z: pos.z + 100 });

    w.im._tickTowers(Date.now());
    expect(perto.hp).toBeLessThan(perto.maxHp);
    expect(meio.hp).toBe(meio.maxHp);
  });

  it('não atira em quem está em outro mapa', () => {
    const pos = towerSlotPos(0);
    const outro = addPlayer(w, 1, 'Outro', { x: pos.x, z: pos.z + 20, mapLevel: 11 });
    w.im._tickTowers(Date.now());
    expect(outro.hp).toBe(outro.maxHp);
  });

  // ── O tiro precisa APARECER ───────────────────────────────────────────────
  // A vida caía e nada saía da pedra: `tower_shot` é privado do alvo (carrega o
  // hp dele) e ninguém mais no mapa recebia nada. O modo silencioso de isto
  // quebrar de novo é alguém tirar o x/z da mensagem — sem a origem, o cliente
  // não tem de onde desenhar a bala e simplesmente não desenha.
  it('o alvo recebe de ONDE o tiro saiu, não só quanto doeu', () => {
    const pos = towerSlotPos(0);
    const p = addPlayer(w, 1, 'Alvo', { x: pos.x, z: pos.z + 20 });

    w.im._tickTowers(Date.now());

    const shot = ultimo(w.sent, 'tower_shot');
    expect(shot).toBeTruthy();
    expect(shot.damage).toBeGreaterThan(0);
    // A bala nasce na TORRE e cai no barco.
    expect(shot.x).toBeCloseTo(pos.x, 3);
    expect(shot.z).toBeCloseTo(pos.z, 3);
    expect(shot.targetX).toBe(p.x);
    expect(shot.targetZ).toBe(p.z);
  });

  // ── O dano da torre NÃO é fixo ────────────────────────────────────────────
  // A torre é o "hit de NPC" da ilha: o `damage` da tabela é o golpe BRUTO, e
  // o que chega no casco passa pelas defesas do jogador. O modo silencioso de
  // isto quebrar é alguém voltar a escrever `alvo.hp -= torre.damage` — não dá
  // erro, e o kit defensivo inteiro simplesmente para de valer contra a
  // muralha da ilha sem nenhuma pista.
  describe('as defesas do jogador contam', () => {
    it('redução de talento corta o golpe da torre', () => {
      const pos = towerSlotPos(0);
      const nu = addPlayer(w, 1, 'Nu', { x: pos.x, z: pos.z + 20 });
      w.im._tickTowers(Date.now());
      const levouNu = nu.maxHp - nu.hp;

      // O MESMO posto, o mesmo tiro — só o alvo muda. A torre mira o mais
      // próximo, então o primeiro tem de sair de cena para o segundo entrar.
      w.players.delete(1);
      const couro = addPlayer(w, 2, 'Couro', { x: pos.x, z: pos.z + 20,
        tal: { damage_reduction_pct: 40 } });   // 40 pontos percentuais
      w.im._tickTowers(Date.now() + TOWER_FIRE_MS * 2);
      const levouCouro = couro.maxHp - couro.hp;

      expect(levouNu).toBeGreaterThan(0);
      expect(levouCouro).toBe(Math.round(levouNu * 0.6));
    });

    it('a redução PLANA da Carapaça de Kraken sai do golpe', () => {
      const pos = towerSlotPos(0);
      // flat_reduction_pct é sobre a vida MÁXIMA do alvo: 0,2% de 500 mil = 1.000.
      // A fração é pequena de propósito — grande o bastante para o corte
      // aparecer, pequena o bastante para não engolir o golpe inteiro em
      // nenhuma das escalas de torre (a de teste é dez vezes menor que a de
      // produção, e um número fixo aqui prenderia o teste a uma delas).
      const p = addPlayer(w, 1, 'Kraken', { x: pos.x, z: pos.z + 20,
        maxHp: 500_000, hp: 500_000, tal: { flat_reduction_pct: 0.2 } });
      const torre = w.im._towerEntity(1, 0);
      const corte = 500_000 * 0.002;

      w.im._tickTowers(Date.now());
      expect(corte).toBeLessThan(torre.damage);            // o golpe sobrevive ao corte
      expect(p.maxHp - p.hp).toBe(torre.damage - corte);
    });

    it('esquivar é não ser atingido — e o mapa vê a esquiva', () => {
      const pos = towerSlotPos(0);
      const p = addPlayer(w, 1, 'Vento', { x: pos.x, z: pos.z + 20,
        tal: { dodge_chance: 100 } });      // o teto do jogo corta em 60%…

      // …então força o dado: com 60% de esquiva, um sorteio de 0 sempre desvia.
      const dado = vi.spyOn(Math, 'random').mockReturnValue(0);
      w.im._tickTowers(Date.now());
      dado.mockRestore();

      expect(p.hp).toBe(p.maxHp);
      expect(w.eventos.some(e => e.type === 'dodge' && e.targetId === p.id)).toBe(true);
      // A torre atirou de qualquer jeito: quem está ao lado vê a salva sair.
      expect(w.eventos.some(e => e.type === 'tower_fire')).toBe(true);
    });

    it('a invencibilidade da Névoa Espectral segura a salva inteira', () => {
      const pos = towerSlotPos(0);
      const p = addPlayer(w, 1, 'Nevoa', { x: pos.x, z: pos.z + 20,
        relicInvincibleExpires: Date.now() + 5_000 });

      w.im._tickTowers(Date.now());
      expect(p.hp).toBe(p.maxHp);
      expect(w.eventos.some(e => e.type === 'shield_block' && e.targetId === p.id)).toBe(true);
    });

    it('a Carapaça Eriçada devolve na pedra o que aparou', () => {
      const pos = towerSlotPos(0);
      const p = addPlayer(w, 1, 'Tanque', { x: pos.x, z: pos.z + 20,
        relicBulwarkExpires: Date.now() + 5_000,
        relicBulwarkReduction: 0.4, relicBulwarkReflect: 0.3 });
      const torre = w.im._towerEntity(1, 0);
      const hpTorre = torre.hp;

      w.im._tickTowers(Date.now());

      expect(p.maxHp - p.hp).toBe(Math.round(torre.damage * 0.6));
      expect(torre.hp).toBeLessThan(hpTorre);
      expect(w.eventos.some(e => e.type === 'bulwark_reflect')).toBe(true);
    });
  });

  it('o resto do mapa vê a torre atirar, sem ver a vida do alvo', () => {
    const pos = towerSlotPos(0);
    const p = addPlayer(w, 1, 'Alvo', { x: pos.x, z: pos.z + 20 });

    w.im._tickTowers(Date.now());

    const fire = w.eventos.filter(e => e.type === 'tower_fire');
    expect(fire).toHaveLength(1);
    expect(fire[0]._map).toBe(ilha.mapLevel);   // vai para o mapa da ilha
    expect(fire[0].targetId).toBe(p.id);
    expect(fire[0].x).toBeCloseTo(pos.x, 3);
    expect(fire[0].targetX).toBe(p.x);
    // Geometria, e só: a vida do alvo é assunto dele.
    expect(fire[0].hp).toBeUndefined();
    expect(fire[0].damage).toBeUndefined();
  });
});

describe('Ilhas — conquista', () => {
  let w, ilha, a, b;
  beforeEach(async () => {
    w = await makeWorld();
    ilha = ilhaDe(w);
    a = addPlayer(w, 1, 'CapA');
    b = addPlayer(w, 2, 'CapB');
    w.guilds.criar('gA', 'AAA', 'Guilda A', 'CapA');
    w.guilds.criar('gB', 'BBB', 'Guilda B', 'CapB');
  });
  afterEach(() => { w.im.destroy(); w.tb.destroy(); });

  it('quem soma mais dano nas cinco leva a ilha', () => {
    // A derruba três, B derruba duas — mas as torres têm vidas diferentes, então
    // o que decide é o DANO somado, não a contagem de torres.
    for (let i = 0; i < TOWER_SLOTS; i++) derrubar(w, ilha, i, i < 3 ? a : b);

    const rank = w.im._ranking(ilha);
    const vencedor = rank[0].guildId;
    expect(ilha.ownerGuildId).toBe(vencedor);
    expect(ilha.state).toBe('grace');
  });

  it('a ilha só muda de dono quando a QUINTA cai', () => {
    for (let i = 0; i < TOWER_SLOTS - 1; i++) derrubar(w, ilha, i, a);
    expect(ilha.ownerGuildId).toBeNull();

    derrubar(w, ilha, TOWER_SLOTS - 1, a);
    expect(ilha.ownerGuildId).toBe('gA');
  });

  // Bater sem guilda é bater de graça: a conquista é da irmandade.
  it('jogador sem guilda derruba tudo e não leva a ilha', () => {
    const solo = addPlayer(w, 9, 'Solitario');
    for (let i = 0; i < TOWER_SLOTS; i++) derrubar(w, ilha, i, solo);

    expect(ilha.ownerGuildId).toBeNull();
    expect(ilha.state).toBe('neutral');
    expect(Object.keys(ilha.damageRank)).toEqual([]);
  });

  it('uma guilda só toma UMA ilha por semana', () => {
    // A leva a primeira.
    for (let i = 0; i < TOWER_SLOTS; i++) derrubar(w, ilha, i, a);
    expect(ilha.ownerGuildId).toBe('gA');

    // Na segunda ilha, A bate mais que B — e mesmo assim é pulada.
    const ilha2 = ilhaDe(w, 2);
    for (let i = 0; i < TOWER_SLOTS; i++) {
      const ent = w.im._towerEntity(ilha2.id, i);
      w.im.recordTowerDamage(ent, a, 1_000_000);
      w.im.recordTowerDamage(ent, b, 10);
      ent.hp = 0;
      w.im.onTowerDestroyed(ent, a);
    }
    expect(w.im._ranking(ilha2)[0].guildId).toBe('gA');   // A lidera o dano
    expect(ilha2.ownerGuildId).toBe('gB');                 // mas quem leva é B
  });

  it('sem guilda elegível no ranking a ilha fica neutra', () => {
    for (let i = 0; i < TOWER_SLOTS; i++) derrubar(w, ilha, i, a);
    const ilha2 = ilhaDe(w, 2);
    for (let i = 0; i < TOWER_SLOTS; i++) derrubar(w, ilha2, i, a);   // A já tem a 1
    expect(ilha2.ownerGuildId).toBeNull();
    expect(ilha2.state).toBe('neutral');
  });

  // "Se a guilda vencedora não colocar torres em até 10 minutos, a próxima
  // guilda no ranking assume."
  it('prazo de graça vencido sem torre passa a ilha ao segundo colocado', () => {
    for (let i = 0; i < TOWER_SLOTS; i++) {
      const ent = w.im._towerEntity(ilha.id, i);
      w.im.recordTowerDamage(ent, a, 1000);
      w.im.recordTowerDamage(ent, b, 500);
      ent.hp = 0;
      w.im.onTowerDestroyed(ent, a);
    }
    expect(ilha.ownerGuildId).toBe('gA');
    expect(ilha.state).toBe('grace');

    w.im._tickGrace(Date.now() + GRACE_MS + 1);
    expect(ilha.ownerGuildId).toBe('gB');
  });

  it('erguer uma torre dentro do prazo confirma o domínio', () => {
    for (let i = 0; i < TOWER_SLOTS; i++) derrubar(w, ilha, i, a);
    const g = w.guilds.guilds.get('gA');
    g.gold = 5_000_000;

    w.im.handleBuild(a, { islandId: ilha.id, slot: 0, towerType: 'fraca' });
    expect(ilha.state).toBe('owned');

    w.im._tickGrace(Date.now() + GRACE_MS + 1);
    expect(ilha.ownerGuildId).toBe('gA');   // não passou adiante
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// "Os números moram em constants/islands.js" — inclusive para o que já está
// salvo. Os cinco slots vão para o banco como JSON com hp/maxHp dentro, então
// rebalancear a vida da torre não mexia em nada que já existisse: o jogo
// continuava mostrando o número da versão anterior, sem pista nenhuma do
// motivo.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// O CERCO tem de ser um só — relato de playtest de 2026-09-06
//
//   "tentando conquistar, em 2 jogadores, ao eliminar 2 das 5 torres ele já
//    disse que eu tinha conquistado, mas não podia fazer nada; e ao eliminar as
//    5 torres, não conquistei a ilha"
//
// O gatilho olhava só `towers.filter(t => !t.dead).length === 0`, e torre em
// respawn conta como caída — com 30 min de respawn, dava meia hora para ir
// lascando a ilha e levar a conquista com duas quedas. O resto do relato é
// consequência: a ilha entrou em graça com ZERO torres, ninguém conseguiu
// erguer nada (o cofre novo não tinha o 1 M da torre fraca, e só o líder ergue),
// a graça venceu, e a segunda investida caiu na mesma armadilha.
// ─────────────────────────────────────────────────────────────────────────────
describe('Ilhas — o cerco tem de ser um só', () => {
  let w, ilha, ana;
  beforeEach(async () => {
    vi.useFakeTimers();
    w = await makeWorld();
    w.guilds.criar('g1', 'BAG', 'Bagunça', 'ana');
    ana  = addPlayer(w, 1, 'ana');
    ilha = ilhaDe(w);
  });
  afterEach(() => { w.im.destroy(); w.tb.destroy(); vi.useRealTimers(); });

  it('derrubar as cinco de uma vez conquista', () => {
    for (let s = 0; s < TOWER_SLOTS; s++) derrubar(w, ilha, s, ana);
    expect(ilha.ownerGuildId, 'o cerco legítimo deixou de conquistar').toBe('g1');
    expect(ilha.state).toBe('grace');
  });

  it('lascar ao longo da tarde NÃO conquista — e as vencidas voltam de pé', () => {
    // Três agora…
    for (const s of [0, 1, 2]) derrubar(w, ilha, s, ana);
    expect(ilha.towers.filter(t => !t.dead).length).toBe(2);

    // …e as duas últimas depois da janela do assalto.
    vi.advanceTimersByTime(ASSAULT_WINDOW_MS + 60_000);
    for (const s of [3, 4]) derrubar(w, ilha, s, ana);

    expect(ilha.ownerGuildId, 'conquistou lascando').toBeNull();
    expect(ilha.state).toBe('neutral');
    // As três antigas voltaram na hora, em vez de deixar a ilha num limbo de
    // "as cinco no chão e nada acontece" até o respawn de 30 min.
    expect(ilha.towers.filter(t => !t.dead).length,
      'as vencidas não foram reerguidas').toBe(3);
    expect(ultimo(w.sent, 'island_notice')?.message ?? '')
      .toMatch(/cerco/i);
  });

  it('dentro da janela ainda é UM cerco, mesmo com pausa', () => {
    // A regra não é "sem pausa" — é "dentro do prazo". Um cerco de verdade tem
    // recuo, reagrupamento e volta.
    for (const s of [0, 1, 2]) derrubar(w, ilha, s, ana);
    vi.advanceTimersByTime(ASSAULT_WINDOW_MS - 60_000);
    for (const s of [3, 4]) derrubar(w, ilha, s, ana);
    expect(ilha.ownerGuildId, 'o cerco dentro do prazo foi recusado').toBe('g1');
  });

  it('slot salvo ANTES desta mudança não entrega conquista de graça', () => {
    // Os slots gravados no banco não têm `deadAt`. Tratá-los como recentes
    // daria a ilha no primeiro tiro depois do deploy.
    for (const s of [0, 1, 2, 3]) derrubar(w, ilha, s, ana);
    for (const t of ilha.towers) if (t.dead) delete t.deadAt;
    derrubar(w, ilha, 4, ana);
    expect(ilha.ownerGuildId, 'slot sem deadAt entregou a ilha').toBeNull();
  });
});

describe('Ilhas — a tabela manda sobre o que está salvo', () => {
  let w;
  afterEach(() => { w?.im.destroy(); w?.tb.destroy(); });

  /** Um banco com a ilha 1 já salva, com as torres na vida `maxHp`. */
  function bancoComTorres(maxHp, over = {}) {
    const db = makeDb();
    db.ilhas.set(1, {
      id: 1, mapLevel: 12, state: 'neutral',
      ownerGuildId: null, ownerSince: 0, graceUntil: 0, conqueredWeek: null,
      taxPot: 0, nextEventAt: Date.now() + 86_400_000, lastEventWeek: null,
      damageRank: {},
      towers: Array.from({ length: TOWER_SLOTS }, (_, i) => ({
        slot: i, type: 'fraca', hp: maxHp, maxHp,
        dead: false, respawnAt: 0, lastDamageAt: 0, built: false, ...over,
      })),
    });
    return db;
  }

  it('torre neutra salva com vida antiga volta com a vida da tabela', async () => {
    const ANTIGA = TOWER_TYPES.fraca.hp * 7 + 13;   // qualquer coisa != da tabela
    w = await makeWorld(bancoComTorres(ANTIGA));
    for (const slot of ilhaDe(w).towers) {
      expect(slot.maxHp).toBe(TOWER_TYPES.fraca.hp);
      expect(slot.hp).toBe(TOWER_TYPES.fraca.hp);
    }
    // E a entidade no mundo nasce com a vida nova, não com a do banco. Só as
    // torres da ILHA 1: as outras duas nascem novas, já com a tabela.
    for (const ent of w.im.towers.values()) {
      if (ent.islandId !== 1) continue;
      expect(ent.maxHp).toBe(TOWER_TYPES.fraca.hp);
    }
  });

  it('a vida é reescalada — torre pela metade continua pela metade', async () => {
    const ANTIGA = TOWER_TYPES.fraca.hp * 7 + 12;   // par, para a metade ser exata
    const db = bancoComTorres(ANTIGA, { hp: ANTIGA / 2 });
    w = await makeWorld(db);
    for (const slot of ilhaDe(w).towers) {
      expect(slot.maxHp).toBe(TOWER_TYPES.fraca.hp);
      expect(slot.hp).toBe(Math.round(TOWER_TYPES.fraca.hp * 0.5));
    }
  });

  // A torre da guilda tem a skill Muralha da Ilha somada no maxHp e foi paga
  // com o cofre — a tabela é só o piso dela, e reescrever isso apagaria o
  // investimento.
  it('torre erguida pela guilda não é tocada', async () => {
    const DA_GUILDA = TOWER_TYPES.fraca.hp * 3 + 7;
    w = await makeWorld(bancoComTorres(DA_GUILDA, { built: true }));
    for (const slot of ilhaDe(w).towers) {
      expect(slot.maxHp).toBe(DA_GUILDA);
    }
  });

  // Guarda do MODO TESTE da vida das torres, no mesmo espírito do guarda do
  // evento da frota: enquanto os 200 mil de playtest estiverem em
  // constants/islands.js, a suíte fica vermelha de propósito. É o único aviso
  // automático que impede o valor de escapar num deploy — se ele incomodar, o
  // certo é restaurar a vida de produção, não afrouxar a asserção.
  it('a vida e o dano das torres são os de produção', () => {
    for (const [id, prod] of Object.entries(TOWER_PROD)) {
      expect(TOWER_TYPES[id].hp,
        `MODO TESTE ATIVO em constants/islands.js — restaure a VIDA da torre ` +
        `"${id}" para ${prod.hp.toLocaleString('pt-BR')} antes de subir.`,
      ).toBe(prod.hp);
      expect(TOWER_TYPES[id].damage,
        `MODO TESTE ATIVO em constants/islands.js — restaure o DANO da torre ` +
        `"${id}" para ${prod.damage.toLocaleString('pt-BR')} antes de subir.`,
      ).toBe(prod.damage);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A patrulha da ilha — os mesmos três cascos da Frota de Caçadores.
//
// O modo silencioso de isto quebrar é a duplicação voltar: alguém ajusta a
// escala do casco num dos dois lados (a frota ou a ilha) e o mesmo navio passa
// a aparecer com dois tamanhos diferentes no mesmo jogo, sem erro nenhum.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Navegar entre as ilhas.
//
// A borda norte do Mar dos Renegados é dividida em três terços, um por ilha, e
// as três se ligam pelas laterais. As duas coisas dependem da MESMA ordem
// oeste→leste: se o array da borda do 11 e a vizinhança das ilhas discordarem,
// sair pelo terço da esquerda leva à ilha do meio — e nada no jogo reclama.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// O cenário de teste semeado por scripts/seed_island_test.js.
//
// Semear uma ilha DOMINADA no banco tem duas armadilhas, e as duas apagam o
// domínio no primeiro boot sem dizer nada:
//
//   • `lastEventWeek` igual à semana corrente faz o servidor entender que a
//     coleta desta semana já rodou e RESETAR a ilha (_checkWeeklyReset);
//   • torre com `maxHp` diferente da tabela é realinhada (_reconciliarTorres)
//     — o que é certo para torre neutra e errado para a que a guilda ergueu.
//
// Quem escreve a linha à mão precisa saber das duas. O teste é o lugar onde
// isso fica escrito.
// ─────────────────────────────────────────────────────────────────────────────
describe('Ilhas — cenário semeado no banco', () => {
  let w;
  afterEach(() => { w?.im.destroy(); w?.tb.destroy(); });

  /** O que o seed grava no modo `dominio`. */
  function bancoDominado(over = {}) {
    const db = makeDb();
    const agora = Date.now();
    db.ilhas.set(1, {
      id: 1, mapLevel: 12, state: 'owned',
      ownerGuildId: 'gA', ownerSince: agora,
      graceUntil: 0, conqueredWeek: null, lastEventWeek: null,
      taxPot: 250_000, nextEventAt: agora + 86_400_000,
      damageRank: {},
      towers: Array.from({ length: TOWER_SLOTS }, (_, i) => ({
        slot: i, type: 'fraca', hp: TOWER_TYPES.fraca.hp, maxHp: TOWER_TYPES.fraca.hp,
        dead: false, respawnAt: 0, lastDamageAt: 0, built: true,
      })),
      ...over,
    });
    return db;
  }

  it('a ilha dominada sobrevive ao boot, com torres e imposto', async () => {
    w = await makeWorld(bancoDominado());
    const ilha = ilhaDe(w);

    expect(ilha.ownerGuildId).toBe('gA');
    expect(ilha.state).toBe('owned');
    expect(ilha.taxPot).toBe(250_000);
    expect(ilha.towers.filter(t => !t.dead)).toHaveLength(TOWER_SLOTS);
    // E as cinco estão NO MAR, não só na linha do banco.
    expect([...w.im.towers.values()].filter(t => t.islandId === 1)).toHaveLength(TOWER_SLOTS);
  });

  // A armadilha nº 1, escrita como teste: é o erro mais fácil de cometer ao
  // montar a linha à mão, e o sintoma ("semeei e não funcionou") não aponta
  // para lugar nenhum.
  it('marcar a semana corrente em lastEventWeek RESETA a ilha no boot', async () => {
    w = await makeWorld(bancoDominado({ lastEventWeek: weekKey() }));
    await vi.waitFor(() => expect(ilhaDe(w).ownerGuildId).toBeNull());
    expect(ilhaDe(w).state).toBe('neutral');
  });

  it('torre erguida pela guilda entra com a vida que foi salva', async () => {
    const db = bancoDominado();
    for (const t of db.ilhas.get(1).towers) { t.maxHp = 3_000_000; t.hp = 3_000_000; }
    w = await makeWorld(db);
    for (const slot of ilhaDe(w).towers) expect(slot.maxHp).toBe(3_000_000);
  });
});

describe('Ilhas — as bordas', () => {
  const NIVEIS = Object.values(ISLAND_DEFS).sort((a, b) => a.id - b.id).map(i => i.mapLevel);

  it('a borda norte do 11 lista as três, de oeste para leste', () => {
    expect(MAP_DEFS[11].sideMap[0].norte).toEqual(NIVEIS);
  });

  it('toda ilha volta ao sul para o Mar dos Renegados', () => {
    for (const lvl of NIVEIS) expect(MAP_DEFS[lvl].sideMap[0].sul).toBe(11);
  });

  it('as laterais ligam as vizinhas e param nas pontas', () => {
    const [oeste, meio, leste] = NIVEIS;

    expect(MAP_DEFS[oeste].sideMap[0].right).toBe(meio);
    expect(MAP_DEFS[oeste].sideMap[0].left).toBeUndefined();   // ponta oeste

    expect(MAP_DEFS[meio].sideMap[0].left).toBe(oeste);
    expect(MAP_DEFS[meio].sideMap[0].right).toBe(leste);

    expect(MAP_DEFS[leste].sideMap[0].left).toBe(meio);
    expect(MAP_DEFS[leste].sideMap[0].right).toBeUndefined();  // ponta leste
  });

  // Ir para o leste e voltar para o oeste tem de dar no mesmo lugar. Uma
  // vizinhança escrita à mão quebra exatamente aqui.
  it('as laterais são simétricas', () => {
    for (const lvl of NIVEIS) {
      const lados = MAP_DEFS[lvl].sideMap[0];
      if (lados.right) expect(MAP_DEFS[lados.right].sideMap[0].left).toBe(lvl);
      if (lados.left)  expect(MAP_DEFS[lados.left].sideMap[0].right).toBe(lvl);
    }
  });
});

describe('Ilhas — a patrulha', () => {
  it('cada ilha tem o seu casco, e é sempre o mesmo', () => {
    const esperado = {
      12: 'mantaFlorestal',
      13: 'nebulaPurpurea',
      14: 'necrofagoDasAlmas',
    };
    for (const [lvl, casco] of Object.entries(esperado)) {
      const npc = MAP_DEFS[lvl].npc;
      expect(npc, `mapa ${lvl} sem patrulha`).toBeTruthy();
      expect(npc.model).toBe(NPC_SHIP_HULLS[casco].model);
      expect(npc.names).toEqual([NPC_SHIP_HULLS[casco].name]);
      expect(npc.count).toBeGreaterThan(0);
      expect(npc.baseHp).toBeGreaterThan(0);
      expect(npc.baseDamage).toBeGreaterThan(0);
    }
  });

  it('o casco é o MESMO objeto que a Frota usa — nada de duas escalas', () => {
    const { FLEET_EVENT } = require('../../constants/fleet_event.js');
    for (const [lvl, casco] of Object.entries({
      12: 'mantaFlorestal', 13: 'nebulaPurpurea', 14: 'necrofagoDasAlmas',
    })) {
      const npc   = MAP_DEFS[lvl].npc;
      const frota = FLEET_EVENT.ships[casco];
      for (const campo of ['model', 'scale', 'yOffset', 'rotOffset', 'hitRadius',
                           'cannonCount', 'cannonSpread', 'cannonRange', 'fireInterval']) {
        expect(npc[campo], `${casco}.${campo} divergiu entre ilha e frota`)
          .toBe(frota[campo]);
      }
    }
  });

  it('é NAVIO: anda a canhão e fica fora do sorteio de relíquia', () => {
    for (const lvl of [12, 13, 14]) {
      const npc = MAP_DEFS[lvl].npc;
      expect(npc.usesCannons).toBe(true);
      // Sem skill de bestiário, uma chance de drop cairia no sorteio GLOBAL —
      // uma torneira de relíquia de fim de jogo que ninguém pediu.
      expect(npc.attacks).toEqual([]);
      expect(npc.relicDropChance).toBe(0);
    }
  });

  // A patrulha é fauna; a torre não é. Trocar um pelo outro faria a torre pagar
  // espólio de caçada e tentar renascer pelo manager errado.
  it('a patrulha não substitui a torre — as ilhas continuam sem chefe', () => {
    for (const lvl of [12, 13, 14]) {
      expect(MAP_DEFS[lvl].boss).toBeNull();
      expect(MAP_DEFS[lvl].guildIsland).toBeTruthy();
    }
  });
});

describe('Ilhas — respawn das torres', () => {
  let w, ilha;
  beforeEach(async () => { w = await makeWorld(); ilha = ilhaDe(w); });
  afterEach(() => { w.im.destroy(); w.tb.destroy(); });

  it('torre neutra volta depois de 30 min, com tipo novo sorteado', () => {
    const solo = addPlayer(w, 9, 'Solo');
    derrubar(w, ilha, 0, solo);
    expect(ilha.towers[0].dead).toBe(true);
    expect(w.im._towerEntity(ilha.id, 0)).toBeNull();

    const agora = Date.now();
    w.im._syncTowers(ilha, agora + TOWER_RESPAWN_MS - 1000);
    expect(ilha.towers[0].dead).toBe(true);

    w.im._syncTowers(ilha, agora + TOWER_RESPAWN_MS + 1000);
    expect(ilha.towers[0].dead).toBe(false);
    expect(ilha.towers[0].hp).toBe(ilha.towers[0].maxHp);
    expect(w.im._towerEntity(ilha.id, 0)).toBeTruthy();
  });

  // "Após conquista, as torres NÃO renascem automaticamente."
  it('em ilha com dono a torre NÃO renasce sozinha', () => {
    const p = addPlayer(w, 1, 'Cap');
    w.guilds.criar('gA', 'AAA', 'A', 'Cap');
    ilha.ownerGuildId = 'gA';

    derrubar(w, ilha, 0, p);
    expect(ilha.towers[0].respawnAt).toBe(0);

    w.im._syncTowers(ilha, Date.now() + TOWER_RESPAWN_MS * 3);
    expect(ilha.towers[0].dead).toBe(true);
  });
});

describe('Ilhas — construir e reparar', () => {
  let w, ilha, lider, membro, g;
  beforeEach(async () => {
    w = await makeWorld();
    ilha = ilhaDe(w);
    lider  = addPlayer(w, 1, 'Lider');
    membro = addPlayer(w, 2, 'Membro');
    g = w.guilds.criar('gA', 'AAA', 'Guilda A', 'Lider');
    w.guilds.entrar('gA', 'Membro');
    ilha.ownerGuildId = 'gA';
    ilha.state = 'owned';
    for (const t of ilha.towers) { t.dead = true; t.hp = 0; }
    for (const id of [...w.im.towers.keys()]) w.im._removeTowerEntity(id);
  });
  afterEach(() => { w.im.destroy(); w.tb.destroy(); });

  it('o líder ergue a torre e o cofre paga', () => {
    g.gold = 30_000_000;
    w.im.handleBuild(lider, { islandId: 1, slot: 2, towerType: 'media' });

    expect(g.gold).toBe(30_000_000 - TOWER_TYPES.media.costGold);
    expect(ilha.towers[2].type).toBe('media');
    expect(ilha.towers[2].built).toBe(true);
    expect(w.im._towerEntity(1, 2)).toBeTruthy();
  });

  it('a torre forte cobra DOBRÃO, não ouro', () => {
    g.gold = 0; g.dobroes = 200_000;
    w.im.handleBuild(lider, { islandId: 1, slot: 0, towerType: 'forte' });

    expect(g.dobroes).toBe(200_000 - TOWER_TYPES.forte.costDobroes);
    expect(g.gold).toBe(0);
    expect(ilha.towers[0].type).toBe('forte');
  });

  it('membro comum não ergue torre', () => {
    g.gold = 30_000_000;
    w.im.handleBuild(membro, { islandId: 1, slot: 0, towerType: 'fraca' });
    expect(ilha.towers[0].dead).toBe(true);
    expect(g.gold).toBe(30_000_000);
  });

  it('cofre vazio não ergue torre', () => {
    g.gold = 10;
    w.im.handleBuild(lider, { islandId: 1, slot: 0, towerType: 'fraca' });
    expect(ilha.towers[0].dead).toBe(true);
    expect(g.gold).toBe(10);
  });

  it('não dá para erguer em slot ocupado', () => {
    g.gold = 30_000_000;
    w.im.handleBuild(lider, { islandId: 1, slot: 0, towerType: 'fraca' });
    const depois = g.gold;
    w.im.handleBuild(lider, { islandId: 1, slot: 0, towerType: 'fraca' });
    expect(g.gold).toBe(depois);
  });

  // As skills de ilha da guilda entram no NASCIMENTO da torre: a barra de vida
  // dela precisa mostrar o número que ela realmente aguenta.
  it('Muralha e Artilharia da Ilha entram na torre erguida', () => {
    g.gold = 30_000_000;
    g.skills.tower_hp_pct  = 3;   // +30%
    g.skills.tower_dmg_pct = 4;   // +20%

    w.im.handleBuild(lider, { islandId: 1, slot: 1, towerType: 'fraca' });

    const base = TOWER_TYPES.fraca;
    expect(ilha.towers[1].maxHp).toBe(Math.round(base.hp * 1.30));
    expect(ilha.towers[1].damage).toBe(Math.round(base.damage * 1.20));
    expect(w.im._towerEntity(1, 1).damage).toBe(Math.round(base.damage * 1.20));
  });

  it('reparo cura 1% por minuto e cobra do cofre', () => {
    g.gold = 30_000_000;
    w.im.handleBuild(lider, { islandId: 1, slot: 0, towerType: 'fraca' });
    const slot = ilha.towers[0];
    slot.hp = Math.round(slot.maxHp * 0.5);
    slot.lastDamageAt = 0;                 // muito tempo sem apanhar
    const antesOuro = g.gold;

    w.im.handleRepair(membro, { islandId: 1, on: true });   // membro comum PODE
    w.im._tickRepair(Date.now());

    const curou = Math.round(slot.maxHp * REPAIR_PCT_PER_MIN);
    expect(slot.hp).toBe(Math.round(slot.maxHp * 0.5) + curou);
    expect(g.gold).toBe(antesOuro - Math.ceil(curou * repairGoldPerHp('fraca')));
  });

  it('torre que apanhou há menos de 5 min não se cura', () => {
    g.gold = 30_000_000;
    w.im.handleBuild(lider, { islandId: 1, slot: 0, towerType: 'fraca' });
    const slot = ilha.towers[0];
    slot.hp = 100;
    const agora = Date.now();
    slot.lastDamageAt = agora - (REPAIR_CALM_MS - 1000);

    w.im.handleRepair(lider, { islandId: 1, on: true });
    w.im._tickRepair(agora);
    expect(slot.hp).toBe(100);

    slot.lastDamageAt = agora - (REPAIR_CALM_MS + 1000);
    w.im._tickRepair(agora);
    expect(slot.hp).toBeGreaterThan(100);
  });

  it('guilda de fora não mexe na ilha', () => {
    const estranho = addPlayer(w, 3, 'Estranho');
    w.guilds.criar('gZ', 'ZZZ', 'Z', 'Estranho');
    const gz = w.guilds.guilds.get('gZ');
    gz.gold = 30_000_000;

    w.im.handleBuild(estranho, { islandId: 1, slot: 0, towerType: 'fraca' });
    expect(ilha.towers[0].dead).toBe(true);
    expect(gz.gold).toBe(30_000_000);
  });
});

describe('Ilhas — imposto', () => {
  let w, ilha, comprador, g;
  beforeEach(async () => {
    w = await makeWorld();
    ilha = ilhaDe(w);   // ilha 1 = Farol
    const lider = addPlayer(w, 1, 'Lider');
    g = w.guilds.criar('gA', 'AAA', 'Guilda A', 'Lider');
    g.level = 3;
    ilha.ownerGuildId = 'gA';
    ilha.state = 'owned';
    comprador = addPlayer(w, 2, 'Comprador', { gold: 1_000_000 });
  });
  afterEach(() => { w.im.destroy(); w.tb.destroy(); });

  it('alíquota é o NÍVEL da guilda em porcento', () => {
    expect(taxPctFor(3)).toBe(0.03);
    const t = w.im.taxOn('buy_afk_time', 100_000);
    expect(t.pct).toBe(0.03);
    expect(t.extra).toBe(3_000);
  });

  it('cobra do comprador e enche o bolo da ilha', () => {
    const cobrado = w.im.chargeTax(comprador, 'buy_afk_time', 100_000);
    expect(cobrado).toBe(3_000);
    expect(comprador.gold).toBe(1_000_000 - 3_000);
    expect(ilha.taxPot).toBe(3_000);
  });

  // Cada praça é de UMA ilha: comprar no Mercado não pode pagar ao dono do Farol.
  it('só a praça da ilha é taxada', () => {
    expect(w.im.taxOn('buy_cannon', 100_000)).toBeNull();     // Mercado, sem dono
    expect(w.im.taxOn('bank_deposit', 100_000)).toBeNull();   // Banco, sem dono
    expect(w.im.taxOn('shoot', 100_000)).toBeNull();          // não é gasto de praça
    expect(ACTION_VENUE.buy_cannon).toBe('mercado');
    expect(ACTION_VENUE.buy_afk_time).toBe('farol');
  });

  // A Ilha do Comércio é UMA praça: a aba do Mercado, a Loja Geral e o Bar
  // ficam na mesma ilha. Os quatro abaixo ficaram fora da tabela na primeira
  // volta e o comprador da Loja Geral não pagava imposto nenhum — a cobrança é
  // por `msg.type`, então o handler que não constar aqui nasce isento e em
  // silêncio.
  it('a ilha do comércio inteira é taxada, não só a aba do Mercado', () => {
    for (const acao of ['buy_general_item', 'buy_pet_food', 'buy_elite_ship']) {
      expect(ACTION_VENUE[acao], `${acao} é gasto da praça do Mercado`).toBe('mercado');
    }
    // Fora da lista de propósito: o upgrade de casco custa dobrão + pó de ouro,
    // e a cobrança mede OURO. Listá-lo não cobraria nada e ainda anunciaria na
    // ficha do imposto que ele paga.
    expect(ACTION_VENUE.buy_ship_upgrade).toBeUndefined();
  });

  it('ilha sem dono não cobra nada', () => {
    ilha.ownerGuildId = null;
    expect(w.im.taxOn('buy_afk_time', 100_000)).toBeNull();
    expect(w.im.chargeTax(comprador, 'buy_afk_time', 100_000)).toBe(0);
    expect(comprador.gold).toBe(1_000_000);
  });

  // Isentar quem não tem o valor cheio criaria o truque de chegar na loja com
  // exatamente o preço do item.
  it('cobra o que couber no bolso em vez de isentar', () => {
    comprador.gold = 500;
    const cobrado = w.im.chargeTax(comprador, 'buy_afk_time', 100_000);
    expect(cobrado).toBe(500);
    expect(comprador.gold).toBe(0);
  });

  it('o Farol/Mercado/Banco sabem quem governa e quanto', () => {
    const info = w.im.venueInfo('farol');
    expect(info.ownerTag).toBe('AAA');
    expect(info.taxPct).toBe(0.03);
    expect(w.im.venueInfo('mercado').ownerTag).toBeNull();
  });
});

describe('Ilhas — coleta semanal', () => {
  let w, ilha, g, lider, membro;
  beforeEach(async () => {
    w = await makeWorld();
    ilha = ilhaDe(w);
    lider  = addPlayer(w, 1, 'Lider',  { gold: 0, mapLevel: 4 });
    membro = addPlayer(w, 2, 'Membro', { gold: 0, mapLevel: 4 });
    g = w.guilds.criar('gA', 'AAA', 'Guilda A', 'Lider');
    w.guilds.entrar('gA', 'Membro');
    ilha.ownerGuildId = 'gA';
    ilha.state  = 'owned';
    ilha.taxPot = 1_000_000;
  });
  afterEach(() => { w.im.destroy(); w.tb.destroy(); });

  /** Força a hora do evento e roda o agendador. */
  function zarpar() {
    ilha.nextEventAt = Date.now() - 1;
    w.tb._checkSchedule(Date.now());
    return w.tb.trips.get(1);
  }

  it('o barco zarpa da praça com o bolo, e a ilha zera', () => {
    const trip = zarpar();
    expect(trip).toBeTruthy();
    expect(trip.amount).toBe(1_000_000);
    expect(trip.boat.mapLevel).toBe(4);          // Farol
    expect(trip.boat.maxHp).toBe(TAX_BOAT_HP);
    expect(ilha.taxPot).toBe(0);
  });

  it('a skill Barco de Coleta engorda o que zarpa', () => {
    g.skills.tax_boat_pct = 3;                   // +30%
    const trip = zarpar();
    expect(trip.amount).toBe(1_300_000);
  });

  it('chegou inteiro → divide IGUALMENTE entre os membros', () => {
    const trip = zarpar();
    w.tb._finish(trip, true, Date.now());

    expect(lider.gold).toBe(500_000);
    expect(membro.gold).toBe(500_000);
    expect(ultimo(w.sent, 'tax_boat_result').arrived).toBe(true);
  });

  it('afundado → divide na PROPORÇÃO do dano', () => {
    const trip = zarpar();
    const saqA = addPlayer(w, 5, 'SaqA', { gold: 0 });
    const saqB = addPlayer(w, 6, 'SaqB', { gold: 0 });

    w.tb.recordDamage(trip.boat, saqA, 750_000);
    w.tb.recordDamage(trip.boat, saqB, 250_000);
    trip.boat.hp = 0;
    w.tb.onBoatSunk(trip.boat);

    expect(saqA.gold).toBe(750_000);
    expect(saqB.gold).toBe(250_000);
    expect(lider.gold).toBe(0);                  // a guilda não leva nada
  });

  // A promessa mais frágil do sistema: "se o jogador morrer, o dano continua
  // contando". O id da entidade não sobrevive ao respawn — o NOME sobrevive.
  it('o dano sobrevive à morte de quem bateu', () => {
    const trip = zarpar();
    const saq = addPlayer(w, 5, 'Saqueador', { gold: 0 });

    w.tb.recordDamage(trip.boat, saq, 400_000);

    // Morreu e voltou com outro id de sessão — o que o servidor faz de verdade.
    w.players.delete(5);
    const renascido = addPlayer(w, 77, 'Saqueador', { gold: 0 });
    w.tb.recordDamage(trip.boat, renascido, 600_000);

    trip.boat.hp = 0;
    w.tb.onBoatSunk(trip.boat);

    expect(renascido.gold).toBe(1_000_000);      // o milhão inteiro, as duas metades
  });

  it('quem afundou e saiu do jogo recebe pelo banco', () => {
    const trip = zarpar();
    const saq = addPlayer(w, 5, 'Fantasma', { gold: 0 });
    w.tb.recordDamage(trip.boat, saq, 1_000_000);
    w.players.delete(5);                          // desconectou

    trip.boat.hp = 0;
    w.tb.onBoatSunk(trip.boat);

    expect(w.db.offlineGold.get('Fantasma')).toBe(1_000_000);
  });

  // "Se não houver guilda dona no momento da coleta: imposto NÃO é recolhido."
  it('ilha sem dono cancela a coleta e guarda o bolo', () => {
    ilha.ownerGuildId = null;
    const trip = zarpar();
    expect(trip).toBeUndefined();
    expect(ilha.taxPot).toBe(1_000_000);
    expect(ilha.lastEventWeek).toBe(weekKey());
  });

  it('bolo vazio não faz o barco zarpar', () => {
    ilha.taxPot = 0;
    expect(zarpar()).toBeUndefined();
  });

  // ── A nau: quem ela é e por onde ela vai ──────────────────────────────────
  //
  // Três coisas quebravam em SILÊNCIO aqui — a viagem "terminava" nas três, e
  // o que se via no mar é que não havia barco nenhum navegando.
  describe('a nau da coleta', () => {
    it('tem a cara da ILHA que a mandou, não um galeão qualquer', () => {
      const casco = islandHull(ilha.id);
      const trip  = zarpar();
      expect(trip.boat.npcModel).toBe(casco.model);
      expect(trip.boat.npcScale).toBe(casco.scale);
      expect(trip.boat.npcRotOffset).toBe(casco.rotOffset);
      // O raio de acerto é o do casco: "fácil de acertar" é o tamanho que ela
      // tem na tela, não um número à parte que envelhece sozinho.
      expect(trip.boat.hitRadius).toBe(casco.hitRadius);
    });

    // A praça FICA no centro do mapa. A nau nascia em (0,0), ou seja, dentro
    // do Mercado e do Banco — empurrada de um colisor para o outro a cada
    // tique, parada, até a perna vencer por tempo.
    it('larga as amarras em água livre, fora da praça', () => {
      const trip = zarpar();
      const mapDef = MAP_DEFS[trip.boat.mapLevel];
      const copia  = { x: trip.boat.x, z: trip.boat.z };
      expect(pushOutOfIslands(copia, mapDef, 30)).toBe(false);
      // E perto da praça: é de lá que ela tem de ser vista saindo.
      expect(Math.hypot(trip.boat.x, trip.boat.z)).toBeLessThan(700);
    });

    // BORDER_TEST no server.js: norte = z NEGATIVO. Os quatro sinais estavam
    // invertidos, e a coleta saía do Farol rumo ao sul enquanto a ilha fica ao
    // norte — espelhada, mas "funcionando".
    it('sai pela borda certa: norte é z negativo', () => {
      const saida = w.tb._exitPoint(4, 6, MAP_DEFS[4].size);   // 4 → 6 é norte
      expect(saida.dir).toBe('norte');
      expect(saida.z).toBeLessThan(0);
      // E entra pela borda OPOSTA no mapa seguinte, como qualquer jogador.
      expect(w.tb._entryPoint('norte', 6, 0).z).toBeGreaterThan(0);
      expect(w.tb._entryPoint('sul',   6, 0).z).toBeLessThan(0);
      expect(w.tb._entryPoint('left',  6, 0).x).toBeGreaterThan(0);
      expect(w.tb._entryPoint('right', 6, 0).x).toBeLessThan(0);
    });

    // Construção compacta (arena, Banco, Mercado) vira UM círculo; a floresta
    // submersa do 11, espalhada por meio mapa, continua colisor a colisor.
    // Trocar os dois faz a nau prender dentro da construção ou achar o mapa
    // inteiro bloqueado.
    it('enxerga a arena como um obstáculo só e a floresta como muitos', () => {
      const arena = w.tb._obstaculos(11).filter(o => o.r > 500);
      expect(arena).toHaveLength(1);
      expect(arena[0].r).toBeGreaterThan(200);
      expect(w.tb._obstaculos(11).length).toBeGreaterThan(50);   // a floresta
    });
  });

  // ── Partida forçada (a aba de teste do painel da guilda) ──────────────────
  // O ciclo é semanal; esperar até sexta-feira para ver o barco navegar não é
  // um jeito de desenvolver o barco. O que a partida forçada NÃO pode fazer é
  // consumir a semana — senão testar o evento apagaria a coleta de verdade.
  describe('coleta forçada', () => {
    it('zarpa na hora com o bolo que a ilha tem', () => {
      const r = w.tb.forceStart(ilha.id);
      expect(r.ok).toBe(true);
      expect(r.amount).toBe(1_000_000);
      expect(w.tb.trips.get(ilha.id)).toBeTruthy();
      expect(ilha.taxPot).toBe(0);
    });

    it('não consome a semana — a coleta de verdade continua marcada', () => {
      const semanaAntes  = ilha.lastEventWeek;
      const proximaAntes = ilha.nextEventAt;
      w.tb.forceStart(ilha.id);
      expect(ilha.lastEventWeek).toBe(semanaAntes);
      expect(ilha.nextEventAt).toBe(proximaAntes);
    });

    it('bolo vazio ganha o pote de teste — sem carga não há evento para testar', () => {
      ilha.taxPot = 0;
      const r = w.tb.forceStart(ilha.id);
      expect(r.ok).toBe(true);
      expect(r.amount).toBe(FORCE_EVENT_TEST_POT);
      expect(w.tb.trips.get(ilha.id).amount).toBe(FORCE_EVENT_TEST_POT);
    });

    it('recusa ilha sem dono e coleta já a caminho', () => {
      expect(w.tb.forceStart(999).ok).toBe(false);

      w.tb.forceStart(ilha.id);
      expect(w.tb.forceStart(ilha.id).ok).toBe(false);   // já no mar

      const outra = ilhaDe(w, 2);
      expect(w.tb.forceStart(outra.id).ok).toBe(false);  // sem dono
    });

    it('só o líder da guilda dona convoca', () => {
      const estranho = addPlayer(w, 9, 'Estranho');
      w.im.handleForceEvent(estranho, { islandId: ilha.id });
      expect(w.tb.trips.get(ilha.id)).toBeUndefined();
      expect(ultimo(w.sent, 'island_error')).toBeTruthy();

      w.im.handleForceEvent(membro, { islandId: ilha.id });   // é da guilda, não é líder
      expect(w.tb.trips.get(ilha.id)).toBeUndefined();

      w.im.handleForceEvent(lider, { islandId: ilha.id });
      expect(w.tb.trips.get(ilha.id)).toBeTruthy();
      expect(ultimo(w.sent, 'island_ok').action).toBe('force_event');
    });
  });

  // Reagendar ANTES de tentar é o que impede o agendador de disparar a cada
  // tique durante o dia inteiro do evento.
  it('não zarpa duas vezes na mesma semana', () => {
    zarpar();
    w.tb.trips.delete(1);
    ilha.taxPot = 5_000;
    w.tb._checkSchedule(Date.now());
    expect(w.tb.trips.get(1)).toBeUndefined();
  });

  it('a coleta reinicia a ilha: torres novas e sem dono', async () => {
    const trip = zarpar();
    w.tb._finish(trip, true, Date.now());
    await vi.waitFor(() => expect(ilha.ownerGuildId).toBeNull());

    expect(ilha.state).toBe('neutral');
    expect(ilha.towers.length).toBe(TOWER_SLOTS);
    expect(ilha.towers.every(t => !t.dead)).toBe(true);
    expect(ilha.taxPot).toBe(0);
    expect(Object.keys(ilha.damageRank)).toEqual([]);
  });

  it('cada ilha tem o seu dia e a rota bate com as fronteiras do mundo', () => {
    expect(ISLAND_DEFS[1].weekday).toBe(5);   // sexta
    expect(ISLAND_DEFS[2].weekday).toBe(6);   // sábado
    expect(ISLAND_DEFS[3].weekday).toBe(0);   // domingo

    // Toda perna precisa existir no sideMap, senão o barco navega para o centro
    // do mapa e a perna vence por tempo — o evento "acontece" sem acontecer.
    for (const def of Object.values(ISLAND_DEFS)) {
      for (let i = 0; i < def.route.length - 1; i++) {
        const p = w.tb._exitPoint(def.route[i], def.route[i + 1],
                                  MAP_DEFS[def.route[i]].size);
        expect(p.dir, `perna ${def.route[i]}→${def.route[i + 1]}`).toBeTruthy();
      }
      expect(def.route[def.route.length - 1]).toBe(def.mapLevel);
    }
  });

  it('o dia do próximo evento é sempre o da ilha', () => {
    for (const def of Object.values(ISLAND_DEFS)) {
      const quando = nextEventAt(def.id, Date.now());
      expect(new Date(quando).getUTCDay()).toBe(def.weekday);
      expect(quando).toBeGreaterThan(Date.now());
    }
  });
});
