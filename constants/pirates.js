// constants/pirates.js — Tripulação de piratas: combate de abordagem e passivas
//
// ── Uma tripulação só ─────────────────────────────────────────────────────────
// O jogo já tinha piratas: os curandeiros equipados em `player.pirates`, com
// vagas por navio. Em vez de abrir um segundo alistamento paralelo só para a
// batalha de espólio, os piratas de combate entram NA MESMA lista. O que muda é
// o limite: em vez de contar cabeças (`maxHealers`), o navio agora carrega
// PESO — e cada pirata pesa conforme o que entrega.
//
// Consequência prática: `player.inventory.pirates` continua sendo o alistamento
// (quem o jogador possui) e `player.pirates` continua sendo quem está embarcado.
// Curandeiro é o pirata de função `suporte`; ele cura fora de combate como
// sempre curou E soma sua força na abordagem.
//
// ── Curandeiros (comportamento preservado) ───────────────────────────────────
// A cura é um valor FIXO por tique, não uma fração da vida máxima. Em
// percentual o curandeiro valia exatamente a mesma coisa na fragata de 200 de
// vida e no Fancy de 70.000 — e agora que dá para equipar vários, o percentual
// multiplicado por 10 encheria a barra em meio segundo em qualquer navio.
//
// `needsIdle` + `combatCooldown`: só cura depois de 10s fora de combate.
//
// ── Campos de um pirata ──────────────────────────────────────────────────────
//   name/icon/desc   texto de fallback (a UI usa I18n: pir.<id>.name / .desc)
//   role             'equilibrado' | 'atacante' | 'tanque' | 'defensor'
//                    | 'suporte' | 'lendario' — é o que permite compor time
//   venues           ONDE se contrata, e são vários: 'loja' é o Mercado dos
//                    mapas 1 e 2, 'bar' é o Bar da Ilha do Comércio (mapa 3).
//                    O Bar é o salão de contratação COMPLETO — tem os seis de
//                    abordagem e também os curandeiros, para montar a tripulação
//                    inteira num lugar só. A loja é o recorte: lá só o
//                    curandeiro, que é utilidade básica e precisa estar perto de
//                    quem começou. Por isso curandeiro é o único nos dois.
//   atk/def/hp       atributos de combate (ver POWER_* na fórmula abaixo)
//   weight           peso no porão; o navio tem um teto em SHIP_PIRATE_CAPACITY
//   price/currency   custo na loja (SHOP.piratas espelha estes campos)
//   survival         peso de MORTE relativo: 0,5 morre metade das vezes que um
//                    pirata de 1,0 morreria na mesma derrota. Tanque protege-se.
//   immortal         não entra no sorteio de baixas, nem no piso de um morto do
//                    lado derrotado. Só o Curandeiro Elite tem — ver battle-sim.
//   aura             bônus que ESTE pirata dá ao grupo inteiro, em frações:
//                    { off, def } — somam por cabeça, então uma tripulação de
//                    contramestres é forte mas cara em peso.
//   healAmount…      só os curandeiros têm; o tique de cura do server.js e o
//                    homing do projectile-manager leem com `?.`, então piratas
//                    sem esses campos passam batido.
'use strict';

const { SHIP_DEFS } = require('./ships');

