// constants/islands.js — Ilhas de guilda: torres, conquista e imposto
//
// Três ilhas conquistáveis, uma por mapa (12, 13 e 14), logo ao norte do Mar dos
// Renegados. Cada uma GOVERNA uma praça econômica do jogo e cobra imposto sobre
// o que se gasta lá — e uma vez por semana esse imposto sai num barco que
// qualquer um pode afundar.
//
// ── O ciclo de uma ilha ──────────────────────────────────────────────────────
//   NEUTRA      5 torres sorteadas, hostis a todo mundo. Derrube as cinco.
//   DISPUTADA   as cinco caíram; a guilda que somou mais dano leva a ilha.
//   GRAÇA       a dona tem GRACE_MS para erguer a primeira torre; se não erguer,
//               a ilha passa para a segunda colocada no ranking de dano, e assim
//               por diante.
//   DOMINADA    a guilda cobra imposto na praça e defende com as próprias torres.
//   COLETA      no dia da ilha, o barco parte da praça rumo a ela.
//   RESET       depois da coleta tudo volta ao começo: torres novas, sem dono.
//
// ── Por que os números moram aqui ────────────────────────────────────────────
// O managers/island-manager.js só executa regra. Balancear é editar este
// arquivo. Os valores de torre e custo vieram do pedido; o resto (cadência de
// tiro, raio de gerência, rota do barco) é escolha de implementação e está
// comentado onde não é óbvio.
'use strict';

const { NPC_SHIP_HULLS } = require('./npc_ships');

// ═══════════════════════════════════════════════════════════════════════════════
// Torres
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Os três tipos. `weight` é a fatia do sorteio das torres NEUTRAS (10/30/60).
 *
 * O `fireInterval` não veio do pedido, que pede "dano contínuo enquanto no
 * alcance". Dano contínuo de verdade — um pedaço por tique a 62 Hz — dá 1,8
 * milhão de dano por segundo na torre fraca e mata qualquer barco antes de ele
 * ler a tela. Uma salva a cada 2s é o mesmo número no papel do jeito que o
 * jogador consegue reagir: dá para entrar, levar um tiro e sair.
 */
// ── Escala: leia isto antes de mexer na vida ou no dano ──────────────────────
// Estes são os valores de PRODUÇÃO, e o teste 'a vida e o dano das torres são
// os de produção' (utils/__tests__/islands.test.js) compara linha a linha com
// TOWER_PROD, logo abaixo. É de propósito: durante o playtest a escala foi
// baixada para caber num teste de campo, e o único aviso automático que impede
// esse número de escapar num deploy é a suíte ficar vermelha. Se precisar
// baixar de novo, baixe aqui e RESTAURE antes de subir — não afrouxe o teste.
//
// Medido contra o barco de fim de jogo (queen_annes_revenge, 20 canhões c6,
// upgrades de ilha no 5): 104.400 de vida, salva de 1.710 a cada 3s, alcance
// 120. Nesta escala esse barco morre em 10 SEGUNDOS sob UMA torre tendo tirado
// 2,5% dela — a conquista é obra de FROTA, não de barco só. Foi por não caber
// num teste de uma pessoa que a escala de playtest existiu.
//
// A vida das torres JÁ SALVAS é realinhada no boot (ver
// IslandManager._reconciliarTorres) — mudar o número aqui basta.
//
// O ALCANCE (TOWER_RANGE 150 contra 120 do canhão) é decisão de projeto e não
// escala: a torre enxergar mais longe que o canhão é o que cobra o preço de
// entrar no anel.
const TOWER_TYPES = {
  fraca: {
    id: 'fraca', name: 'Torre Fraca', icon: '🗼',
    hp: 1_000_000, damage: 30_000,
    costGold: 1_000_000, costDobroes: 0,
    weight: 60,
    model: '/models/torres/torreBasica.glb',
  },
  media: {
    id: 'media', name: 'Torre Média', icon: '🏯',
    hp: 20_000_000, damage: 50_000,
    costGold: 20_000_000, costDobroes: 0,
    weight: 30,
    model: '/models/torres/torreMedia.glb',
  },
  forte: {
    id: 'forte', name: 'Torre Forte', icon: '🏰',
    hp: 40_000_000, damage: 50_000,
    costGold: 0, costDobroes: 100_000,
    weight: 10,
    model: '/models/torres/torreLendaria.glb',
  },
};

/**
 * A mesma vida e o mesmo dano de novo, e de propósito: é contra ESTA tabela que
 * o teste guarda o TOWER_TYPES acima. Duas cópias parecem desperdício até a
 * primeira vez que uma escala de playtest quase sobe para produção — a segunda
 * cópia é o que faz a suíte gritar. Mexeu na escala de verdade? Mude as duas.
 */
