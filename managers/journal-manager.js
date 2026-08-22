// managers/journal-manager.js — O Diário do capitão
//
// Registro cronológico e PERMANENTE do que aconteceu com o jogador: o que ele
// ganhou, o que recebeu, que abordagens travou e quantos piratas enterrou.
// A aba Diário do painel Capitão lê daqui.
//
// ── Por que guarda `kind` + `data` e não a frase pronta ──────────────────────
// O jogo fala três idiomas (locale/pt|en|es.json) e o Diário é permanente. Uma
// frase em português gravada no banco em 2026 continuaria em português para um
// jogador que troca o idioma amanhã. Gravamos o EVENTO — o tipo e os números —
// e o cliente monta a frase com I18n na hora de mostrar. Entradas de um `kind`
// que o cliente ainda não conhece caem num texto genérico em vez de sumirem.
//
// ── O livro-caixa ────────────────────────────────────────────────────────────
// Além dos eventos narrados, o Diário é o EXTRATO do capitão: toda entrada e
// toda saída de ouro, dobrão e XP, mais as subidas de Tier. Quem move o saldo
// chama `ledger` (ou `accrue`) logo depois de mexer nele — ver a seção
// "Livro-caixa" mais abaixo para a diferença entre os dois e por que o abate de
// NPC comum NÃO vira uma linha por abate.
'use strict';

const { sendTo } = require('../utils/helpers');

/** Tipos que o cliente sabe desenhar (ver journal.* nos locales). */
const KINDS = {
  REWARD:          'reward',           // recompensa obtida por mérito próprio
  REWARD_RECEIVED: 'reward_received',  // recompensa recebida (partilha, correio)
  SPOIL_BATTLE:    'spoil_battle',     // abordagem de espólio + resultado
  SPOIL_LOOTED:    'spoil_looted',     // espólio saqueado + recursos
  PIRATES_LOST:    'pirates_lost',     // piratas mortos permanentemente
  SPOIL_CREATED:   'spoil_created',    // seu naufrágio virou espólio de outro
  LEDGER:          'ledger',           // entrada/saída de ouro, dobrão ou XP
  TIER_UP:         'tier_up',          // o Tier de abates subiu
};

/**
 * Fontes do livro-caixa. O cliente traduz por `ledger.src.<fonte>`; uma fonte
 * que ele ainda não conheça aparece com o próprio identificador em vez de
 * sumir, então acrescentar uma linha aqui nunca quebra o Diário antigo.
 *
 * `ACCRUED` marca as que passam por `accrue` em vez de `ledger` — as que
 * acontecem dezenas de vezes por minuto.
 */
const SRC = {
  // Ganhos de combate
  NPC_KILL:      'npc_kill',
  PARTY_SHARE:   'party_share',
  BOSS:          'boss',
  WORLD_BOSS:    'world_boss',
  FLEET:         'fleet',
  WANTED:        'wanted',
  PVP_KILL:      'pvp_kill',
  PVP_DEATH:     'pvp_death',
  DUNGEON:       'dungeon',
  WRECK_LOOT:    'wreck_loot',
  WRECK_DEATH:   'wreck_death',
  SPOIL_LOOT:    'spoil_loot',
  SPOIL_LOST:    'spoil_lost',
  MISSION:       'mission',
  TUTORIAL:      'tutorial',
  // Movimentos de bolsa
  BANK_IN:       'bank_in',
  BANK_OUT:      'bank_out',
  EXCHANGE:      'exchange',
  SHIP_SALE:     'ship_sale',
  // Leilão — quatro fontes porque as quatro contam histórias diferentes no
  // extrato, e quem abre o Diário querendo saber "para onde foi meu ouro"
  // precisa distinguir a taxa que pagou do lance que ficou preso. Arrematar
  // não entra aqui: o ouro do vencedor já saiu em AUCTION_BID, e uma linha de
  // saldo zero é descartada pelo _pack.
  AUCTION_FEE:    'auction_fee',     // taxa de 10% paga ao anunciar (não volta)
  AUCTION_SALE:   'auction_sale',    // vendeu: lance cheio entra
  AUCTION_BID:    'auction_bid',     // lance dado — ouro sai e fica em custódia
  AUCTION_REFUND: 'auction_refund',  // superado ou leilão cancelado: ouro volta
  // Gastos
  SHOP_GENERAL:  'shop_general',
  SHOP_PET_FOOD: 'shop_pet_food',
  SHOP_CANNON:   'shop_cannon',
  SHOP_AMMO:     'shop_ammo',
  SHOP_SHIP:     'shop_ship',
  SHOP_SAIL:     'shop_sail',
  SHOP_ELITE:    'shop_elite',
  SHOP_PIRATE:   'shop_pirate',
  UPG_ISLAND:    'upg_island',
  UPG_CANNON:    'upg_cannon',
  RESEARCH:      'research',
  TALENT:        'talent',
  AFK_TRAINING:  'afk_training',
  EXPLORATION:   'exploration',
  GOLD_SHIELD:   'gold_shield',
  GOLD_STOLEN:   'gold_stolen',
};