const PIRATE_DEFS = {
  // ── Suporte: os dois curandeiros que já existiam ──────────────────────────
  healer: {
    name: 'Curandeiro', icon: '⚕', role: 'suporte', venues: ['loja', 'bar'],
    desc: 'Cura o navio fora de combate e mantém a moral da abordagem.',
    atk: 6, def: 10, hp: 18, weight: 2, survival: 1.0,
    aura: { off: 0, def: 0.02 },
    price: 100, currency: 'gold',
    healAmount: 100, healInterval: 500, needsIdle: true, combatCooldown: 10000,
    homingRadius: 0, homingStrength: 0, critChance: 0,
  },
  healer_elite: {
    name: 'Curandeiro Elite', icon: '✚', role: 'suporte', venues: ['loja', 'bar'],
    desc: 'Cirurgião de bordo. Cura muito mais, ampara os feridos e nunca cai na abordagem.',
    // `immortal`: o ÚNICO pirata que não morre. Todo o resto da tripulação é
    // consumível — uma derrota feia enterra 95% dela — e é isso que dá peso à
    // decisão de abordar. O Curandeiro Elite é a exceção que o jogador compra
    // uma vez e leva para sempre; o preço dele é em dobrão e o peso 3 no porão.
    atk: 10, def: 16, hp: 30, weight: 3, survival: 0.9, immortal: true,
    aura: { off: 0, def: 0.04 },
    price: 100, currency: 'dobrao',
    healAmount: 300, healInterval: 500, needsIdle: true, combatCooldown: 10000,
    homingRadius: 0, homingStrength: 0, critChance: 0,
  },

  // ── Linha de frente ───────────────────────────────────────────────────────
  marujo: {
    name: 'Marujo', icon: '🏴', role: 'equilibrado', venues: ['bar'],
    desc: 'Tripulante comum. Não brilha em nada e serve para tudo — é o peso mais barato do porão.',
    atk: 12, def: 12, hp: 24, weight: 1, survival: 1.0,
    aura: { off: 0, def: 0 },
    price: 600, currency: 'gold',
  },
  bucaneiro: {
    name: 'Bucaneiro', icon: '🗡', role: 'atacante', venues: ['bar'],
    desc: 'Vive do primeiro golpe. Corta fundo e se protege pouco — perde-se muitos deles numa vitória apertada.',
    atk: 34, def: 7, hp: 20, weight: 2, survival: 1.35,
    aura: { off: 0, def: 0 },
    price: 2200, currency: 'gold',
  },
  couraceiro: {
    name: 'Couraceiro', icon: '🛡', role: 'tanque', venues: ['bar'],
    desc: 'Escudo de ferro e passo lento. Absorve a abordagem e sai vivo de quase tudo.',
    atk: 8, def: 30, hp: 70, weight: 4, survival: 0.45,
    aura: { off: 0, def: 0 },
    price: 4000, currency: 'gold',
  },
  fuzileiro: {
    name: 'Fuzileiro Naval', icon: '🎯', role: 'defensor', venues: ['bar'],
    desc: 'Treinado para segurar o convés. Firma a defesa de toda a tripulação.',
    atk: 16, def: 24, hp: 34, weight: 3, survival: 0.75,
    aura: { off: 0, def: 0.05 },
    price: 3200, currency: 'gold',
  },
  contramestre: {
    name: 'Contramestre', icon: '🎺', role: 'suporte', venues: ['bar'],
    desc: 'Grita as ordens que fazem a diferença. Aumenta o ímpeto de todos a bordo.',
    atk: 14, def: 14, hp: 28, weight: 3, survival: 0.85,
    aura: { off: 0.06, def: 0.01 },
    price: 1500, currency: 'dobrao',
  },

  // ── Lendário ──────────────────────────────────────────────────────────────
  // `outnumberedBonus`: a passiva só acende quando ele está em MENOR número —
  // é o pirata que se compra para virar a briga perdida, não para engordar uma
  // tripulação que já era maior.
  capitao_fantasma: {
    name: 'Capitão Fantasma', icon: '👻', role: 'lendario', venues: ['bar'],
    desc: 'Atravessa o casco e ataca por dentro. Quanto mais em desvantagem numérica, mais aterroriza.',
    atk: 42, def: 30, hp: 80, weight: 5, survival: 0.35,
    aura: { off: 0.04, def: 0.04 },
    outnumberedBonus: 0.35,
    price: 9000, currency: 'dobrao',
  },
};

/** Ids na ordem em que aparecem na loja e no armazém. */
const PIRATE_ORDER = [
  'marujo', 'bucaneiro', 'fuzileiro', 'couraceiro',
  'healer', 'healer_elite', 'contramestre', 'capitao_fantasma',
];

