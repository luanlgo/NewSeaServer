// managers/db-manager.js
const mysql = require('mysql2/promise');

// Local dev uses public proxy URL, Railway hosting uses internal URL
const rawConn =
  process.env.DATABASE_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_PUBLIC_URL ||
  process.env.MYSQL_PUBLIC_URL ||
  process.env.VITE_DATABASE_PUBLIC_URL ||
  '';
// Strip surrounding quotes if dotenv included them
const connStr = rawConn.replace(/^["']|["']$/g, '').trim();

if (!connStr) {
  console.error('❌ No database URL found! Set DATABASE_PUBLIC_URL (mysql://...) in your .env file');
  process.exit(1);
}

// Log sanitized URL
const maskedUrl = connStr.replace(/:([^:@]+)@/, ':***@');
console.log(`🔌 Connecting to DB: ${maskedUrl}`);

// Parse the connection string so we can pass explicit pool options
const dbUrl = new URL(connStr);
const pool = mysql.createPool({
  host: dbUrl.hostname,
  port: Number(dbUrl.port || 3306),
  user: decodeURIComponent(dbUrl.username),
  password: decodeURIComponent(dbUrl.password),
  database: dbUrl.pathname.replace(/^\//, '') || 'railway',
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  // mysql2 auto-parses JSON columns into JS objects on read and accepts
  // JSON.stringify'd strings on write — so the _parse/_flush logic below
  // works the same way it did under PostgreSQL/JSONB.
});

// Prevent an unhandled 'error' event from crashing the process when a pooled
// connection is terminated unexpectedly (e.g. Railway idle cutoff).
pool.on('error', (err) => {
  console.error('[DB] Pool error (connection dropped):', err.message);
});

// Default JSON blobs (kept in one place so save/batchSave stay consistent)
const DEFAULT_SKILLS = { ataque: { level: 1, xp: 0 }, velocidade: { level: 1, xp: 0 }, defesa: { level: 1, xp: 0 }, vida: { level: 1, xp: 0 } };
const DEFAULT_TALENTS = { hp: 0, defesa: 0, canhoes: 0, dano: 0, dano_relic: 0, riqueza: 0, ganancioso: 0, mestre: 0, totalSpent: 0 };
const DEFAULT_ISLAND_UPGRADES = { hpBonus: 0, defenseBonus: 0 };

class DBManager {
  constructor() {
    // Debounce timers per player name
    this._pending = new Map();
    this.DEBOUNCE_MS = 1000; // wait 1s after last kill before writing to DB

    // Cleanup automático a cada 30 segundos
    this._cleanupInterval = setInterval(() => {
      this._cleanupStaleEntries();
    }, 30000);
  }

  // Public API — debounced. urgent=true skips debounce (disconnect, purchase, etc.)
  async save(player, urgent = false) {
    if (!player || !player.name) return Promise.resolve();

    // Flush imediato para ações urgentes
    if (urgent) {
      this._clearPending(player.name);
      try {
        return await this._flush(player);
      } catch (err) {
        console.error(`[DB] Urgent save failed for ${player.name}:`, err);
      }
    }

    // Debounce com timestamp
    const now = Date.now();
    const existing = this._pending.get(player.name);

    if (existing) {
      clearTimeout(existing.timer);
      // Atualiza o player mas marca como atualizado
      existing.player = player;
      existing.lastUpdate = now;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(player.name);
        this._flush(player)
          .then(resolve)
          .catch(err => {
            console.error(`[DB] Debounced save failed for ${player.name}:`, err);
            reject(err);
          });
      }, this.DEBOUNCE_MS);

      this._pending.set(player.name, {
        timer,
        player,
        createdAt: now,
        lastUpdate: now
      });
    });
  }

  _clearPending(playerName) {
    const pending = this._pending.get(playerName);
    if (pending) {
      clearTimeout(pending.timer);
      this._pending.delete(playerName);
      // Libera referência ao player
      pending.player = null;
    }
  }

  // Limpa entradas antigas (stale)
  _cleanupStaleEntries() {
    const now = Date.now();
    const MAX_AGE = 10000; // 10 segundos

    for (const [name, pending] of this._pending.entries()) {
      // Se o timer já expirou ou passou do tempo máximo
      if (!pending.timer._idleNext || (now - pending.createdAt) > MAX_AGE) {
        console.log(`[DB] Cleaning stale entry for ${name} (age: ${now - pending.createdAt}ms)`);
        clearTimeout(pending.timer);
        pending.player = null;
        this._pending.delete(name);
      }
    }
  }

  // Actual DB write — called after debounce
  async _flush(player) {
    if (!player || !player.name) return;

    // Cópia mínima necessária
    const inventory = player.inventory || {};
    const ammoToSave = inventory.ammo ? { ...inventory.ammo } : {};
    delete ammoToSave.bala_pedra;
    delete ammoToSave.bala_ferro;

    try {
      const [result] = await pool.query(
        `UPDATE players
         SET gold=?, dobroes=?, cannons=?, pirates=?, ammo=?,
             equipped_cannons=?, equipped_pirates=?,
             ships=?, active_ship=?,
             skills=?, npc_kills=?, pvp_kills=?, difficulty=?,
             equipped_sails=?, sails_inv=?,
             map_xp=?, map_level=?,
             map_fragments=?,
             relics_inv=?, relics_equipped=?,
             talents=?, talent_builds=?,
             ship_island_upgrades=?,
             cannon_upgrades_data=?,
             iron_plates=?, gold_dust=?, gunpowder=?,
             bonus_maps_unlocked=?,
             cannon_research_level=?, ship_material_level=?,
             map_pieces=?, rare_ships=?,
             hp=?,
             current_ammo=?,
             bank_gold=?,
             bank_unlocked=?,
             bonus_inventory=?,
             active_bonus_ship_stats=?,
             owned_pets=?,
             equipped_pet=?,
             pet_levels=?,
             pet_xp=?,
             pet_relics=?,
             pet_food=?,
             run_stock=?,
             tutorial_state=?,
             afk_until=?,
             last_seen=NOW()
         WHERE name=?`,
        [
          player.gold || 0,
          player.dobroes || 0,
          JSON.stringify(inventory.cannons || []),
          JSON.stringify(inventory.pirates || []),
          JSON.stringify(ammoToSave),
          JSON.stringify(player.cannons || []),
          JSON.stringify(player.pirates || []),
          JSON.stringify(inventory.ships || ['fragata']),
          player.activeShip || 'fragata',
          JSON.stringify(player.skills || DEFAULT_SKILLS),
          player.npcKills || 0,
          player.pvpKills || 0,
          player.difficulty || 0,
          JSON.stringify(player.equippedSails || []),
          JSON.stringify(inventory.sails || []),
          player.mapXp || 0,
          player.mapLevel || 1,
          player.mapFragments || 0,
          JSON.stringify(inventory.relics || []),
          JSON.stringify(player.relicDeck || []),
          JSON.stringify(player.talents || DEFAULT_TALENTS),
          JSON.stringify(player.talentBuilds || []),
          JSON.stringify(player.shipIslandUpgrades || DEFAULT_ISLAND_UPGRADES),
          JSON.stringify(player.cannonUpgradesData || []),
          player.ironPlates          || 0,
          player.goldDust            || 0,
          player.gunpowder           || 0,
          JSON.stringify(player.bonusMapsUnlocked   || []),
          player.cannonResearchLevel || 0,
          player.shipMaterialLevel   || 0,
          JSON.stringify(player.mapPieces   || {}),
          JSON.stringify(player.bonusShips  || []),
          player.hp != null ? player.hp : (player.maxHp || 100),
          player.currentAmmo || 'bala_ferro',
          player.bankGold    || 0,
          player.bankUnlocked ? 1 : 0,
          JSON.stringify(player.bonusInventory || []),
          player.activeBonusShipStats ? JSON.stringify(player.activeBonusShipStats) : null,
          JSON.stringify(player.ownedPets   || []),
          player.equippedPet || '',
          JSON.stringify(player.petLevels   || {}),
          JSON.stringify(player.petXp       || {}),
          JSON.stringify(player.petRelics   || {}),
          Number(player.inventory?.uva || 0),   // comida de pet (uva)
          Number(player.inventory?.run || 0),   // RUN da tripulação de piratas
          player.tutorialState || 0,
          player.afkTraining ? (player.afkUntil || null) : null,
          player.name, // WHERE name=?
        ]
      );

      if (result.affectedRows === 0) {
        console.warn(`[DB] No rows updated for "${player.name}"`);
      }
    } catch (error) {
      console.error(`[DB] Error flushing ${player.name}:`, error);
      throw error;
    }
  }

  async init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        name VARCHAR(255) PRIMARY KEY,
        gold INT NOT NULL DEFAULT 100,
        dobroes INT NOT NULL DEFAULT 0,
        cannons JSON,
        pirates JSON,
        ammo JSON,
        equipped_cannons JSON,
        equipped_pirates JSON,
        equipped_sails JSON,
        sails_inv JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Add columns (mantido seu código de migração)
    await this._addColumns();
    await this._ensureAuctionsTable();
    await this._ensureMailTable();
    await this._ensureJournalTables();
    await this._ensureGuildTables();
    await this._ensureIslandTables();

    console.log('💾 MySQL ready');
  }

  // ── Diário do capitão + relatórios de batalha ──────────────────────────────
  //
  // `battle_reports` guarda o relatório inteiro como JSON de uma vez. Não é
  // preguiça de modelar: o relatório é um DOCUMENTO IMUTÁVEL — a fotografia da
  // batalha no instante em que ela aconteceu. Normalizar em colunas convidaria
  // a "corrigir" um relatório antigo quando o balanceamento mudasse, e é
  // exatamente isso que ele não pode sofrer. Ninguém consulta por dentro dele:
  // a busca é por id, e as duas colunas de nome existem só para autorizar a
  // leitura de quem lutou.
  async _ensureJournalTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS battle_reports (
        id            BIGINT AUTO_INCREMENT PRIMARY KEY,
        attacker_name VARCHAR(255) NOT NULL,
        defender_name VARCHAR(255) NOT NULL,
        created_at    BIGINT NOT NULL,
        data          JSON NOT NULL,
        INDEX idx_report_attacker (attacker_name, created_at),
        INDEX idx_report_defender (defender_name, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS journal (
        id          BIGINT AUTO_INCREMENT PRIMARY KEY,
        player_name VARCHAR(255) NOT NULL,
        at          BIGINT NOT NULL,
        kind        VARCHAR(40) NOT NULL,
        data        JSON,
        report_id   BIGINT NULL,
        INDEX idx_journal_player (player_name, at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  }

  /** Uma entrada no Diário. Ver managers/journal-manager.js para os `kind`. */
  async addJournal(playerName, at, kind, data, reportId = null) {
    await pool.query(
      'INSERT INTO journal (player_name, at, kind, data, report_id) VALUES (?,?,?,?,?)',
      [playerName, at, kind, JSON.stringify(data || {}), reportId]
    );
  }

  /**
   * Página do Diário, mais recente primeiro.
   * @param {number} before  timestamp de corte para paginar ("mais antigas que")
   */
  async getJournal(playerName, limit = 60, before = 0) {
    const lim = Math.max(1, Math.min(200, limit | 0));
    const params = [playerName];
    let where = 'player_name = ?';
    if (before > 0) { where += ' AND at < ?'; params.push(Number(before)); }
    const [rows] = await pool.query(
      `SELECT id, at, kind, data, report_id FROM journal
       WHERE ${where} ORDER BY at DESC, id DESC LIMIT ${lim}`,
      params
    );
    return rows.map(r => ({
      id:       Number(r.id),
      at:       Number(r.at),
      kind:     r.kind,
      data:     r.data || {},
      reportId: r.report_id != null ? Number(r.report_id) : null,
    }));
  }

  /** Grava o relatório e devolve o id gerado (é o que vai para o Diário). */
  async saveBattleReport(report) {
    const [res] = await pool.query(
      'INSERT INTO battle_reports (attacker_name, defender_name, created_at, data) VALUES (?,?,?,?)',
      [report.attackerName, report.defenderName, report.at || Date.now(), JSON.stringify(report)]
    );
    return Number(res.insertId);
  }

  /**
   * Anexa o saque ao relatório. É a ÚNICA escrita permitida depois da criação,
   * e acontece no mesmo minuto: o saque é o desfecho da batalha, não uma
   * revisão dela.
   */
  async updateBattleReportLoot(reportId, looted) {
    const [rows] = await pool.query('SELECT data FROM battle_reports WHERE id = ?', [reportId]);
    if (!rows.length) return;
    const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    data.resourcesLooted = looted;
    await pool.query('UPDATE battle_reports SET data = ? WHERE id = ?', [JSON.stringify(data), reportId]);
  }

  /** Relatório por id. Só o atacante e o defendido daquela batalha leem. */
  async getBattleReport(reportId, playerName) {
    const [rows] = await pool.query(
      `SELECT data FROM battle_reports
       WHERE id = ? AND (attacker_name = ? OR defender_name = ?)`,
      [reportId, playerName, playerName]
    );
    if (!rows.length) return null;
    return typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
  }

  // ── Correio entre jogadores ────────────────────────────────────────────────
  async _ensureMailTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mail (
        id          BIGINT AUTO_INCREMENT PRIMARY KEY,
        from_name   VARCHAR(255) NOT NULL,
        to_name     VARCHAR(255) NOT NULL,
        title       VARCHAR(140) NOT NULL,
        body        TEXT NOT NULL,
        is_read     TINYINT(1) NOT NULL DEFAULT 0,
        created_at  BIGINT NOT NULL,
        INDEX idx_mail_to (to_name, created_at),
        INDEX idx_mail_from (from_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  }

  // Insere uma mensagem. Retorna o id gerado.
  async sendMail(fromName, toName, title, body) {
    const [res] = await pool.query(
      'INSERT INTO mail (from_name, to_name, title, body, created_at) VALUES (?,?,?,?,?)',
      [fromName, toName, title, body, Date.now()]
    );
    return Number(res.insertId);
  }

  // Caixa de entrada de um jogador (mais recentes primeiro).
  async getInbox(name, limit = 50) {
    const lim = Math.max(1, Math.min(200, limit | 0));
    const [rows] = await pool.query(
      `SELECT id, from_name, title, body, is_read, created_at
       FROM mail WHERE to_name = ? ORDER BY created_at DESC LIMIT ${lim}`,
      [name]
    );
    return rows.map(r => ({
      id:    Number(r.id),
      from:  r.from_name,
      title: r.title,
      body:  r.body,
      read:  !!r.is_read,
      at:    Number(r.created_at),
    }));
  }

  // Nomes para os quais o jogador já enviou (lista de "contatos", recentes 1º).
  async getSentContacts(name, limit = 30) {
    const lim = Math.max(1, Math.min(100, limit | 0));
    const [rows] = await pool.query(
      `SELECT to_name, MAX(created_at) AS last_at FROM mail
       WHERE from_name = ? GROUP BY to_name ORDER BY last_at DESC LIMIT ${lim}`,
      [name]
    );
    return rows.map(r => r.to_name);
  }

  // Busca nomes de contas por trecho (para o autocomplete do envio).
  async searchPlayerNames(query, limit = 20) {
    const lim = Math.max(1, Math.min(50, limit | 0));
    const safe = String(query).replace(/[%_\\]/g, c => '\\' + c);
    const [rows] = await pool.query(
      `SELECT name FROM players WHERE name LIKE ? ORDER BY name LIMIT ${lim}`,
      [`%${safe}%`]
    );
    return rows.map(r => r.name);
  }

  async playerExists(name) {
    const [rows] = await pool.query('SELECT 1 FROM players WHERE name = ? LIMIT 1', [name]);
    return rows.length > 0;
  }

  // Marca uma mensagem como lida (autorizada pelo destinatário).
  async markMailRead(id, toName) {
    await pool.query('UPDATE mail SET is_read = 1 WHERE id = ? AND to_name = ?', [id, toName]);
  }

  async countUnread(name) {
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS c FROM mail WHERE to_name = ? AND is_read = 0', [name]);
    return Number(rows[0] && rows[0].c || 0);
  }

  // ── Leilão de navios raros ────────────────────────────────────────────────
  //
  // Duas tabelas, e a segunda existe por um motivo só: o leilão VENCE sozinho,
  // no relógio, sem ninguém online. Quando isso acontece há ouro para pagar ao
  // vendedor e um navio para entregar ao vencedor — e os dois podem estar
  // dormindo. `auction_deliveries` é a caixa onde esse pagamento espera. Sem
  // ela, resolver um leilão exigiria carregar e gravar a linha de um jogador
  // offline, que é justamente a corrida que estraga um save quando ele loga no
  // meio da operação.
  async _ensureAuctionsTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auctions (
        id          VARCHAR(255) PRIMARY KEY,
        ship_data   JSON NOT NULL,
        owner_id    VARCHAR(255) NOT NULL,
        owner_name  VARCHAR(255) NOT NULL,
        min_bid     INT NOT NULL DEFAULT 0,
        top_bid     INT NOT NULL DEFAULT 0,
        bids        JSON,
        ends_at     BIGINT NOT NULL,
        created_at  BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Quem está ganhando agora. Dava para deduzir do último item de `bids`,
    // mas aí toda leitura passaria a depender da ordem do array — e um dia
    // alguém ordena aquilo por valor e o leilão paga a pessoa errada.
    const cols = [
      "ALTER TABLE auctions ADD COLUMN top_bidder_id   VARCHAR(255) DEFAULT NULL",
      "ALTER TABLE auctions ADD COLUMN top_bidder_name VARCHAR(255) DEFAULT NULL",
    ];
    for (const sql of cols) {
      try {
        await pool.query(sql);
      } catch (err) {
        if (err.errno !== 1060) console.error('[DB] auctions migration:', err.message);
      }
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS auction_deliveries (
        id         BIGINT AUTO_INCREMENT PRIMARY KEY,
        to_name    VARCHAR(255) NOT NULL,
        reason     VARCHAR(32)  NOT NULL,
        gold       INT          NOT NULL DEFAULT 0,
        ship_data  JSON         NULL,
        created_at BIGINT       NOT NULL,
        INDEX idx_adeliv_to (to_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  }

  // Grava UM leilão. Antes isto era um DELETE da tabela inteira seguido de
  // reinserção de tudo: além de ser O(n) a cada lance, apagava o leilão que
  // outro jogador tivesse criado entre a leitura e a escrita.
  async upsertAuction(a) {
    try {
      await pool.query(
        `INSERT INTO auctions
           (id, ship_data, owner_id, owner_name, min_bid, top_bid, bids,
            top_bidder_id, top_bidder_name, ends_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           top_bid         = VALUES(top_bid),
           bids            = VALUES(bids),
           top_bidder_id   = VALUES(top_bidder_id),
           top_bidder_name = VALUES(top_bidder_name)`,
        [
          a.id,
          JSON.stringify(a.shipData),
          a.ownerId,
          a.ownerName,
          a.minBid,
          a.topBid || 0,
          JSON.stringify(a.bids || []),
          a.topBidderId   || null,
          a.topBidderName || null,
          a.endsAt,
          a.createdAt || Date.now(),
        ]
      );
    } catch (err) {
      console.error('[DB] Error saving auction:', err);
    }
  }

  // Carrega TODOS os leilões, inclusive os já vencidos. O filtro `ends_at >
  // now` que morava aqui perdia exatamente os leilões que venceram com o
  // servidor fora do ar — e com eles o navio, que não está em lugar nenhum
  // enquanto o leilão corre. Quem decide o que fazer com um leilão vencido é a
  // varredura do AuctionManager, não a consulta.
  async loadAuctions() {
    try {
      const [rows] = await pool.query('SELECT * FROM auctions');
      return rows.map(r => ({
        id:            r.id,
        shipData:      r.ship_data,
        ownerId:       r.owner_id,
        ownerName:     r.owner_name,
        minBid:        Number(r.min_bid),
        topBid:        Number(r.top_bid),
        bids:          r.bids || [],
        topBidderId:   r.top_bidder_id   || null,
        topBidderName: r.top_bidder_name || null,
        endsAt:        Number(r.ends_at),
        createdAt:     Number(r.created_at),
      }));
    } catch (err) {
      console.error('[DB] Error loading auctions:', err);
      return [];
    }
  }

  async deleteAuction(auctionId) {
    try {
      await pool.query('DELETE FROM auctions WHERE id = ?', [auctionId]);
    } catch (err) {
      console.error('[DB] Error deleting auction:', err);
    }
  }

  /** Enfileira ouro e/ou navio para um jogador que não está online. */
  async addAuctionDelivery(toName, reason, gold, shipData) {
    try {
      await pool.query(
        `INSERT INTO auction_deliveries (to_name, reason, gold, ship_data, created_at)
         VALUES (?,?,?,?,?)`,
        [toName, reason, gold | 0, shipData ? JSON.stringify(shipData) : null, Date.now()]
      );
    } catch (err) {
      console.error('[DB] Error queueing auction delivery:', err);
    }
  }

  /**
   * Retira (lê e apaga) tudo que espera por um jogador. Apagar junto é de
   * propósito: entregue duas vezes é pior que não entregue, e o chamador
   * aplica no player em memória logo em seguida, dentro do mesmo login.
   */
  async takeAuctionDeliveries(toName) {
    try {
      const [rows] = await pool.query(
        'SELECT * FROM auction_deliveries WHERE to_name = ? ORDER BY created_at ASC', [toName]);
      if (rows.length === 0) return [];
      await pool.query('DELETE FROM auction_deliveries WHERE to_name = ?', [toName]);
      return rows.map(r => ({
        reason:    r.reason,
        gold:      Number(r.gold || 0),
        shipData:  r.ship_data || null,
        createdAt: Number(r.created_at),
      }));
    } catch (err) {
      console.error('[DB] Error taking auction deliveries:', err);
      return [];
    }
  }

  // ── Guildas ────────────────────────────────────────────────────────────────
  //
  // Três tabelas, e a divisão importa:
  //
  //   `guilds`               a irmandade em si — cofre, nível, skills, taxa.
  //   `guild_members`        quem pertence a quê. A CHAVE PRIMÁRIA é o nome do
  //                          jogador, e é ela que garante "uma guilda por
  //                          pirata" no banco, e não só na memória do manager.
  //   `guild_applications`   pedidos de entrada pendentes.
  //
  // Por que a filiação NÃO é uma coluna em `players`: a linha do jogador é
  // reescrita inteira pelo batchSave a cada 15s a partir de uma cópia em
  // memória. Foi exatamente isso que apagou os navios raros uma vez (ver
  // `rare_ships` no topo deste arquivo). Filiação, contribuição e cofre da
  // guilda são escritos SÓ por aqui, num caminho que ninguém sobrescreve em
  // lote — nenhuma corrida possível entre o cofre e o autosave do jogador.
  async _ensureGuildTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS guilds (
        id           VARCHAR(64)  PRIMARY KEY,
        name         VARCHAR(64)  NOT NULL,
        tag          VARCHAR(16)  NOT NULL,
        flag         VARCHAR(128) NOT NULL DEFAULT '',
        leader_name  VARCHAR(255) NOT NULL,
        gold         BIGINT       NOT NULL DEFAULT 0,
        dobroes      BIGINT       NOT NULL DEFAULT 0,
        level        INT          NOT NULL DEFAULT 1,
        xp           BIGINT       NOT NULL DEFAULT 0,
        tax_pct      FLOAT        NOT NULL DEFAULT 0,
        skills       JSON,
        island       JSON,
        next_tax_at  BIGINT       NOT NULL DEFAULT 0,
        created_at   BIGINT       NOT NULL,
        UNIQUE KEY uq_guild_name (name),
        UNIQUE KEY uq_guild_tag  (tag)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS guild_members (
        player_name  VARCHAR(255) PRIMARY KEY,
        guild_id     VARCHAR(64)  NOT NULL,
        role         VARCHAR(16)  NOT NULL DEFAULT 'member',
        contrib_gold BIGINT       NOT NULL DEFAULT 0,
        contrib_dobroes BIGINT    NOT NULL DEFAULT 0,
        contrib_xp   BIGINT       NOT NULL DEFAULT 0,
        joined_at    BIGINT       NOT NULL,
        INDEX idx_gmember_guild (guild_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Migração para quem já rodou uma versão anterior destas tabelas.
    // 1060 = coluna duplicada, que é o caso normal daqui em diante.
    for (const sql of [
      'ALTER TABLE guild_members ADD COLUMN contrib_dobroes BIGINT NOT NULL DEFAULT 0',
    ]) {
      try { await pool.query(sql); }
      catch (err) { if (err.errno !== 1060) console.error('[DB] guilds migration:', err.message); }
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS guild_applications (
        guild_id    VARCHAR(64)  NOT NULL,
        player_name VARCHAR(255) NOT NULL,
        created_at  BIGINT       NOT NULL,
        PRIMARY KEY (guild_id, player_name),
        INDEX idx_gapp_player (player_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  }

  /** Carrega TODAS as guildas com seus membros e pedidos. Chamado uma vez no boot. */
  async loadGuilds() {
    const [gRows] = await pool.query('SELECT * FROM guilds');
    const [mRows] = await pool.query('SELECT * FROM guild_members');
    const [aRows] = await pool.query('SELECT * FROM guild_applications');

    const guilds = new Map();
    for (const r of gRows) {
      guilds.set(r.id, {
        id:         r.id,
        name:       r.name,
        tag:        r.tag,
        flag:       r.flag || '',
        leaderName: r.leader_name,
        gold:       Number(r.gold    || 0),
        dobroes:    Number(r.dobroes || 0),
        level:      Number(r.level   || 1),
        xp:         Number(r.xp      || 0),
        taxPct:     Number(r.tax_pct || 0),
        skills:     r.skills || {},
        island:     r.island || null,
        nextTaxAt:  Number(r.next_tax_at || 0),
        createdAt:  Number(r.created_at  || 0),
        members:      new Map(),   // playerName → { role, contribGold, contribXp, joinedAt }
        applications: new Map(),   // playerName → createdAt
      });
    }

    // Membro cuja guilda sumiu é lixo de uma remoção interrompida: some junto,
    // senão o jogador fica preso a um id que não existe e não consegue entrar
    // em guilda nenhuma para sempre.
    const orphanMembers = [];
    for (const r of mRows) {
      const g = guilds.get(r.guild_id);
      if (!g) { orphanMembers.push(r.player_name); continue; }
      g.members.set(r.player_name, {
        role:        r.role || 'member',
        contribGold:    Number(r.contrib_gold    || 0),
        contribDobroes: Number(r.contrib_dobroes || 0),
        contribXp:      Number(r.contrib_xp      || 0),
        joinedAt:    Number(r.joined_at    || 0),
      });
    }
    if (orphanMembers.length) {
      await pool.query('DELETE FROM guild_members WHERE player_name IN (?)', [orphanMembers]);
      console.warn(`[Guilda] ${orphanMembers.length} filiacao(oes) orfa(s) removida(s)`);
    }

    for (const r of aRows) {
      const g = guilds.get(r.guild_id);
      if (g) g.applications.set(r.player_name, Number(r.created_at || 0));
    }

    return guilds;
  }

  /** Grava a guilda inteira (menos membros e pedidos, que têm caminho próprio). */
  async upsertGuild(g) {
    try {
      await pool.query(
        `INSERT INTO guilds
           (id, name, tag, flag, leader_name, gold, dobroes, level, xp,
            tax_pct, skills, island, next_tax_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           name        = VALUES(name),
           tag         = VALUES(tag),
           flag        = VALUES(flag),
           leader_name = VALUES(leader_name),
           gold        = VALUES(gold),
           dobroes     = VALUES(dobroes),
           level       = VALUES(level),
           xp          = VALUES(xp),
           tax_pct     = VALUES(tax_pct),
           skills      = VALUES(skills),
           island      = VALUES(island),
           next_tax_at = VALUES(next_tax_at)`,
        [
          g.id, g.name, g.tag, g.flag || '', g.leaderName,
          Math.round(g.gold || 0), Math.round(g.dobroes || 0),
          g.level || 1, Math.round(g.xp || 0),
          g.taxPct || 0,
          JSON.stringify(g.skills || {}),
          g.island ? JSON.stringify(g.island) : null,
          Math.round(g.nextTaxAt || 0),
          Math.round(g.createdAt || Date.now()),
        ]
      );
      return true;
    } catch (err) {
      // 1062 = chave duplicada (nome ou tag já existe). O manager traduz isso
      // em recado ao jogador, então não é erro de servidor.
      if (err.errno === 1062) return false;
      console.error('[DB] Erro ao salvar guilda:', err.message);
      return false;
    }
  }

  async deleteGuild(guildId) {
    try {
      await pool.query('DELETE FROM guild_members      WHERE guild_id=?', [guildId]);
      await pool.query('DELETE FROM guild_applications WHERE guild_id=?', [guildId]);
      await pool.query('DELETE FROM guilds             WHERE id=?',       [guildId]);
    } catch (err) {
      console.error('[DB] Erro ao apagar guilda:', err.message);
    }
  }

  async upsertGuildMember(guildId, playerName, m) {
    try {
      await pool.query(
        `INSERT INTO guild_members
           (player_name, guild_id, role, contrib_gold, contrib_dobroes, contrib_xp, joined_at)
         VALUES (?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           guild_id        = VALUES(guild_id),
           role            = VALUES(role),
           contrib_gold    = VALUES(contrib_gold),
           contrib_dobroes = VALUES(contrib_dobroes),
           contrib_xp      = VALUES(contrib_xp)`,
        [playerName, guildId, m.role || 'member',
         Math.round(m.contribGold || 0), Math.round(m.contribDobroes || 0),
         Math.round(m.contribXp || 0),
         Math.round(m.joinedAt || Date.now())]
      );
    } catch (err) {
      console.error('[DB] Erro ao salvar membro de guilda:', err.message);
    }
  }

  async removeGuildMember(playerName) {
    try {
      await pool.query('DELETE FROM guild_members WHERE player_name=?', [playerName]);
    } catch (err) {
      console.error('[DB] Erro ao remover membro de guilda:', err.message);
    }
  }

  async addGuildApplication(guildId, playerName) {
    try {
      await pool.query(
        'INSERT IGNORE INTO guild_applications (guild_id, player_name, created_at) VALUES (?,?,?)',
        [guildId, playerName, Date.now()]
      );
    } catch (err) {
      console.error('[DB] Erro ao salvar pedido de guilda:', err.message);
    }
  }

  /**
   * XP e abates de uma lista de jogadores, por NOME. O líder precisa disto para
   * julgar um pedido de entrada: quem está online tem o número na memória do
   * servidor, quem não está só existe no banco — e um pedido de quem está
   * offline é a regra, não a exceção.
   *
   * Uma consulta só para a lista inteira (IN (...)): a alternativa era um
   * SELECT por candidato, e o líder que abre a aba com dez pedidos pagaria dez
   * viagens ao banco por abertura.
   *
   * @returns {Map<string, {xp:number, npcKills:number, mapLevel:number}>}
   */
  async getPlayerProgress(names = []) {
    const lista = [...new Set(names.map(String))].filter(Boolean);
    const out = new Map();
    if (!lista.length) return out;
    try {
      const marks = lista.map(() => '?').join(',');
      const [rows] = await pool.query(
        `SELECT name, map_xp, npc_kills, map_level FROM players WHERE name IN (${marks})`,
        lista
      );
      for (const r of rows) {
        out.set(r.name, {
          xp:       Number(r.map_xp     || 0),
          npcKills: Number(r.npc_kills  || 0),
          mapLevel: Number(r.map_level  || 1),
        });
      }
    } catch (err) {
      console.error('[DB] Erro ao ler progresso de jogadores:', err.message);
    }
    return out;
  }

  async removeGuildApplication(guildId, playerName) {
    try {
      await pool.query('DELETE FROM guild_applications WHERE guild_id=? AND player_name=?',
        [guildId, playerName]);
    } catch (err) {
      console.error('[DB] Erro ao remover pedido de guilda:', err.message);
    }
  }

  /**
   * Ouro na conta de um jogador OFFLINE. A taxa diária precisa disto: o ouro de
   * quem está online mora na memória do servidor, mas o de quem não está só
   * existe no banco.
   */
  async getPlayerGold(name) {
    try {
      const [rows] = await pool.query('SELECT gold FROM players WHERE name=?', [name]);
      return rows.length ? Number(rows[0].gold || 0) : null;
    } catch (err) {
      console.error('[DB] Erro ao ler ouro de jogador:', err.message);
      return null;
    }
  }

  /**
   * Debita ouro de um jogador OFFLINE direto no banco. GREATEST(...,0) impede
   * saldo negativo mesmo se algo mudar entre a leitura e a escrita, e o
   * `affectedRows` diz se a linha existia.
   *
   * NUNCA usar para jogador online: a linha dele é reescrita inteira pelo
   * autosave a partir da memória, e a subtração seria desfeita 15 segundos
   * depois sem deixar rastro.
   */
  async debitOfflineGold(name, amount) {
    const amt = Math.max(0, Math.round(amount || 0));
    if (!amt) return 0;
    try {
      const [res] = await pool.query(
        'UPDATE players SET gold = GREATEST(0, gold - ?) WHERE name=?', [amt, name]
      );
      return res.affectedRows ? amt : 0;
    } catch (err) {
      console.error('[DB] Erro ao cobrar taxa de guilda:', err.message);
      return 0;
    }
  }

  // ── Ilhas das guildas ──────────────────────────────────────────────────────
  //
  // UMA linha por ilha, e as três nascem no boot se não existirem. A tabela é
  // pequena e escrita a cada mudança de estado (torre caiu, ilha trocou de dono,
  // imposto entrou) — não há caminho em lote nenhum tocando nela, então não há
  // a corrida que já apagou `rare_ships` uma vez (ver o topo deste arquivo).
  //
  // `towers` e `damage_rank` são JSON de propósito: os cinco slots e o ranking
  // de dano são lidos e escritos SEMPRE inteiros, nunca por dentro. Normalizar
  // daria duas tabelas filhas e cinco UPDATEs por salva de torre para ganhar
  // consultas que ninguém faz.
  //
  // O imposto (`tax_pot`) é BIGINT: uma semana de 25% sobre a economia de um
  // servidor cheio passa folgado do teto do INT.
  async _ensureIslandTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS islands (
        id               INT          PRIMARY KEY,
        map_level        INT          NOT NULL,
        state            VARCHAR(16)  NOT NULL DEFAULT 'neutral',
        owner_guild_id   VARCHAR(64)  DEFAULT NULL,
        owner_since      BIGINT       NOT NULL DEFAULT 0,
        grace_until      BIGINT       NOT NULL DEFAULT 0,
        conquered_week   VARCHAR(16)  DEFAULT NULL,
        tax_pot          BIGINT       NOT NULL DEFAULT 0,
        next_event_at    BIGINT       NOT NULL DEFAULT 0,
        last_event_week  VARCHAR(16)  DEFAULT NULL,
        towers           JSON,
        damage_rank      JSON,
        updated_at       BIGINT       NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  }

  /** Carrega as três ilhas. Devolve Map id → linha já desserializada. */
  async loadIslands() {
    const [rows] = await pool.query('SELECT * FROM islands');
    const out = new Map();
    for (const r of rows) {
      out.set(Number(r.id), {
        id:            Number(r.id),
        mapLevel:      Number(r.map_level),
        state:         r.state || 'neutral',
        ownerGuildId:  r.owner_guild_id || null,
        ownerSince:    Number(r.owner_since   || 0),
        graceUntil:    Number(r.grace_until   || 0),
        conqueredWeek: r.conquered_week || null,
        taxPot:        Number(r.tax_pot       || 0),
        nextEventAt:   Number(r.next_event_at || 0),
        lastEventWeek: r.last_event_week || null,
        towers:        Array.isArray(r.towers) ? r.towers : [],
        damageRank:    (r.damage_rank && typeof r.damage_rank === 'object') ? r.damage_rank : {},
      });
    }
    return out;
  }

  /** Grava UMA ilha inteira. Chamado a cada mudança de estado. */
  async upsertIsland(i) {
    try {
      await pool.query(
        `INSERT INTO islands
           (id, map_level, state, owner_guild_id, owner_since, grace_until,
            conquered_week, tax_pot, next_event_at, last_event_week,
            towers, damage_rank, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           map_level       = VALUES(map_level),
           state           = VALUES(state),
           owner_guild_id  = VALUES(owner_guild_id),
           owner_since     = VALUES(owner_since),
           grace_until     = VALUES(grace_until),
           conquered_week  = VALUES(conquered_week),
           tax_pot         = VALUES(tax_pot),
           next_event_at   = VALUES(next_event_at),
           last_event_week = VALUES(last_event_week),
           towers          = VALUES(towers),
           damage_rank     = VALUES(damage_rank),
           updated_at      = VALUES(updated_at)`,
        [
          i.id, i.mapLevel, i.state, i.ownerGuildId || null,
          Math.round(i.ownerSince  || 0), Math.round(i.graceUntil || 0),
          i.conqueredWeek || null,
          Math.round(i.taxPot      || 0),
          Math.round(i.nextEventAt || 0),
          i.lastEventWeek || null,
          JSON.stringify(i.towers     || []),
          JSON.stringify(i.damageRank || {}),
          Date.now(),
        ]
      );
    } catch (err) {
      console.error('[DB] Erro ao salvar ilha:', err.message);
    }
  }

  /**
   * Credita ouro a um jogador OFFLINE. O espólio da coleta é dividido entre
   * quem participou, e participar não obriga ninguém a ficar online até o fim —
   * inclusive porque durante o evento morrer é comum.
   *
   * O par do `debitOfflineGold` (guildas). Mesma regra dura: NUNCA usar em
   * jogador online, cuja linha é reescrita pelo autosave a partir da memória.
   */
  async creditOfflineGold(name, amount) {
    const amt = Math.max(0, Math.round(amount || 0));
    if (!amt) return 0;
    try {
      const [res] = await pool.query(
        'UPDATE players SET gold = gold + ? WHERE name=?', [amt, name]
      );
      return res.affectedRows ? amt : 0;
    } catch (err) {
      console.error('[DB] Erro ao creditar espólio da coleta:', err.message);
      return 0;
    }
  }

  async _addColumns() {
    // MySQL não tem "ADD COLUMN IF NOT EXISTS" — erros de coluna duplicada
    // (ER_DUP_FIELDNAME / errno 1060) são ignorados abaixo.
    const columns = [
      "ALTER TABLE players ADD COLUMN equipped_cannons JSON",
      "ALTER TABLE players ADD COLUMN equipped_sails JSON",
      "ALTER TABLE players ADD COLUMN sails_inv JSON",
      "ALTER TABLE players ADD COLUMN equipped_pirates JSON",
      "ALTER TABLE players ADD COLUMN ships JSON",
      "ALTER TABLE players ADD COLUMN active_ship VARCHAR(64) NOT NULL DEFAULT 'fragata'",
      "ALTER TABLE players ADD COLUMN npc_kills INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN pvp_kills INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN difficulty INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN skills JSON",
      "ALTER TABLE players ADD COLUMN map_xp INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN map_level INT NOT NULL DEFAULT 1",
      "ALTER TABLE players ADD COLUMN map_fragments INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN relics_inv JSON",
      "ALTER TABLE players ADD COLUMN relics_equipped JSON",
      "ALTER TABLE players ADD COLUMN talents JSON",
      "ALTER TABLE players ADD COLUMN talent_builds JSON",
      "ALTER TABLE players ADD COLUMN ship_island_upgrades JSON",
      "ALTER TABLE players ADD COLUMN cannon_upgrades_data JSON",
      "ALTER TABLE players ADD COLUMN iron_plates INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN gold_dust INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN gunpowder INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN bonus_maps_unlocked JSON",
      "ALTER TABLE players ADD COLUMN cannon_research_level INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN ship_material_level INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN map_pieces JSON",
      "ALTER TABLE players ADD COLUMN rare_ships JSON",
      "ALTER TABLE players ADD COLUMN bonus_inventory JSON",
      "ALTER TABLE players ADD COLUMN active_bonus_ship_stats JSON",
      "ALTER TABLE players ADD COLUMN hp INT NOT NULL DEFAULT 100",
      "ALTER TABLE players ADD COLUMN current_ammo VARCHAR(64) NOT NULL DEFAULT 'bala_ferro'",
      "ALTER TABLE players ADD COLUMN bank_gold INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN bank_unlocked TINYINT(1) NOT NULL DEFAULT 0",
      // ── Pets (Session 12) ─────────────────────────────────────────────────
      "ALTER TABLE players ADD COLUMN owned_pets    JSON",
      "ALTER TABLE players ADD COLUMN equipped_pet  VARCHAR(64) NOT NULL DEFAULT ''",
      "ALTER TABLE players ADD COLUMN pet_levels    JSON",
      "ALTER TABLE players ADD COLUMN pet_xp        JSON",
      "ALTER TABLE players ADD COLUMN pet_relics    JSON",
      "ALTER TABLE players ADD COLUMN pet_food      FLOAT NOT NULL DEFAULT 0",
      // ── RUN da tripulação de piratas ──────────────────────────────────────
      // Mesma escolha da comida de pet: uma coluna FLOAT em vez de um saco de
      // inventário genérico, porque o consumo é fracionário (garrafas/minuto).
      "ALTER TABLE players ADD COLUMN run_stock     FLOAT NOT NULL DEFAULT 0",
      // ── Auth (token de dispositivo, TOFU) ─────────────────────────────────
      "ALTER TABLE players ADD COLUMN secret_hash   VARCHAR(64) DEFAULT NULL",
      // ── Tutorial (0=pendente, 1=relíquia concedida, 2=completo) ───────────
      "ALTER TABLE players ADD COLUMN tutorial_state TINYINT NOT NULL DEFAULT 0",
      // Fim do treino AFK (ms epoch). Sem isto o estado do treino vivia só em
      // memória: um restart do servidor deixava o jogador preso no mapa 5 —
      // a torre continuava atirando (só olha mapLevel), mas o servidor não o
      // considerava mais em treino, então nada de afk_started/expiração e as
      // horas pagas eram perdidas. afkTraining é derivado desta coluna.
      "ALTER TABLE players ADD COLUMN afk_until BIGINT NULL",
      // ── Conta (cadastro com senha + email + sexo — Session 13) ────────────
      "ALTER TABLE players ADD COLUMN password_hash   VARCHAR(255) DEFAULT NULL",
      "ALTER TABLE players ADD COLUMN email           VARCHAR(255) DEFAULT NULL",
      "ALTER TABLE players ADD COLUMN gender          VARCHAR(1)   DEFAULT NULL",
      "ALTER TABLE players ADD COLUMN reset_code_hash VARCHAR(64)  DEFAULT NULL",
      "ALTER TABLE players ADD COLUMN reset_expires   BIGINT       DEFAULT NULL",
      // Índice para busca por e-mail no "esqueci minha senha"
      "CREATE INDEX idx_players_email ON players (email)",
    ];

    for (const sql of columns) {
      try {
        await pool.query(sql);
      } catch (err) {
        // Ignora coluna já existente (1060) e índice já existente (1061)
        if (err.errno !== 1060 && err.errno !== 1061) {
          console.error('Error adding column:', err.message);
        }
      }
    }
  }

  async loadOrCreate(name) {
    const [rows] = await pool.query(
      'SELECT * FROM players WHERE name = ?',
      [name]
    );
    if (rows.length === 0) {
      await pool.query(
        `INSERT INTO players (name, cannons, ships, active_ship)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE last_seen = NOW()`,
        [name, JSON.stringify(['c1', 'c1', 'c1']), JSON.stringify(['fragata']), 'fragata']
      );
      const [created] = await pool.query('SELECT * FROM players WHERE name = ?', [name]);
      console.log(`💾 New player: ${name}`);
      return this._parse(created[0]);
    }

    await pool.query('UPDATE players SET last_seen = NOW() WHERE name = ?', [name]);
    console.log(`💾 Player loaded: ${name}`);
    return this._parse(rows[0]);
  }

  _parse(row) {
    return {
      gold: row.gold,
      dobroes: row.dobroes,
      inventory: {
        cannons: row.cannons  || [],
        pirates: row.pirates  || [],
        ammo:    row.ammo     || {},
        ships:   row.ships    || ['fragata'],
        sails:   row.sails_inv || [],
        relics:  row.relics_inv || [],
      },
      equipped: {
        cannons: row.equipped_cannons || [],
        sails: row.equipped_sails || [],
        pirates: row.equipped_pirates || [],
        ship: row.active_ship || 'fragata',
        relics: row.relics_equipped || [],
      },
      skills: row.skills || { ...DEFAULT_SKILLS },
      npcKills: row.npc_kills || 0,
      pvpKills: row.pvp_kills || 0,
      difficulty: row.difficulty || 0,
      mapXp: row.map_xp || 0,
      mapLevel: row.map_level || 1,
      mapFragments: row.map_fragments || 0,
      talents: row.talents || { ...DEFAULT_TALENTS },
      talentBuilds: row.talent_builds || [],
      shipIslandUpgrades: row.ship_island_upgrades || { ...DEFAULT_ISLAND_UPGRADES },
      cannonUpgradesData: row.cannon_upgrades_data || [],
      ironPlates:          row.iron_plates          || 0,
      goldDust:            row.gold_dust            || 0,
      gunpowder:           row.gunpowder            || 0,
      bonusMapsUnlocked:   row.bonus_maps_unlocked  || [],
      mapPieces:           row.map_pieces           || {},
      bonusShips:          row.rare_ships            || [],
      bonusInventory:         row.bonus_inventory           || [],
      activeBonusShipStats:   row.active_bonus_ship_stats   || null,
      hp:                  row.hp != null ? row.hp : 100,
      currentAmmo:         row.current_ammo || 'bala_ferro',
      bankGold:            row.bank_gold    || 0,
      bankUnlocked:        !!row.bank_unlocked,
      cannonResearchLevel: row.cannon_research_level || 0,
      shipMaterialLevel:   row.ship_material_level  || 0,
      // ── Pets ────────────────────────────────────────────────────────────
      ownedPets:    row.owned_pets   || [],
      equippedPet:  row.equipped_pet || '',
      petLevels:    row.pet_levels   || {},
      petXp:        row.pet_xp       || {},
      petRelics:    row.pet_relics   || {},
      petFood:      Number(row.pet_food || 0),
      // ── Piratas ─────────────────────────────────────────────────────────
      // O alistamento e o embarque não precisam de coluna nova: são as mesmas
      // `pirates` / `equipped_pirates` que os curandeiros já usavam.
      runStock:     Number(row.run_stock || 0),
      tutorialState: row.tutorial_state || 0,
      // Treino AFK: `afkTraining` é derivado — se o prazo já passou o jogador
      // volta como não-treinando e o tick de expiração o devolve ao mapa.
      afkUntil:     row.afk_until ? Number(row.afk_until) : null,
      afkTraining:  !!(row.afk_until && Number(row.afk_until) > Date.now()),
      // ── Auth ────────────────────────────────────────────────────────────
      secretHash:   row.secret_hash  || null,
      passwordHash: row.password_hash || null,
      email:        row.email  || null,
      gender:       row.gender || '',
      resetCodeHash: row.reset_code_hash || null,
      resetExpires:  row.reset_expires != null ? Number(row.reset_expires) : 0,
    };
  }

  // ── Rankings (top jogadores) ───────────────────────────────────────────────
  // Uma query cobre as 4 categorias; cache de 60s protege o MySQL do Railway
  // (o painel pede a cada troca de aba). Quem está online pode aparecer até
  // ~15s defasado (intervalo do batchSave) — aceitável para ranking.
  async getRankings() {
    const now = Date.now();
    if (this._rankingsCache && (now - this._rankingsCacheAt) < 60000) {
      return this._rankingsCache;
    }
    const [rows] = await pool.query(
      'SELECT name, map_level, map_xp, npc_kills, pvp_kills, pet_levels FROM players'
    );

    // xp: o XP acumulado é o critério — é lifetime e nunca reseta. `map_level`
    // NÃO serve pra ordenar: é só o mapa em que o jogador está agora e muda a
    // cada travessia de borda, então quem estava no 5 e voltou pro 1 despencava
    // no ranking. Fica como valor exibido (e desempate) apenas.
    const xp = rows
      .map(r => ({ name: r.name, value: r.map_level || 1, xp: r.map_xp || 0 }))
      .sort((a, b) => (b.xp - a.xp) || (b.value - a.value));

    const byValueDesc = (a, b) => b.value - a.value;
    const npcKills = rows
      .map(r => ({ name: r.name, value: r.npc_kills || 0 }))
      .filter(e => e.value > 0)
      .sort(byValueDesc);
    const pvpKills = rows
      .map(r => ({ name: r.name, value: r.pvp_kills || 0 }))
      .filter(e => e.value > 0)
      .sort(byValueDesc);

    // pet: maior nível entre os pets do jogador; soma dos níveis desempata
    const pet = rows
      .map(r => {
        const levels = Object.values(r.pet_levels || {}).map(Number);
        return {
          name: r.name,
          value: levels.length ? Math.max(...levels) : 0,
          total: levels.reduce((s, l) => s + l, 0),
        };
      })
      .filter(e => e.value > 0)
      .sort((a, b) => (b.value - a.value) || (b.total - a.total));

    this._rankingsCache   = { xp, npc_kills: npcKills, pvp_kills: pvpKills, pet };
    this._rankingsCacheAt = now;
    return this._rankingsCache;
  }

  // Vincula (ou atualiza) o hash do token de dispositivo de uma conta.
  async setSecretHash(name, hash) {
    await pool.query('UPDATE players SET secret_hash = ? WHERE name = ?', [hash, name]);
  }

  // ── Conta: cadastro / senha / recuperação ──────────────────────────────────

  // Carrega uma conta SEM criar (login exige conta existente). null se não existe.
  async load(name) {
    const [rows] = await pool.query('SELECT * FROM players WHERE name = ?', [name]);
    if (rows.length === 0) return null;
    await pool.query('UPDATE players SET last_seen = NOW() WHERE name = ?', [name]);
    return this._parse(rows[0]);
  }

  // Cria a conta do cadastro (nome + email + senha + sexo). Lança se nome duplicado.
  async createAccount({ name, email, passwordHash, gender }) {
    await pool.query(
      `INSERT INTO players (name, email, password_hash, gender, cannons, ships, active_ship)
       VALUES (?,?,?,?,?,?,?)`,
      [name, email, passwordHash, gender || null,
       JSON.stringify(['c1', 'c1', 'c1']), JSON.stringify(['fragata']), 'fragata']
    );
    console.log(`💾 New account: ${name} <${email}>`);
  }

  // Nome da conta vinculada a um e-mail (null se nenhum).
  async findNameByEmail(email) {
    const [rows] = await pool.query(
      'SELECT name FROM players WHERE email = ? LIMIT 1', [email]
    );
    return rows.length > 0 ? rows[0].name : null;
  }

  // Define a senha de uma conta existente (upgrade de conta legada, sem email).
  async setPassword(name, passwordHash) {
    await pool.query(
      'UPDATE players SET password_hash = ?, reset_code_hash = NULL, reset_expires = NULL WHERE name = ?',
      [passwordHash, name]
    );
  }

  // Guarda o código de recuperação (hash) + expiração (epoch ms).
  async setResetCode(name, codeHash, expires) {
    await pool.query(
      'UPDATE players SET reset_code_hash = ?, reset_expires = ? WHERE name = ?',
      [codeHash, expires, name]
    );
  }

  // Conclui a recuperação: nova senha, limpa o código e DESVINCULA o token de
  // dispositivo (secret_hash) — quem recuperou provavelmente está em outro
  // dispositivo, e o próximo login re-vincula via TOFU.
  async resetPassword(name, passwordHash) {
    await pool.query(
      `UPDATE players SET password_hash = ?, reset_code_hash = NULL,
              reset_expires = NULL, secret_hash = NULL WHERE name = ?`,
      [passwordHash, name]
    );
  }

  // Batch save para múltiplos jogadores (uso no setInterval periódico).
  // rare_ships e pets NÃO são salvos aqui — apenas via _flush urgente
  // (evita a race condition que apagava navios raros — ver memória Session 8).
  async batchSave(playersMap) {
    const playersToSave = [];
    for (const p of playersMap.values()) {
      if (p && p.name && p._dbLoaded) playersToSave.push(p);
    }
    if (playersToSave.length === 0) return;

    const sql = `UPDATE players SET
        gold=?, dobroes=?, cannons=?, pirates=?, ammo=?,
        equipped_cannons=?, equipped_pirates=?,
        ships=?, active_ship=?,
        skills=?, npc_kills=?, pvp_kills=?,
        equipped_sails=?, sails_inv=?,
        map_xp=?, map_level=?, map_fragments=?,
        relics_inv=?, relics_equipped=?,
        talents=?, talent_builds=?, ship_island_upgrades=?, cannon_upgrades_data=?,
        iron_plates=?, gold_dust=?, gunpowder=?,
        bonus_maps_unlocked=?, cannon_research_level=?, ship_material_level=?,
        map_pieces=?,
        hp=?, current_ammo=?, bank_gold=?, bank_unlocked=?,
        bonus_inventory=?, active_bonus_ship_stats=?,
        tutorial_state=?,
        afk_until=?,
        last_seen=NOW()
      WHERE name=?`;

    try {
      const start = Date.now();
      await Promise.all(playersToSave.map((p) => {
        const inventory = p.inventory || {};
        const ammoToSave = { ...(inventory.ammo || {}) };
        delete ammoToSave.bala_pedra;
        delete ammoToSave.bala_ferro;

        return pool.query(sql, [
          p.gold || 0,
          p.dobroes || 0,
          JSON.stringify(inventory.cannons || []),
          JSON.stringify(inventory.pirates || []),
          JSON.stringify(ammoToSave),
          JSON.stringify(p.cannons || []),
          JSON.stringify(p.pirates || []),
          JSON.stringify(inventory.ships || ['fragata']),
          p.activeShip || 'fragata',
          JSON.stringify(p.skills || DEFAULT_SKILLS),
          p.npcKills || 0,
          p.pvpKills || 0,
          JSON.stringify(p.equippedSails || []),
          JSON.stringify(inventory.sails || []),
          p.mapXp || 0,
          p.mapLevel || 1,
          p.mapFragments || 0,
          JSON.stringify(inventory.relics || []),
          JSON.stringify(p.relicDeck || []),
          JSON.stringify(p.talents || DEFAULT_TALENTS),
          JSON.stringify(p.talentBuilds || []),
          JSON.stringify(p.shipIslandUpgrades || DEFAULT_ISLAND_UPGRADES),
          JSON.stringify(p.cannonUpgradesData || []),
          p.ironPlates          || 0,
          p.goldDust            || 0,
          p.gunpowder           || 0,
          JSON.stringify(p.bonusMapsUnlocked   || []),
          p.cannonResearchLevel || 0,
          p.shipMaterialLevel   || 0,
          JSON.stringify(p.mapPieces   || {}),
          p.hp != null ? p.hp : (p.maxHp || 100),
          p.currentAmmo || 'bala_ferro',
          p.bankGold || 0,
          p.bankUnlocked ? 1 : 0,
          JSON.stringify(p.bonusInventory || []),
          p.activeBonusShipStats ? JSON.stringify(p.activeBonusShipStats) : null,
          p.tutorialState || 0,
          p.afkTraining ? (p.afkUntil || null) : null,
          p.name, // WHERE name=?
        ]);
      }));
      console.log(`💾 Batch save: ${playersToSave.length} players in ${Date.now() - start}ms`);
    } catch (err) {
      console.error('[DB] Batch save error:', err);
      // Fallback: tenta salvar individualmente
      for (const p of playersToSave) {
        this._flush(p).catch(e => console.error(`[DB] Fallback save failed for ${p.name}:`, e));
      }
    }
  }

  _shutdown() {
    console.log('[DB] Shutting down, flushing pending saves...');

    // Limpar todos os timers pendentes
    for (const [name, pending] of this._pending.entries()) {
      clearTimeout(pending.timer);
      if (pending.player) {
        // Tenta salvar uma última vez
        this._flush(pending.player).catch(console.error);
      }
      pending.player = null;
    }

    this._pending.clear();
    clearInterval(this._cleanupInterval);

    // Fecha o pool
    pool.end().then(() => {
      console.log('[DB] Pool closed');
    }).catch(() => {});
  }
}

module.exports = new DBManager();
