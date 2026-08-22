// managers/spoil-manager.js — Espólio de abordagem (mapas Red ou superiores)
//
// ── O que é ──────────────────────────────────────────────────────────────────
// Quando um jogador afunda numa zona Red ou mais severa, o naufrágio deixa um
// ESPÓLIO no local: um destroço que fica 1 hora no mar guardando o ouro da
// vítima e a memória de quem estava a bordo. Para levar o ouro não basta
// chegar perto: é preciso abordar e vencer os piratas que defendiam aquele
// barco. Perdeu, não saqueia — e enterra os próprios mortos.
//
// ── Relação com a ruína de 10 segundos ───────────────────────────────────────
// A ruína (wreck-manager) e o espólio são o MESMO ouro, não dois saques. A
// regra de quanto a vítima perde continua sendo uma só — WRECK_GOLD_PCT, no
// wreck-manager, que é quem sempre soube fazer essa conta. O que muda é o
// recipiente: em zona Red o pote vai para o espólio de 1h em vez da ruína de
// 10s, e o wreck-manager não cria ruína nenhuma ali. Duplicar a conta criaria
// duas penalidades de morte que divergiriam no primeiro rebalanceamento.
//
// O resto do PvP não é tocado: os 5% de XP e de abates continuam indo para o
// assassino em `_creditPvpKill`, em Yellow e em Red, exatamente como antes.
//
// ── Um gesto, e uma surpresa ─────────────────────────────────────────────────
// Abordar é apertar F ao lado do destroço: a batalha corre e, vencendo, o saque
// entra na mesma volta. Não há tela antes nem no meio.
//
// O jogador NÃO sabe quanto tem lá dentro antes de vencer. Só a cor do risco
// (🟢🟡🔴) viaja até ele, e é ela que pinta o destroço no mar. O butim é a
// surpresa que paga a aposta — quem quiser os números depois vai ao Diário do
// capitão, onde o relatório completo fica gravado para sempre.
//
// ── Autoridade ───────────────────────────────────────────────────────────────
// Tudo que importa mora aqui: quem pode abordar, o resultado, quantos morreram,
// quanto tem dentro, quanto saiu e se já foi saqueado. O cliente só desenha.
//
// Protocolo:
//   server → mapa:  spoil_spawn   {id, x, z, ownerName, ownerShip, guildName, ttlMs}
//   server → mapa:  spoil_removed {id, looted, looterName?}
//   server → jog.:  spoil_info    {id, difficulty, difficultyColor, fought}
//   server → jog.:  spoil_raid_result {won, myDeaths, ..., looted, gold}
//   server → jog.:  spoil_error   {reason}
//   cliente → server: spoil_inspect / spoil_raid  {spoilId}
'use strict';

const { sendTo }     = require('../utils/helpers');
const { isSpoilZone } = require('../constants/maps');
const {
  PIRATE_DEFS, SPOIL_TTL_MS, SPOIL_LOOT_RANGE,
} = require('../constants/pirates');
const battle = require('../utils/battle-sim');
const fx     = require('../utils/talent-effects');
const { KINDS } = require('./journal-manager');

