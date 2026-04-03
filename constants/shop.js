// constants/shop.js — Catálogo do Mercado (o que aparece nas lojas)

const { CANNON_DEFS, AMMO_DEFS, SAIL_DEFS } = require('./cannons');
const { SHIP_DEFS } = require('./ships');

const SHOP = {
  canhao: Object.entries(CANNON_DEFS).map(([id, d]) => ({ id, ...d })),

  bala: [
    { id: 'bala_ferro',      name: 'Bala de Ferro',   price: 0,  qty: 0,  currency: 'free',   ...AMMO_DEFS.bala_ferro },
    { id: 'bala_perfurante', name: 'Bala Perfurante', price: 30, qty: 30, currency: 'gold',   ...AMMO_DEFS.bala_perfurante },
    { id: 'bala_gelo',       name: 'Bala de Gelo',    price: 10, qty: 30, currency: 'dobrao', ...AMMO_DEFS.bala_gelo },
    { id: 'bala_fogo',       name: 'Bala de Fogo',    price: 20, qty: 30, currency: 'dobrao', ...AMMO_DEFS.bala_fogo },
    { id: 'bala_luz',        name: 'Bala de Luz',     price: 20, qty: 30, currency: 'dobrao', ...AMMO_DEFS.bala_luz },
    { id: 'bala_sangue',     name: 'Bala de Sangue',  price: 40, qty: 30, currency: 'dobrao', ...AMMO_DEFS.bala_sangue },
  ],

  // ammo: keyed object para lookup O(1) no handler buy_ammo
  get ammo() {
    return Object.fromEntries(this.bala.map(b => [b.id, b]));
  },

  // piratasMap: keyed object para lookup O(1) no handler buy_pirate
  get piratasMap() {
    return Object.fromEntries(this.piratas.map(p => [p.id, p]));
  },

  vela: Object.entries(SAIL_DEFS).map(([id, d]) => ({ id, ...d })),

  piratas: [
    { id: 'healer',       name: 'Curandeiro',       price: 100, currency: 'gold',   qty: 1 },
    { id: 'healer_elite', name: 'Curandeiro Elite', price: 100, currency: 'dobrao', qty: 1 },
  ],

  navios: Object.entries(SHIP_DEFS).map(([id, d]) => ({ id, ...d })),
};

module.exports = { SHOP };
