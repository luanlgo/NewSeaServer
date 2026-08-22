import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import AuctionManager from '../../managers/auction-manager.js';
import JournalManager from '../../managers/journal-manager.js';

const { DURATIONS_H, FEE_PCT, MAX_ACTIVE_PER_PLAYER } = AuctionManager;
const SRC = JournalManager.SRC;

// ─────────────────────────────────────────────────────────────────────────────
// A casa de leilões move duas coisas que não podem sumir: um NAVIO, que sai do
// inventário e fica sem dono enquanto o leilão corre, e OURO de terceiros, que
// sai do bolso de quem deu lance e fica em custódia. Os testes aqui perseguem
// exatamente as formas de perder uma das duas:
//
//   1. o navio anunciado tem de estar em algum lugar o tempo todo — no leilão,
//      com o vencedor ou de volta com o dono, nunca em lugar nenhum;
//   2. quem é superado recebe o ouro de volta na hora, mesmo offline;
//   3. um leilão que vence com o servidor fora do ar precisa ser resolvido no
//      boot seguinte — este é o caso que o `ends_at > now` do carregamento
//      original apagava, e com ele o navio.
//
// A taxa é a única coisa que o jogador perde de propósito: 10% do lance mínimo,
// cobrada ao anunciar, não devolvida nem quando ninguém dá lance.
// ─────────────────────────────────────────────────────────────────────────────

/** Banco de mentira: guarda leilões e entregas em memória, como o MySQL faria. */
function makeDb() {
  return {
    auctions:   new Map(),
    deliveries: [],
    journal:    [],
    saves:      [],

    async loadAuctions() { return [...this.auctions.values()].map(a => ({ ...a })); },
    async upsertAuction(a) { this.auctions.set(a.id, JSON.parse(JSON.stringify(a))); },
    async deleteAuction(id) { this.auctions.delete(id); },
    async addAuctionDelivery(toName, reason, gold, shipData) {
      this.deliveries.push({ toName, reason, gold: gold | 0, shipData: shipData || null, createdAt: Date.now() });
    },
    async takeAuctionDeliveries(toName) {
      const mine = this.deliveries.filter(d => d.toName === toName);
      this.deliveries = this.deliveries.filter(d => d.toName !== toName);
      return mine;
    },
    async addJournal(name, at, kind, data) { this.journal.push({ name, kind, data }); },
    async save(player) { this.saves.push(player.name); },
  };
}

function makeShip(over = {}) {
  return {
    instanceId: 'colossal_1', id: 'colossal_ghost_pirate_galleon',
    name: 'Galeão Fantasma', hp: 900, maxHp: 900, cannon: 18,
    hpTier: 'epico', cannonTier: 'raro', tradeable: true, equipped: false,
    ...over,
  };
}

function makePlayer(id, name, over = {}) {
  return {
    id, name, gold: 100000, dobroes: 0,
    bonusShips: [], ws: { readyState: 1 },
    ...over,
  };
}

let db, players, journal, am, sent;

/** Captura toda mensagem que o servidor mandaria, por jogador. */
function sendSpy(ws, msg) {
  const dono = [...players.values()].find(p => p.ws === ws);
  sent.push({ to: dono ? dono.name : '?', msg });
}

function msgsTo(name, type) {
  return sent.filter(e => e.to === name && e.msg.type === type).map(e => e.msg);
}

beforeEach(() => {
  db      = makeDb();
  players = new Map();
  journal = new JournalManager(db);
  sent    = [];
  am      = new AuctionManager(sendSpy, players, db, journal, SRC);
});

afterEach(() => {
  am.destroy();
  vi.useRealTimers();
});

