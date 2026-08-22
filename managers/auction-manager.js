// managers/auction-manager.js — Casa de leilões de navios raros
//
// ── O que este manager governa ───────────────────────────────────────────────
//   • ANÚNCIO   um navio sai de `player.bonusShips` e passa a morar no leilão
//   • CUSTÓDIA  o ouro de cada lance sai do bolso na hora e fica preso aqui
//   • RELÓGIO   8, 24 ou 48 horas; vencido, a varredura resolve sozinha
//   • ENTREGA   navio e ouro chegam mesmo com todo mundo offline
//
// ── Por que o navio sai do inventário ────────────────────────────────────────
// Enquanto o leilão corre, o navio não está em lugar nenhum que o jogador possa
// alcançar. É a única forma de garantir que ele não seja vendido ao NPC, não
// seja ativado e não seja anunciado de novo enquanto alguém dá lance nele. O
// preço disso é que o navio depende deste manager para voltar — daí a varredura
// resolver leilões vencidos ANTES de qualquer outra coisa no boot.
//
// ── Por que o lance sai do bolso na hora ─────────────────────────────────────
// Custódia, não reserva. Se o ouro continuasse com quem deu o lance, bastaria
// gastá-lo para o leilão terminar sem pagamento — e aí o vendedor perde o navio
// sem receber nada. Quem é superado recebe de volta imediatamente; quem vence
// já pagou.
//
// ── A taxa ───────────────────────────────────────────────────────────────────
// 10% do lance mínimo, cobrada ao anunciar e NÃO devolvida. É o que faz o preço
// mínimo ser uma declaração séria: quem pede 1.000.000 por uma fragata comum
// paga 100.000 pelo direito de tentar. Não vender é uma perda de verdade, e é
// isso que impede a casa de virar depósito de navio encalhado.
//
// Cliente envia:  auction_list, auction_create, auction_bid, auction_cancel
// Servidor envia: auction_state, auction_error, auction_created, auction_bid_ok,
//                 auction_outbid, auction_closed, auction_delivery
'use strict';

// `sendTo` chega pelo construtor em vez de vir do helpers: é o mesmo caminho do
// SpoilManager, e é o que deixa o teste observar cada mensagem sem socket.

/** Durações oferecidas, em horas. Qualquer outro valor é recusado. */
const DURATIONS_H = [8, 24, 48];
/** Fatia do lance mínimo cobrada ao anunciar. Não volta. */
const FEE_PCT = 0.10;
/** Piso do lance mínimo — sem isto dá para anunciar por 0 e fugir da taxa. */
const MIN_BID = 1;
/** Teto de lance. A coluna é INT; parar bem antes do estouro é de graça. */
const MAX_BID = 1_000_000_000;
/** Anúncios simultâneos por jogador. Impede encher a casa sozinho. */
const MAX_ACTIVE_PER_PLAYER = 5;
/** Intervalo da varredura de leilões vencidos. */
const SWEEP_MS = 30_000;

class AuctionManager {
  /**
   * @param {Function} sendToFn  sendTo(ws, msg)
   * @param {Map}      players   id → player do server.js
   * @param {Object}   db        DBManager
   * @param {Object}   journal   JournalManager
   * @param {Object}   SRC       JournalManager.SRC
   */
  constructor(sendToFn, players, db, journal, SRC) {
    this.send     = sendToFn;
    this.players  = players;
    this.db       = db;
    this.journal  = journal;
    this.SRC      = SRC;
    this.auctions = new Map();   // id → leilão
    this._sweepInterval = null;
  }

