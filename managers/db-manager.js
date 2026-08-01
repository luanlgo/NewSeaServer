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

  // Limpa pendências para um jogador específico
  cleanupPlayer(playerName) {
    this._clearPending(playerName);
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
             talents=?,
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

    console.log('💾 MySQL ready');
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
  }

  // Salva todos os leilões ativos (substitui todos de uma vez)
  async saveAuctions(auctionsMap) {
    try {
      await pool.query('DELETE FROM auctions');
      for (const [id, a] of auctionsMap) {
        await pool.query(
          `INSERT INTO auctions (id, ship_data, owner_id, owner_name, min_bid, top_bid, bids, ends_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE
             ship_data = VALUES(ship_data),
             top_bid   = VALUES(top_bid),
             bids      = VALUES(bids)`,
          [
            id,
            JSON.stringify(a.shipData),
            a.ownerId,
            a.ownerName,
            a.minBid,
            a.topBid,
            JSON.stringify(a.bids || []),
            a.endsAt,
            a.createdAt || Date.now(),
          ]
        );
      }
    } catch (err) {
      console.error('[DB] Error saving auctions:', err);
    }
  }

  // Carrega todos os leilões do DB (chamado no startup)
  async loadAuctions() {
    try {
      const [rows] = await pool.query('SELECT * FROM auctions WHERE ends_at > ?', [Date.now()]);
      return rows.map(r => ({
        id:        r.id,
        shipData:  r.ship_data,
        ownerId:   r.owner_id,
        ownerName: r.owner_name,
        minBid:    r.min_bid,
        topBid:    r.top_bid,
        bids:      r.bids || [],
        endsAt:    Number(r.ends_at),
        createdAt: Number(r.created_at),
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
      // ── Auth (token de dispositivo, TOFU) ─────────────────────────────────
      "ALTER TABLE players ADD COLUMN secret_hash   VARCHAR(64) DEFAULT NULL",
      // ── Tutorial (0=pendente, 1=foguete concedido, 2=completo) ────────────
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
        talents=?, ship_island_upgrades=?, cannon_upgrades_data=?,
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
