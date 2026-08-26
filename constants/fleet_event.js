// constants/fleet_event.js — Evento "Frota de Caçadores"
//
// Uma frota de 1–3 navios aparece de hora em hora num mapa PvP e CAÇA quem
// estiver lá: são NPCs com isFleetShip=true — perseguem o jogador mais próximo
// do mapa inteiro, sem leash (ver npc-manager.js). Cada navio abatido paga um
// bounty direto ao killer (managers/fleet-event-manager.js) além das
// recompensas normais de kill de NPC.
//
// ── A escala é o TIER DO CAÇADO ─────────────────────────────────────────────
// No anúncio a frota escolhe UM alvo — o jogador de maior Tier no mapa — e
// TUDO (vida, dano, bounty) cresce com o Tier dele. Tier = abates/10, o mesmo
// número que o jogador já lê na HUD, então a conta é verificável de dentro do
// jogo.
//
// Cada atributo é um par `{ base, perTier }`, no mesmo espírito do `perLevel`
// dos talentos (constants/talents.js):
//
//     valor(tier) = base + perTier × tier
//
//   base     o que o navio tem em Tier 0 — o piso, para a frota nunca nascer
//            ridícula contra um alvo novato
//   perTier  quanto cada Tier soma. TODO Tier conta: um alvo Tier 37 leva
//            exatamente 37 incrementos, não o degrau de uma faixa
//
// A curva é linear até TIER_CAP: a vida dos navios do jogador cresce junto
// (fragata 200 → fancy 70.000), então achatar cedo demais viraria farm para o
// veterano. Para achatar ou inclinar o evento inteiro, mexa nos `perTier`; para
// mudar só o piso contra alvos jovens, nos `base`.
//
// ── Por que existe um teto ──────────────────────────────────────────────────
// Sem teto, `base + perTier × tier` não para nunca: 70.000 abates (Tier 7.000)
// já dão um Necrófago de 5,6 milhões de vida e 280 mil de dano por bala — e o
// número segue subindo enquanto o jogador jogar. TIER_CAP é onde a curva para
// de crescer, nos dois sentidos: o navio para de engordar E o bounty para de
// engordar junto. Trava depois do fim do jogo de qualquer jogador real, então
// não achata a progressão de ninguém; ela existe para que a conta tenha um
// limite conhecido em vez de um limite acidental.
//
// A dificuldade de mundo (constants/difficulty.js) e o mapa NÃO entram na
// conta — nem nos atributos, nem no bounty. Só o Tier. É o que torna o evento
// legível: dois jogadores de mesmo Tier enfrentam a mesma frota em qualquer
// mapa, e o pagamento é o mesmo.
//
// ── Onde acontece ───────────────────────────────────────────────────────────
// Todo mapa de zona amarela, derivado de MAP_DEFS em vez de uma lista fixa: a
// caçada é uma regra de zona PvP, então um mapa amarelo novo já nasce dentro
// do evento. Verde (novatos e treino) e vermelho (a arena do mapa 11, que tem
// as próprias regras) ficam de fora.

const { MAP_DEFS }      = require('./maps');
const { NPC_SHIP_HULLS } = require('./npc_ships');

/**
 * Teto do Tier que o evento enxerga. Tier = abates/10, então 7.000 são 70.000
 * abates: nenhum jogador chega perto, e é exatamente por isso que o teto é
 * seguro. Vale para os atributos E para o bounty — os dois lados da mesma
 * régua param no mesmo ponto.
 */
const TIER_CAP = 7000;