/**
 * Ids vendidos num balcão — 'loja' (Mercado dos mapas 1 e 2) ou 'bar' (Ilha do
 * Comércio). Um mesmo pirata pode estar nos dois, e um def sem `venues` cai na
 * loja: o balcão é o detalhe, o pirata é o dado, e um def novo nunca some da UI
 * por esquecimento.
 */
function piratesAtVenue(venue) {
  return PIRATE_ORDER.filter(id => (PIRATE_DEFS[id].venues || ['loja']).includes(venue));
}

// ── Capacidade de peso por navio ─────────────────────────────────────────────
// Mesma regra do antigo `maxHealersFor`: a categoria decide, com exceções
// nominais para os navios que devem fugir da média. Assim um navio novo entra
// no jogo com capacidade sensata sem ninguém lembrar de cadastrá-lo aqui.
const PIRATE_CAPACITY_DEFAULT = 10;   // fragata inicial e qualquer navio desconhecido
const PIRATE_CAPACITY_NORMAL  = 18;
const PIRATE_CAPACITY_ELITE   = 40;

const SHIP_PIRATE_CAPACITY = {
  fragata:   10,
  sloop:     14,
  brigantine: 18,
  schooner:  18,
  galleon:   24,
  frigate:   22,
  // Elites
  ghost_pirate_ship:   34,
  royal_fortune:       44,
  adventure_galley:    40,
  whydah_galley:       40,
  queen_annes_revenge: 46,
  fancy:               48,
  // Navios raros do Mapa Bônus
  colossal_ghost_pirate_galleon:   50,
  massive_imperial_warship:        50,
  gigantic_mechanical_pirate_ship: 50,
};

/** Quanto peso de pirata este navio carrega. Aceita o def ou o id. */
function pirateCapacityFor(shipDefOrId) {
  const id  = typeof shipDefOrId === 'string' ? shipDefOrId : null;
  if (id && SHIP_PIRATE_CAPACITY[id] != null) return SHIP_PIRATE_CAPACITY[id];
  const def = id ? SHIP_DEFS[id] : shipDefOrId;
  if (!def) return PIRATE_CAPACITY_DEFAULT;
  return def.isElite ? PIRATE_CAPACITY_ELITE : PIRATE_CAPACITY_NORMAL;
}

/** Peso somado de uma lista de ids de pirata (ids desconhecidos pesam 0). */
function pirateWeightOf(list) {
  let total = 0;
  for (const id of (list || [])) total += PIRATE_DEFS[id]?.weight || 0;
  return total;
}

// ── RUN — ativação dos piratas ───────────────────────────────────────────────
// Mesmo desenho da comida de pet (`uva`): é um ITEM de inventário consumido por
// tempo, não um segundo sistema. Sem RUN os piratas continuam embarcados, mas
// não abordam — exatamente como o pet sem comida some do mundo e continua
// equipado. Comprar RUN reativa (onRunPurchased).
//
// O consumo escala com o peso embarcado: levar 40 de peso custa mais garrafas
// por hora do que levar 5. RUN_PER_HOUR_BASE é o piso de quem leva alguém.
const RUN_ITEM_ID        = 'run';
const RUN_PER_HOUR_BASE  = 1.0;    // garrafas/hora com qualquer tripulação a bordo
const RUN_PER_HOUR_WEIGHT = 0.15;  // + por ponto de peso embarcado
const RUN_TICK_MS        = 60_000; // mesmo tique da comida de pet
const RUN_PRICE          = 120;    // ouro por garrafa (autoritativo no servidor)

/** Garrafas por hora de uma tripulação com este peso total. */
function runPerHour(totalWeight) {
  if (totalWeight <= 0) return 0;
  return RUN_PER_HOUR_BASE + RUN_PER_HOUR_WEIGHT * totalWeight;
}

