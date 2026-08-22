// managers/pirate-manager.js — Tripulação de piratas: porão, peso e RUN
//
// ── O que este manager governa ───────────────────────────────────────────────
//   • ALISTAMENTO  `player.inventory.pirates` — quem o jogador possui
//   • EMBARQUE     `player.pirates`           — quem está a bordo agora
//   • PESO         a soma dos pesos embarcados não passa da capacidade do navio
//   • RUN          o item que mantém a tripulação em condições de abordar
//   • MORTE        piratas mortos na abordagem somem dos DOIS, para sempre
//
// ── Por que não é um sistema novo ────────────────────────────────────────────
// As duas listas acima já existiam (eram os curandeiros) e já estavam
// persistidas em `pirates` / `equipped_pirates`. O que mudou foi o limite: a
// contagem de vagas por navio (`maxHealers`) virou capacidade de PESO. O tique
// de cura do server.js e o homing do projectile-manager continuam lendo
// `player.pirates` sem saber que a régua mudou.
//
// ── RUN ──────────────────────────────────────────────────────────────────────
// É a comida de pet aplicada à tripulação, de propósito: mesmo formato (item de
// inventário), mesmo tique de 60s, mesma reação à compra (`onRunPurchased`), e
// a mesma consequência suave — sem RUN ninguém morre nem desembarca, a
// tripulação só fica INATIVA e não pode abordar. O consumo escala com o peso
// embarcado, então uma tripulação enorme é cara de manter.
//
// Cliente envia:  pirate_board, buy_pirate (server.js), pirate_state_request
// Servidor envia: pirate_state, pirate_error, run_tick, pirates_inactive,
//                 pirates_reactivated
'use strict';

const { sendTo } = require('../utils/helpers');
const {
  PIRATE_DEFS, PIRATE_ORDER,
  pirateCapacityFor, pirateWeightOf,
  RUN_ITEM_ID, RUN_TICK_MS, runPerHour,
} = require('../constants/pirates');
const fx = require('../utils/talent-effects');

