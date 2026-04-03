// constants/engine.js — Constantes de motor e fallbacks globais de NPC

// ── Motor ─────────────────────────────────────────────────────────────────────
const MAP_SIZE            = 1200;
const SHIP_SPEED          = 1.5;
const MAX_CANNON_SLOTS    = 20;
const PROJECTILE_SPEED    = 28;
const PROJECTILE_LIFETIME = 2800;   // ms
const HIT_RADIUS          = 8;      // barco ~4u largura, margem generosa

// ── Fallbacks globais de NPC (preferir MAP_DEFS[n].npc.* quando disponível) ──
const MAX_HP            = 100;   // fallback se npc.baseHp não definido
const NPC_COUNT         = 5;     // fallback se npc.count não definido
const NPC_FIRE_INTERVAL = 2200;  // fallback se npc.fireInterval não definido
const GOLD_DROP_MIN     = 3;     // fallback se npc.goldMin não definido
const GOLD_DROP_MAX     = 8;     // fallback se npc.goldMax não definido
const DOBRAO_DROP_MIN   = 1;     // fallback boss (boss.dobraoMin preferred)
const DOBRAO_DROP_MAX   = 3;     // fallback boss (boss.dobraoMax preferred)

const SHOW_LOG = false;          // true para logs detalhados de drops e recompensas

module.exports = {
  MAP_SIZE, SHIP_SPEED, MAX_CANNON_SLOTS,
  PROJECTILE_SPEED, PROJECTILE_LIFETIME, HIT_RADIUS,
  MAX_HP, NPC_COUNT, NPC_FIRE_INTERVAL,
  GOLD_DROP_MIN, GOLD_DROP_MAX, DOBRAO_DROP_MIN, DOBRAO_DROP_MAX,
  SHOW_LOG,
};