// ── Fórmula de batalha ───────────────────────────────────────────────────────
// A força de um lado é a soma dos atributos dos piratas, com a vida entrando
// nos dois pratos: um pirata robusto contribui atacando e defendendo.
//
//     ofensiva  = Σ (atk + hp × POWER_HP_WEIGHT) × (1 + auras ofensivas)
//     defensiva = Σ (def + hp × POWER_HP_WEIGHT) × (1 + auras defensivas)
//
// O confronto é a razão entre a ofensiva do atacante e a defensiva do defensor.
const POWER_HP_WEIGHT = 0.25;
/** Teto das auras somadas — 20 contramestres não podem dobrar a tripulação. */
const MAX_AURA        = 0.60;

// ── Baixas ───────────────────────────────────────────────────────────────────
// `q = (1/r)^LOSS_EXP`, onde r ≥ 1 é a vantagem de quem venceu. q vale 1 numa
// batalha empatada e cai rápido conforme a vantagem cresce:
//
//     r      1,0    1,5    2,0    3,0    5,0   10,0
//     q      1,00   0,54   0,35   0,19   0,09   0,03
//     venc.  80%    44%    28%    15%     7%     3%   ← perde da própria tripulação
//     perd.  85%    90%    92%    93%    94%    95%
//
// É por isso que as baixas NÃO são uma porcentagem fixa: uma vitória folgada
// custa 3% da tripulação e uma vitória no fio da navalha custa 80%. Quem perde
// um combate impossível enterra 95% — o piso de 85% existe para que perder
// nunca seja barato.
const LOSS_EXP        = 1.5;
const WINNER_MAX_LOSS = 0.80;
const LOSER_MIN_LOSS  = 0.85;
const LOSER_MAX_LOSS  = 0.95;

// Sorte da batalha: ±10% na razão de forças, sorteada da semente registrada no
// relatório. É o que faz uma batalha 🟡 amarela poder virar dos dois lados.
const LUCK_SPREAD = 0.10;

// ── Grau de dificuldade (o farol 🟢🟡🔴 do espólio) ──────────────────────────
// Calculado ANTES da sorte, sobre a razão ofensiva do atacante ÷ defensiva do
// defensor. O jogador vê a cor, nunca os piratas inimigos.
const DIFFICULTY_TIERS = [
  { id: 'facil',  color: 'green',  minRatio: 1.60 },
  { id: 'medio',  color: 'yellow', minRatio: 0.90 },
  { id: 'dificil', color: 'red',   minRatio: 0    },
];

// ── Espólio ──────────────────────────────────────────────────────────────────
// O destroço de espólio nasce só em mapas de zona Red ou superior e coexiste
// com a ruína de ouro de 10s que já existia (wreck-manager) — são duas coisas
// diferentes no mesmo naufrágio.
const SPOIL_TTL_MS       = 60 * 60 * 1000;  // 1 hora
const SPOIL_LOOT_RANGE   = 60;              // mesma distância do saque de ruína
// Quanto a vítima perde NÃO se decide aqui. O ouro é WRECK_GOLD_PCT, no
// wreck-manager, que é quem sempre fez essa conta; os 5% de XP e de abates
// saem em `_creditPvpKill`, no server.js. Moravam aqui três constantes que
// repetiam esses números sem ninguém lê-las — mexer nelas não mudava nada,
// mas parecia que mudava.

module.exports = {
  PIRATE_DEFS, PIRATE_ORDER, piratesAtVenue,
  SHIP_PIRATE_CAPACITY, pirateCapacityFor, pirateWeightOf,
  PIRATE_CAPACITY_DEFAULT, PIRATE_CAPACITY_NORMAL, PIRATE_CAPACITY_ELITE,
  RUN_ITEM_ID, RUN_PER_HOUR_BASE, RUN_PER_HOUR_WEIGHT, RUN_TICK_MS, RUN_PRICE,
  runPerHour,
  POWER_HP_WEIGHT, MAX_AURA,
  LOSS_EXP, WINNER_MAX_LOSS, LOSER_MIN_LOSS, LOSER_MAX_LOSS, LUCK_SPREAD,
  DIFFICULTY_TIERS,
  SPOIL_TTL_MS, SPOIL_LOOT_RANGE,
};