const TOWER_PROD = {
  fraca: { hp:  1_000_000, damage: 30_000 },
  media: { hp: 20_000_000, damage: 50_000 },
  forte: { hp: 40_000_000, damage: 50_000 },
};

const TOWER_ORDER = ['fraca', 'media', 'forte'];

/** Quantas torres cercam cada ilha. Muda isto e os slots são recalculados. */
const TOWER_SLOTS = 5;
/** Raio em que as torres ficam do centro da ilha. Fora do costão, para dar-se
 *  para atirar nelas do mar sem encalhar. */
const TOWER_RING_RADIUS = 210;
/** Alcance de tiro da torre, em unidades de mundo (pedido). */
const TOWER_RANGE = 150;
/** Intervalo entre salvas da mesma torre. Ver o comentário de fireInterval. */
const TOWER_FIRE_MS = 2000;
/** Torre neutra derrubada volta em 30 min — só enquanto a ilha não tem dono. */
const TOWER_RESPAWN_MS = 30 * 60 * 1000;

/** Posição fixa do slot `i` em torno do centro da ilha. */
function towerSlotPos(i, cx = 0, cz = 0) {
  const a = (i / TOWER_SLOTS) * Math.PI * 2;
  return { x: cx + Math.sin(a) * TOWER_RING_RADIUS, z: cz + Math.cos(a) * TOWER_RING_RADIUS };
}

