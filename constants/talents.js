// constants/talents.js — Talentos permanentes e estrutura de custo

// ── TALENT_DEFS ───────────────────────────────────────────────────────────────
// stat: chave usada no servidor para calcular o bônus
// perLevel: valor bruto do bônus por nível (unidade depende do stat)
const TALENT_DEFS = {
  hp:           { name: 'Casco de Ferro',         icon: '❤️',  max: 5, perLevel: 500, stat: 'hp',           desc: '+500 HP máximo por nível'               },
  defesa:       { name: 'Armadura Grossa',         icon: '🛡️',  max: 5, perLevel: 300, stat: 'defense',      desc: '+3% de redução de dano por nível'       },
  canhoes:      { name: 'Canhoneira',              icon: '💣',  max: 5, perLevel: 2,   stat: 'cannon_slots',  desc: '+2 slots de canhão por nível'            },
  dano:         { name: 'Artilheiro',              icon: '🎯',  max: 5, perLevel: 2,   stat: 'damage',        desc: '+2% de dano por nível'                   },
  dano_relic:   { name: 'Místico',                 icon: '✨',  max: 5, perLevel: 3,   stat: 'relic_damage',  desc: '+3% de dano de relíquias por nível'      },
  riqueza:      { name: 'Pilhador',                icon: '💰',  max: 5, perLevel: 3,   stat: 'gold_drop',     desc: '+3% de drop em ouro por nível'           },
  ganancioso:   { name: 'Corsário Ganancioso',     icon: '🟡',  max: 5, perLevel: 3,   stat: 'dobrao_drop',   desc: '+3% de chance de drop em dobrões/nível'  },
  mestre:       { name: 'Estudioso',               icon: '📚',  max: 5, perLevel: 5,   stat: 'xp_drop',       desc: '+5% de XP ganho por nível'               },
  slot_reliquia:{ name: 'Guardião das Relíquias',  icon: '🏺',  max: 1, perLevel: 1,   stat: 'relic_slot',    desc: '+1 slot de relíquia para o navio'        },
};

// ── TALENT_COST_TIERS — custo por compra conforme total de talentos adquiridos ─
// upTo: limite superior EXCLUSIVO (upTo:10 → primeiras 10 compras, índices 0-9)
const TALENT_COST_TIERS = [
  { upTo: 3,    cost: 500,  currency: 'gold'   },
  { upTo: 10,   cost: 1000, currency: 'gold'   },
  { upTo: 20,   cost: 500,  currency: 'dobrao' },
  { upTo: 30,   cost: 1000, currency: 'dobrao' },
  { upTo: 9999, cost: 3000, currency: 'dobrao' },
];

// ── XP mínimo para a n-ésima compra (0-indexed) ──────────────────────────────
// Fórmula: TALENT_XP_BASE × TALENT_XP_GROWTH^n → 400, 520, 676, …
const TALENT_XP_BASE   = 400;
const TALENT_XP_GROWTH = 1.3;

module.exports = { TALENT_DEFS, TALENT_COST_TIERS, TALENT_XP_BASE, TALENT_XP_GROWTH };
