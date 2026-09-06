// managers/island-manager.js — Ilhas de guilda: torres, conquista e imposto
//
// ── O que este manager governa ───────────────────────────────────────────────
//   • TORRES     nascem, atiram, caem e renascem; as neutras são hostis a todos
//   • CONQUISTA  as 5 caíram → leva a ilha quem somou mais dano nelas
//   • GRAÇA      a vencedora tem 10 min para erguer a primeira torre, ou passa
//   • DOMÍNIO    construir e reparar torres com o cofre da guilda
//   • IMPOSTO    uma fatia do que se gasta na praça que a ilha governa
//   • SEMANA     depois da coleta tudo volta a zero e a disputa recomeça
//
// Os números todos moram em constants/islands.js. Aqui só há regra.
//
// ── Por que a torre é uma entidade do mundo, e não um "lugar" ────────────────
// A torre precisa levar tiro de canhão, aparecer no `state` com barra de vida,
// morrer e dar dano. Tudo isso o jogo já sabe fazer com NPC — então a torre
// ENTRA no registro de NPCs (o `extraNpcs` do server.js, o mesmo dos pets
// selvagens) e ganha de graça a detecção de colisão de projétil, o AOI e a
// placa de nome.
//
// O que ela NÃO pode herdar é a MORTE de um NPC: cair uma torre não paga ouro,
// não conta para o chefe do mapa e não chama respawnScaled. Por isso o
// projectile-manager tem um ramo `isTower` ANTES do ramo de NPC comum, e é ele
// que chama o onTowerDestroyed daqui. Sem esse ramo a torre pagaria espólio de
// caçada e tentaria renascer pelo manager errado.
//
// ── O dano é creditado à GUILDA, não ao jogador ──────────────────────────────
// A conquista é da irmandade. Quem bate sem guilda bate de graça: derruba a
// torre e não leva a ilha. É o que faz a guerra de ilha ser coisa de guilda em
// vez de um caçador solitário com um navio bom.
//
// Cliente envia:  island_info, island_build, island_repair
// Servidor envia: island_state, island_error, island_ok, island_notice
'use strict';

const { mitigateForPlayer } = require('../utils/player-defense');
const shield = require('../utils/shield');
const { isSafeAfterRespawn } = require('../utils/invincibility');
const {
  TOWER_TYPES, TOWER_SLOTS, TOWER_RANGE, TOWER_FIRE_MS, TOWER_RESPAWN_MS,
  towerSlotPos, rollTowerType,
  REPAIR_CALM_MS, REPAIR_PCT_PER_MIN, repairGoldPerHp,
  GRACE_MS, MAX_ISLANDS_PER_GUILD_PER_WEEK,
  taxPctFor,
  ISLAND_DEFS, ISLAND_BY_MAP, ISLAND_BY_VENUE, ACTION_VENUE, VENUE_ACTIONS,
  weekKey, nextEventAt,
} = require('../constants/islands');

/**
 * Raio de acerto da torre. Ela é grande — errar de perto seria estranho.
 *
 * Acompanha TOWER_SCALE: o modelo tem ~1 unidade de largura, então na escala 78
 * a torre ocupa ~38 de raio na tela. Deixar o raio em 16 com um desenho três
 * vezes maior faria a bala atravessar a pedra à vista de todo mundo.
 */
const TOWER_HIT_RADIUS = 48;
/**
 * Escala e altura do modelo no cliente (assets/torres).
 *
 * 78 = os 26 originais × 3: a torre precisa ser vista do mar, e no tamanho
 * antigo ela sumia ao lado de um galeão. Quem realmente aplica a escala é o
 * `_PLACES` do cliente (scripts/model_loader.gd) — este valor viaja no
 * snapshot e existe para o editor de lugares e para o dia em que o cliente
 * voltar a ler a escala do servidor. Os DOIS precisam mudar juntos.
 */
const TOWER_SCALE    = 78;
const TOWER_Y_OFFSET = 4;

/** Passo do tique de torres/graça. Não precisa de 62 Hz: a salva é de 2s. */
const TICK_MS = 500;
/** Passo da varredura de reparo. Um por minuto é a granularidade do 1%/min. */
const REPAIR_TICK_MS = 60 * 1000;