function addPlayer(id, name, over) {
  const p = makePlayer(id, name, over);
  players.set(id, p);
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('anunciar', () => {
  it('tira o navio do inventário e cobra 10% do lance mínimo', async () => {
    const vendedor = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()], gold: 5000 });

    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 10000, hours: 24 });

    expect(vendedor.bonusShips).toHaveLength(0);
    expect(vendedor.gold).toBe(5000 - 1000);        // taxa = 10% de 10.000
    expect(am.auctions.size).toBe(1);

    const criado = msgsTo('Bagatinha', 'auction_created')[0];
    expect(criado.fee).toBe(1000);
    expect(criado.rareShips).toHaveLength(0);
  });

  it('anota a taxa no livro-caixa como saída', async () => {
    const vendedor = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()] });
    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 10000, hours: 8 });

    const linha = db.journal.find(j => j.data.source === SRC.AUCTION_FEE);
    expect(linha).toBeTruthy();
    expect(linha.data.gold).toBe(-1000);
  });

  it('arredonda a taxa para cima — lance mínimo de 1 custa 1, não 0', async () => {
    const vendedor = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()], gold: 10 });
    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 1, hours: 8 });
    expect(vendedor.gold).toBe(9);
  });

  it('recusa duração fora de 8/24/48 e não toca no inventário', async () => {
    const vendedor = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()], gold: 5000 });

    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 10000, hours: 3 });

    expect(msgsTo('Bagatinha', 'auction_error')[0].reason).toBe('bad_duration');
    expect(vendedor.bonusShips).toHaveLength(1);
    expect(vendedor.gold).toBe(5000);
    expect(am.auctions.size).toBe(0);
  });

  it('aceita as três durações oferecidas', async () => {
    for (const h of DURATIONS_H) {
      const p = addPlayer(`p${h}`, `Cap${h}`, { bonusShips: [makeShip()] });
      await am.handleCreate(p, { instanceId: 'colossal_1', minBid: 100, hours: h });
      expect(msgsTo(`Cap${h}`, 'auction_created')).toHaveLength(1);
    }
    expect(am.auctions.size).toBe(DURATIONS_H.length);
  });

  it('recusa navio que o jogador não tem — o pedido não é estado', async () => {
    const vendedor = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()] });

    await am.handleCreate(vendedor, { instanceId: 'navio_inventado', minBid: 100, hours: 8 });

    expect(msgsTo('Bagatinha', 'auction_error')[0].reason).toBe('ship_not_found');
    expect(vendedor.bonusShips).toHaveLength(1);
  });

  it('recusa quando não há ouro para a taxa, sem consumir o navio', async () => {
    const vendedor = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()], gold: 50 });

    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 10000, hours: 8 });

    expect(msgsTo('Bagatinha', 'auction_error')[0].reason).toBe('no_gold_for_fee');
    expect(vendedor.bonusShips).toHaveLength(1);
    expect(vendedor.gold).toBe(50);
  });

  it('respeita tradeable: false', async () => {
    const vendedor = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip({ tradeable: false })] });
    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 100, hours: 8 });
    expect(msgsTo('Bagatinha', 'auction_error')[0].reason).toBe('not_tradeable');
    expect(vendedor.bonusShips).toHaveLength(1);
  });

  it('trava no teto de anúncios simultâneos por jogador', async () => {
    const navios = Array.from({ length: MAX_ACTIVE_PER_PLAYER + 1 },
      (_, i) => makeShip({ instanceId: `n${i}` }));
    const vendedor = addPlayer('p1', 'Bagatinha', { bonusShips: navios, gold: 999999 });

    for (let i = 0; i <= MAX_ACTIVE_PER_PLAYER; i++) {
      await am.handleCreate(vendedor, { instanceId: `n${i}`, minBid: 100, hours: 8 });
    }

    expect(am.auctions.size).toBe(MAX_ACTIVE_PER_PLAYER);
    expect(msgsTo('Bagatinha', 'auction_error').pop().reason).toBe('too_many');
    expect(vendedor.bonusShips).toHaveLength(1);   // o recusado continua com ele
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('dar lance', () => {
  let vendedor, comprador, auctionId;

  beforeEach(async () => {
    vendedor  = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()], gold: 5000 });
    comprador = addPlayer('p2', 'Corsário',  { gold: 50000 });
    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 10000, hours: 24 });
    auctionId = [...am.auctions.keys()][0];
  });

  it('tira o ouro do bolso na hora — custódia, não reserva', async () => {
    await am.handleBid(comprador, { auctionId, amount: 12000 });

    expect(comprador.gold).toBe(50000 - 12000);
    expect(am.auctions.get(auctionId).topBid).toBe(12000);
    expect(am.auctions.get(auctionId).topBidderName).toBe('Corsário');
  });

  it('anota o lance como saída no livro-caixa', async () => {
    await am.handleBid(comprador, { auctionId, amount: 12000 });
    const linha = db.journal.find(j => j.data.source === SRC.AUCTION_BID);
    expect(linha.data.gold).toBe(-12000);
  });

  it('recusa lance abaixo do mínimo e informa o piso', async () => {
    await am.handleBid(comprador, { auctionId, amount: 9999 });

    const erro = msgsTo('Corsário', 'auction_error')[0];
    expect(erro.reason).toBe('bid_too_low');
    expect(erro.minimum).toBe(10000);
    expect(comprador.gold).toBe(50000);
  });

  it('recusa lance que não supera o atual', async () => {
    await am.handleBid(comprador, { auctionId, amount: 12000 });
    const terceiro = addPlayer('p3', 'Almirante', { gold: 50000 });

    await am.handleBid(terceiro, { auctionId, amount: 12000 });

    expect(msgsTo('Almirante', 'auction_error')[0].minimum).toBe(12001);
    expect(terceiro.gold).toBe(50000);
  });

  it('devolve o ouro de quem foi superado, na hora', async () => {
    await am.handleBid(comprador, { auctionId, amount: 12000 });
    const terceiro = addPlayer('p3', 'Almirante', { gold: 50000 });

    await am.handleBid(terceiro, { auctionId, amount: 15000 });

    expect(comprador.gold).toBe(50000);            // recebeu de volta
    expect(terceiro.gold).toBe(50000 - 15000);
    const devolucao = msgsTo('Corsário', 'auction_delivery')[0];
    expect(devolucao.reason).toBe('outbid');
    expect(devolucao.gold).toBe(12000);
  });

  it('enfileira a devolução quando o superado está offline', async () => {
    await am.handleBid(comprador, { auctionId, amount: 12000 });
    players.delete('p2');                          // deslogou segurando o lance

    const terceiro = addPlayer('p3', 'Almirante', { gold: 50000 });
    await am.handleBid(terceiro, { auctionId, amount: 15000 });

    const fila = db.deliveries.filter(d => d.toName === 'Corsário');
    expect(fila).toHaveLength(1);
    expect(fila[0]).toMatchObject({ reason: 'outbid', gold: 12000 });
  });

  it('não deixa o dono dar lance no próprio navio', async () => {
    await am.handleBid(vendedor, { auctionId, amount: 20000 });
    expect(msgsTo('Bagatinha', 'auction_error')[0].reason).toBe('own_auction');
  });

  it('não deixa cobrir o próprio lance', async () => {
    await am.handleBid(comprador, { auctionId, amount: 12000 });
    await am.handleBid(comprador, { auctionId, amount: 13000 });

    expect(msgsTo('Corsário', 'auction_error')[0].reason).toBe('already_winning');
    expect(comprador.gold).toBe(50000 - 12000);
  });

  it('recusa lance sem ouro suficiente', async () => {
    const pobre = addPlayer('p4', 'Grumete', { gold: 500 });
    await am.handleBid(pobre, { auctionId, amount: 10000 });

    expect(msgsTo('Grumete', 'auction_error')[0].reason).toBe('no_gold');
    expect(pobre.gold).toBe(500);
  });

  it('avisa o dono que o navio dele recebeu lance', async () => {
    await am.handleBid(comprador, { auctionId, amount: 12000 });
    const aviso = msgsTo('Bagatinha', 'auction_bid_received')[0];
    expect(aviso).toMatchObject({ amount: 12000, bidderName: 'Corsário' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('cancelar', () => {
  it('devolve o navio, mas não a taxa', async () => {
    const vendedor = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()], gold: 5000 });
    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 10000, hours: 24 });
    const auctionId = [...am.auctions.keys()][0];

    await am.handleCancel(vendedor, { auctionId });

    expect(vendedor.bonusShips).toHaveLength(1);
    expect(vendedor.gold).toBe(4000);              // a taxa de 1.000 não volta
    expect(am.auctions.size).toBe(0);
  });

  it('recusa cancelar depois do primeiro lance', async () => {
    const vendedor  = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()] });
    const comprador = addPlayer('p2', 'Corsário', { gold: 50000 });
    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 10000, hours: 24 });
    const auctionId = [...am.auctions.keys()][0];
    await am.handleBid(comprador, { auctionId, amount: 12000 });

    await am.handleCancel(vendedor, { auctionId });

    expect(msgsTo('Bagatinha', 'auction_error')[0].reason).toBe('has_bids');
    expect(am.auctions.size).toBe(1);
    expect(comprador.gold).toBe(38000);            // o ouro dele continua preso
  });

  it('recusa cancelar leilão de outro jogador', async () => {
    const vendedor = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()] });
    const outro    = addPlayer('p2', 'Corsário');
    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 100, hours: 8 });
    const auctionId = [...am.auctions.keys()][0];

    await am.handleCancel(outro, { auctionId });

    expect(msgsTo('Corsário', 'auction_error')[0].reason).toBe('not_owner');
    expect(am.auctions.size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('o relógio', () => {
  it('vencido com lance: navio ao vencedor, ouro cheio ao vendedor', async () => {
    vi.useFakeTimers();
    const vendedor  = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()], gold: 5000 });
    const comprador = addPlayer('p2', 'Corsário',  { gold: 50000 });
    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 10000, hours: 8 });
    const auctionId = [...am.auctions.keys()][0];
    await am.handleBid(comprador, { auctionId, amount: 12000 });

    vi.advanceTimersByTime(8 * 3600_000 + 1000);
    await am._sweep();

    expect(comprador.bonusShips).toHaveLength(1);
    expect(comprador.bonusShips[0].instanceId).toBe('colossal_1');
    expect(vendedor.gold).toBe(4000 + 12000);      // taxa já paga + lance cheio
    expect(am.auctions.size).toBe(0);
  });

  it('vencido sem lance: o navio volta para o dono', async () => {
    vi.useFakeTimers();
    const vendedor = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()], gold: 5000 });
    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 10000, hours: 8 });

    vi.advanceTimersByTime(8 * 3600_000 + 1000);
    await am._sweep();

    expect(vendedor.bonusShips).toHaveLength(1);
    expect(vendedor.gold).toBe(4000);              // só a taxa saiu
    expect(am.auctions.size).toBe(0);
  });

  it('anota a venda como entrada no livro-caixa do vendedor', async () => {
    vi.useFakeTimers();
    const vendedor  = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()] });
    const comprador = addPlayer('p2', 'Corsário', { gold: 50000 });
    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 10000, hours: 8 });
    await am.handleBid(comprador, { auctionId: [...am.auctions.keys()][0], amount: 12000 });

    vi.advanceTimersByTime(8 * 3600_000 + 1000);
    await am._sweep();

    const venda = db.journal.find(j => j.data.source === SRC.AUCTION_SALE);
    expect(venda.data.gold).toBe(12000);
  });

  it('some da vitrine assim que vence, antes mesmo da varredura', async () => {
    vi.useFakeTimers();
    const vendedor = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()] });
    const olheiro  = addPlayer('p2', 'Corsário');
    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 100, hours: 8 });

    expect(am.stateOf(olheiro).auctions).toHaveLength(1);
    vi.advanceTimersByTime(8 * 3600_000 + 1000);
    expect(am.stateOf(olheiro).auctions).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// O caso que o carregamento original perdia: `SELECT ... WHERE ends_at > now`
