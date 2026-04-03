// constants/index.js — Re-exporta todas as constantes do jogo
// Todos os requires existentes (require('./constants') / require('../constants'))
// continuam funcionando sem alteração — Node.js resolve pastas para index.js.

const engine      = require('./engine');
const maps        = require('./maps');
const ships       = require('./ships');
const cannons     = require('./cannons');
const pirates     = require('./pirates');
const shop        = require('./shop');
const relics      = require('./relics');
const talents     = require('./talents');
const attacks       = require('./attacks');
const exploration   = require('./exploration');
const bonusDungeons = require('./bonus_dungeons');

module.exports = {
  // Engine
  ...engine,

  // Mapas
  ...maps,

  // Navios
  ...ships,

  // Canhões / Munições / Velas
  ...cannons,

  // Piratas
  ...pirates,

  // Loja
  ...shop,

  // Relíquias
  ...relics,

  // Talentos
  ...talents,

  // Ataques
  ...attacks,

  // Exploração / Boss Mundial
  ...exploration,

  // Masmorras Bônus
  ...bonusDungeons,
};
