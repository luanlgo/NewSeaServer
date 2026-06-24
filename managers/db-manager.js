// managers/db-manager.js
const { Pool } = require('pg');

const rawConn =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_PUBLIC_URL ||
  process.env.VITE_DATABASE_PUBLIC_URL ||
  '';
const connStr = rawConn.replace(/^["']|["']$/g, '').trim();

if (!connStr) {
  console.error('❌ No database URL found! Set DATABASE_PUBLIC_URL in your .env file');
  process.exit(1);
}

const maskedUrl = connStr.replace(/:([^:@]+)@/, ':***@');
console.log(`🔌 Connecting to DB: ${maskedUrl}`);

const pool = new Pool({
  connectionString: connStr,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[DB] Pool error (connection dropped):', err.message);
});

const DEFAULT_SKILLS         = { ataque: { level: 1, xp: 0 }, velocidade: { level: 1, xp: 0 }, defesa: { level: 1, xp: 0 }, vida: { level: 1, xp: 0 } };
const DEFAULT_TALENTS        = { hp: 0, defesa: 0, canhoes: 0, dano: 0, dano_relic: 0, riqueza: 0, ganancioso: 0, mestre: 0, totalSpent: 0 };
const DEFAULT_ISLAND_UPGRADES = { hpBonus: 0, defenseBonus: 0 };

class DBManager {
  constructor() {
    this._pending = new Map();
    this.DEBOUNCE_MS = 1000;
    this._cleanupInterval = setInterval(() => {
      this._cleanupStaleEntries();
    }, 30000);
  }

  async save(player, urgent = false) {
    if (!player || !player.name) return Promise.resolve();
    if (urgent) {
      this._clearPending(player.name);
      try {
        return await this._flush(player);
      } catch (err) {
        console.error(`[DB] Urgent save failed for ${player.name}:`, err);
      }
    }
    const now = Date.now();
    const existing = this._pending.get(player.name);
    if (existing) {
      clearTimeout(existing.timer);
      existing.player = player;
      existing.lastUpdate = now;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(player.name);
        this._flush(player).then(resolve).catch(err => {
          console.error(`[DB] Debounced save failed for ${player.name}:`, err);
          reject(err);
        });
      }, this.DEBOUNCE_MS);
      this._pending.set(player.name, { timer, player, createdAt: now, lastUpdate: now });
    });
  }

  cleanupPlayer(playerName) { this._clearPending(playerName); }

  _clearPending(playerName) {
    const pending = this._pending.get(playerName);
    if (pending) {
      clearTimeout(pending.timer);
      this._pending.delete(playerName);
      pending.player = null;
    }
  }

  _cleanupStaleEntries() {
    const now = Date.now();
    const MAX_AGE = 10000;
    for (const [name, pending] of this._pending.entries()) {
      if (!pending.timer._idleNext || (now - pending.createdAt) > MAX_AGE) {
        console.log(`[DB] Cleaning stale entry for ${name} (age: ${now - pending.createdAt}ms)`);
        clearTimeout(pending.timer);
        pending.player = null;
        this._pending.delete(name);
      }
    }
  }

  async _flush(player) {
    if (!player || !player.name) return;
    const inventory = player.inventory || {};
    const ammoToSave = inventory.ammo ? { ...inventory.ammo } : {};
    delete ammoToSave.bala_pedra;
    delete ammoToSave.bala_ferro;
    try {
      const result = await pool.query(
        `UPDATE players
         SET gold=$1, dobroes=$2, cannons=$3, pirates=$4, ammo=$5,
             equipped_cannons=$6, equipped_pirates=$7,
             ships=$8, active_ship=$9,
             skills=$10, npc_kills=$11, difficulty=$12,
             equipped_sails=$13, sails_inv=$14,
             map_xp=$15, map_level=$16, map_fragments=$17,
             relics_inv=$18, relics_equipped=$19,
             talents=$20, ship_island_upgrades=$21, cannon_upgrades_data=$22,
             iron_plates=$23, gold_dust=$24, gunpowder=$25,
             bonus_maps_unlocked=$26, cannon_research_level=$27, ship_material_level=$28,
             map_pieces=$29, rare_ships=$30,
             hp=$31, current_ammo=$32, bank_gold=$33, bank_unlocked=$34,
             bonus_inventory=$35, active_bonus_ship_stats=$36,
             owned_pets=$37, equipped_pet=$38, pet_levels=$39, pet_xp=$40,
             last_seen=NOW()
         WHERE name=$41`,
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
          player.bankUnlocked ? true : false,
          JSON.stringify(player.bonusInventory || []),
          player.activeBonusShipStats ? JSON.stringify(player.activeBonusShipStats) : null,
          JSON.stringify(player.ownedPets   || []),
          player.equippedPet || '',
          JSON.stringify(player.petLevels   || {}),
          JSON.stringify(player.petXp       || {}),
          player.name,
        ]
      );
      if (result.rowCount === 0) {
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
        name TEXT PRIMARY KEY,
        gold INT NOT NULL DEFAULT 100,
        dobroes INT NOT NULL DEFAULT 0,
        cannons JSONB,
        pirates JSONB,
        ammo JSONB,
        equipped_cannons JSONB,
        equipped_pirates JSONB,
        equipped_sails JSONB,
        sails_inv JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_seen TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await this._addColumns();
    await this._ensureAuctionsTable();
    console.log('💾 PostgreSQL ready');
  }

  async _ensureAuctionsTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auctions (
        id          TEXT PRIMARY KEY,
        ship_data   JSONB NOT NULL,
        owner_id    TEXT NOT NULL,
        owner_name  TEXT NOT NULL,
        min_bid     INT NOT NULL DEFAULT 0,
        top_bid     INT NOT NULL DEFAULT 0,
        bids        JSONB,
        ends_at     BIGINT NOT NULL,
        created_at  BIGINT NOT NULL
      );
    `);
  }

  async saveAuctions(auctionsMap) {
    try {
      await pool.query('DELETE FROM auctions');
      for (const [id, a] of auctionsMap) {
        await pool.query(
          `INSERT INTO auctions (id, ship_data, owner_id, owner_name, min_bid, top_bid, bids, ends_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO UPDATE SET
             ship_data = EXCLUDED.ship_data,
             top_bid   = EXCLUDED.top_bid,
             bids      = EXCLUDED.bids`,
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

  async loadAuctions() {
    try {
      const result = await pool.query('SELECT * FROM auctions WHERE ends_at > $1', [Date.now()]);
      return result.rows.map(r => ({
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
      await pool.query('DELETE FROM auctions WHERE id = $1', [auctionId]);
    } catch (err) {
      console.error('[DB] Error deleting auction:', err);
    }
  }

  async _addColumns() {
    const columns = [
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS equipped_cannons JSONB",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS equipped_sails JSONB",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS sails_inv JSONB",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS equipped_pirates JSONB",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS ships JSONB",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS active_ship TEXT NOT NULL DEFAULT 'fragata'",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS npc_kills INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS difficulty INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS skills JSONB",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS map_xp INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS map_level INT NOT NULL DEFAULT 1",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS map_fragments INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS relics_inv JSONB",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS relics_equipped JSONB",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS talents JSONB",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS ship_island_upgrades JSONB",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS cannon_upgrades_data JSONB",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS iron_plates INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS gold_dust INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS gunpowder INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS bonus_maps_unlocked JSONB",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS cannon_research_level INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS ship_material_level INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS map_pieces JSONB",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS rare_ships JSONB",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS bonus_inventory JSONB",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS active_bonus_ship_stats JSONB",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS hp INT NOT NULL DEFAULT 100",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS current_ammo TEXT NOT NULL DEFAULT 'bala_ferro'",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS bank_gold INT NOT NULL DEFAULT 0",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS bank_unlocked BOOLEAN NOT NULL DEFAULT FALSE",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS owned_pets JSONB",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS equipped_pet TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS pet_levels JSONB",
      "ALTER TABLE players ADD COLUMN IF NOT EXISTS pet_xp JSONB",
    ];
    for (const sql of columns) {
      try {
        await pool.query(sql);
      } catch (err) {
        if (err.code !== '42701') {
          console.error('Error adding column:', err.message);
        }
      }
    }
  }

  async loadOrCreate(name) {
    const result = await pool.query('SELECT * FROM players WHERE name = $1', [name]);
    if (result.rows.length === 0) {
      await pool.query(
        `INSERT INTO players (name, cannons, ships, active_ship)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (name) DO UPDATE SET last_seen = NOW()`,
        [name, JSON.stringify(['c1', 'c1', 'c1']), JSON.stringify(['fragata']), 'fragata']
      );
      const created = await pool.query('SELECT * FROM players WHERE name = $1', [name]);
      console.log(`💾 New player: ${name}`);
      return this._parse(created.rows[0]);
    }
    await pool.query('UPDATE players SET last_seen = NOW() WHERE name = $1', [name]);
    console.log(`💾 Player loaded: ${name}`);
    return this._parse(result.rows[0]);
  }

  _parse(row) {
    return {
      gold: row.gold,
      dobroes: row.dobroes,
      inventory: {
        cannons: row.cannons   || [],
        pirates: row.pirates   || [],
        ammo:    row.ammo      || {},
        ships:   row.ships     || ['fragata'],
        sails:   row.sails_inv || [],
        relics:  row.relics_inv || [],
      },
      equipped: {
        cannons: row.equipped_cannons  || [],
        sails:   row.equipped_sails    || [],
        pirates: row.equipped_pirates  || [],
        ship:    row.active_ship       || 'fragata',
        relics:  row.relics_equipped   || [],
      },
      skills:              row.skills               || { ...DEFAULT_SKILLS },
      npcKills:            row.npc_kills            || 0,
      difficulty:          row.difficulty           || 0,
      mapXp:               row.map_xp               || 0,
      mapLevel:            row.map_level            || 1,
      mapFragments:        row.map_fragments        || 0,
      talents:             row.talents              || { ...DEFAULT_TALENTS },
      shipIslandUpgrades:  row.ship_island_upgrades || { ...DEFAULT_ISLAND_UPGRADES },
      cannonUpgradesData:  row.cannon_upgrades_data || [],
      ironPlates:          row.iron_plates          || 0,
      goldDust:            row.gold_dust            || 0,
      gunpowder:           row.gunpowder            || 0,
      bonusMapsUnlocked:   row.bonus_maps_unlocked  || [],
      mapPieces:           row.map_pieces           || {},
      bonusShips:          row.rare_ships           || [],
      bonusInventory:      row.bonus_inventory      || [],
      activeBonusShipStats: row.active_bonus_ship_stats || null,
      hp:                  row.hp != null ? row.hp : 100,
      currentAmmo:         row.current_ammo         || 'bala_ferro',
      bankGold:            row.bank_gold            || 0,
      bankUnlocked:        !!row.bank_unlocked,
      cannonResearchLevel: row.cannon_research_level || 0,
      shipMaterialLevel:   row.ship_material_level  || 0,
      ownedPets:           row.owned_pets           || [],
      equippedPet:         row.equipped_pet         || '',
      petLevels:           row.pet_levels           || {},
      petXp:               row.pet_xp               || {},
    };
  }

  async batchSave(playersMap) {
    const playersToSave = [];
    for (const p of playersMap.values()) {
      if (p && p.name && p._dbLoaded) playersToSave.push(p);
    }
    if (playersToSave.length === 0) return;

    const sql = `UPDATE players SET
        gold=$1, dobroes=$2, cannons=$3, pirates=$4, ammo=$5,
        equipped_cannons=$6, equipped_pirates=$7,
        ships=$8, active_ship=$9,
        skills=$10, npc_kills=$11,
        equipped_sails=$12, sails_inv=$13,
        map_xp=$14, map_level=$15, map_fragments=$16,
        relics_inv=$17, relics_equipped=$18,
        talents=$19, ship_island_upgrades=$20, cannon_upgrades_data=$21,
        iron_plates=$22, gold_dust=$23, gunpowder=$24,
        bonus_maps_unlocked=$25, cannon_research_level=$26, ship_material_level=$27,
        map_pieces=$28,
        hp=$29, current_ammo=$30, bank_gold=$31, bank_unlocked=$32,
        bonus_inventory=$33, active_bonus_ship_stats=$34,
        last_seen=NOW()
      WHERE name=$35`;

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
          p.bankUnlocked ? true : false,
          JSON.stringify(p.bonusInventory || []),
          p.activeBonusShipStats ? JSON.stringify(p.activeBonusShipStats) : null,
          p.name,
        ]);
      }));
      console.log(`💾 Batch save: ${playersToSave.length} players in ${Date.now() - start}ms`);
    } catch (err) {
      console.error('[DB] Batch save error:', err);
      for (const p of playersToSave) {
        this._flush(p).catch(e => console.error(`[DB] Fallback save failed for ${p.name}:`, e));
      }
    }
  }

  _shutdown() {
    console.log('[DB] Shutting down, flushing pending saves...');
    for (const [name, pending] of this._pending.entries()) {
      clearTimeout(pending.timer);
      if (pending.player) {
        this._flush(pending.player).catch(console.error);
      }
      pending.player = null;
    }
    this._pending.clear();
    clearInterval(this._cleanupInterval);
    pool.end().then(() => {
      console.log('[DB] Pool closed');
    }).catch(() => {});
  }
}

module.exports = new DBManager();