// simplesmente não trazia o leilão vencido durante a parada, e o navio ficava
// sem existir em lugar nenhum — nem no leilão, nem com o dono, nem com ninguém.
describe('reinício do servidor', () => {
  it('resolve no boot o leilão que venceu com o servidor fora do ar', async () => {
    vi.useFakeTimers();
    const vendedor = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()], gold: 5000 });
    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 10000, hours: 8 });
    expect(db.auctions.size).toBe(1);

    // Servidor cai, o relógio corre, e sobe outro manager sobre o mesmo banco.
    am.destroy();
    vi.advanceTimersByTime(9 * 3600_000);
    players.delete('p1');                          // dono ainda não voltou

    const am2 = new AuctionManager(sendSpy, players, db, journal, SRC);
    await am2.init();

    expect(am2.auctions.size).toBe(0);
    expect(db.auctions.size).toBe(0);
    const fila = db.deliveries.filter(d => d.toName === 'Bagatinha');
    expect(fila).toHaveLength(1);
    expect(fila[0].reason).toBe('unsold');
    expect(fila[0].shipData.instanceId).toBe('colossal_1');
    am2.destroy();
  });

  it('mantém em pé o leilão que ainda não venceu', async () => {
    vi.useFakeTimers();
    const vendedor = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()] });
    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 10000, hours: 48 });
    am.destroy();

    vi.advanceTimersByTime(2 * 3600_000);
    const am2 = new AuctionManager(sendSpy, players, db, journal, SRC);
    await am2.init();

    expect(am2.auctions.size).toBe(1);
    am2.destroy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `player.id` vem de um contador em memória (utils/helpers uid()) que reinicia