/** Teto de entradas devolvidas de uma vez ao cliente. */
const PAGE_SIZE = 60;

/**
 * Janela de agregação das fontes de alta frequência. Um jogador ativo mata
 * dezenas de NPCs por minuto; uma linha por abate encheria a tabela e o Diário
 * viraria um log de combate. Com a janela, vira uma linha por minuto e por
 * fonte — "Abates de NPC ×37 · 🪙 +12.400 · ✨ +840" — que é o que o jogador
 * realmente procura quando abre o extrato.
 */
const ACCRUE_WINDOW_MS = 60000;

class JournalManager {
  /**
   * @param {Object} db  DBManager (precisa de addJournal/getJournal/getBattleReport)
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Grava uma entrada. Nunca lança: o Diário é um registro secundário e uma
   * falha de banco não pode derrubar o fluxo que gerou o evento (uma batalha,
   * um saque). Erros vão para o console e a vida continua.
   *
   * @param {object} player
   * @param {string} kind      um dos KINDS
   * @param {object} data      números/nomes que o cliente formata
   * @param {number|null} reportId  relatório de batalha ligado, quando houver
   */
  log(player, kind, data = {}, reportId = null) {
    if (!player || !player.name) return;
    const at = Date.now();
    this.db.addJournal(player.name, at, kind, data, reportId)
      .catch(e => console.error('[Diário] falha ao gravar:', e.message));

    // Eco imediato para quem está online: a aba Diário aberta atualiza sozinha
    // sem esperar uma nova consulta.
    sendTo(player.ws, { type: 'journal_entry', entry: { at, kind, data, reportId } });
  }

  /**
   * Grava para um jogador que pode estar OFFLINE — o dono do espólio saqueado,
   * por exemplo, que fica sabendo ao voltar. Sem eco: não há socket para avisar.
   */
  logByName(name, kind, data = {}, reportId = null) {
    if (!name) return;
    this.db.addJournal(name, Date.now(), kind, data, reportId)
      .catch(e => console.error('[Diário] falha ao gravar:', e.message));
  }

  // ── Livro-caixa ────────────────────────────────────────────────────────────
  //
  // O extrato NÃO mexe no saldo: quem chama já somou ou subtraiu, e aqui só
  // fica a anotação. Foi de propósito — os ~40 pontos que movem moeda no
  // servidor têm cada um a sua validação, o seu broadcast e o seu clamp, e
  // trocar todos por um helper que credita seria um refatoramento com risco de
  // regressão em cada compra do jogo. O livro-caixa é observação, não caixa.
  //
  // Os deltas vão ASSINADOS: ganho positivo, gasto negativo. Só os campos com
  // valor são gravados, para o JSON não carregar três zeros em toda linha.

  /**
   * Anota um movimento de saldo na hora.
   *
   * @param {object} player
   * @param {string} source  um dos SRC
   * @param {{gold?:number, dobroes?:number, xp?:number}} deltas  assinados
   * @param {object} [extra] campos livres para a frase (nome do item, alvo…)
   */
  ledger(player, source, deltas = {}, extra = null) {
    const data = this._pack(source, deltas, extra);
    if (data) this.log(player, KINDS.LEDGER, data);
  }

  /** Versão do `ledger` para quem pode estar offline (dono do espólio saqueado). */
  ledgerByName(name, source, deltas = {}, extra = null) {
    const data = this._pack(source, deltas, extra);
    if (data) this.logByName(name, KINDS.LEDGER, data);
  }