class SpoilManager {
  /**
   * @param {Function} sendTo    sendTo(ws, msg)
   * @param {Function} addEvent  broadcast bufferizado por mapa
   * @param {Map}      players   id → player
   * @param {Object}   db        DBManager
   * @param {Object}   journal   JournalManager
   * @param {Object}   pirates   PirateManager
   */
  constructor(sendTo_, addEvent, players, db, journal, pirates) {
    this.sendTo   = sendTo_;
    this.addEvent = addEvent;
    this.players  = players;
    this.db       = db;
    this.journal  = journal;
    this.pirates  = pirates;
    this.spoils   = new Map();   // id → espólio
    this._seq     = 1;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Criação
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Cria o espólio do naufrágio. Chamado por `resolvePlayerDeath` ANTES do
   * wreck-manager, que só cria a ruína de 10s se aqui devolvermos `false`.
   *
   * @param {object} victim
   * @param {number} gold  ouro que a vítima perdeu — a conta é do wreck-manager
   * @returns {boolean} true se o espólio absorveu o naufrágio
   */
  onPlayerDeath(victim, gold) {
    if (!victim || victim.isNPC) return false;
    const lvl = victim.mapLevel || 1;
    if (!isSpoilZone(lvl)) return false;

    // A tripulação do momento do naufrágio é o que o abordador vai enfrentar.
    // Copiada agora: se a vítima renascer e trocar de piratas, o espólio
    // continua guardando quem estava lá quando o barco foi ao fundo.
    const defenders = (victim.pirates || []).slice();

    const id = `spoil_${this._seq++}`;
    const spoil = {
      id,
      mapLevel:  lvl,
      x: victim.x, z: victim.z,
      createdAt: Date.now(),
      expiresAt: Date.now() + SPOIL_TTL_MS,

      ownerId:    victim.id,
      ownerName:  victim.name,
      ownerShip:  victim.activeShip || 'fragata',
      // ── Preparado para Guildas ────────────────────────────────────────────
      // O sistema de guildas não existe ainda. Os campos nascem aqui, viajam
      // até o relatório e são gravados: no dia em que a guilda existir, basta
      // preencher estas duas linhas — o destroço, o relatório e o Diário já
      // sabem carregar a informação.
      ownerGuildId:   victim.guildId   || null,
      ownerGuildName: victim.guildName || '',

      defenders,
      // Muralha de Convés (res_muralha) é lida AGORA, do capitão que afundou:
      // é ele quem treinou aquela tripulação. Congelada no espólio junto com os
      // piratas, para o relatório não depender do build dele meses depois.
      defenderDefPct: fx.pirateDefensePct(victim),
      resources: { gold: Math.max(0, Math.floor(gold || 0)) },

      lootedBy:   null,   // nome de quem saqueou (o espólio morre junto)
      battles:    new Map(),  // playerId → { won, reportId }
      _resolving: false,      // trava de reentrância (ver _guard)
    };

    this.spoils.set(id, spoil);
    this.addEvent({
      type: 'spoil_spawn',
      id, x: spoil.x, z: spoil.z,
      ownerName: spoil.ownerName,
      ownerShip: spoil.ownerShip,
      guildName: spoil.ownerGuildName,
      ttlMs:     SPOIL_TTL_MS,
    }, lvl);

    this.journal.logByName(victim.name, KINDS.SPOIL_CREATED, {
      gold:     spoil.resources.gold,
      pirates:  defenders.length,
      mapLevel: lvl,
    });

    console.log(`🏴 Espólio ${id}: ${victim.name} afundou no mapa ${lvl} com ${spoil.resources.gold} de ouro e ${defenders.length} pirata(s)`);
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Validação comum
  // ═══════════════════════════════════════════════════════════════════════════

  _reject(player, reason) {
    sendTo(player.ws, { type: 'spoil_error', reason });
    return null;
  }

  /**
   * Todas as portas que um pedido de espólio precisa atravessar. Devolve o
   * espólio ou null (com o erro já enviado).
   *
   * `needsCrew` só é exigido de quem vai abordar: inspecionar um espólio sem
   * tripulação é legítimo — é assim que o jogador descobre que precisa de uma.
   */
  _validate(player, spoilId, { needsCrew = false } = {}) {
    if (!player || player.dead) return null;
    const s = this.spoils.get(String(spoilId || ''));
    if (!s)                                  return this._reject(player, 'Este espólio não existe mais.');
    if (s.lootedBy)                          return this._reject(player, 'Este espólio já foi saqueado.');
    if (Date.now() > s.expiresAt)            return this._reject(player, 'Este espólio afundou de vez.');
    if ((player.mapLevel || 1) !== s.mapLevel) return this._reject(player, 'O espólio está em outro mapa.');
    if (Math.hypot(player.x - s.x, player.z - s.z) > SPOIL_LOOT_RANGE) {
      return this._reject(player, 'Aproxime-se do destroço.');
    }
    if (player.id === s.ownerId) {
      return this._reject(player, 'Você não saqueia o próprio naufrágio.');
    }
    if (needsCrew) {
      if (!(player.pirates || []).length) {
        return this._reject(player, 'Sem piratas embarcados não há quem aborde.');
      }
      if (!this.pirates.isActive(player)) {
        return this._reject(player, 'Sua tripulação está sem RUN e não vai abordar.');
      }
    }
    return s;
  }

  /**
   * Modificadores da abordagem: os do atacante saem dos talentos DELE agora, o
   * do defensor veio congelado no espólio quando o barco afundou.
   */
  _modsFor(player, spoil) {
    return {
      attackerOffPct:      fx.pirateBattlePowerPct(player),
      attackerCasualtyPct: fx.pirateCasualtyReductionPct(player),
      defenderDefPct:      spoil?.defenderDefPct || 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Inspeção — o farol 🟢🟡🔴
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handler de `spoil_inspect` — o farol 🟢🟡🔴 e MAIS NADA.
   *
   * O cliente pede quando o jogador chega perto do destroço e usa a resposta só
   * para pintar o marcador no mar. Por isso o que sai daqui é a cor do risco:
   *
   * O BUTIM NÃO VIAJA. Antes este payload trazia `resources`, e o jogador lia o
   * ouro do destroço antes de decidir — a abordagem virava uma conta, não uma
   * aposta. Quanto tem lá dentro só se descobre depois de vencer. Tirar o campo
   * da mensagem (em vez de só não desenhar) é o que torna isso verdade: um
   * cliente modificado não tem de onde ler.
   *
   * A composição inimiga também nunca sai — nem antes, nem agora.
   */
  handleInspect(player, spoilId) {
    const s = this._validate(player, spoilId);
    if (!s) return;

    const est  = battle.estimate(player.pirates || [], s.defenders, this._modsFor(player, s));
    const prev = s.battles.get(player.id) || null;

    sendTo(player.ws, {
      type: 'spoil_info',
      id:   s.id,
      difficulty:      est.difficulty,
      difficultyColor: est.difficultyColor,
      // Já tentou aqui? O marcador apaga o [F] de quem já gastou a chance.
      fought: !!prev,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // A abordagem — um gesto só
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handler de `spoil_raid`. O F do jogador: aborda e, vencendo, saqueia.
   *
   * ── Por que um passo e não dois ───────────────────────────────────────────
   * Havia `spoil_battle` e `spoil_loot` separados, com uma tela entre eles
   * mostrando o butim. Mas ninguém que vence uma abordagem escolhe NÃO saquear:
   * o segundo clique era cerimônia, e a tela no meio contava o que o jogador
   * não deveria saber (ver `handleInspect`). Juntando os dois some junto o
   * estado "venci mas ainda não saqueei", que era a fonte de metade das
   * validações desta classe.
   *
   * ── Uma tentativa por jogador ─────────────────────────────────────────────
   * Perdeu, acabou: sem isso o abordador voltaria com a tripulação restante até
   * a moeda cair do lado dele, e o risco da zona Red viraria uma taxa.
   *
   * ── Atomicidade ───────────────────────────────────────────────────────────
   * Dois `spoil_raid` do mesmo socket podem chegar colados. O registro em
   * `battles` acontece ANTES de qualquer `await`, então o segundo já encontra a
   * tentativa gasta; e o saque apaga o espólio do mapa na mesma volta síncrona.
   * O `_resolving` fecha a janela equivalente entre dois jogadores abordando no
   * mesmo tique.
   */
  handleRaid(player, spoilId) {
    const s = this._validate(player, spoilId, { needsCrew: true });
    if (!s) return;
    if (s._resolving) return this._reject(player, 'O destroço já está sendo abordado.');
    if (s.battles.has(player.id)) {
      return this._reject(player, 'Sua tripulação já foi rechaçada neste destroço.');
    }

    s._resolving = true;
    try {
      const result = this._resolveBattle(player, s);
      // Vencer e saquear são o mesmo instante: nada acontece entre os dois.
      const looted = result.attackerWon ? this._takeLoot(player, s) : null;

      sendTo(player.ws, {
        type: 'spoil_raid_result',
        id:   s.id,
        won:  result.attackerWon,
        difficulty:      result.difficulty,
        difficultyColor: result.difficultyColor,
        myDeaths:        result.attacker.deaths,
        mySurvivors:     result.attacker.survivors.length,
        enemyDeaths:     result.defender.deaths,
        enemySurvivors:  result.defender.survivors.length,
        // Só de quem venceu — e é AQUI que o jogador descobre quanto havia.
        looted,
        gold:    player.gold,
        dobroes: player.dobroes,
      });

      this.pirates.sendState(player);
      console.log(`🏴 Abordagem ${s.id}: ${player.name} ${result.attackerWon ? 'VENCEU' : 'perdeu'} (${result.difficulty}, r=${result.finalRatio}) — ${result.attacker.deaths} baixas contra ${result.defender.deaths}${looted ? ` · saque ${looted.gold || 0}` : ''}`);
    } finally {
      s._resolving = false;
    }
  }

  /**
   * Simula a abordagem, enterra os mortos dos dois lados e grava o relatório.
   * Não fala com o cliente: quem monta a resposta é o `handleRaid`.
   */
  _resolveBattle(player, s) {
    const result = battle.simulate({
      attackerIds:  (player.pirates || []).slice(),
      defenderIds:  s.defenders.slice(),
      seed:         battle.newSeed(),
      mods:         this._modsFor(player, s),
    });

    // Reserva a tentativa antes de qualquer I/O.
    s.battles.set(player.id, { won: result.attackerWon, reportId: null });

    // ── Mortes permanentes ───────────────────────────────────────────────────
    // Do atacante saem do alistamento dele. Do defensor saem do ESPÓLIO: o
    // barco já afundou, aqueles piratas são uma lembrança — quem os enterra é o
    // próximo abordador, que encontra a defesa mais fraca.
    this.pirates.killPirates(player, result.attacker.dead);
    s.defenders = result.defender.survivors.slice();

    if (result.attackerWon) s.wonBy = player.id;

    this._persistReport(player, s, this._buildReport(player, s, result), result);
    return result;
  }

  /** O relatório imutável: o estado da batalha no instante em que ela ocorreu. */
  _buildReport(player, s, result) {
    const label = (ids) => {
      const counts = {};
      for (const id of ids) counts[id] = (counts[id] || 0) + 1;
      return Object.entries(counts).map(([id, n]) => ({
        id, n, name: PIRATE_DEFS[id]?.name || id, icon: PIRATE_DEFS[id]?.icon || '🏴',
      }));
    };
    return {
      at:   Date.now(),
      seed: result.seed,

      attackerName: player.name,
      defenderName: s.ownerName,
      defenderShip: s.ownerShip,
      guildName:    s.ownerGuildName,   // reservado para Guildas
      mapLevel:     s.mapLevel,

      won:             result.attackerWon,
      difficulty:      result.difficulty,
      difficultyColor: result.difficultyColor,

      // Os números que explicam o resultado — é o que o jogador procura quando
      // acha que perdeu sem motivo.
      attackPower:  result.attackPower,
      defensePower: result.defensePower,
      baseRatio:    result.baseRatio,
      luck:         result.luck,
      finalRatio:   result.finalRatio,

      attacker: {
        count:     result.attacker.count,
        used:      label(result.attacker.used),
        deaths:    result.attacker.deaths,
        dead:      label(result.attacker.dead),
        survivors: result.attacker.survivors.length,
        lossPct:   result.attacker.lossPct,
      },
      defender: {
        count:     result.defender.count,
        used:      label(result.defender.used),
        deaths:    result.defender.deaths,
        dead:      label(result.defender.dead),
        survivors: result.defender.survivors.length,
        lossPct:   result.defender.lossPct,
      },

      resourcesAvailable: { ...s.resources },
      resourcesLooted:    null,   // preenchido pelo saque, se houver
    };
  }

  /**
   * Grava o relatório e o Diário dos dois lados.
   *
   * Guarda a PROMESSA em `s._reportReady` porque o saque pode chegar antes do
   * INSERT terminar: quem vence e clica em saquear no mesmo instante ficaria
   * com um relatório sem a linha "recursos saqueados", que é justamente o
   * fecho do documento. O `handleLoot` espera esta promessa antes de anexar.
   */
  _persistReport(player, s, report, result) {
    s._reportReady = this.db.saveBattleReport(report)
      .then(reportId => {
        const entry = s.battles.get(player.id);
        if (entry) entry.reportId = reportId;
        s.lastReportId = reportId;

        this.journal.log(player, KINDS.SPOIL_BATTLE, {
          won:         result.attackerWon,
          difficulty:  result.difficulty,
          opponent:    s.ownerName,
          myDeaths:    result.attacker.deaths,
          enemyDeaths: result.defender.deaths,
        }, reportId);

        if (result.attacker.deaths > 0) {
          this.journal.log(player, KINDS.PIRATES_LOST, {
            n: result.attacker.deaths, where: 'espolio',
          }, reportId);
        }

        this.journal.logByName(s.ownerName, KINDS.SPOIL_BATTLE, {
          won:         !result.attackerWon,
          defending:   true,
          difficulty:  result.difficulty,
          opponent:    player.name,
          myDeaths:    result.defender.deaths,
          enemyDeaths: result.attacker.deaths,
        }, reportId);

        // O `battle_report_id` que ia daqui não tem mais quem o ouça: existia
        // para destravar o botão "Relatório" do painel de espólio, e o painel
        // não abre mais na abordagem. A entrada do Diário já viaja com o
        // `reportId` dentro (ver journal.log logo acima), que é por onde o
        // jogador chega ao documento.
        return reportId;
      })
      .catch(e => {
        console.error('[Espólio] falha ao gravar relatório:', e.message);
        return null;
      });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Saque
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Esvazia o destroço para quem acabou de vencer. Chamado SÓ pelo `handleRaid`,
   * no mesmo instante da vitória — o jogador não pede o saque, ele acontece.
   *
   * A ordem das linhas é a garantia contra duplicação: `lootedBy` e o
   * `spoils.delete` acontecem antes de qualquer `await`, então um segundo raid
   * que chegue no mesmo tique encontra o espólio já fora do mapa. O `db.save`
   * vem depois e não abre janela nenhuma.
   *
   * @returns {Object} o que saiu do destroço, já com o talento aplicado
   */
  _takeLoot(player, s) {
    // Talento de saque (res_saqueador): aumenta o que sai do destroço.
    const mult = 1 + fx.spoilLootPct(player);
    const looted = {};
    for (const [key, val] of Object.entries(s.resources)) {
      looted[key] = Math.floor(val * mult);
    }

    // ── Ponto de não retorno ────────────────────────────────────────────────
    s.lootedBy = player.name;
    this.spoils.delete(s.id);

    player.gold = (player.gold || 0) + (looted.gold || 0);

    this.addEvent({
      type: 'spoil_removed', id: s.id,
      looted: true, looterId: player.id, looterName: player.name,
    }, s.mapLevel);

    sendTo(player.ws, {
      type: 'currency_update',
      gold: player.gold, dobroes: player.dobroes,
      reward: { type: 'gold', amount: looted.gold || 0 },
    });

    // O id do relatório está SEMPRE a caminho do banco quando chegamos aqui: a
    // batalha acabou de acontecer, no mesmo tique, e o INSERT é assíncrono.
    // Esperar a promessa é seguro — o espólio já saiu do mapa lá em cima, e é só
    // o Diário e o anexo do saque que dependem deste número.
    Promise.resolve(s._reportReady || null).then(reportId => {
      const rid = reportId || null;
      if (rid) {
        this.db.updateBattleReportLoot(rid, looted)
          .catch(e => console.error('[Espólio] falha ao anexar o saque ao relatório:', e.message));
      }
      this.journal.log(player, KINDS.SPOIL_LOOTED, {
        opponent: s.ownerName, resources: looted,
      }, rid);
      this.journal.logByName(s.ownerName, KINDS.SPOIL_LOOTED, {
        lost: true, opponent: player.name, resources: looted,
      }, rid);
      // A linha narrada acima conta a HISTÓRIA; esta entra no extrato, para o
      // ouro do saque somar nos ganhos de quem saqueou.
      //
      // Só do lado do SAQUEADOR. O dono já pagou quando afundou — o ouro do
      // espólio é o mesmo pote que o wreck-manager tirou dele e registrou como
      // `wreck_death`. Debitar de novo aqui cobraria a perda duas vezes no
      // extrato dele; a linha narrada `spoil_looted` é que o avisa do saque.
      this.journal.ledger(player, 'spoil_loot',
        { gold: looted.gold || 0 }, { target: s.ownerName });
    });

    this.db.save(player, true).catch(e => console.error('Save error:', e));
    return looted;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Ciclo de vida
  // ═══════════════════════════════════════════════════════════════════════════

  /** Expira espólios — chamar a cada tique do game loop. */
  update(now) {
    if (this.spoils.size === 0) return;
    for (const [id, s] of this.spoils) {
      if (now > s.expiresAt) {
        this.spoils.delete(id);
        this.addEvent({ type: 'spoil_removed', id, looted: false }, s.mapLevel);
      }
    }
  }

  /** Espólios vivos de um mapa — para quem entra no meio da hora. */
  snapshot(mapLevel) {
    const now = Date.now();
    const out = [];
    this.spoils.forEach(s => {
      if (s.mapLevel === mapLevel && !s.lootedBy && now < s.expiresAt) {
        out.push({
          id: s.id, x: s.x, z: s.z,
          ownerName: s.ownerName, ownerShip: s.ownerShip,
          guildName: s.ownerGuildName,
          ttlMs: s.expiresAt - now,
        });
      }
    });
    return out;
  }
}

module.exports = SpoilManager;