class PirateManager {
  /**
   * @param {Map}    players  id → player do server.js
   * @param {Object} db       DBManager
   */
  constructor(players, db) {
    this.players = players;
    this.db      = db;
    this._runInterval = setInterval(() => this._tickAllRun(), RUN_TICK_MS);
    console.log('[Piratas] PirateManager iniciado');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Peso e capacidade
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Capacidade de peso do navio ativo, já com o talento de porão.
   * Toda checagem de embarque passa por aqui — inclusive a que roda na troca
   * de navio, senão descer de um elite para uma fragata deixaria o jogador
   * navegando com o dobro do peso permitido.
   */
  capacityOf(player) {
    const base = pirateCapacityFor(player.activeShip);
    return Math.max(0, base + fx.pirateCapacityBonus(player, base));
  }

  weightOf(player) {
    return pirateWeightOf(player.pirates || []);
  }

  /**
   * Corta o excesso de peso do navio ativo. Chamar em TODA troca de navio.
   * Desembarca do fim para o começo (os últimos a subir são os primeiros a
   * descer) para não escolher por conta própria quem o jogador prefere.
   * @returns {number} quantos piratas desembarcaram
   */
  refreshCapacity(player) {
    const cap  = this.capacityOf(player);
    const list = (player.pirates || []).slice();
    let removed = 0;
    while (pirateWeightOf(list) > cap && list.length > 0) {
      list.pop();
      removed += 1;
    }
    if (removed > 0) player.pirates = list;
    return removed;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Embarque
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handler de `pirate_board` — o cliente manda a lista INTEIRA de embarcados
   * e o servidor a reconstrói do zero a partir do que o jogador realmente
   * possui. Nunca confia na lista recebida: ela é um pedido, não um estado.
   */
  handleBoard(player, msg) {
    const incoming = Array.isArray(msg.pirates) ? msg.pirates : [];

    // Estoque real: o cliente poderia mandar 10 cópias de um pirata comprado
    // uma vez só. Cada embarque desconta do estoque, então o excedente cai.
    const estoque = {};
    for (const pid of (player.inventory?.pirates || [])) {
      estoque[pid] = (estoque[pid] || 0) + 1;
    }

    const cap = this.capacityOf(player);
    const aceitos = [];
    let peso = 0;
    let recusadosPorPeso = 0;

    for (const pid of incoming) {
      const def = PIRATE_DEFS[pid];
      if (!def) continue;                       // id inventado
      if ((estoque[pid] || 0) <= 0) continue;   // não possui (mais)
      const w = def.weight || 0;
      if (peso + w > cap) { recusadosPorPeso += 1; continue; }
      estoque[pid] -= 1;
      aceitos.push(pid);
      peso += w;
    }

    player.pirates = aceitos;
    // Campos legados do curandeiro: o sync antigo os zerava a cada troca de
    // tripulação e o projectile-manager conta com isso.
    player.homingCharges    = 0;
    player.damageMultiplier = 1.0;

    this._refreshActive(player);
    this.db.save(player, true).catch(e => console.error('Save error:', e));

    if (recusadosPorPeso > 0) {
      sendTo(player.ws, {
        type: 'pirate_error',
        reason: `Porão cheio: ${recusadosPorPeso} pirata(s) ficaram em terra.`,
      });
    }
    this.sendState(player);
  }

  /** Estado completo da tripulação — init, embarque, compra, morte, RUN. */
  sendState(player) {
    sendTo(player.ws, { type: 'pirate_state', ...this.stateOf(player) });
  }

  stateOf(player) {
    const weight = this.weightOf(player);
    return {
      pirates:       player.pirates || [],
      roster:        player.inventory?.pirates || [],
      capacity:      this.capacityOf(player),
      weight,
      piratesActive: !!player.piratesActive,
      run:           Number(player.inventory?.[RUN_ITEM_ID] || 0),
      runPerHour:    Number(this.runPerHourFor(player).toFixed(2)),
      // Mantido para o cliente antigo, que ainda lê este campo no armazém.
      homingCharges: player.homingCharges || 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RUN
  // ═══════════════════════════════════════════════════════════════════════════

  /** Consumo por hora deste jogador, já com o talento de eficiência. */
  runPerHourFor(player) {
    const base = runPerHour(this.weightOf(player));
    return base * fx.runUpkeepMult(player);
  }

  /**
   * A tripulação está em condições de abordar? É a única pergunta que a RUN
   * responde — o curandeiro continua curando sem ela, como sempre curou.
   */
  isActive(player) {
    return (player.pirates || []).length > 0 && !!player.piratesActive;
  }

  /** Deriva `piratesActive` do inventário. O estado não persiste; é calculado. */
  _refreshActive(player) {
    const has = Number(player.inventory?.[RUN_ITEM_ID] || 0) > 0;
    player.piratesActive = has && (player.pirates || []).length > 0;
    return player.piratesActive;
  }

  _tickAllRun() {
    for (const [, player] of this.players) {
      if (!player || player.dead) continue;
      if (!(player.pirates || []).length) continue;
      this._tickPlayerRun(player);
    }
  }

  _tickPlayerRun(player) {
    if (!player.piratesActive) return;   // inativo não consome

    const inventory = player.inventory || (player.inventory = {});
    const have = Number(inventory[RUN_ITEM_ID] || 0);
    const need = this.runPerHourFor(player) / 60.0;

    if (have <= 0) {
      player.piratesActive = false;
      sendTo(player.ws, {
        type: 'pirates_inactive',
        reason: 'Sua tripulação ficou sem RUN! Sem RUN os piratas não abordam.',
      });
      this.sendState(player);
      this.db.save(player);
      return;
    }

    inventory[RUN_ITEM_ID] = Math.max(0, have - need);
    sendTo(player.ws, {
      type:     'run_tick',
      run:      inventory[RUN_ITEM_ID],
      perHour:  Number(this.runPerHourFor(player).toFixed(2)),
    });
    this.db.save(player);
  }

  /** Chamado após a compra de RUN — reativa a tripulação na hora. */
  onRunPurchased(player) {
    if (player.piratesActive) { this.sendState(player); return; }
    if (Number(player.inventory?.[RUN_ITEM_ID] || 0) <= 0) return;
    if (!(player.pirates || []).length) { this.sendState(player); return; }
    player.piratesActive = true;
    sendTo(player.ws, { type: 'pirates_reactivated' });
    this.sendState(player);
    console.log(`[Piratas] ${player.name}: tripulação reativada (RUN comprada)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Morte permanente
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Enterra os piratas mortos numa abordagem. Some do embarque E do
   * alistamento: para ter aquele pirata de volta, contrata-se outro.
   *
   * Remove uma ocorrência por morto (e não todas as do tipo) — quem levava
   * cinco marujos e perdeu dois continua com três.
   *
   * @param {string[]} deadIds
   * @returns {number} quantos foram efetivamente removidos
   */
  killPirates(player, deadIds) {
    if (!player || !deadIds?.length) return 0;
    const boarded = (player.pirates || []).slice();
    const roster  = (player.inventory?.pirates || []).slice();
    let buried = 0;

    for (const id of deadIds) {
      const bi = boarded.indexOf(id);
      if (bi >= 0) boarded.splice(bi, 1);
      const ri = roster.indexOf(id);
      if (ri >= 0) roster.splice(ri, 1);
      if (bi >= 0 || ri >= 0) buried += 1;
    }

    player.pirates = boarded;
    if (!player.inventory) player.inventory = {};
    player.inventory.pirates = roster;

    this._refreshActive(player);
    this.db.save(player, true).catch(e => console.error('Save error:', e));
    return buried;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Ciclo de vida
  // ═══════════════════════════════════════════════════════════════════════════

  /** Login / troca de navio. Corta o excesso de peso e apura a RUN. */
  onPlayerJoined(player) {
    const cortados = this.refreshCapacity(player);
    this._refreshActive(player);
    if (cortados > 0) {
      console.log(`[Piratas] ${player.name}: ${cortados} pirata(s) desembarcados (porão do ${player.activeShip} não comporta)`);
    }
  }

  /** Dados da tripulação no payload do init. */
  injectInitData(player) {
    this._refreshActive(player);
    return {
      pirateState: this.stateOf(player),
      pirateDefs:  PIRATE_ORDER.map(id => ({ id, ...PIRATE_DEFS[id] })),
    };
  }

  destroy() {
    clearInterval(this._runInterval);
  }
}

module.exports = PirateManager;