  /**
   * Acumula um movimento de alta frequência. Fica na memória do jogador até a
   * janela fechar (ver ACCRUE_WINDOW_MS); só então vira uma linha, com o número
   * de ocorrências junto.
   */
  accrue(player, source, deltas = {}) {
    if (!player || !player.name) return;
    const g = Math.round(Number(deltas.gold)    || 0);
    const d = Math.round(Number(deltas.dobroes) || 0);
    const x = Math.round(Number(deltas.xp)      || 0);
    if (!g && !d && !x) return;

    if (!player._ledgerAcc) player._ledgerAcc = new Map();
    let b = player._ledgerAcc.get(source);
    if (!b) {
      b = { gold: 0, dobroes: 0, xp: 0, n: 0, since: Date.now() };
      player._ledgerAcc.set(source, b);
    }
    b.gold += g; b.dobroes += d; b.xp += x; b.n += 1;
  }

  /**
   * Fecha as janelas vencidas de UM jogador.
   * @param {boolean} force  fecha todas, mesmo as que ainda não venceram
   *        (troca de mapa, desconexão — o extrato não pode perder o último minuto)
   */
  flushPlayer(player, force = false) {
    if (!player || !player._ledgerAcc || player._ledgerAcc.size === 0) return;
    const now = Date.now();
    for (const [source, b] of player._ledgerAcc) {
      if (!force && now - b.since < ACCRUE_WINDOW_MS) continue;
      player._ledgerAcc.delete(source);
      this.ledger(player, source, b, b.n > 1 ? { n: b.n } : null);
    }
  }

  /** Fecha as janelas vencidas de todo mundo. Chamado pelo tique do servidor. */
  sweep(players) {
    if (!players) return;
    players.forEach(p => this.flushPlayer(p, false));
  }

  /**
   * Registra a subida de Tier, se houve. Chamar depois de mexer em npcKills.
   *
   * O Tier é `abates / 10` e o jogador vê na HUD, mas nunca teve onde olhar
   * QUANDO subiu. A primeira chamada de cada sessão só memoriza o valor atual —
   * senão todo login viraria uma linha falsa de subida.
   */
  checkTier(player) {
    if (!player || !player.name) return;
    const tier = Math.floor((player.npcKills || 0) / 10);
    if (player._lastTier === undefined) { player._lastTier = tier; return; }
    if (tier <= player._lastTier) { player._lastTier = tier; return; }
    const from = player._lastTier;
    player._lastTier = tier;
    this.log(player, KINDS.TIER_UP, { tier, from, kills: player.npcKills || 0 });
  }

  /** Monta o `data` da linha, ou null se o movimento for zerado. */
  _pack(source, deltas, extra) {
    const g = Math.round(Number(deltas.gold)    || 0);
    const d = Math.round(Number(deltas.dobroes) || 0);
    const x = Math.round(Number(deltas.xp)      || 0);
    if (!g && !d && !x) return null;
    const data = { source };
    if (g) data.gold    = g;
    if (d) data.dobroes = d;
    if (x) data.xp      = x;
    return extra ? Object.assign(data, extra) : data;
  }

  /** Handler de `journal_list` — página mais recente primeiro. */
  async sendList(player, limit = PAGE_SIZE, before = 0) {
    if (!player) return;
    try {
      const entries = await this.db.getJournal(player.name, limit, before);
      sendTo(player.ws, { type: 'journal_list', entries, hasMore: entries.length >= limit });
    } catch (e) {
      console.error('[Diário] falha ao ler:', e.message);
      sendTo(player.ws, { type: 'journal_list', entries: [], hasMore: false });
    }
  }

  /**
   * Handler de `battle_report` — o relatório completo de uma batalha.
   * A consulta filtra pelo nome do jogador: só quem lutou (dos dois lados) lê.
   */
  async sendReport(player, reportId) {
    if (!player) return;
    try {
      const report = await this.db.getBattleReport(Number(reportId), player.name);
      if (!report) {
        sendTo(player.ws, { type: 'battle_report_error', reason: 'Relatório não encontrado.' });
        return;
      }
      sendTo(player.ws, { type: 'battle_report', report });
    } catch (e) {
      console.error('[Diário] falha ao ler relatório:', e.message);
      sendTo(player.ws, { type: 'battle_report_error', reason: 'Erro ao carregar o relatório.' });
    }
  }
}

module.exports = JournalManager;
module.exports.KINDS            = KINDS;
module.exports.SRC              = SRC;
module.exports.PAGE_SIZE        = PAGE_SIZE;
module.exports.ACCRUE_WINDOW_MS = ACCRUE_WINDOW_MS;
