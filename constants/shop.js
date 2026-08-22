// constants/shop.js — Catálogo do Mercado (o que aparece nas lojas)

const { CANNON_DEFS, AMMO_DEFS, SAIL_DEFS } = require('./cannons');
const { SHIP_DEFS } = require('./ships');
const { PIRATE_DEFS, piratesAtVenue, RUN_ITEM_ID, RUN_PRICE } = require('./pirates');

// Uma prateleira de piratas. O que muda entre a loja e o bar é só QUEM está
// nela: preço, peso e atributos continuam morando em constants/pirates.js.
const pirateShelf = (venue) => piratesAtVenue(venue).map(id => {
  const d = PIRATE_DEFS[id];
  return {
    id, qty: 1,
    name:     d.name,
    icon:     d.icon,
    role:     d.role,
    desc:     d.desc,
    price:    d.price,
    currency: d.currency,
    weight:   d.weight,
    atk: d.atk, def: d.def, hp: d.hp,
  };
});

const SHOP = {
  canhao: Object.entries(CANNON_DEFS).map(([id, d]) => ({ id, ...d })),

  bala: [
    { id: 'bala_ferro',      name: 'Bala de Ferro',   price: 0,  qty: 0,  currency: 'free',   ...AMMO_DEFS.bala_ferro },
    { id: 'bala_perfurante', name: 'Bala Perfurante', price: 30, qty: 30, currency: 'gold',   ...AMMO_DEFS.bala_perfurante },
    { id: 'bala_gelo',       name: 'Bala de Gelo',    price: 10, qty: 30, currency: 'dobrao', ...AMMO_DEFS.bala_gelo },
    { id: 'bala_fogo',       name: 'Bala de Fogo',    price: 20, qty: 30, currency: 'dobrao', ...AMMO_DEFS.bala_fogo },
    { id: 'bala_luz',        name: 'Bala de Luz',     price: 20, qty: 30, currency: 'dobrao', ...AMMO_DEFS.bala_luz },
    { id: 'bala_sangue',     name: 'Bala de Sangue',  price: 40, qty: 30, currency: 'dobrao', ...AMMO_DEFS.bala_sangue },
    { id: 'bala_cura',       name: 'Bala de Cura',    price: 15, qty: 30, currency: 'dobrao', ...AMMO_DEFS.bala_cura },
  ],

  // ammo: keyed object para lookup O(1) no handler buy_ammo
  get ammo() {
    return Object.fromEntries(this.bala.map(b => [b.id, b]));
  },

  // piratasMap: keyed object para lookup O(1) no handler buy_pirate. Cobre os
  // DOIS balcões — o handler é um só, quem separa a loja do bar é a vitrine.
  // Os balcões se sobrepõem (curandeiro está nos dois) e a chave repetida cai
  // sobre si mesma: as duas fichas saem do mesmo def, então não há versão certa
  // e errada para escolher.
  get piratasMap() {
    return Object.fromEntries([...this.piratas, ...this.bar].map(p => [p.id, p]));
  },

  vela: Object.entries(SAIL_DEFS).map(([id, d]) => ({ id, ...d })),

  // O catálogo de piratas é DERIVADO de PIRATE_DEFS: preço, peso e atributos
  // moram todos em constants/pirates.js, então rebalancear um pirata não exige
  // lembrar de editar a loja também.
  //
  // `piratas` é a aba do Mercado (mapas 1 e 2): só os curandeiros, que são
  // utilidade de navegação. `bar` é o salão da Ilha do Comércio, com a
  // tripulação INTEIRA — os de abordagem e também os curandeiros, para montar o
  // time num lugar só sem ter de velejar de volta ao mapa 1.
  piratas: pirateShelf('loja'),
  bar:     pirateShelf('bar'),

  // ── Loja Geral (Ilha do Comércio) ─────────────────────────────────────────
  // Itens de consumo, vendidos por quantidade livre. A lista é o único lugar a
  // tocar para colocar um item novo na prateleira: o handler `buy_general_item`
  // valida contra ela e credita em `player.inventory[id]`, sem caso especial
  // por item. `onBuy` é o gancho opcional de quem precisa reagir à compra
  // (reativar o pet, reativar a tripulação).
  gerais: [
    { id: 'uva',        name: 'Comida de Pet', icon: '🍇', price: 30,        currency: 'gold',
      desc: 'Uvas para o seu mascote. Sem comida o pet fica inativo.',  onBuy: 'pet' },
    { id: RUN_ITEM_ID,  name: 'RUN',           icon: '🍾', price: RUN_PRICE, currency: 'gold',
      desc: 'A bebida que mantém os piratas prontos para abordar. Sem RUN a tripulação não luta.', onBuy: 'pirates' },
  ],

  // geraisMap: lookup O(1) para o handler buy_general_item
  get geraisMap() {
    return Object.fromEntries(this.gerais.map(g => [g.id, g]));
  },

  // bonusOnly fora: navio de masmorra vive no SHIP_DEFS pelas regras de navio,
  // não para ser vendido.
  navios: Object.entries(SHIP_DEFS)
    .filter(([, d]) => !d.bonusOnly)
    .map(([id, d]) => ({ id, ...d })),
};

module.exports = { SHOP };