class IslandManager {
  /**
   * @param {Function} sendToFn      sendTo(ws, msg)
   * @param {Function} addEventFn    addEvent(evt, mapLevel)
   * @param {Map}      players       id → player do server.js
   * @param {Object}   db            DBManager
   * @param {Object}   guildManager  GuildManager
   * @param {Object}   journal       JournalManager
   * @param {Object}   SRC           JournalManager.SRC
   */
  constructor(sendToFn, addEventFn, players, db, guildManager, journal, SRC) {
    this.send     = sendToFn;
    this.addEvent = addEventFn;
    this.players  = players;
    this.db       = db;
    this.guilds   = guildManager;
    this.journal  = journal;
    this.SRC      = SRC;

    this.islands = new Map();      // islandId → estado
    this.towers  = new Map();      // towerId  → entidade viva
    this._tickAcc   = 0;
    this._repairAcc = 0;

    /** Injetado pelo server.js: registra/remove a torre no registro de NPCs. */
    this.registerEntity   = null;  // (id, entity) => void
    this.unregisterEntity = null;  // (id) => void
    /** Injetado pelo server.js: uid() para o id da entidade. */
    this.uid = null;
    /** Injetado pelo server.js: o TaxBoatManager (o evento semanal). */
    this.taxBoat = null;
    /** Injetados pelo server.js: as defesas do jogador dependem dos dois.
     *  O PartyManager conta os companheiros na zona (talentos de grupo) e o
     *  PetManager intercepta o golpe com a relíquia defensiva do bicho. Sem
     *  eles a conta ainda fecha — só sem essas duas parcelas. */
    this.partyManager = null;
    this.petManager   = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Ciclo de vida
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Carrega as três ilhas e põe as torres no mundo. Precisa de await no boot:
   * antes disto o mapa da ilha existe sem torre nenhuma, e o primeiro jogador a
   * chegar conquistaria uma ilha vazia sem dar um tiro.
   */
  async init() {
    const salvas = await this.db.loadIslands();
    const agora  = Date.now();

    for (const def of Object.values(ISLAND_DEFS)) {
      let ilha = salvas.get(def.id);
      if (!ilha) {
        ilha = this._novaIlha(def, agora);
        await this.db.upsertIsland(ilha);
      }
      ilha.def = def;
      // A tabela de constants/islands.js manda, inclusive sobre o que já estava
      // salvo — ver _reconciliarTorres.
      this._reconciliarTorres(ilha);
      this.islands.set(def.id, ilha);
    }

    // A semana pode ter virado com o servidor fora do ar.
    await this._checkWeeklyReset(agora);

    // Ergue no mundo as torres que a linha do banco descreve. Uma torre neutra
    // cujo respawn venceu offline nasce agora, e não daqui a 30 minutos.
    for (const ilha of this.islands.values()) this._syncTowers(ilha, agora);

    for (const ilha of this.islands.values()) {
      if (!ilha.nextEventAt || ilha.nextEventAt <= agora) {
        ilha.nextEventAt = nextEventAt(ilha.id, agora);
        await this.db.upsertIsland(ilha);
      }
    }

    const donas = [...this.islands.values()].filter(i => i.ownerGuildId).length;
    console.log(`🏝 ${this.islands.size} ilha(s) de guilda, ${this.towers.size} torre(s) no mar` +
                (donas ? `, ${donas} com dono` : ', nenhuma com dono'));
  }

  destroy() {
    for (const id of [...this.towers.keys()]) this._removeTowerEntity(id);
    this.towers.clear();
  }

  _novaIlha(def, agora) {
    return {
      id: def.id, mapLevel: def.mapLevel,
      state: 'neutral',
      ownerGuildId: null, ownerSince: 0,
      graceUntil: 0, conqueredWeek: null,
      taxPot: 0,
      nextEventAt: nextEventAt(def.id, agora),
      lastEventWeek: null,
      towers: this._sortearTorres(agora),
      damageRank: {},
    };
  }

  /** Cinco slots com tipo sorteado — o estado "default" da ilha. */
  _sortearTorres(agora) {
    const out = [];
    for (let i = 0; i < TOWER_SLOTS; i++) {
      const tipo = rollTowerType();
      const def  = TOWER_TYPES[tipo];
      out.push({
        slot: i, type: tipo,
        hp: def.hp, maxHp: def.hp,
        dead: false, respawnAt: 0,
        lastDamageAt: 0,
        built: false,          // false = torre neutra sorteada; true = erguida pela guilda
        _bornAt: agora,
      });
    }
    return out;
  }

  /**
   * Alinha as torres NEUTRAS salvas com a tabela de constants/islands.js.
   *
   * ── Por que isto precisa existir ───────────────────────────────────────────
   * Os cinco slots são gravados no banco como JSON, com `hp` e `maxHp` dentro.
   * Mudar `TOWER_TYPES.fraca.hp` no arquivo não mexia em NADA que já estivesse
   * salvo: as torres continuavam com a vida da versão anterior até a próxima
   * semana, e quem tinha acabado de rebalancear via o número antigo no jogo sem
   * nenhuma pista do motivo. "Os números moram em constants/islands.js" só é
   * verdade com esta reconciliação no boot.
   *
   * A vida é REESCALADA, não zerada: uma torre pela metade continua pela
   * metade. E torre ERGUIDA PELA GUILDA (`built`) fica de fora — o `maxHp` dela
   * tem a skill Muralha da Ilha somada por dentro (ver handleBuild), foi paga
   * com o cofre, e a tabela não sabe disso.
   */
  _reconciliarTorres(ilha) {
    for (const slot of ilha.towers || []) {
      if (slot.built) continue;
      const def = TOWER_TYPES[slot.type];
      if (!def || slot.maxHp === def.hp) continue;

      const fracao = slot.maxHp > 0 ? (slot.hp || 0) / slot.maxHp : 1;
      slot.maxHp = def.hp;
      slot.hp    = slot.dead ? 0 : Math.max(1, Math.round(def.hp * fracao));
      console.log(`🗼 ${ilha.def.name}: torre ${slot.slot + 1} (${slot.type}) ` +
                  `realinhada com a tabela — ${def.hp.toLocaleString('pt-BR')} de vida`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Entidades das torres no mundo
  // ═══════════════════════════════════════════════════════════════════════════

  /** Põe no mundo as torres vivas da ilha e tira as que caíram. */
  _syncTowers(ilha, agora) {
    for (const slot of ilha.towers) {
      // Respawn de torre NEUTRA: só enquanto a ilha não tem dono (pedido).
      if (slot.dead && !ilha.ownerGuildId && slot.respawnAt && agora >= slot.respawnAt) {
        this._renascerSlot(ilha, slot, agora);
      }
      const viva = !slot.dead;
      const ent  = this._towerEntity(ilha.id, slot.slot);
      if (viva && !ent)  this._spawnTowerEntity(ilha, slot);
      if (!viva && ent)  this._removeTowerEntity(ent.id);
    }
  }

  /** Torre neutra volta com tipo NOVO — é um sorteio a cada renascimento. */
  _renascerSlot(ilha, slot, agora) {
    const tipo = rollTowerType();
    const def  = TOWER_TYPES[tipo];
    slot.type = tipo;
    slot.hp = def.hp; slot.maxHp = def.hp;
    slot.dead = false; slot.respawnAt = 0;
    slot.lastDamageAt = 0;
    slot.built = false;
    slot._bornAt = agora;
  }

  _towerEntity(islandId, slot) {
    for (const t of this.towers.values()) {
      if (t.islandId === islandId && t.slot === slot) return t;
    }
    return null;
  }

  _spawnTowerEntity(ilha, slot) {
    const def = TOWER_TYPES[slot.type] || TOWER_TYPES.fraca;
    const pos = towerSlotPos(slot.slot);
    const id  = this.uid ? this.uid() : `t${ilha.id}_${slot.slot}_${Date.now()}`;

    const ent = {
      id,
      // `isNPC` faz o cliente e o AOI tratarem a torre como entidade de mundo;
      // `isTower` é o que separa a morte dela da morte de um bicho.
      isNPC: true, isTower: true,
      islandId: ilha.id, slot: slot.slot, towerType: slot.type,
      name: def.name,
      x: pos.x, y: 0, z: pos.z, rotation: 0, speed: 0,
      hp: slot.hp, maxHp: slot.maxHp,
      dead: false,
      mapLevel: ilha.mapLevel,
      npcModel:  def.model,
      npcScale:  TOWER_SCALE,
      npcYOffset: TOWER_Y_OFFSET,
      npcRotOffset: 0,
      hitRadius: TOWER_HIT_RADIUS,
      // O slot manda: uma torre erguida por guilda guardou nele a vida e o dano
      // JÁ com as skills de ilha somadas (ver handleBuild). A tabela é só o
      // piso, usado pelas torres neutras sorteadas.
      damage: slot.damage || def.damage,
      // Torre erguida por guilda não atira em quem veste a bandeira dela.
      ownerGuildId: ilha.ownerGuildId || null,
      _nextShot: 0,
    };
    this.towers.set(id, ent);
    if (this.registerEntity) this.registerEntity(id, ent);
    return ent;
  }

  _removeTowerEntity(id) {
    this.towers.delete(id);
    if (this.unregisterEntity) this.unregisterEntity(id);
  }

  /** Snapshot das torres deste mapa para entrar no `state` da zona. */
  snapshotFor(zone) {
    const out = [];
    for (const t of this.towers.values()) {
      if (t.mapLevel !== zone || t.dead) continue;
      out.push({
        id: t.id, name: t.name,
        x: t.x, y: t.y, z: t.z, rotation: t.rotation, speed: 0,
        hp: t.hp, maxHp: t.maxHp, dead: false,
        isNPC: true, isTower: true,
        towerType: t.towerType, islandId: t.islandId, slot: t.slot,
        mapLevel: t.mapLevel,
        npcModel: t.npcModel, npcScale: t.npcScale,
        npcYOffset: t.npcYOffset, npcRotOffset: 0,
        ownerGuildId: t.ownerGuildId || null,
      });
    }
    return out;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Tique — tiro das torres, respawn, prazo de graça
  // ═══════════════════════════════════════════════════════════════════════════

  update(now, dt) {
    this._tickAcc += dt * 1000;
    if (this._tickAcc >= TICK_MS) {
      this._tickAcc = 0;
      this._tickTowers(now);
      this._tickGrace(now);
      for (const ilha of this.islands.values()) this._syncTowers(ilha, now);
    }

    this._repairAcc += dt * 1000;
    if (this._repairAcc >= REPAIR_TICK_MS) {
      this._repairAcc = 0;
      this._tickRepair(now);
    }
  }

  /**
   * Cada torre viva escolhe o alvo MAIS PRÓXIMO dentro de TOWER_RANGE e dispara
   * a cada TOWER_FIRE_MS. Torre de guilda poupa quem veste a bandeira dela;
   * torre neutra não poupa ninguém.
   */
  _tickTowers(now) {
    if (!this.towers.size) return;

    // Índice de jogadores por mapa — as torres de uma ilha só olham o mapa dela,
    // e varrer `players` por torre daria 5 varreduras por ilha por tique.
    const porMapa = new Map();
    this.players.forEach(p => {
      if (!p || p.dead || p.afkTraining) return;
      const z = p.mapLevel || 1;
      let arr = porMapa.get(z);
      if (!arr) { arr = []; porMapa.set(z, arr); }
      arr.push(p);
    });

    for (const torre of this.towers.values()) {
      if (torre.dead) continue;
      const candidatos = porMapa.get(torre.mapLevel);
      if (!candidatos || !candidatos.length) continue;
      if (now < (torre._nextShot || 0)) continue;

      let alvo = null;
      let melhor = TOWER_RANGE * TOWER_RANGE;
      for (const p of candidatos) {
        // Dona da ilha não leva tiro da própria muralha.
        if (torre.ownerGuildId && this._guildIdOf(p) === torre.ownerGuildId) continue;
        if (isSafeAfterRespawn(p, now)) continue;   // imunidade pós-respawn
        const dx = p.x - torre.x, dz = p.z - torre.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < melhor) { melhor = d2; alvo = p; }
      }
      if (!alvo) continue;

      torre._nextShot = now + TOWER_FIRE_MS;
      this._dispararTorre(torre, alvo, now);
    }
  }

  /**
   * A salva de UMA torre num alvo.
   *
   * ── O dano da torre NÃO é fixo ─────────────────────────────────────────────
   * `torre.damage` é o golpe BRUTO — o mesmo papel que o `cannonDmg` tem no
   * ataque de um bicho. O que chega no casco passa pelas defesas do jogador
   * (esquiva, redução de talento, casco da ilha, redução plana, Escudo de Ouro,
   * Carapaça Eriçada, pet), pela mesma pilha e na mesma ordem do resto do jogo
   * — ver utils/player-defense.js.
   *
   * Antes disto a torre tirava um número fixo da vida: trinta mil, sempre,
   * contra qualquer barco. Quem tivesse comprado meio kit defensivo tomava
   * exatamente o mesmo que o novato, e nada no jogo dizia por quê.
   */
  _dispararTorre(torre, alvo, now) {
    const bruto = Math.max(0, Math.round(torre.damage || 0));
    if (bruto <= 0) return;

    // A geometria do tiro vai para o mapa inteiro ANTES de qualquer coisa: a
    // torre atirou, e ela atirou mesmo que o barco desvie. `tower_fire` é só
    // "de onde para onde" — a vida do alvo é assunto dele, e é por isso que ela
    // viaja separada, no `tower_shot` privado logo abaixo.
    this.addEvent?.({
      type: 'tower_fire', towerId: torre.id, targetId: alvo.id,
      x: torre.x, z: torre.z, targetX: alvo.x, targetZ: alvo.z,
    }, torre.mapLevel);

    const def = mitigateForPlayer(alvo, bruto, {
      fromNPC:     true,          // a torre é do lado do bicho, não do jogador
      fromTower:   true,          // e é torre: liga o Escudo de Assédio
      allyCount:   this.partyManager
        ? this.partyManager.getPartyMembersInZone(alvo.id, alvo.mapLevel || 1, this.players).length
        : 0,
      petManager:  this.petManager,
      now,
    });

    // Desviou ou o escudo comeu o golpe: o mapa vê o mesmo recado que vê no
    // tiro de qualquer bicho, e a torre não tira vida nenhuma.
    if (def.dodged) {
      this.addEvent?.({ type: 'dodge', targetId: alvo.id }, torre.mapLevel);
      return;
    }
    if (def.goldCost > 0) {
      this.send(alvo.ws, { type: 'gold_shield_cost', targetId: alvo.id,
                           goldCost: def.goldCost, gold: alvo.gold });
      this.journal?.accrue(alvo, 'gold_shield', { gold: -def.goldCost });
    }
    // A Carapaça Eriçada devolve na pedra o que aparou. A torre é entidade de
    // mundo com vida: o reflexo conta como dano de verdade, e por isso passa
    // pelo mesmo registro de dano do canhão — quem tanka a muralha da ilha
    // credita a guilda dele na conquista, como quem atira nela.
    if (def.reflected > 0 && !torre.dead) {
      this._danoNaTorre(torre, alvo, def.reflected);
    }
    if (def.blocked) {
      this.addEvent?.({ type: 'shield_block', targetId: alvo.id }, torre.mapLevel);
      return;
    }

    const dano = def.damage;
    if (dano <= 0) return;

    alvo.hp = Math.max(0, alvo.hp - shield.absorb(alvo, dano).dmg);
    alvo.lastCombatTime = now;

    // O cliente já sabe desenhar `tower_shot` (a torre do campo de treino usa a
    // mesma mensagem) — reaproveitar evita um VFX novo para o mesmo evento.
    // x/z são os da TORRE: é de lá que a bala sai na tela.
    this.send(alvo.ws, {
      type: 'tower_shot', damage: dano, hp: alvo.hp, maxHp: alvo.maxHp,
      x: torre.x, z: torre.z, towerId: torre.id,
      targetX: alvo.x, targetZ: alvo.z,
    });

    if (alvo.hp <= 0 && !alvo.dead) {
      // A morte em si é resolvida pelo caminho único do servidor
      // (resolvePlayerDeath), injetado como callback: a torre não sabe — nem
      // precisa saber — o que uma morte desencadeia (espólio, ruína, respawn).
      if (this.onPlayerKilled) this.onPlayerKilled(alvo, null, { byTower: true });
    }
  }

  /**
   * Dano numa torre vindo de FORA do canhão (hoje: o reflexo da Carapaça
   * Eriçada). O caminho do tiro faz isto por dentro do projectile-manager —
   * registra o dano, e se a torre cair, avisa o mapa e chama onTowerDestroyed.
   * Quem bate por outro caminho precisa fazer o mesmo, ou a torre fica com 0 de
   * vida e continua de pé atirando.
   */
  _danoNaTorre(torre, autor, dano) {
    const d = Math.max(0, Math.round(dano));
    if (!d || torre.dead) return;

    torre.hp = Math.max(0, torre.hp - d);
    this.recordTowerDamage(torre, autor, d);
    this.addEvent?.({
      type: 'bulwark_reflect', targetId: autor.id,
      shooterId: torre.id, dmg: d, hp: torre.hp,
    }, torre.mapLevel);

    if (torre.hp > 0) return;
    torre.dead = true;
    this.addEvent?.({ type: 'entity_dead', id: torre.id, isNPC: true,
                      isTower: true, killerId: autor.id }, torre.mapLevel);
    this.onTowerDestroyed(torre, autor);
  }

  /** Prazo de graça vencido → a ilha passa para a próxima do ranking de dano. */
  _tickGrace(now) {
    for (const ilha of this.islands.values()) {
      if (ilha.state !== 'grace' || now < ilha.graceUntil) continue;
      // Ergueu alguma torre dentro do prazo? Então virou domínio de verdade.
      if (ilha.towers.some(t => t.built && !t.dead)) {
        ilha.state = 'owned';
        ilha.graceUntil = 0;
        this._save(ilha);
        this._broadcastIsland(ilha);
        continue;
      }
      this._passarAoProximo(ilha, now);
    }
  }

  /**
   * Reparo: 1% da vida por minuto, só em torre com 5 minutos sem levar dano, e
   * cobrando o ouro do cofre da guilda. Todo membro pode reparar — o pedido é
   * explícito nisso, e é o que dá aos membros comuns um papel na defesa.
   *
   * O reparo é AUTOMÁTICO por tique enquanto houver ouro no cofre: pedir um
   * clique por minuto por torre seria trabalho de escritório, não de jogo. Quem
   * dispara é o comando `island_repair`, que liga/desliga o conserto da ilha.
   */
  _tickRepair(now) {
    for (const ilha of this.islands.values()) {
      if (!ilha.ownerGuildId || !ilha.repairing) continue;
      const guilda = this.guilds?.guilds?.get(ilha.ownerGuildId);
      if (!guilda) continue;

      let gastou = 0;
      let curou  = false;
      for (const slot of ilha.towers) {
        if (slot.dead || slot.hp >= slot.maxHp) continue;
        if (now - (slot.lastDamageAt || 0) < REPAIR_CALM_MS) continue;

        // Estaleiro da Ilha: acelera o conserto, e SÓ ele — o ouro por ponto de
        // vida continua o mesmo, então consertar mais rápido custa mais caro
        // por minuto. A skill compra tempo, não desconto.
        const acel   = 1 + Math.max(0, Number(this.guilds?._skillPct?.(guilda, 'tower_repair_pct') || 0));
        const cura   = Math.max(1, Math.round(slot.maxHp * REPAIR_PCT_PER_MIN * acel));
        const falta  = slot.maxHp - slot.hp;
        const real   = Math.min(cura, falta);
        const custo  = Math.ceil(real * repairGoldPerHp(slot.type));
        if ((guilda.gold || 0) - gastou < custo) continue;

        slot.hp += real;
        gastou  += custo;
        curou    = true;

        const ent = this._towerEntity(ilha.id, slot.slot);
        if (ent) { ent.hp = slot.hp; ent.maxHp = slot.maxHp; }
      }

      if (!curou) continue;
      guilda.gold = Math.max(0, (guilda.gold || 0) - gastou);
      this.db.upsertGuild(guilda).catch(() => {});
      this._save(ilha);
      this._broadcastIsland(ilha);
      this._noticeGuild(ilha, `🔧 Reparo das torres: −${gastou.toLocaleString('pt-BR')} 🪙 do cofre.`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Dano e queda
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Registra dano numa torre. Chamado pelo projectile-manager a cada acerto.
   * O crédito é da GUILDA de quem atirou — quem não tem guilda bate de graça.
   */
  recordTowerDamage(torre, atirador, dano) {
    if (!torre || !torre.isTower || !(dano > 0)) return;
    const ilha = this.islands.get(torre.islandId);
    if (!ilha) return;

    const slot = ilha.towers[torre.slot];
    if (slot) {
      slot.hp = Math.max(0, torre.hp);
      slot.lastDamageAt = Date.now();
    }
    // Levar dano cancela o conserto em andamento — "cura apenas fora de
    // combate" é a regra, e ela vale para a ilha inteira enquanto a briga corre.
    ilha._lastFightAt = Date.now();

    const gid = this._guildIdOf(atirador);
    if (!gid) return;
    const g = this.guilds?.guilds?.get(gid);
    const r = ilha.damageRank[gid] || { name: g?.name || '?', tag: g?.tag || '?', damage: 0 };
    r.damage += Math.round(dano);
    r.name = g?.name || r.name;
    r.tag  = g?.tag  || r.tag;
    ilha.damageRank[gid] = r;
  }

  /**
   * Uma torre caiu. Chamado pelo projectile-manager no lugar do caminho de morte
   * de NPC comum (a torre não paga espólio de caçada).
   */
  onTowerDestroyed(torre, matador) {
    const ilha = this.islands.get(torre.islandId);
    this._removeTowerEntity(torre.id);
    if (!ilha) return;

    const agora = Date.now();
    const slot  = ilha.towers[torre.slot];
    if (slot) {
      slot.hp = 0;
      slot.dead = true;
      slot.built = false;
      // Torre de ilha DOMINADA não renasce sozinha — a guilda ergue outra.
      slot.respawnAt = ilha.ownerGuildId ? 0 : agora + TOWER_RESPAWN_MS;
    }

    this.addEvent?.({
      type: 'island_tower_down', islandId: ilha.id,
      slot: torre.slot, towerType: torre.towerType,
      x: torre.x, z: torre.z,
    }, ilha.mapLevel);

    const restantes = ilha.towers.filter(t => !t.dead).length;
    this._broadcastMap(ilha, {
      type: 'island_notice',
      message: `🗼 Torre ${torre.slot + 1} de ${ilha.def.name} caiu! Restam ${restantes}.`,
    });

    if (restantes === 0) this._resolverConquista(ilha, agora, matador);

    this._save(ilha);
    this._broadcastIsland(ilha);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Conquista
  // ═══════════════════════════════════════════════════════════════════════════

  /** Ranking de dano em ordem decrescente: [{guildId, name, tag, damage}]. */
  _ranking(ilha) {
    return Object.entries(ilha.damageRank)
      .map(([guildId, r]) => ({ guildId, ...r }))
      .sort((a, b) => b.damage - a.damage);
  }

  /**
   * As cinco caíram. Entrega a ilha a quem somou mais dano e que ainda PODE
   * tomar uma ilha esta semana. Quem já tem uma é pulado — o pedido é explícito:
   * defender a sua é livre, tomar a segunda não.
   */
  _resolverConquista(ilha, agora, matador) {
    const rank = this._ranking(ilha);
    const vencedor = rank.find(r => this._podeConquistar(r.guildId, ilha.id));

    if (!vencedor) {
      // Ninguém elegível (só bateram jogadores sem guilda, ou todas as guildas
      // do ranking já têm ilha). A ilha fica neutra e as torres voltam pelo
      // respawn de 30 min — a disputa recomeça sozinha.
      ilha.state = 'neutral';
      ilha.ownerGuildId = null;
      this._broadcastMap(ilha, {
        type: 'island_notice',
        message: `🏝 ${ilha.def.name} ficou sem dono — nenhuma guilda elegível no ranking de dano.`,
      });
      return;
    }

    this._entregarIlha(ilha, vencedor, agora);
  }

  /** Passa a ilha à próxima do ranking (prazo de graça vencido sem torre). */
  _passarAoProximo(ilha, agora) {
    const rank = this._ranking(ilha);
    const atual = rank.findIndex(r => r.guildId === ilha.ownerGuildId);
    const proximo = rank.slice(atual + 1).find(r => this._podeConquistar(r.guildId, ilha.id));

    this._broadcastMap(ilha, {
      type: 'island_notice',
      message: `⌛ ${ilha.def.name}: a guilda dona não ergueu torre a tempo.`,
    });

    if (!proximo) {
      ilha.state = 'neutral';
      ilha.ownerGuildId = null;
      ilha.graceUntil = 0;
      ilha.conqueredWeek = null;
      // Volta ao estado default: cinco torres novas, disputa aberta.
      ilha.towers = this._sortearTorres(agora);
      ilha.damageRank = {};
      this._save(ilha);
      this._syncTowers(ilha, agora);
      this._broadcastIsland(ilha);
      return;
    }
    this._entregarIlha(ilha, proximo, agora);
  }

  _entregarIlha(ilha, vencedor, agora) {
    ilha.ownerGuildId  = vencedor.guildId;
    ilha.ownerSince    = agora;
    ilha.state         = 'grace';
    ilha.graceUntil    = agora + GRACE_MS;
    ilha.conqueredWeek = weekKey(agora);
    ilha.repairing     = false;

    this._save(ilha);
    this._syncTowers(ilha, agora);
    this._broadcastIsland(ilha);

    const minutos = Math.round(GRACE_MS / 60000);
    this._broadcastAll({
      type: 'island_notice',
      message: `🏴 [${vencedor.tag}] ${vencedor.name} conquistou ${ilha.def.name}!`,
    });
    this._noticeGuild(ilha,
      `🏝 Vocês tomaram ${ilha.def.name}! Ergam a primeira torre em ${minutos} min ou a ilha passa adiante.`);
    console.log(`[Ilha] ${ilha.def.name} → [${vencedor.tag}] ${vencedor.name} (${vencedor.damage} de dano)`);
  }

  /** A guilda pode TOMAR esta ilha agora? (uma por semana, ver o pedido) */
  _podeConquistar(guildId, islandId) {
    if (!guildId || !this.guilds?.guilds?.has(guildId)) return false;
    const semana = weekKey();
    let jaTem = 0;
    for (const outra of this.islands.values()) {
      if (outra.id === islandId) continue;
      if (outra.ownerGuildId === guildId && outra.conqueredWeek === semana) jaTem++;
    }
    return jaTem < MAX_ISLANDS_PER_GUILD_PER_WEEK;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Comandos do cliente
  // ═══════════════════════════════════════════════════════════════════════════

  handleMessage(player, msg) {
    switch (msg.type) {
      case 'island_info':   this.sendState(player); break;
      case 'island_build':  this.handleBuild(player, msg); break;
      case 'island_repair': this.handleRepair(player, msg); break;
      case 'island_force_event': this.handleForceEvent(player, msg); break;
      default: break;
    }
  }

  /**
   * Faz a coleta desta ilha zarpar agora — a aba de teste do painel da guilda.
   * Só o líder da guilda que DOMINA a ilha. Ver TaxBoatManager.forceStart para
   * o que a partida forçada faz (e o que ela deliberadamente não faz).
   */
  handleForceEvent(player, msg) {
    const ilha = this.islands.get(Number(msg.islandId));
    if (!ilha) return this._err(player, 'Ilha desconhecida.');

    const gid = this._guildIdOf(player);
    if (!gid || gid !== ilha.ownerGuildId) return this._err(player, 'Sua guilda não domina esta ilha.');

    const guilda = this.guilds.guilds.get(gid);
    if (!guilda) return this._err(player, 'Guilda não encontrada.');
    if (guilda.leaderName !== player.name) return this._err(player, 'Só o líder convoca a coleta.');
    if (!this.taxBoat) return this._err(player, 'A coleta não está disponível.');

    const r = this.taxBoat.forceStart(ilha.id);
    if (!r.ok) return this._err(player, r.reason);

    this.send(player.ws, {
      type: 'island_ok', action: 'force_event',
      message: `⛵ A coleta do ${ilha.def.venueName} zarpou com ` +
               `${r.amount.toLocaleString('pt-BR')} 🪙.`,
    });
    this._broadcastIsland(ilha);
  }

  /** Ergue uma torre num slot vazio. Só o líder, e o custo sai do cofre. */
  handleBuild(player, msg) {
    const ilha = this.islands.get(Number(msg.islandId));
    if (!ilha) return this._err(player, 'Ilha desconhecida.');

    const gid = this._guildIdOf(player);
    if (!gid || gid !== ilha.ownerGuildId) return this._err(player, 'Sua guilda não domina esta ilha.');

    const guilda = this.guilds.guilds.get(gid);
    if (!guilda) return this._err(player, 'Guilda não encontrada.');
    if (guilda.leaderName !== player.name) return this._err(player, 'Só o líder ergue torres.');

    const idx = Math.floor(Number(msg.slot));
    if (!(idx >= 0 && idx < TOWER_SLOTS)) return this._err(player, 'Slot inválido.');
    const slot = ilha.towers[idx];
    if (slot && !slot.dead) return this._err(player, 'Esse slot já tem uma torre de pé.');

    const def = TOWER_TYPES[String(msg.towerType || '')];
    if (!def) return this._err(player, 'Tipo de torre desconhecido.');

    if ((guilda.gold || 0) < (def.costGold || 0)) {
      return this._err(player, `Cofre sem ouro: precisa de ${(def.costGold).toLocaleString('pt-BR')} 🪙.`);
    }
    if ((guilda.dobroes || 0) < (def.costDobroes || 0)) {
      return this._err(player, `Cofre sem dobrões: precisa de ${(def.costDobroes).toLocaleString('pt-BR')} 💰.`);
    }

    guilda.gold    = (guilda.gold    || 0) - (def.costGold    || 0);
    guilda.dobroes = (guilda.dobroes || 0) - (def.costDobroes || 0);
    this.db.upsertGuild(guilda).catch(() => {});

    // Muralha da Ilha e Artilharia da Ilha entram AQUI, na hora de erguer: a
    // torre nasce com a vida e o dano que as skills da guilda dão, e guarda
    // esses números no slot. Aplicar no tique de tiro em vez de no nascimento
    // faria a barra de vida da torre mentir — ela mostraria o `maxHp` de
    // tabela enquanto a torre aguenta outro tanto.
    const bonus  = this.guilds.bonusFor(player);
    const vida   = Math.round(def.hp     * (1 + Math.max(0, bonus.tower_hp_pct  || 0)));
    const dano   = Math.round(def.damage * (1 + Math.max(0, bonus.tower_dmg_pct || 0)));

    const agora = Date.now();
    ilha.towers[idx] = {
      slot: idx, type: def.id,
      hp: vida, maxHp: vida, damage: dano,
      dead: false, respawnAt: 0, lastDamageAt: 0,
      built: true, _bornAt: agora,
    };

    // Erguer a primeira torre dentro do prazo confirma o domínio.
    if (ilha.state === 'grace') { ilha.state = 'owned'; ilha.graceUntil = 0; }

    this._save(ilha);
    this._syncTowers(ilha, agora);
    this._broadcastIsland(ilha);
    this.send(player.ws, { type: 'island_ok', action: 'build',
      message: `${def.icon} ${def.name} erguida no posto ${idx + 1}.` });
    this._noticeGuild(ilha, `${def.icon} ${player.name} ergueu uma ${def.name} em ${ilha.def.name}.`);
  }

  /** Liga/desliga o conserto contínuo das torres. Qualquer membro. */
  handleRepair(player, msg) {
    const ilha = this.islands.get(Number(msg.islandId));
    if (!ilha) return this._err(player, 'Ilha desconhecida.');

    const gid = this._guildIdOf(player);
    if (!gid || gid !== ilha.ownerGuildId) return this._err(player, 'Sua guilda não domina esta ilha.');

    ilha.repairing = msg.on === undefined ? !ilha.repairing : !!msg.on;
    this._save(ilha);
    this._broadcastIsland(ilha);
    this.send(player.ws, {
      type: 'island_ok', action: 'repair',
      message: ilha.repairing
        ? '🔧 Conserto ligado: 1% por minuto em toda torre 5 min sem apanhar.'
        : '🔧 Conserto desligado.',
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Imposto
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sobretaxa de um gasto na praça. Devolve QUANTO cobrar a mais — o chamador
   * soma ao preço e debita o total do jogador.
   *
   * Fica separado do `collectTax` de propósito: quem chama precisa saber o
   * valor ANTES de checar se o jogador tem dinheiro. Cobrar primeiro e conferir
   * depois é como se vende fiado sem querer.
   *
   * @param {string} action  o `type` da mensagem do cliente (ver VENUE_ACTIONS)
   * @param {number} amount  valor base do gasto, em ouro
   * @returns {{pct:number, extra:number, islandId:number, tag:string}|null}
   */
  taxOn(action, amount) {
    const venue = ACTION_VENUE[action];
    if (!venue || !(amount > 0)) return null;
    const def = ISLAND_BY_VENUE[venue];
    const ilha = def && this.islands.get(def.id);
    if (!ilha || !ilha.ownerGuildId) return null;

    const guilda = this.guilds?.guilds?.get(ilha.ownerGuildId);
    if (!guilda) return null;

    const pct = taxPctFor(guilda.level);
    if (pct <= 0) return null;
    return {
      pct,
      extra: Math.ceil(amount * pct),
      islandId: ilha.id,
      tag: guilda.tag,
      guildName: guilda.name,
    };
  }

  /** Guarda no bolo da ilha o que a sobretaxa arrecadou. */
  collectTax(islandId, extra) {
    const ilha = this.islands.get(Number(islandId));
    if (!ilha || !(extra > 0)) return;
    ilha.taxPot = Math.round((ilha.taxPot || 0) + extra);
    this._save(ilha);
  }

  /**
   * Atalho para os handlers de compra: calcula, cobra e guarda numa chamada.
   * Devolve o EXTRA cobrado (0 se não há imposto).
   *
   * O jogador já teve o preço base debitado pelo handler; aqui sai só a
   * sobretaxa, e ela vira uma linha própria no extrato — o capitão precisa
   * conseguir ver que pagou imposto a uma guilda, e a quem.
   */
  chargeTax(player, action, amount) {
    const t = this.taxOn(action, amount);
    if (!t) return 0;

    // Cobra o que couber no bolso. Isentar quem não tem o valor cheio criaria o
    // truque óbvio de chegar na loja com exatamente o preço do item e nunca
    // pagar imposto; cobrar o que há deixa o comprador em zero, que é um custo
    // de verdade e não dá para planejar em torno.
    const cobrado = Math.min(t.extra, Math.max(0, player.gold || 0));
    if (cobrado <= 0) return 0;

    player.gold -= cobrado;
    this.collectTax(t.islandId, cobrado);
    this.journal?.ledger(player, this.SRC.ISLAND_TAX, { gold: -cobrado },
      { detail: `[${t.tag}] ${Math.round(t.pct * 100)}%` });
    return cobrado;
  }

  /** O que o Farol/Mercado/Banco mostram no cabeçalho ("quem governa"). */
  venueInfo(venue) {
    const def = ISLAND_BY_VENUE[venue];
    const ilha = def && this.islands.get(def.id);
    if (!ilha) return null;
    const guilda = ilha.ownerGuildId ? this.guilds?.guilds?.get(ilha.ownerGuildId) : null;
    return {
      islandId:  ilha.id,
      islandName: def.name,
      venue,
      venueName: def.venueName,
      // Em que MAPA a praça fica. O cliente precisa saber qual das três está
      // sob os pés do jogador para desenhar a ficha do imposto, e derivar isso
      // de uma tabela mapa→praça no cliente seria uma segunda cópia da rota das
      // ilhas — a primeira já escorregou uma vez (ver o mapa-múndi).
      venueMap:  def.venueMap,
      // O que exatamente é taxado aqui. Vai junto porque a ficha do imposto
      // promete responder "o que paga imposto nesta praça", e a resposta é esta
      // lista e mais nenhuma — VENUE_ACTIONS é a autoridade, e escrever a mesma
      // coisa por extenso no cliente é o jeito de as duas divergirem no dia em
      // que a loja ganhar um balcão.
      actions:   VENUE_ACTIONS[venue] || [],
      ownerTag:  guilda?.tag  || null,
      ownerName: guilda?.name || null,
      ownerFlag: guilda?.flag || null,
      // A alíquota é o NÍVEL da guilda dona em pontos percentuais (ver
      // taxPctFor). `guildLevel` vai junto para a ficha poder EXPLICAR o
      // número em vez de só mostrá-lo.
      guildLevel: guilda?.level || 0,
      taxPct:    guilda ? taxPctFor(guilda.level) : 0,
      taxPot:    ilha.taxPot || 0,
      nextEventAt: ilha.nextEventAt || 0,
      weekday:   def.weekday,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Semana
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Vira a semana: a ilha volta ao estado default, com torres novas e sem dono.
   * Só roda para ilha cuja coleta JÁ passou nesta semana — reiniciar antes do
   * evento apagaria o imposto que a guilda passou a semana acumulando.
   */
  async _checkWeeklyReset(agora) {
    const semana = weekKey(agora);
    for (const ilha of this.islands.values()) {
      if (ilha.state === 'neutral' && !ilha.ownerGuildId) continue;
      // Coleta desta semana já aconteceu? Então a ilha reinicia.
      if (ilha.lastEventWeek !== semana) continue;
      if (ilha._resetWeek === semana) continue;
      await this.resetIsland(ilha, agora);
    }
  }

  /** Devolve a ilha ao estado default (torres sorteadas, sem dono, sem bolo). */
  async resetIsland(ilha, agora = Date.now()) {
    ilha.state         = 'neutral';
    ilha.ownerGuildId  = null;
    ilha.ownerSince    = 0;
    ilha.graceUntil    = 0;
    ilha.conqueredWeek = null;
    ilha.repairing     = false;
    ilha.damageRank    = {};
    ilha.taxPot        = 0;
    ilha.towers        = this._sortearTorres(agora);
    ilha._resetWeek    = weekKey(agora);
    ilha.nextEventAt   = nextEventAt(ilha.id, agora);

    for (const id of [...this.towers.keys()]) {
      if (this.towers.get(id)?.islandId === ilha.id) this._removeTowerEntity(id);
    }
    this._syncTowers(ilha, agora);
    await this.db.upsertIsland(ilha);
    this._broadcastIsland(ilha);
    console.log(`[Ilha] ${ilha.def.name} reiniciada — torres novas, sem dono`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Estado para o cliente
  // ═══════════════════════════════════════════════════════════════════════════

  /** Uma ilha, do jeito que o cliente desenha. */
  publicState(ilha, viewer = null) {
    const guilda = ilha.ownerGuildId ? this.guilds?.guilds?.get(ilha.ownerGuildId) : null;
    const gid    = viewer ? this._guildIdOf(viewer) : null;
    const meu    = !!gid && gid === ilha.ownerGuildId;

    return {
      id:        ilha.id,
      mapLevel:  ilha.mapLevel,
      name:      ilha.def.name,
      venue:     ilha.def.venue,
      venueName: ilha.def.venueName,
      icon:      ilha.def.icon,
      state:     ilha.state,
      owner: guilda ? {
        id: guilda.id, tag: guilda.tag, name: guilda.name,
        flag: guilda.flag, level: guilda.level,
      } : null,
      isMine:      meu,
      isLeader:    meu && guilda?.leaderName === viewer?.name,
      graceUntil:  ilha.graceUntil || 0,
      repairing:   !!ilha.repairing,
      taxPct:      guilda ? taxPctFor(guilda.level) : 0,
      taxPot:      ilha.taxPot || 0,
      nextEventAt: ilha.nextEventAt || 0,
      weekday:     ilha.def.weekday,
      towers: ilha.towers.map(t => ({
        slot: t.slot, type: t.type,
        hp: t.dead ? 0 : t.hp, maxHp: t.maxHp,
        dead: !!t.dead,
        built: !!t.built,
        respawnAt: t.respawnAt || 0,
        lastDamageAt: t.lastDamageAt || 0,
        pos: towerSlotPos(t.slot),
      })),
      // O ranking só interessa enquanto a ilha está em disputa; com dono ele é
      // história, e mostrá-lo sugeriria que ainda dá para virar o jogo.
      ranking: ilha.ownerGuildId ? [] : this._ranking(ilha).slice(0, 5),
      towerDefs: Object.values(TOWER_TYPES).map(t => ({
        id: t.id, name: t.name, icon: t.icon,
        hp: t.hp, damage: t.damage,
        costGold: t.costGold, costDobroes: t.costDobroes,
      })),
    };
  }

  /**
   * Todas as ilhas — é o que o cliente recebe no init e a cada mudança.
   *
   * `venues` vai junto porque o Farol, o Mercado e o Banco precisam mostrar no
   * cabeçalho quem governa e quanto está sendo cobrado, e esses três painéis
   * não têm por que saber que existe uma ilha por trás disso. Eles perguntam
   * pela PRAÇA e recebem a resposta pronta.
   */
  stateFor(player) {
    const venues = {};
    for (const def of Object.values(ISLAND_DEFS)) {
      venues[def.venue] = this.venueInfo(def.venue);
    }
    return {
      islands: [...this.islands.values()].map(i => this.publicState(i, player)),
      venues,
      // Coleta em curso, para o HUD dizer onde o barco está agora.
      trips: this.taxBoat ? this.taxBoat.activeTrips() : [],
    };
  }

  sendState(player) {
    if (!player?.ws) return;
    this.send(player.ws, { type: 'island_state', ...this.stateFor(player) });
  }

  injectInitData(player) {
    return { islandState: this.stateFor(player) };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Internos
  // ═══════════════════════════════════════════════════════════════════════════

  _guildIdOf(player) {
    if (!player || !this.guilds) return null;
    const g = this.guilds.guildOf(player);
    return g ? g.id : null;
  }

  _save(ilha) {
    this.db.upsertIsland(ilha).catch(e => console.error('[Ilha] gravação falhou:', e.message));
  }

  /** Manda o estado novo a quem está no mapa da ilha ou é da guilda dona. */
  _broadcastIsland(ilha) {
    this.players.forEach(p => {
      if (!p?.ws) return;
      const noMapa = (p.mapLevel || 1) === ilha.mapLevel;
      const daDona = !!ilha.ownerGuildId && this._guildIdOf(p) === ilha.ownerGuildId;
      if (noMapa || daDona) this.sendState(p);
    });
  }

  _broadcastMap(ilha, msg) {
    this.players.forEach(p => {
      if (p?.ws && (p.mapLevel || 1) === ilha.mapLevel) this.send(p.ws, msg);
    });
  }

  _broadcastAll(msg) {
    this.players.forEach(p => { if (p?.ws) this.send(p.ws, msg); });
  }

  _noticeGuild(ilha, message) {
    if (!ilha.ownerGuildId) return;
    const g = this.guilds?.guilds?.get(ilha.ownerGuildId);
    if (!g) return;
    this.players.forEach(p => {
      if (p?.ws && g.members.has(p.name)) this.send(p.ws, { type: 'island_notice', message });
    });
  }

  _err(player, reason) {
    if (player?.ws) this.send(player.ws, { type: 'island_error', reason });
  }

  // ── Consultas usadas pelo resto do servidor ────────────────────────────────

  /** A ilha deste mapa, ou null. */
  islandOfMap(mapLevel) {
    const def = ISLAND_BY_MAP[mapLevel];
    return def ? (this.islands.get(def.id) || null) : null;
  }

  /** true se o jogador é da guilda que domina a ilha deste mapa. */
  ownsIslandOfMap(player, mapLevel) {
    const ilha = this.islandOfMap(mapLevel);
    if (!ilha || !ilha.ownerGuildId) return false;
    return this._guildIdOf(player) === ilha.ownerGuildId;
  }
}

module.exports = IslandManager;
module.exports.TOWER_HIT_RADIUS = TOWER_HIT_RADIUS;
