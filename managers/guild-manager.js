// managers/guild-manager.js — Guildas (irmandades de piratas)
//
// ── O que este manager governa ───────────────────────────────────────────────
//   • FUNDAÇÃO   nome, tag, bandeira; 500 mil de ouro saem do bolso do fundador
//   • FILIAÇÃO   pedido → o líder aceita ou recusa; um pirata, uma guilda
//   • COFRE      doação de dobrões e a taxa diária em ouro
//   • NÍVEL      sobe com uma fatia do XP que os membros ganham jogando
//   • SKILLS     seis bônus que valem para TODOS os membros, online ou não
//
// ── Onde os bônus são LIDOS ──────────────────────────────────────────────────
// Este manager não multiplica recompensa nenhuma: ele só mantém
// `player._guildBonus` atualizado. Quem lê:
//   utils/talent-effects.js  lootMult()    → ouro, dobrão e XP
//   utils/talent-logic.js    recalcMaxHp() → vida máxima
// Foi feito assim de propósito. Espalhar multiplicador por cada local de
// recompensa é como se perde bônus em silêncio — o mesmo erro que já custou
// caro nos talentos. Duas funções centrais, e todo caminho de espólio que já
// existe (tiro, DoT, chefe, boss mundial) ganha o bônus de graça.
//
// As duas skills de TORRE não têm leitor ainda: torre é da Ilha da Guilda, que
// é a próxima leva. `bonusFor()` já devolve os valores; quando o sistema de
// torres nascer, ele lê de lá e nada mais muda aqui.
//
// ── O XP da guilda é AMOSTRADO, não empurrado ────────────────────────────────
// XP de jogador é creditado em uma dúzia de lugares (abate a tiro, abate por
// DoT, chefe de mapa, boss mundial, missão, masmorra, PVP…). Pendurar uma
// chamada em cada um garante que um deles fique de fora hoje ou no próximo
// sistema que somar XP. Em vez disso, uma varredura compara `player.mapXp` com
// a marca da última passagem e credita a DIFERENÇA: uma fonte só, e nenhuma
// fonte futura de XP escapa dela.
//
// Cliente envia:  guild_info, guild_create, guild_search, guild_apply,
//                 guild_applications, guild_application_resolve, guild_leave,
//                 guild_kick, guild_set_tax, guild_donate, guild_skill_up
// Servidor envia: guild_state, guild_error, guild_ok, guild_search_result,
//                 guild_applications, guild_notice
'use strict';

const {
  GUILD_CREATE_COST, GUILD_MAX_LEVEL, GUILD_XP_SHARE, GUILD_GOLD_SHARE,
  TAX_MAX_PCT, TAX_INTERVAL_MS,
  NAME_MIN, NAME_MAX, TAG_MIN, TAG_MAX, NAME_RE, TAG_RE,
  DONATE_MIN_DOBROES,
  GUILD_SKILLS, GUILD_SKILL_BY_ID,
  memberCap, xpToNextLevel, skillUpCost,
} = require('../constants/guilds');

/** Passo da varredura que converte o que o membro ganhou (XP e ouro de abate)
 *  em XP e ouro de guilda. */
const XP_SWEEP_MS  = 30_000;
/** Passo da varredura da taxa diária. Fino o bastante para o "diário" não
 *  atrasar horas, grosso o bastante para não pesar. */
const TAX_SWEEP_MS = 5 * 60_000;
/** Teto de resultados de uma busca. */
const SEARCH_LIMIT = 30;

/** Bônus zerado — devolvido para quem não tem guilda. Congelado para não haver
 *  como alguém escrever nele por engano e "dar" bônus a um sem-guilda. */
const NO_BONUS = Object.freeze({
  gold_pct: 0, dobrao_pct: 0, xp_pct: 0,
  member_hp_pct: 0, tower_hp_pct: 0, tower_dmg_pct: 0,
  tax_boat_pct: 0,
});