  /**
   * Carrega os leilões e resolve o que venceu enquanto o servidor esteve fora.
   * Precisa ser await no boot: até isto terminar, um `auction_list` responderia
   * uma casa vazia e um jogador poderia reanunciar um navio que está em leilão.
   */
  async init() {
    const rows = await this.db.loadAuctions();
    for (const a of rows) this.auctions.set(a.id, a);
    const pendentes = await this._sweep();
    this._sweepInterval = setInterval(() => {
      this._sweep().catch(e => console.error('[Leilão] varredura falhou:', e.message));
    }, SWEEP_MS);
    console.log(`[Leilão] ${this.auctions.size} ativo(s)` +
                (pendentes ? `, ${pendentes} vencido(s) resolvido(s) no boot` : ''));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Consulta
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * A vitrine. Manda a lista inteira — a casa tem dezenas de itens, não
   * milhares, e paginar aqui só adicionaria estado para o cliente errar.
   */
  stateOf(player) {
    const now  = Date.now();
    const list = [];
    for (const a of this.auctions.values()) {
      if (a.endsAt <= now) continue;   // vencido: some da vitrine antes da varredura
      list.push({
        id:            a.id,
        ship:          a.shipData,
        ownerName:     a.ownerName,
        isMine:        a.ownerName === player.name,
        minBid:        a.minBid,
        topBid:        a.topBid || 0,
        topBidderName: a.topBidderName || '',
        iAmTopBidder:  a.topBidderName === player.name,
        bidCount:      (a.bids || []).length,
        endsAt:        a.endsAt,
      });
    }
    list.sort((x, y) => x.endsAt - y.endsAt);
    return {
      auctions:  list,
      durations: DURATIONS_H,
      feePct:    FEE_PCT,
      gold:      player.gold || 0,
    };
  }

  handleList(player) {
    this.send(player.ws, { type: 'auction_state', ...this.stateOf(player) });
  }

  _error(player, reason) {
    this.send(player.ws, { type: 'auction_error', reason });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Anunciar
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handler de `auction_create`. Nada do que vem do cliente é usado sem passar
   * pelo estoque real: o navio tem de estar em `player.bonusShips` AGORA, e é a
   * cópia do servidor que vai para o leilão — não a que veio na mensagem.
   */
  async handleCreate(player, msg) {
    const instanceId = String(msg.instanceId || '');
    const minBid     = Math.floor(Number(msg.minBid) || 0);
    const hours      = Math.floor(Number(msg.hours)  || 0);

    if (!instanceId)                    return this._error(player, 'invalid');
    if (!DURATIONS_H.includes(hours))   return this._error(player, 'bad_duration');
    if (minBid < MIN_BID)               return this._error(player, 'bad_min_bid');
    if (minBid > MAX_BID)               return this._error(player, 'bid_too_high');

    const ativos = this._countActiveOf(player.name);
    if (ativos >= MAX_ACTIVE_PER_PLAYER) return this._error(player, 'too_many');

    const ships = player.bonusShips || [];
    const idx   = ships.findIndex(s => s && s.instanceId === instanceId);
    if (idx === -1) return this._error(player, 'ship_not_found');

    // `tradeable` é gravado por rollBonusShip em todo navio rolado. Respeitar o
    // campo aqui é o que permite, um dia, existir navio de evento intransferível
    // sem precisar mexer no leilão.
    const ship = ships[idx];
    if (ship.tradeable === false) return this._error(player, 'not_tradeable');

    const fee = Math.ceil(minBid * FEE_PCT);
    if ((player.gold || 0) < fee) {
      this.send(player.ws, { type: 'auction_error', reason: 'no_gold_for_fee', fee });
      return;
    }

    // A partir daqui nada pode falhar pela metade: cobra, tira o navio e grava.
    player.gold -= fee;
    ships.splice(idx, 1);
    player.bonusShips = ships;

    const auction = {
      id:            `a_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
      shipData:      ship,
      ownerId:       player.id,
      ownerName:     player.name,
      minBid,
      topBid:        0,
      bids:          [],
      topBidderId:   null,
      topBidderName: null,
      endsAt:        Date.now() + hours * 3600_000,
      createdAt:     Date.now(),
    };
    this.auctions.set(auction.id, auction);

    await this.db.upsertAuction(auction);
    this.journal.ledger(player, this.SRC.AUCTION_FEE, { gold: -fee },
      { detail: ship.name || ship.id });
    this.db.save(player, true).catch(e => console.error('[Leilão] save (create):', e.message));

    this.send(player.ws, {
      type:       'auction_created',
      auctionId:  auction.id,
      fee,
      gold:       player.gold,
      rareShips:  player.bonusShips,
      ...this.stateOf(player),
    });
    this.send(player.ws, { type: 'currency_update', gold: player.gold, dobroes: player.dobroes || 0 });
    console.log(`🏷️ ${player.name} anunciou ${ship.name || ship.id} por ${minBid} (${hours}h, taxa ${fee})`);
  }

  _countActiveOf(playerName) {
    const now = Date.now();
    let n = 0;
    for (const a of this.auctions.values()) {
      if (a.ownerName === playerName && a.endsAt > now) n += 1;
    }
    return n;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Dar lance
  // ═══════════════════════════════════════════════════════════════════════════

  /** Handler de `auction_bid`. O ouro sai do bolso nesta chamada. */
  async handleBid(player, msg) {
    const auctionId = String(msg.auctionId || '');
    const amount    = Math.floor(Number(msg.amount) || 0);

    const a = this.auctions.get(auctionId);
    if (!a)                                 return this._error(player, 'not_found');
    if (a.endsAt <= Date.now())             return this._error(player, 'ended');
    if (a.ownerName === player.name)        return this._error(player, 'own_auction');
    if (a.topBidderName === player.name)    return this._error(player, 'already_winning');
    if (amount > MAX_BID)                   return this._error(player, 'bid_too_high');

    const piso = a.topBid > 0 ? a.topBid + 1 : a.minBid;
    if (amount < piso) {
      this.send(player.ws, { type: 'auction_error', reason: 'bid_too_low', minimum: piso });
      return;
    }
    if ((player.gold || 0) < amount) {
      this.send(player.ws, { type: 'auction_error', reason: 'no_gold', needed: amount });
      return;
    }

    // ── Trecho crítico: nada de `await` daqui até o fim das atribuições ──────
    // O Node é uma thread só, então este bloco é atômico enquanto não ceder o
    // controle. Se o reembolso do superado fosse aguardado ANTES de gravar o
    // novo topo, dois lances quase simultâneos passariam os dois na validação
    // contra o mesmo `topBid` antigo: o primeiro teria o ouro debitado, seria
    // sobrescrito pelo segundo e nunca receberia de volta.
    const supBidder = a.topBidderName;
    const supValor  = a.topBid;

    player.gold -= amount;
    a.topBid        = amount;
    a.topBidderId   = player.id;      // só informativo: `id` não sobrevive a restart
    a.topBidderName = player.name;
    (a.bids ||= []).push({ name: player.name, amount, at: Date.now() });
    // ── Fim do trecho crítico ───────────────────────────────────────────────

    if (supBidder && supValor > 0) {
      await this._deliver(supBidder, 'outbid', supValor, null, {
        shipName: a.shipData?.name || '', auctionId: a.id,
      });
    }

    await this.db.upsertAuction(a);
    this.journal.ledger(player, this.SRC.AUCTION_BID, { gold: -amount },
      { detail: a.shipData?.name || a.shipData?.id });
    this.db.save(player, true).catch(e => console.error('[Leilão] save (bid):', e.message));

    this.send(player.ws, {
      type: 'auction_bid_ok', auctionId, amount, gold: player.gold, ...this.stateOf(player),
    });
    this.send(player.ws, { type: 'currency_update', gold: player.gold, dobroes: player.dobroes || 0 });

    // O dono fica sabendo na hora que o navio dele subiu de preço.
    const dono = this._onlineByName(a.ownerName);
    if (dono) {
      this.send(dono.ws, {
        type: 'auction_bid_received', auctionId, amount, bidderName: player.name,
        shipName: a.shipData?.name || '',
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Cancelar
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handler de `auction_cancel`. Só antes do primeiro lance: depois disso há
   * ouro de outra pessoa preso no leilão, e cancelar seria puxar o tapete de
   * quem já pagou. A taxa não volta em nenhum caso — foi paga pelo anúncio, e
   * o anúncio aconteceu.
   */
  async handleCancel(player, msg) {
    const auctionId = String(msg.auctionId || '');
    const a = this.auctions.get(auctionId);
    if (!a)                             return this._error(player, 'not_found');
    if (a.ownerName !== player.name)    return this._error(player, 'not_owner');
    if ((a.bids || []).length > 0)      return this._error(player, 'has_bids');
    if (a.endsAt <= Date.now())         return this._error(player, 'ended');

    // Tirar do mapa e devolver o navio ANTES do await, pelo mesmo motivo do
    // lance: dois cancelamentos em sequência não podem devolver duas cópias.
    this.auctions.delete(auctionId);
    if (!player.bonusShips) player.bonusShips = [];
    player.bonusShips.push(a.shipData);

    await this.db.deleteAuction(auctionId);
    this.db.save(player, true).catch(e => console.error('[Leilão] save (cancel):', e.message));

    this.send(player.ws, {
      type: 'auction_closed', auctionId, outcome: 'cancelled',
      rareShips: player.bonusShips, ...this.stateOf(player),
    });
    console.log(`🏷️ ${player.name} cancelou o leilão de ${a.shipData?.name || a.shipData?.id}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Relógio
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve todo leilão vencido. Rodar isto no boot é o que impede um navio de
   * ficar órfão quando o servidor cai com leilões em andamento.
   * @returns {Promise<number>} quantos foram resolvidos
   */
  async _sweep() {
    // Guarda de reentrância. A varredura monta a lista de vencidos e só então
    // resolve um por um, cada um com ida ao banco. Se o intervalo disparasse
    // outra varredura no meio disso, ela veria os que ainda não foram
    // removidos do mapa e resolveria os mesmos leilões de novo — pagando o
    // vendedor duas vezes e entregando dois navios.
    if (this._sweeping) return 0;
    this._sweeping = true;
    try {
      const now      = Date.now();
      const vencidos = [];
      for (const a of this.auctions.values()) {
        if (a.endsAt <= now) vencidos.push(a);
      }
      for (const a of vencidos) await this._resolve(a);
      return vencidos.length;
    } finally {
      this._sweeping = false;
    }
  }

  /**
   * Fecha um leilão. Duas saídas: com lance, o navio vai para quem venceu e o
   * ouro para quem vendeu; sem lance, o navio volta para o dono. A taxa fica
   * com a casa nos dois casos.
   */
  async _resolve(a) {
    this.auctions.delete(a.id);
    await this.db.deleteAuction(a.id);

    const nomeNavio = a.shipData?.name || a.shipData?.id || 'navio';

    if (a.topBidderName && a.topBid > 0) {
      await this._deliver(a.topBidderName, 'won',  0,        a.shipData, { shipName: nomeNavio });
      await this._deliver(a.ownerName,     'sold', a.topBid, null,       { shipName: nomeNavio });
      console.log(`🏷️ Leilão fechado: ${nomeNavio} — ${a.topBidderName} arrematou de ${a.ownerName} por ${a.topBid}`);
    } else {
      await this._deliver(a.ownerName, 'unsold', 0, a.shipData, { shipName: nomeNavio });
      console.log(`🏷️ Leilão vencido sem lance: ${nomeNavio} devolvido a ${a.ownerName}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Entrega
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Entrega ouro e/ou navio. Online, aplica na hora; offline, enfileira no
   * banco para o próximo login. Este é o único caminho pelo qual o leilão
   * devolve qualquer coisa — inclusive o reembolso de quem foi superado.
   */
  async _deliver(toName, reason, gold, shipData, extra = {}) {
    if (!toName) return;
    const alvo = this._onlineByName(toName);

    if (!alvo) {
      await this.db.addAuctionDelivery(toName, reason, gold, shipData);
      if (gold > 0) {
        this.journal.ledgerByName(toName, this._srcFor(reason), { gold }, { detail: extra.shipName || '' });
      }
      return;
    }

    this._applyDelivery(alvo, { reason, gold, shipData }, extra);
  }

  /** Aplica uma entrega num jogador que está online e avisa o cliente. */
  _applyDelivery(player, { reason, gold, shipData }, extra = {}) {
    if (gold > 0) {
      player.gold = (player.gold || 0) + gold;
      this.journal.ledger(player, this._srcFor(reason), { gold }, { detail: extra.shipName || '' });
    }
    if (shipData) {
      if (!player.bonusShips) player.bonusShips = [];
      player.bonusShips.push(shipData);
    }

    this.db.save(player, true).catch(e => console.error('[Leilão] save (entrega):', e.message));
    this.send(player.ws, {
      type:      'auction_delivery',
      reason,
      gold,
      ship:      shipData || null,
      shipName:  extra.shipName || shipData?.name || '',
      auctionId: extra.auctionId || '',
      newGold:   player.gold || 0,
      rareShips: player.bonusShips || [],
    });
    if (gold > 0) {
      this.send(player.ws, { type: 'currency_update', gold: player.gold, dobroes: player.dobroes || 0 });
    }
  }

  /**
   * Motivo da entrega → fonte do livro-caixa. Só a venda é entrada nova; tudo
   * mais que traz ouro de volta (lance superado) é devolução. `won` e `unsold`
   * não passam por aqui com ouro, então caem no mesmo balde sem consequência.
   */
  _srcFor(reason) {
    return reason === 'sold' ? this.SRC.AUCTION_SALE : this.SRC.AUCTION_REFUND;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Ciclo de vida do jogador
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Login: esvazia a caixa de entregas pendentes. Roda ANTES do payload do
   * init ser montado, para o ouro e os navios já entrarem no primeiro estado
   * que o cliente recebe em vez de aparecerem um quadro depois.
   */
  async onPlayerJoined(player) {
    const pend = await this.db.takeAuctionDeliveries(player.name);
    if (pend.length === 0) return;
    for (const d of pend) {
      // Sem eco por entrega: o init já vai levar o saldo e a lista de navios.
      if (d.gold > 0) player.gold = (player.gold || 0) + d.gold;
      if (d.shipData) {
        if (!player.bonusShips) player.bonusShips = [];
        player.bonusShips.push(d.shipData);
      }
    }
    console.log(`[Leilão] ${player.name} recebeu ${pend.length} entrega(s) pendente(s)`);
    player._auctionPending = pend.map(d => ({
      reason: d.reason, gold: d.gold, shipName: d.shipData?.name || '',
    }));
  }

  /** Dados da casa de leilões no payload do init. */
  injectInitData(player) {
    const data = { auctionState: this.stateOf(player) };
    if (player._auctionPending && player._auctionPending.length) {
      data.auctionPending = player._auctionPending;
      player._auctionPending = null;
    }
    return data;
  }

  /**
   * Quem está online, por NOME. O leilão nunca procura por `player.id`: aquele
   * id vem de um contador em memória que reinicia junto com o processo, então
   * o id gravado num leilão de ontem pode ser o de outra pessoa hoje. O nome é
   * a identidade estável — é o que o correio e o Diário também usam.
   */
  _onlineByName(name) {
    for (const p of this.players.values()) if (p && p.name === name) return p;
    return null;
  }

  destroy() {
    if (this._sweepInterval) clearInterval(this._sweepInterval);
  }
}

module.exports = AuctionManager;
// Só o que alguém de fora lê. MIN_BID e MAX_BID ficam internos: exportá-los
// "por simetria" criaria exatamente o tipo de export sem consumidor que esta
// limpeza acabou de varrer do resto do projeto.
module.exports.DURATIONS_H            = DURATIONS_H;
module.exports.FEE_PCT                = FEE_PCT;
module.exports.MAX_ACTIVE_PER_PLAYER  = MAX_ACTIVE_PER_PLAYER;
