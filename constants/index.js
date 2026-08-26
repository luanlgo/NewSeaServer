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
const difficulty    = require('./difficulty');
const missions      = require('./missions');
const fleetEvent    = require('./fleet_event');
const guilds        = require('./guilds');
const islands       = require('./islands');

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

  // Dificuldades
  ...difficulty,

  // Missões diárias (Barco de Missões)
  ...missions,

  // Evento Frota de Caçadores
  ...fleetEvent,

  // Guildas
  ...guilds,

  // Ilhas de guilda (torres, conquista, imposto)
  ...islands,
};