/** Sorteia um tipo de torre pelos pesos (60% fraca, 30% média, 10% forte). */
function rollTowerType(rnd = Math.random) {
  const total = TOWER_ORDER.reduce((s, id) => s + TOWER_TYPES[id].weight, 0);
  let roll = rnd() * total;
  for (const id of TOWER_ORDER) {
    roll -= TOWER_TYPES[id].weight;
    if (roll < 0) return id;
  }
  return 'fraca';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Reparo
// ═══════════════════════════════════════════════════════════════════════════════

/** A torre precisa passar este tempo sem levar dano para começar a se curar. */
const REPAIR_CALM_MS = 5 * 60 * 1000;
/** Quanto da vida máxima volta por minuto de reparo. */
const REPAIR_PCT_PER_MIN = 0.01;
/**
 * Preço do reparo, em ouro do cofre da guilda, por ponto de vida recuperado.
 * Não veio do pedido ("custo do reparo vem do banco da guilda", sem valor).
 * A conta escolhida: recuperar a torre INTEIRA custa 25% do que ela custou
 * para erguer — barato o bastante para valer a pena consertar em vez de deixar
 * cair, caro o bastante para uma torre forte machucada doer no cofre.
 */
const REPAIR_COST_FRACTION = 0.25;

/** Câmbio usado só para precificar o reparo da torre forte. */
const DOBRAO_TO_GOLD = 500;

/** Ouro por ponto de vida no reparo de uma torre deste tipo. */
function repairGoldPerHp(typeId) {
  const t = TOWER_TYPES[typeId];
  if (!t) return 0;
  // A torre forte custa dobrão, não ouro. O reparo cobra sempre em OURO (o
  // cofre precisa de uma moeda só para isso), convertendo pelo mesmo câmbio da
  // vitrine: 1 dobrão ≈ 500 de ouro.
  const valorOuro = t.costGold || (t.costDobroes * DOBRAO_TO_GOLD);
  return (valorOuro * REPAIR_COST_FRACTION) / t.hp;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Conquista
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Tempo que a guilda vencedora tem para erguer a PRIMEIRA torre. Vencido o
 * prazo sem torre nenhuma, a ilha passa para a próxima do ranking de dano.
 */
const GRACE_MS = 10 * 60 * 1000;

/**
 * Uma guilda só pode DOMINAR uma ilha por semana. Defender a que já tem é
 * livre; tomar a segunda, não. Sem isto a guilda mais forte do servidor levaria
 * as três e o sistema inteiro viraria um monopólio de uma temporada.
 */
const MAX_ISLANDS_PER_GUILD_PER_WEEK = 1;

// ═══════════════════════════════════════════════════════════════════════════════
// Imposto e coleta
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Alíquota = NÍVEL DA GUILDA em pontos percentuais (guilda 3 → 3%). Teto no
 * nível máximo da guilda, que hoje é 25 → 25%.
 */
function taxPctFor(guildLevel) {
  return Math.max(0, Math.min(25, Math.floor(guildLevel || 0))) / 100;
}

/** Vida do barco de coleta (pedido). */
const TAX_BOAT_HP = 10_000_000;
/**
 * Velocidade de cruzeiro — mesma escala dos NPCs (× dt × 30 u/s).
 *
 * Calibrada para a travessia inteira durar cerca de UMA HORA, que é o tempo em
 * que a coleta é um evento que dá para organizar (ver a nau passar, chamar a
 * guilda, cortar caminho pela borda) sem virar plantão. Medida rota a rota, sem
 * nenhuma perna vencendo por tempo:
 *
 *   Farol  → Ilha do Farol Negro       (4→6→11→12)   ~58 min
 *   Mercado→ Ilha do Mercado Roubado   (3→10→11→13)  ~69 min
 *   Banco  → Ilha do Cofre Afundado    (10→11→14)    ~51 min
 *
 * A diferença entre elas é a rota, não a nau: a do Mercado atravessa quatro
 * mapas e contorna duas construções centrais. Para mexer no relógio do evento
 * inteiro, mexa AQUI — as rotas em si vêm das fronteiras do mundo.
 */
const TAX_BOAT_SPEED = 0.115;
/** Distância para considerar um ponto da rota alcançado. */
const TAX_BOAT_WAYPOINT_REACH = 40;
/**
 * Teto de tempo em CADA perna da rota. O barco atravessa vários mapas; se ele
 * emperrar num contorno de ilha, a perna vence e ele segue. Sem isto um evento
 * semanal poderia simplesmente nunca terminar.
 *
 * É REDE DE SEGURANÇA, não cadência: a perna mais longa das três rotas (a
 * travessia do Mar dos Renegados, 7.200 unidades) leva ~35 min na velocidade
 * de cruzeiro, e o teto tem de ficar confortavelmente acima disso. Quando ele
 * era de 6 minutos, TODA travessia do 11 vencia por tempo e a nau teleportava
 * para a borda seguinte — a viagem "funcionava" sem a nau ter navegado.
 */
const TAX_BOAT_LEG_TIMEOUT_MS = 50 * 60 * 1000;
/** Aviso aos jogadores antes de o barco zarpar. */
const TAX_BOAT_WARN_MS = 60 * 1000;

/**
 * Bolo usado quando a coleta é FORÇADA pela aba de teste e a ilha não tem
 * imposto nenhum acumulado (ver TaxBoatManager.forceStart). Um barco sem carga
 * não exercita nada do que o evento faz — a partilha entre membros, a divisão
 * por dano, o extrato — que é justamente o que o teste precisa ver.
 *
 * Este ouro é CRIADO: só entra pelo caminho de teste, e só quando o cofre da
 * praça está vazio. Se um dia a aba virar coisa de jogador, este número tem de
 * virar zero (e o botão, cinza sem imposto).
 */
const FORCE_EVENT_TEST_POT = 100_000;

// ═══════════════════════════════════════════════════════════════════════════════
// As três ilhas
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * `venue` é a chave que o servidor usa para carimbar um gasto (ver
 * islandManager.chargeTax). `venueMap` é onde a praça fica no mundo, e é de lá
 * que o barco parte.
 *
 * `weekday` segue o Date.getDay(): 0 domingo … 6 sábado.
 *
 * `route` é a sequência de mapas que o barco percorre, da praça até a ilha.
 * Foi montada sobre as fronteiras que já existem (sideMap), então o barco
 * atravessa o mundo pelo mesmo caminho que um jogador faria a nado — e é isso
 * que dá aos perseguidores a chance de cortá-lo à frente.
 */
const ISLAND_DEFS = {
  1: {
    id: 1, mapLevel: 12,
    name: 'Ilha do Farol Negro',
    venue: 'farol', venueName: 'Farol', venueMap: 4,
    icon: '🗼',
    weekday: 5,                 // sexta-feira
    route: [4, 6, 11, 12],
  },
  2: {
    id: 2, mapLevel: 13,
    name: 'Ilha do Mercado Roubado',
    venue: 'mercado', venueName: 'Mercado', venueMap: 3,
    icon: '⚖',
    weekday: 6,                 // sábado
    route: [3, 10, 11, 13],
  },
  3: {
    id: 3, mapLevel: 14,
    name: 'Ilha do Cofre Afundado',
    venue: 'banco', venueName: 'Banco', venueMap: 10,
    icon: '🏦',
    weekday: 0,                 // domingo
    route: [10, 11, 14],
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// A guarda da ilha
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A fauna dos mapas 12/13/14 — um navio por ilha, sempre o mesmo.
 *
 * ── Por que existe ───────────────────────────────────────────────────────────
 * As ilhas nasceram sem bicho nenhum: só as cinco torres, para o foco ser a
 * guerra de ilha. Na prática o mapa ficava VAZIO entre uma investida e outra —
 * quem chegava cedo, quem estava esperando a guilda juntar gente ou quem só
 * queria olhar a ilha não tinha absolutamente nada para fazer no caminho até o
 * costão. A patrulha resolve isso sem competir com a torre: ela é fauna comum,
 * paga ouro e XP como qualquer outra, e não conta para a conquista.
 *
 * ── Um casco por ilha ────────────────────────────────────────────────────────
 * Ilha 1 → Manta, ilha 2 → Nébula, ilha 3 → Necrófago. Cada ilha ganha uma
 * silhueta, e quem olha o horizonte sabe em qual das três está. Os cascos são
 * os MESMOS da Frota de Caçadores (constants/npc_ships.js) — o que muda é que
 * aqui a vida e o dano são fixos, como em qualquer mapa, em vez de escalarem
 * pelo Tier do caçado.
 *
 * ── Os números ───────────────────────────────────────────────────────────────
 * A escala é a do fim do jogo: os mapas 12–14 ficam ao norte do 11, e a régua
 * é o Mímico do mapa 10 (140 mil de vida, 15 mil de dano) puxada para cima.
 * `count` é por mapa, não por ilha: doze navios num mapa de 2.400 unidades dão
 * um encontro a cada travessia sem virar parede.
 *
 * `relicDropChance: 0` de propósito. Estes navios não têm skill de bestiário
 * (`attacks: []`), e uma chance de drop aqui cairia no SORTEIO GLOBAL de
 * relíquias — uma torneira de fim de jogo que ninguém pediu, dentro do mapa
 * onde o jogador já vai passar horas. É a mesma escolha da Frota.
 */
const ISLAND_NPC_HULL = {
  1: 'mantaFlorestal',
  2: 'nebulaPurpurea',
  3: 'necrofagoDasAlmas',
};

/** Vida, dano e espólio da patrulha — iguais nas três, só o casco muda. */
const ISLAND_NPC_STATS = {
  count:        12,
  baseHp:       400_000,
  baseDamage:   25_000,
  xpPerKill:    900,
  goldMin:      25_000,
  goldMax:      40_000,
  dobraoChance: 1,
  dobraoMin:    1_500,
  dobraoMax:    3_000,
  relicDropChance: 0,
  hullColor:    0x1a1024,
  sailColor:    0x3d2b55,
  flagColor:    0x120a1a,
};

/**
 * O casco da ilha — a silhueta que manda nela.
 *
 * Vale para a PATRULHA e para o BARCO DA COLETA: a nau que leva o imposto é da
 * ilha, e vê-la sair da praça com a cara da guarda que o jogador enfrentou lá
 * em cima é o que liga as duas metades do evento. Antes ela era um galeão
 * genérico do catálogo de navios, igual a qualquer outro no mar.
 */
function islandHull(islandId) {
  return NPC_SHIP_HULLS[ISLAND_NPC_HULL[islandId]] || null;
}

/**
 * Monta o bloco `npc` do MAP_DEFS de uma ilha. Chamado por constants/maps.js,
 * que é quem monta os três mapas em laço.
 */
function islandNpcDef(islandId) {
  const casco = islandHull(islandId);
  if (!casco) return null;
  return {
    ...ISLAND_NPC_STATS,
    names:        [casco.name],
    // Navio, não bicho: o motor o move e o faz atirar pelo caminho de canhão
    // (ver usesCannons em managers/npc-manager.js). `attacks` vazio é o que
    // mantém a patrulha fora do sorteio de relíquia do bestiário.
    usesCannons:  true,
    cannonCount:  casco.cannonCount,
    cannonSpread: casco.cannonSpread,
    cannonRange:  casco.cannonRange,
    fireInterval: casco.fireInterval,
    hitRadius:    casco.hitRadius,
    model:        casco.model,
    scale:        casco.scale,
    yOffset:      casco.yOffset,
    rotOffset:    casco.rotOffset,
    attacks:      [],
  };
}

/** mapLevel → definição da ilha. É a busca mais quente do sistema. */
const ISLAND_BY_MAP = {};
for (const def of Object.values(ISLAND_DEFS)) ISLAND_BY_MAP[def.mapLevel] = def;

/** venue ('farol'|'mercado'|'banco') → definição da ilha. */
const ISLAND_BY_VENUE = {};
for (const def of Object.values(ISLAND_DEFS)) ISLAND_BY_VENUE[def.venue] = def;

/**
 * Quais mensagens do cliente contam como "gasto" em cada praça. É esta tabela
 * que decide o que é taxado — e ela está aqui, e não espalhada por vinte
 * handlers, para que acrescentar um item à loja não deixe o imposto para trás
 * sem ninguém perceber.
 *
 * O Banco cobra sobre DEPÓSITO e TROCA (o pedido: "transferências e
 * depósitos"). Sacar não é taxado: cobrar nas duas pontas seria cobrar duas
 * vezes pelo mesmo ouro.
 *
 * "Mercado" aqui é a ILHA DO COMÉRCIO inteira, não a aba: a Loja Geral e o Bar
 * ficam na mesma ilha e são a mesma praça para efeito de imposto. Ficaram de
 * fora na primeira volta e o comprador da Loja Geral não pagava nada — o tipo
 * de buraco que esta tabela existe para não deixar acontecer, e que só some se
 * a linha entrar aqui junto com o handler novo.
 *
 * Só entra o que gasta OURO: a cobrança mede o ouro que saiu do bolso (ver o
 * gancho no server.js), então uma ação paga em dobrão ou pó de ouro não gera
 * imposto nenhum. Listá-la aqui não cobraria nada e ainda apareceria na ficha
 * do ⚖ como "isto paga imposto" — é por isso que `buy_ship_upgrade` (dobrão +
 * pó de ouro) está de fora, e não por esquecimento.
 */
const VENUE_ACTIONS = {
  farol:   ['buy_afk_time', 'accept_wanted'],
  mercado: ['buy_cannon', 'buy_ammo', 'buy_navio', 'buy_vela', 'buy_pirate',
            'buy_cannon_upgrade', 'cannon_research',
            'buy_general_item', 'buy_pet_food', 'buy_elite_ship'],
  banco:   ['bank_deposit', 'exchange_gold'],
};

/** A praça de uma ação, ou null se a ação não é taxada. */
const ACTION_VENUE = {};
for (const [venue, actions] of Object.entries(VENUE_ACTIONS)) {
  for (const a of actions) ACTION_VENUE[a] = venue;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Semana
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Identificador da semana corrente (segunda-feira como primeiro dia). Serve
 * para dois controles: "esta guilda já tomou uma ilha esta semana?" e "o evento
 * desta ilha já rodou nesta semana?".
 *
 * Em UTC de propósito: o servidor pode reiniciar em qualquer fuso e a semana
 * não pode escorregar com ele.
 */
function weekKey(at = Date.now()) {
  const d = new Date(at);
  // getUTCDay(): 0 domingo. Recua até a segunda-feira anterior.
  const diaDaSemana = (d.getUTCDay() + 6) % 7;
  const segunda = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diaDaSemana);
  return new Date(segunda).toISOString().slice(0, 10);   // 'YYYY-MM-DD'
}

/** Próximo instante em que o evento desta ilha acontece (hora do dia = HOUR_UTC). */
const EVENT_HOUR_UTC = 21;   // 18h em Brasília — horário de pico

function nextEventAt(islandId, from = Date.now()) {
  const def = ISLAND_DEFS[islandId];
  if (!def) return 0;
  const d = new Date(from);
  for (let i = 0; i < 8; i++) {
    const cand = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + i,
                          EVENT_HOUR_UTC, 0, 0, 0);
    if (cand > from && new Date(cand).getUTCDay() === def.weekday) return cand;
  }
  return from + 7 * 24 * 3600 * 1000;
}

module.exports = {
  TOWER_TYPES, TOWER_ORDER, TOWER_SLOTS, TOWER_RING_RADIUS, TOWER_PROD,
  TOWER_RANGE, TOWER_FIRE_MS, TOWER_RESPAWN_MS,
  towerSlotPos, rollTowerType,
  REPAIR_CALM_MS, REPAIR_PCT_PER_MIN, REPAIR_COST_FRACTION, DOBRAO_TO_GOLD,
  repairGoldPerHp,
  GRACE_MS, MAX_ISLANDS_PER_GUILD_PER_WEEK,
  taxPctFor,
  TAX_BOAT_HP, TAX_BOAT_SPEED, TAX_BOAT_WAYPOINT_REACH,
  TAX_BOAT_LEG_TIMEOUT_MS, TAX_BOAT_WARN_MS, FORCE_EVENT_TEST_POT,
  ISLAND_DEFS, ISLAND_BY_MAP, ISLAND_BY_VENUE,
  ISLAND_NPC_HULL, ISLAND_NPC_STATS, islandNpcDef, islandHull,
  VENUE_ACTIONS, ACTION_VENUE,
  weekKey, nextEventAt, EVENT_HOUR_UTC,
};