// com o processo. Um leilão vive até 48 h e atravessa reinícios, então comparar
// dono por id significa que o id gravado ontem pode pertencer a outra pessoa
// hoje — e essa pessoa cancelaria o leilão alheio. A identidade é o NOME.
describe('identidade do dono sobrevive a restart', () => {
  it('reconhece o dono pelo nome mesmo com outro id de sessão', async () => {
    const vendedor = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()], gold: 5000 });
    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 10000, hours: 24 });
    const auctionId = [...am.auctions.keys()][0];

    // Relogou: mesmo nome, id novo (o contador andou).
    players.delete('p1');
    const relogado = addPlayer('p99', 'Bagatinha', { gold: 5000 });

    expect(am.stateOf(relogado).auctions[0].isMine).toBe(true);

    await am.handleBid(relogado, { auctionId, amount: 20000 });
    expect(msgsTo('Bagatinha', 'auction_error').pop().reason).toBe('own_auction');
    expect(relogado.gold).toBe(5000);
  });

  it('conta o teto de anúncios pelo nome, não pelo id da sessão', async () => {
    const navios = Array.from({ length: MAX_ACTIVE_PER_PLAYER + 1 },
      (_, i) => makeShip({ instanceId: `n${i}` }));
    const v = addPlayer('p1', 'Bagatinha', { bonusShips: navios, gold: 999999 });
    for (let i = 0; i < MAX_ACTIVE_PER_PLAYER; i++) {
      await am.handleCreate(v, { instanceId: `n${i}`, minBid: 100, hours: 8 });
    }

    // Relogou com id novo: o teto tem de continuar valendo para ele.
    players.delete('p1');
    const relogado = addPlayer('p77', 'Bagatinha', {
      bonusShips: [makeShip({ instanceId: 'extra' })], gold: 999999,
    });
    await am.handleCreate(relogado, { instanceId: 'extra', minBid: 100, hours: 8 });

    expect(msgsTo('Bagatinha', 'auction_error').pop().reason).toBe('too_many');
    expect(am.auctions.size).toBe(MAX_ACTIVE_PER_PLAYER);
  });

  it('não deixa outro jogador cancelar por herdar o id antigo', async () => {
    const vendedor = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()] });
    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 100, hours: 24 });
    const auctionId = [...am.auctions.keys()][0];

    // Depois do restart o contador recomeça e 'p1' cai em outra pessoa.
    players.delete('p1');
    const intruso = addPlayer('p1', 'Corsário');

    await am.handleCancel(intruso, { auctionId });

    expect(msgsTo('Corsário', 'auction_error')[0].reason).toBe('not_owner');
    expect(am.auctions.size).toBe(1);
    expect(intruso.bonusShips).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dois lances que chegam antes de o primeiro terminar de gravar. Se o débito e