const FLEET_EVENT = {
  // Mapas elegíveis = zona amarela. Precisam ter jogador vivo no sorteio.
  maps: Object.keys(MAP_DEFS)
    .filter(k => MAP_DEFS[k].pvpZone === 'yellow')
    .map(Number),

  // Cadência de PRODUÇÃO. Durante o playtest estes três viram segundos para o
  // evento poder ser exercitado; o teste 'agenda de hora em hora, com jitter
  // menor que o intervalo' (utils/__tests__/fleet-event-tier.test.js) é o que
  // impede a escala de teste de escapar num deploy. Se baixar de novo, lembre
  // que jitterMs TEM de ir a 0 junto: ±5min sobre um intervalo de 10s agenda no
  // passado e o evento passa a disparar de forma errática.
  firstDelayMs: 15 * 60 * 1000,     // primeira caçada, 15 min após o boot
  intervalMs:   60 * 60 * 1000,     // de hora em hora
  jitterMs:      5 * 60 * 1000,     // ±5 min, para não cair sempre no minuto 0
  announceMs:   30 * 1000,          // aviso global → spawn
  durationMs:    6 * 60 * 1000,     // frota não abatida "recua" após isso

  // Nº de navios pela quantidade de jogadores vivos no mapa alvo
  // 1 jogador → 1 navio | 2–3 → 2 navios | 4+ → frota completa
  sizeForPlayers: (n) => (n >= 4 ? 3 : n >= 2 ? 2 : 1),

  /** O teto, exposto para quem quiser mostrá-lo (e para os testes). */
  TIER_CAP,

  /**
   * Tier de um jogador — a mesma conta que a HUD e o diário mostram, limitada
   * a TIER_CAP. O corte é AQUI e não só no `atTier` para que o anúncio, o log
   * do servidor e o `fleetTier` congelado no navio contem todos a mesma
   * história: o Tier que o evento usou.
   */
  tierOf(player) {
    return Math.min(TIER_CAP, Math.floor((player?.npcKills || 0) / 10));
  },

  /**
   * Resolve um par `{ base, perTier }` no Tier do caçado. É a única conta de
   * escala do evento: vida, dano e as duas moedas do bounty passam por aqui,
   * então mudar a curva é mudar esta linha.
   *
   * Tier negativo não existe (tierOf usa floor sobre abates >= 0), mas o clamp
   * a 0 garante que um `npcKills` corrompido no DB devolva o piso em vez de um
   * navio com vida negativa. O teto é reaplicado aqui de propósito: o
   * `fleetTier` viaja congelado dentro do navio e pode ter sido gravado por uma
   * versão sem teto — o pagamento não pode escapar pelo caminho antigo.
   */
  atTier(stat, tier) {
    const t = Math.min(TIER_CAP, Math.max(0, Math.floor(tier) || 0));
    return Math.round((stat?.base || 0) + (stat?.perTier || 0) * t);
  },

  /**
   * Sorteia `n` navios do catálogo. Saca de um "saco" embaralhado que só é
   * reposto quando esvazia: numa frota de até 3 os três modelos saem sempre
   * diferentes, e frotas maiores repetem sem nunca sortear o mesmo duas vezes
   * seguidas por azar de dado.
   */
  pickShips(n) {
    const keys = Object.keys(this.ships);
    const out  = [];
    let bag    = [];
    for (let i = 0; i < n; i++) {
      if (bag.length === 0) {
        bag = keys.slice();
        for (let j = bag.length - 1; j > 0; j--) {           // Fisher-Yates
          const r = Math.floor(Math.random() * (j + 1));
          [bag[j], bag[r]] = [bag[r], bag[j]];
        }
      }
      out.push(bag.pop());
    }
    return out;
  },

  // ── Catálogo ───────────────────────────────────────────────────────────────
  // O CASCO (modelo, escala, perfil de canhão) vem de constants/npc_ships.js —
  // os mesmos três navios são também a guarda das ilhas de guilda, e um ajuste
  // fino de escala feito num lugar tem de valer nos dois. O que o evento
  // acrescenta é o que é dele: quanto o navio aguenta, quanto bate e quanto
  // paga, tudo em `{ base, perTier }`.
  //
  // `base` + `perTier` estão calibrados para que um alvo Tier 15 (150 abates)
  // enfrente exatamente a frota que a versão anterior do evento entregava em
  // força cheia — daí os números fecharem redondos naquele ponto.
  //
  // O símbolo alquímico no nome é do EVENTO, não do casco: é o que separa, na
  // placa de nome, a frota que veio caçar você da patrulha parada na ilha.
  ships: {
    // Manta voadora — a batedora: rápida, salvas curtas, casco fino.
    mantaFlorestal: {
      ...NPC_SHIP_HULLS.mantaFlorestal,
      name:         '🜁 Manta Florestal',
      hp:           { base: 1500, perTier: 450 },   // Tier 15 ->  8.250
      damage:       { base:   15, perTier:   20 },   // Tier 15 ->     60 por projétil
      bounty: {
        gold:   { base: 3000, perTier: 500 },      // Tier 15 -> 18.000
        dobrao: { base:   30, perTier:   20 },      // Tier 15 ->    180
      },
    },
    // Dragão a vapor — o canhão da frota: dano por bala mais alto.
    nebulaPurpurea: {
      ...NPC_SHIP_HULLS.nebulaPurpurea,
      name:         '🜂 Nébula Purpúrea',
      hp:           { base: 1500, perTier: 600 },   // Tier 15 -> 10.500
      damage:       { base:   15, perTier:  30 },   // Tier 15 ->     90
      bounty: {
        gold:   { base: 4500, perTier: 600 },      // Tier 15 -> 22.500
        dobrao: { base:   45, perTier:   24 },      // Tier 15 ->    225
      },
    },
    // Nau fantasma — a bigorna: mais vida, salva larga, alcance curto.
    necrofagoDasAlmas: {
      ...NPC_SHIP_HULLS.necrofagoDasAlmas,
      name:         '🜃 Necrófago das Almas',
      hp:           { base: 3000, perTier: 800 },   // Tier 15 -> 15.000
      damage:       { base:   15, perTier:  40 },   // Tier 15 ->     75
      bounty: {
        gold:   { base: 6000, perTier: 700 },      // Tier 15 -> 30.000
        dobrao: { base:   60, perTier:   31 },      // Tier 15 ->    300
      },
    },
  },
};

module.exports = { FLEET_EVENT, TIER_CAP };
