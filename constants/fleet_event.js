// constants/fleet_event.js — Evento "Frota de Caçadores"
//
// Uma frota de 1–3 navios colossais (modelos das masmorras bônus) aparece
// periodicamente num mapa com jogadores e CAÇA ativamente quem estiver lá:
// são NPCs com isFleetShip=true — perseguem o jogador mais próximo do mapa
// inteiro, sem leash (ver npc-manager.js). Cada navio abatido paga um bounty
// direto ao killer (managers/fleet-event-manager.js) além das recompensas
// normais de kill de NPC.
//
// O tamanho da frota escala pelo número de jogadores vivos no mapa alvo
// (formations[n-1]); a nau capitânia (galeão fantasma) só sai com a frota
// completa. Stats/bounty multiplicam por mapScale × killScale — os mesmos
// navios servem sem defs duplicadas.
//
// Gate: a caçada só acontece nos mapas 3 e 4 (novatos dos mapas 1/2 nunca são
// caçados). A força da frota escala pela MÉDIA de abates de NPC dos jogadores
// vivos no mapa alvo (scaleForKills) — quanto mais veterano o pelotão, mais
// pesada a frota que vem atrás dele.

const FLEET_EVENT = {
  maps:         [3, 4],             // mapas elegíveis (precisa ter jogador vivo)
  firstDelayMs: 60 * 60 * 1000,     // 1ª tentativa após o boot do servidor
  intervalMs:  180 * 60 * 1000,     // intervalo base entre eventos (~3h)
  jitterMs:     30 * 60 * 1000,     // ± aleatório sobre o intervalo
  announceMs:   30 * 1000,          // aviso global → spawn
  durationMs:    6 * 60 * 1000,     // frota não abatida "recua" após isso

  // Nº de navios pela quantidade de jogadores vivos no mapa alvo
  // 1 jogador → 1 navio | 2–3 → 2 navios | 4+ → frota completa
  sizeForPlayers: (n) => (n >= 4 ? 3 : n >= 2 ? 2 : 1),

  // Escala dinâmica pela MÉDIA de abates de NPC dos jogadores no mapa alvo.
  // multiplicador = clamp(avgKills / ref, min, max). Em `ref` abates a frota
  // sai em força "cheia" (×1); abaixo disso encolhe (piso min), acima cresce
  // (teto max). Ajuste `ref` para mover a curva inteira.
  killScale: { ref: 150, min: 0.6, max: 4.0 },
  scaleForKills: function (avgKills) {
    const ks = this.killScale;
    const k  = (avgKills || 0) / ks.ref;
    return Math.max(ks.min, Math.min(ks.max, k));
  },

  // Composição por tamanho (índice = tamanho-1). Capitânia só na frota cheia.
  formations: [
    ['massive_imperial_warship'],
    ['massive_imperial_warship', 'gigantic_mechanical_pirate_ship'],
    ['colossal_ghost_pirate_galleon', 'massive_imperial_warship', 'gigantic_mechanical_pirate_ship'],
  ],

  // Multiplicador de hp/dano/bounty por mapa (mapa 3 = baseline). O valor final
  // é este × scaleForKills(avgKills) — ver managers/fleet-event-manager.js.
  mapScale: { 3: 1.0, 4: 1.6 },

  ships: {
    colossal_ghost_pirate_galleon: {
      name:         '☠ Galeão Fantasma Colossal',
      baseHp:       15000,
      baseDamage:   90,          // dano por projétil
      cannonCount:  6,           // projéteis por salva
      cannonSpread: 0.35,
      cannonRange:  170,
      fireInterval: 3200,
      hitRadius:    30,
      bounty:       { gold: 30000, dobrao: 300 },
      model:        '/models/bonus/colossal_ghost_pirate_galleon.glb',
      scale: 50, yOffset: 0, rotOffset: Math.PI / 2,
    },
    massive_imperial_warship: {
      name:         '⚔ Nau de Guerra Imperial',
      baseHp:       10000,
      baseDamage:   70,
      cannonCount:  4,
      cannonSpread: 0.30,
      cannonRange:  180,
      fireInterval: 2600,
      hitRadius:    26,
      bounty:       { gold: 18000, dobrao: 150 },
      model:        '/models/bonus/massive_imperial_warship.glb',
      scale: 0.7, yOffset: 0, rotOffset: 0,
    },
    gigantic_mechanical_pirate_ship: {
      name:         '⚙ Encouraçado Mecânico',
      baseHp:       12000,
      baseDamage:   80,
      cannonCount:  5,
      cannonSpread: 0.32,
      cannonRange:  160,
      fireInterval: 2800,
      hitRadius:    28,
      bounty:       { gold: 22000, dobrao: 200 },
      model:        '/models/bonus/gigantic_mechanical_pirate_ship.glb',
      scale: 0.8, yOffset: -4, rotOffset: 0,
    },
  },
};

module.exports = { FLEET_EVENT };
