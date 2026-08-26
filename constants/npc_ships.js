// constants/npc_ships.js — os três cascos de NPC de assets/models/npc_ships
//
// Manta Florestal, Nébula Purpúrea e Necrófago das Almas são NAVIOS, não
// bichos: têm canhão, salva e alcance, e o motor os move pelo caminho de
// `usesCannons`. Eles aparecem em DOIS lugares do jogo, e é por isso que a
// ficha deles mora aqui e não em nenhum dos dois:
//
//   • a Frota de Caçadores (constants/fleet_event.js) — vida, dano e bounty
//     escalam com o Tier do caçado;
//   • a guarda das ilhas de guilda (mapas 12/13/14, ver ISLAND_NPCS em
//     constants/islands.js) — vida e dano fixos, como qualquer fauna de mapa.
//
// O que está AQUI é o que não muda entre os dois: o modelo, como ele se apoia
// na água e como ele atira. O que muda — quanto ele aguenta, quanto ele bate,
// quanto ele paga — fica em cada um dos dois donos. Antes desta separação a
// segunda casa teria de copiar nove campos, e o ajuste fino de escala feito num
// deles nunca chegaria no outro.
//
// ── Nada de `require` aqui ───────────────────────────────────────────────────
// Este arquivo é folha de propósito: `fleet_event` importa `maps`, `maps`
// importa `islands`, e se qualquer um deles precisasse importar o outro para
// achar um casco fecharia um ciclo — com `MAP_DEFS` chegando pela metade em
// quem carregasse primeiro.
//
// scale/yOffset vêm da AABB dos GLBs, que são normalizados a ~1 unidade com o
// pivô na base: scale 55 dá ao navio o mesmo porte que o hitRadius cobra, e o
// yOffset negativo afunda a quilha em vez de deixá-la boiando. rotOffset alinha
// a proa com +Z (a direção que rotation=0 aponta) — só a Nébula é comprida no
// eixo X e precisa do quarto de volta.
'use strict';

const NPC_SHIP_HULLS = {
  // A batedora: rápida, salvas curtas, casco fino.
  mantaFlorestal: {
    id:           'mantaFlorestal',
    name:         'Manta Florestal',
    cannonCount:  4,
    cannonSpread: 0.34,
    cannonRange:  120,
    fireInterval: 2300,
    hitRadius:    26,
    model:        '/models/npc_ships/mantaFlorestal.glb',
    scale: 55, yOffset: -3, rotOffset: 180 * Math.PI / 180,
  },
  // O canhão: dano por bala mais alto, cadência mais lenta.
  nebulaPurpurea: {
    id:           'nebulaPurpurea',
    name:         'Nébula Purpúrea',
    cannonCount:  4,
    cannonSpread: 0.30,
    cannonRange:  120,
    fireInterval: 2800,
    hitRadius:    28,
    model:        '/models/npc_ships/nebulaPurpurea.glb',
    scale: 55, yOffset: -4, rotOffset: Math.PI / 2,
  },
  // A bigorna: mais casco, salva larga, a cadência mais lenta das três.
  necrofagoDasAlmas: {
    id:           'necrofagoDasAlmas',
    name:         'Necrófago das Almas',
    cannonCount:  6,
    cannonSpread: 0.36,
    cannonRange:  120,
    fireInterval: 3200,
    hitRadius:    30,
    model:        '/models/npc_ships/necrofagoDasAlmas.glb',
    scale: 55, yOffset: -5, rotOffset: 0,
  },
};

module.exports = { NPC_SHIP_HULLS };