// a troca do topo não fossem síncronos, os dois validariam contra o mesmo
// `topBid` antigo: o primeiro teria o ouro tirado, seria sobrescrito e nunca
// receberia de volta.
describe('lances simultâneos', () => {
  it('não perde o ouro de quem foi sobrescrito no mesmo tick', async () => {
    const vendedor = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()] });
    const a1 = addPlayer('p2', 'Corsário',  { gold: 50000 });
    const a2 = addPlayer('p3', 'Almirante', { gold: 50000 });
    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 10000, hours: 24 });
    const auctionId = [...am.auctions.keys()][0];

    // Sem await entre os dois: é exatamente a corrida real.
    await Promise.all([
      am.handleBid(a1, { auctionId, amount: 12000 }),
      am.handleBid(a2, { auctionId, amount: 15000 }),
    ]);

    const leilao = am.auctions.get(auctionId);
    expect(leilao.topBidderName).toBe('Almirante');
    expect(leilao.topBid).toBe(15000);

    // Quem não está ganhando não pode estar no prejuízo: ou o lance foi
    // recusado, ou o ouro voltou.
    expect(a1.gold).toBe(50000);
    expect(a2.gold).toBe(35000);
  });

  it('não devolve duas vezes ao mesmo superado', async () => {
    const vendedor = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()] });
    const a1 = addPlayer('p2', 'Corsário',  { gold: 50000 });
    const a2 = addPlayer('p3', 'Almirante', { gold: 50000 });
    const a3 = addPlayer('p4', 'Capitão',   { gold: 50000 });
    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 10000, hours: 24 });
    const auctionId = [...am.auctions.keys()][0];

    await am.handleBid(a1, { auctionId, amount: 12000 });
    await Promise.all([
      am.handleBid(a2, { auctionId, amount: 15000 }),
      am.handleBid(a3, { auctionId, amount: 18000 }),
    ]);

    expect(a1.gold).toBe(50000);                   // devolvido uma vez só
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('varredura reentrante', () => {
  it('não resolve o mesmo leilão duas vezes', async () => {
    vi.useFakeTimers();
    const vendedor  = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()], gold: 5000 });
    const comprador = addPlayer('p2', 'Corsário', { gold: 50000 });
    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 10000, hours: 8 });
    await am.handleBid(comprador, { auctionId: [...am.auctions.keys()][0], amount: 12000 });

    vi.advanceTimersByTime(8 * 3600_000 + 1000);
    await Promise.all([am._sweep(), am._sweep(), am._sweep()]);

    expect(comprador.bonusShips).toHaveLength(1);  // um navio, não três
    expect(vendedor.gold).toBe(5000 - 1000 + 12000); // pago uma vez
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('entrega pendente no login', () => {
  it('aplica ouro e navio antes de o init ser montado', async () => {
    await db.addAuctionDelivery('Bagatinha', 'sold', 12000, null);
    await db.addAuctionDelivery('Bagatinha', 'unsold', 0, makeShip({ instanceId: 'outro' }));

    const p = makePlayer('p1', 'Bagatinha', { gold: 1000 });
    players.set('p1', p);
    await am.onPlayerJoined(p);

    expect(p.gold).toBe(13000);
    expect(p.bonusShips).toHaveLength(1);
    expect(p.bonusShips[0].instanceId).toBe('outro');
    expect(db.deliveries).toHaveLength(0);         // a caixa foi esvaziada
  });

  it('não entrega duas vezes se o jogador relogar', async () => {
    await db.addAuctionDelivery('Bagatinha', 'sold', 12000, null);

    const p1 = makePlayer('p1', 'Bagatinha', { gold: 0 });
    players.set('p1', p1);
    await am.onPlayerJoined(p1);

    const p2 = makePlayer('p1', 'Bagatinha', { gold: 12000 });
    await am.onPlayerJoined(p2);

    expect(p2.gold).toBe(12000);                   // nada novo chegou
  });

  it('leva o resumo das entregas no payload do init, uma vez só', async () => {
    await db.addAuctionDelivery('Bagatinha', 'sold', 12000, null);
    const p = makePlayer('p1', 'Bagatinha');
    players.set('p1', p);
    await am.onPlayerJoined(p);

    const primeiro = am.injectInitData(p);
    expect(primeiro.auctionPending).toHaveLength(1);
    expect(primeiro.auctionPending[0]).toMatchObject({ reason: 'sold', gold: 12000 });

    expect(am.injectInitData(p).auctionPending).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a vitrine', () => {
  it('marca o que é meu e onde eu estou ganhando', async () => {
    const vendedor  = addPlayer('p1', 'Bagatinha', { bonusShips: [makeShip()] });
    const comprador = addPlayer('p2', 'Corsário', { gold: 50000 });
    await am.handleCreate(vendedor, { instanceId: 'colossal_1', minBid: 10000, hours: 24 });
    await am.handleBid(comprador, { auctionId: [...am.auctions.keys()][0], amount: 12000 });

    const doVendedor  = am.stateOf(vendedor).auctions[0];
    const doComprador = am.stateOf(comprador).auctions[0];

    expect(doVendedor.isMine).toBe(true);
    expect(doVendedor.iAmTopBidder).toBe(false);
    expect(doComprador.isMine).toBe(false);
    expect(doComprador.iAmTopBidder).toBe(true);
    expect(doComprador.topBid).toBe(12000);
  });

  it('publica a taxa e as durações para o cliente não precisar saber de cor', () => {
    const p = addPlayer('p1', 'Bagatinha');
    const st = am.stateOf(p);
    expect(st.feePct).toBe(FEE_PCT);
    expect(st.durations).toEqual(DURATIONS_H);
  });

  it('ordena por quem vence primeiro', async () => {
    const v = addPlayer('p1', 'Bagatinha', {
      bonusShips: [makeShip({ instanceId: 'a' }), makeShip({ instanceId: 'b' })],
      gold: 99999,
    });
    await am.handleCreate(v, { instanceId: 'a', minBid: 100, hours: 48 });
    await am.handleCreate(v, { instanceId: 'b', minBid: 100, hours: 8 });

    const lista = am.stateOf(v).auctions;
    expect(lista[0].endsAt).toBeLessThan(lista[1].endsAt);
  });
});