class GuildManager {
  /**
   * @param {Function} sendToFn  sendTo(ws, msg)
   * @param {Map}      players   id → player do server.js
   * @param {Object}   db        DBManager
   * @param {Object}   journal   JournalManager
   * @param {Object}   SRC       JournalManager.SRC
   */
  constructor(sendToFn, players, db, journal, SRC) {
    this.send    = sendToFn;
    this.players = players;
    this.db      = db;
    this.journal = journal;
    this.SRC     = SRC;

    this.guilds   = new Map();   // guildId → guilda
    this.byPlayer = new Map();   // playerName → guildId

    this._xpInterval  = null;
    this._taxInterval = null;
    /** Chamado quando a vida máxima de um membro online muda (skill de casco).
     *  O server.js injeta a função que recalcula os derivados do jogador.
     *  Assinatura: (player, notify) — `notify` false no login, onde o `init`
     *  já vai levar os valores novos. */
    this.onMemberStatsChanged = null;
    /** Injetado pelo server.js: o IslandManager. É ele quem sabe qual ilha a
     *  guilda domina — a filiação mora aqui, a posse mora lá, e o painel
     *  precisa das duas na mesma tela. */
    this.islands = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Ciclo de vida
  // ═══════════════════════════════════════════════════════════════════════════

  /** Carrega tudo do banco. Precisa de await no boot: antes disto, um
   *  `guild_info` responderia "sem guilda" a quem tem uma. */
  async init() {
    this.guilds = await this.db.loadGuilds();
    for (const g of this.guilds.values()) {
      for (const name of g.members.keys()) this.byPlayer.set(name, g.id);
    }

    this._xpInterval = setInterval(() => {
      try { this._sweepContrib(); }
      catch (e) { console.error('[Guilda] varredura de contribuição:', e.message); }
    }, XP_SWEEP_MS);

    this._taxInterval = setInterval(() => {
      this._sweepTax().catch(e => console.error('[Guilda] varredura de taxa:', e.message));
    }, TAX_SWEEP_MS);

    // Uma passada logo no boot resolve as guildas cuja cobrança venceu com o
    // servidor fora do ar — senão a taxa só voltaria a correr no primeiro
    // TAX_SWEEP_MS, e uma queda longa perderia o dia inteiro.
    this._sweepTax().catch(() => {});

    const membros = [...this.guilds.values()].reduce((n, g) => n + g.members.size, 0);
    console.log(`🏴 ${this.guilds.size} guilda(s), ${membros} membro(s)`);
  }

  destroy() {
    if (this._xpInterval)  clearInterval(this._xpInterval);
    if (this._taxInterval) clearInterval(this._taxInterval);
    this._xpInterval = this._taxInterval = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Consultas usadas pelo resto do servidor
  // ═══════════════════════════════════════════════════════════════════════════

  /** A guilda do jogador, ou null. */
  guildOf(player) {
    if (!player || !player.name) return null;
    const id = this.byPlayer.get(player.name);
    return id ? (this.guilds.get(id) || null) : null;
  }

  guildOfName(name) {
    const id = this.byPlayer.get(name);
    return id ? (this.guilds.get(id) || null) : null;
  }

  /** true se os dois estão na MESMA guilda (chat, cor no minimapa). */
  areGuildMates(nameA, nameB) {
    if (!nameA || !nameB || nameA === nameB) return false;
    const a = this.byPlayer.get(nameA);
    return !!a && a === this.byPlayer.get(nameB);
  }

  /**
   * Bônus somados das skills, na forma que os leitores esperam (fração, não
   * porcentagem). Guilda nível 10 com Butim Farto 4 devolve gold_pct 0,40.
   */
  bonusFor(player) {
    const g = this.guildOf(player);
    if (!g) return NO_BONUS;
    const out = { ...NO_BONUS };
    for (const def of GUILD_SKILLS) {
      const lvl = Math.max(0, Math.floor(Number(g.skills?.[def.id] || 0)));
      if (lvl > 0) out[def.stat] = lvl * def.pctPerLevel;
    }
    return out;
  }

  /**
   * Companheiros de guilda VIVOS no mesmo mapa. Mesma forma do
   * `getPartyMembersInZone` do grupo — é o que alimenta os blips do minimapa.
   * O próprio jogador e os do grupo ficam de fora: o grupo já tem blip próprio
   * e desenhar duas vezes pinta o mesmo barco em duas cores.
   */
  getGuildMembersInZone(player, mapLevel, excludeIds = null) {
    const g = this.guildOf(player);
    if (!g) return [];
    const out = [];
    this.players.forEach(p => {
      if (!p || p === player || p.dead) return;
      if ((p.mapLevel || 1) !== mapLevel) return;
      if (!g.members.has(p.name)) return;
      if (excludeIds && excludeIds.has(p.id)) return;
      out.push(p);
    });
    return out;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Entrada e saída do jogador
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Carimba o bônus e a marca de XP no jogador. Chamado no login ANTES de o
   * payload do `init` ser montado — o `maxHp` que vai nele já precisa contar o
   * Casco da Irmandade, senão a barra de vida nasce com o teto errado e só é
   * corrigida pelo `inventory_update` do quadro seguinte.
   */
  prepareLogin(player) {
    if (!player) return;
    // Marca de XP: o que ele já tinha ao entrar NÃO conta para a guilda —
    // sem isso, um veterano com 8 milhões de XP subiria a guilda inteira no
    // primeiro login depois de entrar nela.
    player._guildXpMark = player.mapXp || 0;
    // Mesma ideia pelo lado do ouro: o acumulador é de sessão e nasce zerado.
    // (Ele nem chega a ser salvo no banco — ver noteKillGold.)
    player._killGold = 0;
    // `notify: false` — o payload do init que vem logo a seguir já carrega o
    // `maxHp` novo. Mandar um `inventory_update` ANTES do init faria o cliente
    // reagir a uma vida máxima antes de existir barra para mostrá-la.
    this._applyBonus(player, false);
  }

  /** Chamado depois de o `init` ter saído: avisa a irmandade e sincroniza. */
  onPlayerJoined(player) {
    if (!player) return;
    // Rede de segurança: se algum caminho de login novo esquecer o
    // prepareLogin, o bônus ainda entra aqui (uma linha atrás na tela, nunca
    // ausente). `_applyBonus` é idempotente — sem mudança, não faz nada.
    this.prepareLogin(player);
    const g = this.guildOf(player);
    if (g) {
      this._broadcastState(g, { except: player.name });
      this.sendState(player);
    }
  }

  onPlayerLeft(player) {
    if (!player) return;
    // Fecha as contas pendentes antes de a memória do jogador sumir. E GRAVA:
    // a varredura só passa de 30 em 30 segundos, e o último trecho de quem
    // desconectou não pode depender de o servidor continuar de pé até lá.
    // As DUAS chamadas, sempre: `a() || b()` faria o ouro pendente ser
    // descartado toda vez que houvesse XP pendente junto.
    const porXp   = this._creditXp(player);
    const porOuro = this._creditGold(player);
    const tocada  = porXp || porOuro;
    if (tocada) this.db.upsertGuild(tocada).catch(() => {});
    const g = this.guildOf(player);
    if (g) this._broadcastState(g, { except: player.name });
  }

  /** O que vai no `init` do cliente. */
  injectInitData(player) {
    return { guild: this.stateFor(player) };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Roteamento das mensagens do cliente
  // ═══════════════════════════════════════════════════════════════════════════

  handleMessage(player, msg) {
    switch (msg.type) {
      case 'guild_info':                 this.sendState(player); break;
      case 'guild_create':               this.handleCreate(player, msg); break;
      case 'guild_search':               this.handleSearch(player, msg); break;
      case 'guild_apply':                this.handleApply(player, msg); break;
      case 'guild_applications':         this.handleApplications(player); break;
      case 'guild_application_resolve':  this.handleResolveApplication(player, msg); break;
      case 'guild_leave':                this.handleLeave(player); break;
      case 'guild_kick':                 this.handleKick(player, msg); break;
      case 'guild_set_tax':              this.handleSetTax(player, msg); break;
      case 'guild_donate':               this.handleDonate(player, msg); break;
      case 'guild_skill_up':             this.handleSkillUp(player, msg); break;
      default: break;
    }
  }

  // ── Fundar ─────────────────────────────────────────────────────────────────
  handleCreate(player, msg) {
    if (this.guildOf(player)) return this._err(player, 'Você já pertence a uma guilda.');

    const name = String(msg.name || '').trim().replace(/\s+/g, ' ');
    const tag  = String(msg.tag  || '').trim().toUpperCase();
    const flag = this._sanitizeFlag(msg.flag);

    if (name.length < NAME_MIN || name.length > NAME_MAX || !NAME_RE.test(name)) {
      return this._err(player, `Nome inválido (${NAME_MIN} a ${NAME_MAX} letras, sem símbolos).`);
    }
    if (tag.length < TAG_MIN || tag.length > TAG_MAX || !TAG_RE.test(tag)) {
      return this._err(player, `Tag inválida (${TAG_MIN} a ${TAG_MAX} letras ou números).`);
    }
    // Colisão de nome/tag é resolvida DUAS vezes: aqui, para dar um recado
    // decente, e no índice UNIQUE do banco, que é quem realmente garante — duas
    // criações simultâneas passariam por esta checagem juntas.
    const lname = name.toLowerCase();
    for (const g of this.guilds.values()) {
      if (g.name.toLowerCase() === lname) return this._err(player, 'Já existe uma guilda com esse nome.');
      if (g.tag.toUpperCase()   === tag)   return this._err(player, 'Essa tag já está em uso.');
    }
    if ((player.gold || 0) < GUILD_CREATE_COST) {
      return this._err(player, `Ouro insuficiente: fundar custa ${GUILD_CREATE_COST.toLocaleString('pt-BR')} 🪙.`);
    }

    const now = Date.now();
    const guild = {
      id:         `g${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
      name, tag, flag,
      leaderName: player.name,
      gold: 0, dobroes: 0,
      level: 1, xp: 0,
      taxPct: 0,
      skills: {},
      island: null,
      nextTaxAt: now + TAX_INTERVAL_MS,
      createdAt: now,
      members:      new Map([[player.name, {
        role: 'leader', contribGold: 0, contribDobroes: 0, contribXp: 0, joinedAt: now,
      }]]),
      applications: new Map(),
    };

    // O ouro só sai DEPOIS de o banco aceitar a guilda: se o UNIQUE recusar
    // (nome tomado no mesmo instante por outro jogador), quem pagou ficaria
    // sem os 500 mil e sem guilda nenhuma.
    this.db.upsertGuild(guild).then(async ok => {
      if (!ok) return this._err(player, 'Esse nome ou tag acabou de ser registrado. Tente outro.');
      if ((player.gold || 0) < GUILD_CREATE_COST) {
        await this.db.deleteGuild(guild.id);
        return this._err(player, 'Ouro insuficiente.');
      }
      if (this.guildOf(player)) {         // entrou em outra guilda enquanto isso
        await this.db.deleteGuild(guild.id);
        return this._err(player, 'Você já pertence a uma guilda.');
      }

      player.gold -= GUILD_CREATE_COST;
      this.journal?.ledger(player, this.SRC.GUILD_CREATE, { gold: -GUILD_CREATE_COST },
        { detail: `${tag} ${name}` });

      this.guilds.set(guild.id, guild);
      this.byPlayer.set(player.name, guild.id);
      await this.db.upsertGuildMember(guild.id, player.name, guild.members.get(player.name));
      this.db.save(player, true)?.catch?.(() => {});

      this._applyBonus(player);
      this.send(player.ws, { type: 'currency_update', gold: player.gold, dobroes: player.dobroes });
      this.send(player.ws, { type: 'guild_ok', action: 'create',
        message: `🏴 Guilda [${tag}] ${name} fundada!` });
      this.sendState(player);
      console.log(`[Guilda] ${player.name} fundou [${tag}] ${name}`);
    }).catch(e => {
      console.error('[Guilda] falha ao fundar:', e.message);
      this._err(player, 'Não foi possível fundar a guilda agora.');
    });
  }

  // ── Buscar ─────────────────────────────────────────────────────────────────
  handleSearch(player, msg) {
    const q = String(msg.q || '').trim().toLowerCase();
    const rows = [];
    for (const g of this.guilds.values()) {
      // Filtro combinado: o mesmo texto vale para nome e tag. Busca vazia
      // lista tudo — é o que faz a aba abrir já mostrando as guildas do
      // servidor em vez de um vazio pedindo que se adivinhe um nome.
      if (q && !g.name.toLowerCase().includes(q) && !g.tag.toLowerCase().includes(q)) continue;
      rows.push(this._summary(g, player));
    }
    // Maiores e mais avançadas primeiro — é o que quem procura guilda quer ver.
    rows.sort((a, b) => (b.level - a.level) || (b.members - a.members));
    this.send(player.ws, { type: 'guild_search_result', q: String(msg.q || ''),
      guilds: rows.slice(0, SEARCH_LIMIT) });
  }

  // ── Pedir entrada ──────────────────────────────────────────────────────────
  handleApply(player, msg) {
    if (this.guildOf(player)) return this._err(player, 'Você já pertence a uma guilda.');
    const g = this.guilds.get(String(msg.guildId || ''));
    if (!g) return this._err(player, 'Guilda não encontrada.');
    if (g.members.size >= memberCap(g.level)) return this._err(player, 'Essa guilda está lotada.');
    if (g.applications.has(player.name)) return this._err(player, 'Você já pediu entrada nessa guilda.');

    g.applications.set(player.name, Date.now());
    this.db.addGuildApplication(g.id, player.name).catch(() => {});
    this.send(player.ws, { type: 'guild_ok', action: 'apply',
      message: `📜 Pedido enviado para [${g.tag}] ${g.name}.` });

    const leader = this._findOnline(g.leaderName);
    if (leader) {
      this.send(leader.ws, { type: 'guild_notice',
        message: `📜 ${player.name} pediu para entrar na guilda.` });
      this.handleApplications(leader);
    }
  }

  /**
   * Lista os pedidos pendentes — só o líder vê.
   *
   * Cada pedido vai com o XP e os abates do candidato: aceitar alguém é dar
   * vaga, bônus e voz no cofre, e "quem é este pirata?" é a única pergunta que
   * a lista precisa responder. Quem está online tem o número na memória; para
   * os demais, uma consulta só ao banco (ver getPlayerProgress). A consulta é
   * assíncrona, então a resposta sai depois — é o líder abrindo uma aba, não
   * um caminho quente.
   */
  handleApplications(player) {
    const g = this.guildOf(player);
    if (!g || g.leaderName !== player.name) {
      return this.send(player.ws, { type: 'guild_applications', applications: [] });
    }

    const pend = [...g.applications.entries()].sort((a, b) => a[1] - b[1]);
    const offline = [];
    const apps = pend.map(([name, at]) => {
      const on = this._findOnline(name);
      if (!on) offline.push(name);
      // `null` e não `0` para quem está offline: o número ainda não é conhecido
      // neste ponto, e zero é uma afirmação (candidato sem XP nenhum) que o
      // cliente desenharia como tal.
      return {
        name, at,
        online:   !!on,
        xp:       on ? (on.mapXp    || 0) : null,
        npcKills: on ? (on.npcKills || 0) : null,
        mapLevel: on ? (on.mapLevel || 1) : null,
      };
    });

    const responder = () => this.send(player.ws, { type: 'guild_applications', applications: apps });
    if (!offline.length || !this.db.getPlayerProgress) return responder();

    // Falha de banco não pode engolir a lista: o líder ainda precisa poder
    // aceitar e recusar. Sem os números, os candidatos offline vão com `null` e
    // o cliente desenha "—" no lugar do número (ver _render_applications).
    this.db.getPlayerProgress(offline)
      .then(progresso => {
        for (const a of apps) {
          const pr = progresso.get(a.name);
          if (!pr) continue;
          a.xp = pr.xp; a.npcKills = pr.npcKills; a.mapLevel = pr.mapLevel;
        }
      })
      .catch(() => {})
      .finally(responder);
  }

  handleResolveApplication(player, msg) {
    const g = this.guildOf(player);
    if (!g) return this._err(player, 'Você não pertence a nenhuma guilda.');
    if (g.leaderName !== player.name) return this._err(player, 'Só o líder decide quem entra.');

    const name   = String(msg.playerName || '');
    const accept = !!msg.accept;
    if (!g.applications.has(name)) return this._err(player, 'Esse pedido não existe mais.');

    g.applications.delete(name);
    this.db.removeGuildApplication(g.id, name).catch(() => {});

    if (!accept) {
      const rej = this._findOnline(name);
      if (rej) this.send(rej.ws, { type: 'guild_notice',
        message: `Seu pedido para [${g.tag}] ${g.name} foi recusado.` });
      return this.handleApplications(player);
    }

    // Entre o pedido e o aceite o jogador pode ter entrado em outra guilda.
    if (this.byPlayer.has(name)) {
      this._err(player, `${name} já entrou em outra guilda.`);
      return this.handleApplications(player);
    }
    if (g.members.size >= memberCap(g.level)) {
      this._err(player, 'A guilda está lotada.');
      return this.handleApplications(player);
    }

    this._addMember(g, name);
    this.handleApplications(player);
  }

  // ── Sair / expulsar ────────────────────────────────────────────────────────
  handleLeave(player) {
    const g = this.guildOf(player);
    if (!g) return this._err(player, 'Você não pertence a nenhuma guilda.');

    // O líder que sai leva a guilda junto: passar a liderança é uma feature
    // própria e, sem ela, sobraria uma irmandade sem quem aceite membro, mexa
    // na taxa ou suba skill — morta em pé e ocupando o nome.
    if (g.leaderName === player.name) return this._disband(g, player);

    this._creditXp(player);
    this._creditGold(player);
    this._removeMember(g, player.name);
    this._applyBonus(player);
    this.send(player.ws, { type: 'guild_ok', action: 'leave', message: 'Você deixou a guilda.' });
    this.sendState(player);
    this._broadcastState(g);
  }

  handleKick(player, msg) {
    const g = this.guildOf(player);
    if (!g) return this._err(player, 'Você não pertence a nenhuma guilda.');
    if (g.leaderName !== player.name) return this._err(player, 'Só o líder pode expulsar.');

    const name = String(msg.playerName || '');
    if (name === player.name) return this._err(player, 'Para sair, use "Deixar a guilda".');
    if (!g.members.has(name)) return this._err(player, 'Esse pirata não está na guilda.');

    const target = this._findOnline(name);
    if (target) { this._creditXp(target); this._creditGold(target); }
    this._removeMember(g, name);
    if (target) {
      this._applyBonus(target);
      this.send(target.ws, { type: 'guild_notice', message: `Você foi expulso de [${g.tag}] ${g.name}.` });
      this.sendState(target);
    }
    this.send(player.ws, { type: 'guild_ok', action: 'kick', message: `${name} foi expulso.` });
    this._broadcastState(g);
  }

  // ── Taxa ───────────────────────────────────────────────────────────────────
  handleSetTax(player, msg) {
    const g = this.guildOf(player);
    if (!g) return this._err(player, 'Você não pertence a nenhuma guilda.');
    if (g.leaderName !== player.name) return this._err(player, 'Só o líder define a taxa.');

    let pct = Number(msg.taxPct);
    if (!Number.isFinite(pct)) return this._err(player, 'Valor inválido.');
    pct = Math.max(0, Math.min(TAX_MAX_PCT, pct));
    // Arredonda para o passo de 0,1 ponto percentual — o slider do cliente já
    // trabalha assim, e sem isto um cliente adulterado guardaria 4,99999%.
    pct = Math.round(pct * 1000) / 1000;

    g.taxPct = pct;
    this.db.upsertGuild(g).catch(() => {});
    this.send(player.ws, { type: 'guild_ok', action: 'tax',
      message: `Taxa da guilda ajustada para ${(pct * 100).toFixed(1)}%.` });
    this._broadcastState(g);
  }

  // ── Doação ─────────────────────────────────────────────────────────────────
  handleDonate(player, msg) {
    const g = this.guildOf(player);
    if (!g) return this._err(player, 'Você não pertence a nenhuma guilda.');

    const amount = Math.floor(Number(msg.dobroes || 0));
    if (!Number.isFinite(amount) || amount < DONATE_MIN_DOBROES) {
      return this._err(player, 'Informe quantos dobrões quer doar.');
    }
    if ((player.dobroes || 0) < amount) return this._err(player, 'Dobrões insuficientes.');

    player.dobroes -= amount;
    g.dobroes      += amount;
    // A doação conta em `contribDobroes`, separada do ouro: o ouro do membro
    // entra no cofre pela TAXA, que não é escolha dele. Somar as duas numa
    // coluna só faria o quadro de membros premiar quem só tem ouro parado.
    const m = g.members.get(player.name);
    if (m) {
      m.contribDobroes = (m.contribDobroes || 0) + amount;
      this.db.upsertGuildMember(g.id, player.name, m).catch(() => {});
    }
    this.journal?.ledger(player, this.SRC.GUILD_DONATE, { dobroes: -amount },
      { detail: `[${g.tag}] ${g.name}` });

    this.db.upsertGuild(g).catch(() => {});
    this.db.save(player, true)?.catch?.(() => {});
    this.send(player.ws, { type: 'currency_update', gold: player.gold, dobroes: player.dobroes });
    this.send(player.ws, { type: 'guild_ok', action: 'donate',
      message: `💰 ${amount.toLocaleString('pt-BR')} dobrões doados ao cofre.` });
    this._broadcastState(g);
  }

  // ── Subir skill ────────────────────────────────────────────────────────────
  handleSkillUp(player, msg) {
    const g = this.guildOf(player);
    if (!g) return this._err(player, 'Você não pertence a nenhuma guilda.');
    if (g.leaderName !== player.name) return this._err(player, 'Só o líder investe o cofre.');

    const id  = String(msg.skillId || '');
    const def = GUILD_SKILL_BY_ID[id];
    if (!def) return this._err(player, 'Skill desconhecida.');

    const cur  = Math.floor(Number(g.skills?.[id] || 0));
    if (cur >= GUILD_MAX_LEVEL) return this._err(player, 'Essa skill já está no máximo.');
    // O nível da guilda é o teto de TODAS as skills: é o que amarra subir de
    // nível ao poder da irmandade, em vez de o cofre sozinho decidir tudo.
    if (cur >= g.level) return this._err(player, `A guilda precisa ser nível ${cur + 1} para essa skill.`);

    const cost = skillUpCost(id, cur);
    if (!cost) return this._err(player, 'Essa skill já está no máximo.');
    if ((g.gold || 0) < cost.gold) {
      return this._err(player, `Cofre sem ouro: precisa de ${cost.gold.toLocaleString('pt-BR')} 🪙.`);
    }
    if ((g.dobroes || 0) < cost.dobroes) {
      return this._err(player, `Cofre sem dobrões: precisa de ${cost.dobroes.toLocaleString('pt-BR')} 💰.`);
    }

    g.gold      -= cost.gold;
    g.dobroes   -= cost.dobroes;
    g.skills     = { ...(g.skills || {}), [id]: cost.level };
    this.db.upsertGuild(g).catch(() => {});

    // Todo membro ONLINE sente na hora: a skill de casco mexe na vida máxima e
    // as de espólio mexem no próximo abate. Quem está offline pega no login.
    this._refreshAllMembers(g);
    this.send(player.ws, { type: 'guild_ok', action: 'skill',
      message: `${def.icon} ${def.name} → nível ${cost.level}.` });
    this._broadcastState(g);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Estado enviado ao cliente
  // ═══════════════════════════════════════════════════════════════════════════

  /** Resumo público de uma guilda (busca e modal de candidatura). */
  _summary(g, viewer = null) {
    return {
      id:      g.id,
      name:    g.name,
      tag:     g.tag,
      flag:    g.flag,
      level:   g.level,
      members: g.members.size,
      cap:     memberCap(g.level),
      leader:  g.leaderName,
      applied: viewer ? g.applications.has(viewer.name) : false,
    };
  }

  /**
   * O estado completo para `player`. `guild: null` quando ele não tem nenhuma —
   * é o que faz o cliente abrir a tela de fundar/procurar em vez da gerencial.
   */
  stateFor(player) {
    const g = this.guildOf(player);
    if (!g) {
      return {
        guild:      null,
        createCost: GUILD_CREATE_COST,
        skillDefs:  this._skillDefs(),
        maxLevel:   GUILD_MAX_LEVEL,
        maxTaxPct:  TAX_MAX_PCT,
      };
    }

    const members = [];
    for (const [name, m] of g.members) {
      const online = this._findOnline(name);
      members.push({
        name,
        role:        m.role,
        online:      !!online,
        xp:          online ? (online.mapXp || 0) : null,   // XP atual só de quem está online
        mapLevel:    online ? (online.mapLevel || 1) : null,
        contribGold:    m.contribGold    || 0,
        contribDobroes: m.contribDobroes || 0,
        contribXp:      m.contribXp      || 0,
      });
    }
    // Líder primeiro, depois quem mais contribuiu.
    members.sort((a, b) =>
      (a.role === 'leader' ? -1 : b.role === 'leader' ? 1 : 0) ||
      (b.contribXp + b.contribGold) - (a.contribXp + a.contribGold));

    return {
      guild: {
        id:         g.id,
        name:       g.name,
        tag:        g.tag,
        flag:       g.flag,
        leader:     g.leaderName,
        gold:       g.gold,
        dobroes:    g.dobroes,
        level:      g.level,
        xp:         g.xp,
        xpNeeded:   g.level >= GUILD_MAX_LEVEL ? 0 : xpToNextLevel(g.level),
        taxPct:     g.taxPct,
        nextTaxAt:  g.nextTaxAt,
        skills:     { ...(g.skills || {}) },
        cap:        memberCap(g.level),
        island:     this._islandOf(g),  // null enquanto a guilda não conquistar ilha
        members,
      },
      isLeader:   g.leaderName === player.name,
      createCost: GUILD_CREATE_COST,
      skillDefs:  this._skillDefs(),
      maxLevel:   GUILD_MAX_LEVEL,
      maxTaxPct:  TAX_MAX_PCT,
      bonus:      this.bonusFor(player),
    };
  }

  /**
   * A ilha que esta guilda domina, resumida para o painel — ou null.
   *
   * O detalhe (torre por torre, ranking de dano, reparo) é do island_panel, que
   * fala direto com o IslandManager. Aqui vai só o que a ficha da guilda
   * mostra: qual ilha é, quantas torres estão de pé, quanto de imposto está
   * acumulado e quando o barco da coleta zarpa.
   */
  _islandOf(g) {
    const mgr = this.islands;
    if (!mgr || !g) return null;
    for (const ilha of mgr.islands.values()) {
      if (ilha.ownerGuildId !== g.id) continue;
      return {
        islandId:    ilha.id,
        name:        ilha.def?.name || '',
        mapLevel:    ilha.def?.mapLevel || 0,
        venueName:   ilha.def?.venueName || '',
        weekday:     ilha.def?.weekday ?? null,
        towers:      ilha.towers.filter(t => !t.dead).length,
        towerSlots:  ilha.towers.length,
        income:      ilha.taxPot || 0,
        nextEventAt: ilha.nextEventAt || 0,
        // Uma coleta já em curso: a aba do evento precisa saber para não
        // oferecer um botão que só devolveria "o barco já zarpou".
        sailing:     !!mgr.taxBoat?.trips?.has(ilha.id),
      };
    }
    return null;
  }

  sendState(player) {
    if (!player?.ws) return;
    this.send(player.ws, { type: 'guild_state', ...this.stateFor(player) });
  }

  /** Catálogo das skills, já com o custo do PRÓXIMO nível calculado por skill. */
  _skillDefs() {
    return GUILD_SKILLS.map(s => ({
      id: s.id, icon: s.icon, name: s.name, desc: s.desc,
      pctPerLevel: s.pctPerLevel,
      costGold: s.costGold, costDobroes: s.costDobroes,
      island: !!s.island,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Varreduras
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Converte o que os membros ganharam desde a última passagem em XP e ouro de
   * guilda. Ver o cabeçalho do arquivo para o porquê de ser amostragem.
   *
   * As duas contas correm juntas de propósito: são a mesma varredura, a mesma
   * gravação no banco e o mesmo `guild_state` de volta. Separá-las dobraria as
   * duas últimas para ganhar nada.
   */
  _sweepContrib() {
    if (!this.guilds.size) return;
    const touched = new Set();
    this.players.forEach(p => {
      const gx = this._creditXp(p);
      if (gx) touched.add(gx);
      const gg = this._creditGold(p);
      if (gg) touched.add(gg);
    });
    for (const g of touched) {
      this.db.upsertGuild(g).catch(() => {});
      this._broadcastState(g);
    }
  }

  /**
   * Fecha a conta de XP de UM jogador e devolve a guilda tocada (ou null).
   * Também usado ao sair da guilda e ao desconectar, para não perder o trecho
   * ganho entre duas varreduras.
   */
  _creditXp(player) {
    if (!player || !player.name) return null;
    const cur  = player.mapXp || 0;
    const mark = player._guildXpMark;
    // Sem marca ainda (jogador entrou entre duas varreduras) → só carimba.
    if (mark == null) { player._guildXpMark = cur; return null; }
    player._guildXpMark = cur;

    // Delta negativo acontece: o PVP transfere 5% do XP do morto para o matador.
    // A guilda não devolve XP — perder XP no mar não desfaz a caçada de ontem.
    const delta = cur - mark;
    if (delta <= 0) return null;

    const g = this.guildOf(player);
    if (!g) return null;

    const share = Math.floor(delta * GUILD_XP_SHARE);
    if (share <= 0) return null;

    const m = g.members.get(player.name);
    if (m) {
      m.contribXp = (m.contribXp || 0) + share;
      this.db.upsertGuildMember(g.id, player.name, m).catch(() => {});
    }
    this._addGuildXp(g, share);
    return g;
  }

  /**
   * Fecha a conta do OURO DE ABATE de UM jogador e devolve a guilda tocada.
   * Mesma ideia do XP, com uma diferença que importa: aqui não há marca a
   * comparar — `_killGold` é um acumulador que só cresce (utils/helpers.js
   * ::noteKillGold) e que esta função LÊ E ZERA.
   *
   * Zerar em vez de marcar é o que torna a conta imune a saldo: o ouro do
   * jogador sobe e desce o dia inteiro (banco, loja, leilão) e amostrar
   * `player.gold` daria crédito por sacar do banco e prejuízo por comprar um
   * canhão. O acumulador só conhece uma coisa: bicho abatido.
   *
   * O ouro do cofre NÃO sai do bolso do membro — é criado por ele ter caçado
   * sob a bandeira, exatamente como o XP.
   */
  _creditGold(player) {
    if (!player || !player.name) return null;
    const pend = Math.round(player._killGold || 0);
    // Zera SEMPRE, inclusive para quem não tem guilda: senão o acumulador de
    // um sem-guilda cresceria a sessão inteira e cairia inteiro no cofre da
    // primeira guilda em que ele entrasse.
    player._killGold = 0;
    if (pend <= 0) return null;

    const g = this.guildOf(player);
    if (!g) return null;

    const share = Math.floor(pend * GUILD_GOLD_SHARE);
    if (share <= 0) return null;

    const m = g.members.get(player.name);
    if (m) {
      m.contribGold = (m.contribGold || 0) + share;
      this.db.upsertGuildMember(g.id, player.name, m).catch(() => {});
    }
    g.gold = (g.gold || 0) + share;
    return g;
  }

  /** Soma XP à guilda e resolve quantos níveis isso vale. */
  _addGuildXp(g, amount) {
    g.xp = (g.xp || 0) + amount;
    let leveled = 0;
    while (g.level < GUILD_MAX_LEVEL) {
      const need = xpToNextLevel(g.level);
      if (g.xp < need) break;
      g.xp   -= need;
      g.level += 1;
      leveled += 1;
    }
    if (g.level >= GUILD_MAX_LEVEL) g.xp = 0;   // no teto o XP não acumula
    if (leveled) {
      console.log(`[Guilda] [${g.tag}] ${g.name} subiu para o nível ${g.level}`);
      this._noticeAll(g, `🏴 A guilda alcançou o nível ${g.level}!`);
    }
  }

  /**
   * Cobrança diária. Percorre as guildas cuja hora chegou e tira `taxPct` do
   * ouro de cada membro — em memória para quem está online, direto no banco
   * para quem não está (ver `debitOfflineGold`, e o porquê de não misturar os
   * dois caminhos).
   */
  async _sweepTax() {
    const now = Date.now();
    for (const g of this.guilds.values()) {
      if (!g.nextTaxAt || now < g.nextTaxAt) continue;
      // Reagenda ANTES de cobrar: se a cobrança falhar no meio, o pior que
      // acontece é a guilda perder um dia — e não cobrar em laço a cada 5 min.
      g.nextTaxAt = now + TAX_INTERVAL_MS;

      if (!(g.taxPct > 0)) { this.db.upsertGuild(g).catch(() => {}); continue; }

      let total = 0;
      for (const [name, m] of g.members) {
        const online = this._findOnline(name);
        let charged  = 0;

        if (online) {
          charged = Math.floor((online.gold || 0) * g.taxPct);
          if (charged > 0) {
            online.gold -= charged;
            this.journal?.ledger(online, this.SRC.GUILD_TAX, { gold: -charged },
              { detail: `[${g.tag}] ${(g.taxPct * 100).toFixed(1)}%` });
            this.db.save(online, true)?.catch?.(() => {});
            this.send(online.ws, { type: 'currency_update', gold: online.gold, dobroes: online.dobroes });
            this.send(online.ws, { type: 'guild_notice',
              message: `🪙 Taxa da guilda: −${charged.toLocaleString('pt-BR')} de ouro.` });
          }
        } else {
          const gold = await this.db.getPlayerGold(name);
          if (gold != null) {
            const want = Math.floor(gold * g.taxPct);
            charged = await this.db.debitOfflineGold(name, want);
            if (charged > 0) {
              this.journal?.ledgerByName?.(name, this.SRC.GUILD_TAX, { gold: -charged },
                { detail: `[${g.tag}] ${(g.taxPct * 100).toFixed(1)}%` });
            }
          }
        }

        if (charged > 0) {
          total += charged;
          m.contribGold = (m.contribGold || 0) + charged;
          this.db.upsertGuildMember(g.id, name, m).catch(() => {});
        }
      }

      g.gold = (g.gold || 0) + total;
      await this.db.upsertGuild(g);
      if (total > 0) {
        console.log(`[Guilda] taxa de [${g.tag}] ${g.name}: +${total} de ouro no cofre`);
        this._noticeAll(g, `🪙 Taxa recolhida: +${total.toLocaleString('pt-BR')} no cofre da guilda.`);
      }
      this._broadcastState(g);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Internos
  // ═══════════════════════════════════════════════════════════════════════════

  _addMember(g, name) {
    const now = Date.now();
    const m = { role: 'member', contribGold: 0, contribDobroes: 0, contribXp: 0, joinedAt: now };
    g.members.set(name, m);
    this.byPlayer.set(name, g.id);
    this.db.upsertGuildMember(g.id, name, m).catch(() => {});

    const p = this._findOnline(name);
    if (p) {
      p._guildXpMark = p.mapXp || 0;   // o XP anterior não conta para a guilda nova
      p._killGold    = 0;              // nem o ouro de abate acumulado antes dela
      this._applyBonus(p);
      this.send(p.ws, { type: 'guild_notice', message: `🏴 Você entrou em [${g.tag}] ${g.name}!` });
      this.sendState(p);
    }
    this._noticeAll(g, `⚓ ${name} entrou na guilda.`, name);
    this._broadcastState(g);
  }

  _removeMember(g, name) {
    g.members.delete(name);
    this.byPlayer.delete(name);
    this.db.removeGuildMember(name).catch(() => {});
    this._noticeAll(g, `${name} deixou a guilda.`);
  }

  /** O líder saiu: a irmandade acaba, e todo mundo online sabe na hora. */
  _disband(g, leader) {
    const names = [...g.members.keys()];
    for (const name of names) {
      this.byPlayer.delete(name);
      const p = this._findOnline(name);
      if (!p) continue;
      this._applyBonus(p);
      if (name !== leader.name) {
        this.send(p.ws, { type: 'guild_notice', message: `🏴 A guilda [${g.tag}] ${g.name} foi dissolvida.` });
      }
      this.sendState(p);
    }
    this.guilds.delete(g.id);
    this.db.deleteGuild(g.id).catch(() => {});
    this.send(leader.ws, { type: 'guild_ok', action: 'disband',
      message: `A guilda [${g.tag}] ${g.name} foi dissolvida.` });
    console.log(`[Guilda] ${leader.name} dissolveu [${g.tag}] ${g.name}`);
  }

  /**
   * Carimba `player._guildBonus` e refaz os stats derivados. É a ÚNICA porta
   * pela qual o bônus de guilda entra no jogador — o lootMult e o recalcMaxHp
   * leem daí.
   */
  _applyBonus(player, notify = true) {
    if (!player) return;
    const antes  = player._guildBonus || NO_BONUS;
    const agora  = this.bonusFor(player);
    player._guildBonus = agora;

    // Só avisa quando algo REALMENTE mudou. Sem esta comparação, todo login
    // (inclusive de quem não tem guilda) dispararia um recálculo de stats e um
    // `inventory_update` a mais — barulho de rede por nada, e um caminho extra
    // capaz de mexer na vida do jogador onde não havia motivo.
    let mudou = false;
    for (const k in NO_BONUS) {
      if (antes[k] !== agora[k]) { mudou = true; break; }
    }
    if (!mudou) return;

    if (typeof this.onMemberStatsChanged === 'function') {
      try { this.onMemberStatsChanged(player, notify); } catch (e) {
        console.error('[Guilda] recálculo de stats:', e.message);
      }
    }
  }

  _refreshAllMembers(g) {
    for (const name of g.members.keys()) {
      const p = this._findOnline(name);
      if (p) this._applyBonus(p);
    }
  }

  _findOnline(name) {
    let found = null;
    this.players.forEach(p => { if (!found && p && p.name === name) found = p; });
    return found;
  }

  _broadcastState(g, opts = {}) {
    for (const name of g.members.keys()) {
      if (opts.except && name === opts.except) continue;
      const p = this._findOnline(name);
      if (p?.ws) this.sendState(p);
    }
  }

  _noticeAll(g, message, except = null) {
    for (const name of g.members.keys()) {
      if (except && name === except) continue;
      const p = this._findOnline(name);
      if (p?.ws) this.send(p.ws, { type: 'guild_notice', message });
    }
  }

  /**
   * A bandeira é um IDENTIFICADOR, não um arquivo enviado pelo jogador:
   * `proc:<semente>` (o cliente desenha o brasão a partir do número) ou um
   * caminho para `assets/guilds/`. Qualquer outra coisa vira uma semente — nunca
   * um caminho arbitrário, senão o campo viraria um vetor para o cliente
   * carregar o que o servidor mandar.
   */
  _sanitizeFlag(raw) {
    const s = String(raw || '').trim();
    let m = /^proc:(\d{1,10})$/.exec(s);
    if (m) return `proc:${m[1]}`;
    m = /^assets\/guilds\/([A-Za-z0-9_-]{1,48}\.(?:png|svg))$/.exec(s);
    if (m) return `assets/guilds/${m[1]}`;
    return `proc:${Math.floor(Math.random() * 1e9)}`;
  }

  _err(player, reason) {
    if (player?.ws) this.send(player.ws, { type: 'guild_error', reason });
  }
}

module.exports = GuildManager;
module.exports.GUILD_CREATE_COST = GUILD_CREATE_COST;
