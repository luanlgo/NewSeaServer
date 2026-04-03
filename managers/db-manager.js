// managers/db-manager.js
const { Pool } = require('pg');

// Local dev uses public URL, Railway hosting uses internal URL
const rawConn = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || process.env.VITE_DATABASE_PUBLIC_URL || '';
// Strip surrounding quotes if dotenv included them
const connStr = rawConn.replace(/^["']|["']$/g, '').trim();

if (!connStr) {
  console.error('❌ No database URL found! Set DATABASE_PUBLIC_URL in your .env file');
  process.exit(1);
}

// Log sanitized URL
const maskedUrl = connStr.replace(/:([^:@]+)@/, ':***@');
console.log(`🔌 Connecting to DB: ${maskedUrl}`);
const pool = new Pool({
  connectionString: connStr,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Prevent unhandled 'error' event from crashing the process when a pooled
// connection is terminated unexpectedly (e.g. Railway / Supabase idle cutoff).
// The error will still surface as a rejected promise in _flush().
pool.on('error', (err) => {
  console.error('[DB] Pool idle client error (connection dropped):', err.message);
});

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
      const result = await pool.query(
        `UPDATE players
         SET gold=$2, dobroes=$3, cannons=$4, pirates=$5, ammo=$6,
             equipped_cannons=$7, equipped_pirates=$8,
             ships=$9, active_ship=$10,
             skills=$11, npc_kills=$12,
             equipped_sails=$13, sails_inv=$14,
             map_xp=$15, map_level=$16,
             map_fragments=$17,
             relics_inv=$18, relics_equipped=$19,
             talents=$20,
             ship_island_upgrades=$21,
             cannon_upgrades_data=$22,
             iron_plates=$23, gold_dust=$24, gunpowder=$25,
             bonus_maps_unlocked=$26,
             cannon_research_level=$27, ship_material_level=$28,
             map_pieces=$29, rare_ships=$30,
             last_seen=NOW()
         WHERE name=$1`,
        [
          player.name,
          player.gold || 0,
          player.dobroes || 0,
          JSON.stringify(inventory.cannons || []),
          JSON.stringify(inventory.pirates || []),
          JSON.stringify(ammoToSave),
          JSON.stringify(player.cannons || []),
          JSON.stringify(player.pirates || []),
          JSON.stringify(inventory.ships || ['fragata']),
          player.activeShip || 'fragata',
          JSON.stringify(player.skills || { ataque: { level: 1, xp: 0 }, velocidade: { level: 1, xp: 0 }, defesa: { level: 1, xp: 0 }, vida: { level: 1, xp: 0 } }),
          player.npcKills || 0,
          JSON.stringify(player.equippedSails || []),
          JSON.stringify(inventory.sails || []),
          player.mapXp || 0,
          player.mapLevel || 1,
          player.mapFragments || 0,
          JSON.stringify(inventory.relics || []),
          JSON.stringify(player.relicDeck || []),
          JSON.stringify(player.talents || { hp: 0, defesa: 0, canhoes: 0, dano: 0, dano_relic: 0, riqueza: 0, ganancioso: 0, mestre: 0, totalSpent: 0 }),
          JSON.stringify(player.shipIslandUpgrades || { hpBonus: 0, defenseBonus: 0 }),
          JSON.stringify(player.cannonUpgradesData || []),
          player.ironPlates          || 0,
          player.goldDust            || 0,
          player.gunpowder           || 0,
          JSON.stringify(player.bonusMapsUnlocked   || []),
          player.cannonResearchLevel || 0,
          player.shipMaterialLevel   || 0,
          JSON.stringify(player.mapPieces  || {}),
          JSON.stringify(player.rareShips  || []),
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
        gold INTEGER NOT NULL DEFAULT 100,
        dobroes INTEGER NOT NULL DEFAULT 0,
        cannons JSONB NOT NULL DEFAULT '[]',
        pirates JSONB NOT NULL DEFAULT '[]',
        ammo JSONB NOT NULL DEFAULT '{}',
        equipped_cannons JSONB NOT NULL DEFAULT '[]',
        equipped_pirates JSONB NOT NULL DEFAULT '[]',
        equipped_sails JSONB NOT NULL DEFAULT '[]',
        sails_inv JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_seen TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    
    // Add columns (mantido seu código de migração)
    await this._addColumns();
    
    console.log('💾 PostgreSQL ready');
  }

  async _addColumns() {
    const columns = [
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS equipped_cannons JSONB NOT NULL DEFAULT \'[]\'',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS equipped_sails JSONB NOT NULL DEFAULT \'[]\'',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS sails_inv JSONB NOT NULL DEFAULT \'[]\'',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS equipped_pirates JSONB NOT NULL DEFAULT \'[]\'',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS ships JSONB NOT NULL DEFAULT \'["fragata"]\'',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS active_ship TEXT NOT NULL DEFAULT \'fragata\'',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS npc_kills INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS skills JSONB NOT NULL DEFAULT \'{"ataque":{"level":1,"xp":0},"velocidade":{"level":1,"xp":0},"defesa":{"level":1,"xp":0}}\'',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS map_xp INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS map_level INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS map_fragments INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS relics_inv JSONB NOT NULL DEFAULT \'[]\'',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS relics_equipped JSONB NOT NULL DEFAULT \'[]\'',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS talents JSONB NOT NULL DEFAULT \'{"hp":0,"defesa":0,"canhoes":0,"dano":0,"dano_relic":0,"riqueza":0,"ganancioso":0,"mestre":0,"totalSpent":0}\'',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS ship_island_upgrades JSONB NOT NULL DEFAULT \'{"hpBonus":0,"defenseBonus":0}\'',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS cannon_upgrades_data JSONB NOT NULL DEFAULT \'[]\'',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS iron_plates INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS gold_dust INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS gunpowder INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS bonus_maps_unlocked JSONB NOT NULL DEFAULT \'[]\'',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS cannon_research_level INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS ship_material_level INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS map_pieces JSONB NOT NULL DEFAULT \'{}\'',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS rare_ships JSONB DEFAULT \'[]\'',
    ];
    
    for (const sql of columns) {
      try {
        await pool.query(sql);
      } catch (err) {
        // Ignora erros de coluna já existente
        if (!err.message.includes('already exists')) {
          console.error('Error adding column:', err);
        }
      }
    }
  }

  async loadOrCreate(name) {
    const { rows } = await pool.query(
      'SELECT * FROM players WHERE name = $1',
      [name]
    );
    if (rows.length === 0) {
      const { rows: [row] } = await pool.query(
        `INSERT INTO players (name, cannons, ships, active_ship) 
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (name) DO UPDATE SET last_seen = NOW()
         RETURNING *`,
        [name, JSON.stringify(['c1', 'c1', 'c1']), JSON.stringify(['fragata']), 'fragata']
      );
      console.log(`💾 New player: ${name}`);
      return this._parse(row);
    }

    await pool.query('UPDATE players SET last_seen = NOW() WHERE name = $1', [name]);
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
      skills: row.skills || { ataque: { level: 1, xp: 0 }, velocidade: { level: 1, xp: 0 }, defesa: { level: 1, xp: 0 }, vida: { level: 1, xp: 0 } },
      npcKills: row.npc_kills || 0,
      mapXp: row.map_xp || 0,
      mapLevel: row.map_level || 1,
      mapFragments: row.map_fragments || 0,
      talents: row.talents || { hp: 0, defesa: 0, canhoes: 0, dano: 0, dano_relic: 0, riqueza: 0, ganancioso: 0, mestre: 0, totalSpent: 0 },
      shipIslandUpgrades: row.ship_island_upgrades || { hpBonus: 0, defenseBonus: 0 },
      cannonUpgradesData: row.cannon_upgrades_data || [],
      ironPlates:          row.iron_plates          || 0,
      goldDust:            row.gold_dust            || 0,
      gunpowder:           row.gunpowder            || 0,
      bonusMapsUnlocked:   row.bonus_maps_unlocked  || [],
      mapPieces:           row.map_pieces           || {},
      rareShips:           row.rare_ships           || [],
      cannonResearchLevel: row.cannon_research_level || 0,
      shipMaterialLevel:   row.ship_material_level  || 0,
    };
  }

  // Batch save para múltiplos jogadores em uma única query (uso no setInterval periódico)
  async batchSave(playersMap) {
    const playersToSave = [];
    for (const p of playersMap.values()) {
      if (p && p.name && p._dbLoaded) playersToSave.push(p);
    }
    if (playersToSave.length === 0) return;

    // Monta arrays paralelos para UNNEST
    const names        = [], golds      = [], dobroes_arr = [];
    const cannons_arr  = [], pirates_arr = [], ammo_arr   = [];
    const eq_cannons   = [], eq_pirates  = [];
    const ships_arr    = [], active_ship = [];
    const skills_arr   = [], npc_kills   = [];
    const eq_sails     = [], sails_inv   = [];
    const map_xp       = [], map_level   = [], map_frag   = [];
    const relics_inv   = [], relics_eq   = [];
    const talents_arr  = [], island_up   = [], cannon_up  = [];
    const iron_plates  = [], gold_dust   = [], gunpowder_arr = [];
    const bonus_maps   = [], cannon_res  = [], ship_mat   = [];
    const map_pieces_arr = [], rare_ships_arr = [];

    for (const p of playersToSave) {
      const inventory = p.inventory || {};
      const ammoToSave = { ...(inventory.ammo || {}) };
      delete ammoToSave.bala_pedra;
      delete ammoToSave.bala_ferro;

      names.push(p.name);
      golds.push(p.gold || 0);
      dobroes_arr.push(p.dobroes || 0);
      cannons_arr.push(JSON.stringify(inventory.cannons || []));
      pirates_arr.push(JSON.stringify(inventory.pirates || []));
      ammo_arr.push(JSON.stringify(ammoToSave));
      eq_cannons.push(JSON.stringify(p.cannons || []));
      eq_pirates.push(JSON.stringify(p.pirates || []));
      ships_arr.push(JSON.stringify(inventory.ships || ['fragata']));
      active_ship.push(p.activeShip || 'fragata');
      skills_arr.push(JSON.stringify(p.skills || { ataque: { level: 1, xp: 0 }, velocidade: { level: 1, xp: 0 }, defesa: { level: 1, xp: 0 }, vida: { level: 1, xp: 0 } }));
      npc_kills.push(p.npcKills || 0);
      eq_sails.push(JSON.stringify(p.equippedSails || []));
      sails_inv.push(JSON.stringify(inventory.sails || []));
      map_xp.push(p.mapXp || 0);
      map_level.push(p.mapLevel || 1);
      map_frag.push(p.mapFragments || 0);
      relics_inv.push(JSON.stringify(inventory.relics || []));
      relics_eq.push(JSON.stringify(p.relicDeck || []));
      talents_arr.push(JSON.stringify(p.talents || { hp: 0, defesa: 0, canhoes: 0, dano: 0, dano_relic: 0, riqueza: 0, ganancioso: 0, mestre: 0, totalSpent: 0 }));
      island_up.push(JSON.stringify(p.shipIslandUpgrades || { hpBonus: 0, defenseBonus: 0 }));
      cannon_up.push(JSON.stringify(p.cannonUpgradesData || []));
      iron_plates.push(p.ironPlates          || 0);
      gold_dust.push(p.goldDust              || 0);
      gunpowder_arr.push(p.gunpowder         || 0);
      bonus_maps.push(JSON.stringify(p.bonusMapsUnlocked   || []));
      cannon_res.push(p.cannonResearchLevel  || 0);
      ship_mat.push(p.shipMaterialLevel      || 0);
      map_pieces_arr.push(JSON.stringify(p.mapPieces || {}));
      rare_ships_arr.push(JSON.stringify(p.rareShips || []));
    }

    try {
      const start = Date.now();
      await pool.query(
        `UPDATE players SET
           gold                 = v.gold::integer,
           dobroes              = v.dobroes::integer,
           cannons              = v.cannons::jsonb,
           pirates              = v.pirates::jsonb,
           ammo                 = v.ammo::jsonb,
           equipped_cannons     = v.eq_cannons::jsonb,
           equipped_pirates     = v.eq_pirates::jsonb,
           ships                = v.ships::jsonb,
           active_ship          = v.active_ship,
           skills               = v.skills::jsonb,
           npc_kills            = v.npc_kills::integer,
           equipped_sails       = v.eq_sails::jsonb,
           sails_inv            = v.sails_inv::jsonb,
           map_xp               = v.map_xp::integer,
           map_level            = v.map_level::integer,
           map_fragments        = v.map_frag::integer,
           relics_inv           = v.relics_inv::jsonb,
           relics_equipped      = v.relics_eq::jsonb,
           talents              = v.talents::jsonb,
           ship_island_upgrades = v.island_up::jsonb,
           cannon_upgrades_data = v.cannon_up::jsonb,
           iron_plates          = v.iron_plates::integer,
           gold_dust            = v.gold_dust::integer,
           gunpowder            = v.gunpowder::integer,
           bonus_maps_unlocked  = v.bonus_maps::jsonb,
           cannon_research_level = v.cannon_res::integer,
           ship_material_level  = v.ship_mat::integer,
           map_pieces           = v.map_pieces::jsonb,
           rare_ships           = v.rare_ships::jsonb,
           last_seen            = NOW()
         FROM (
           SELECT
             UNNEST($1::text[])    AS name,
             UNNEST($2::text[])    AS gold,
             UNNEST($3::text[])    AS dobroes,
             UNNEST($4::text[])    AS cannons,
             UNNEST($5::text[])    AS pirates,
             UNNEST($6::text[])    AS ammo,
             UNNEST($7::text[])    AS eq_cannons,
             UNNEST($8::text[])    AS eq_pirates,
             UNNEST($9::text[])    AS ships,
             UNNEST($10::text[])   AS active_ship,
             UNNEST($11::text[])   AS skills,
             UNNEST($12::text[])   AS npc_kills,
             UNNEST($13::text[])   AS eq_sails,
             UNNEST($14::text[])   AS sails_inv,
             UNNEST($15::text[])   AS map_xp,
             UNNEST($16::text[])   AS map_level,
             UNNEST($17::text[])   AS map_frag,
             UNNEST($18::text[])   AS relics_inv,
             UNNEST($19::text[])   AS relics_eq,
             UNNEST($20::text[])   AS talents,
             UNNEST($21::text[])   AS island_up,
             UNNEST($22::text[])   AS cannon_up,
             UNNEST($23::text[])   AS iron_plates,
             UNNEST($24::text[])   AS gold_dust,
             UNNEST($25::text[])   AS gunpowder,
             UNNEST($26::text[])   AS bonus_maps,
             UNNEST($27::text[])   AS cannon_res,
             UNNEST($28::text[])   AS ship_mat,
             UNNEST($29::text[])   AS map_pieces,
             UNNEST($30::text[])   AS rare_ships
         ) AS v
         WHERE players.name = v.name`,
        [
          names,
          golds.map(String),
          dobroes_arr.map(String),
          cannons_arr,
          pirates_arr,
          ammo_arr,
          eq_cannons,
          eq_pirates,
          ships_arr,
          active_ship,
          skills_arr,
          npc_kills.map(String),
          eq_sails,
          sails_inv,
          map_xp.map(String),
          map_level.map(String),
          map_frag.map(String),
          relics_inv,
          relics_eq,
          talents_arr,
          island_up,
          cannon_up,
          iron_plates.map(String),
          gold_dust.map(String),
          gunpowder_arr.map(String),
          bonus_maps,
          cannon_res.map(String),
          ship_mat.map(String),
          map_pieces_arr,
          rare_ships_arr,
        ]
      );
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
    });
  }
}

module.exports = new DBManager();