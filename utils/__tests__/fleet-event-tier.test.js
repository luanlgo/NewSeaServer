// ─────────────────────────────────────────────────────────────────────────────
// Frota de Caçadores — a escala é o Tier do caçado
//
// O evento tem uma régua só: o Tier (abates/10) do jogador que a frota elegeu
// como alvo no anúncio. Três coisas precisam ser verdade para essa régua ser
// confiável:
//
//   1. o alvo é o de MAIOR Tier vivo no mapa — senão a frota sai calibrada
//      para o novato que passou por ali e o veterano farma de graça;
//   2. o Tier congela no anúncio e viaja até o pagamento — se o bounty
//      recalculasse na morte, morrer de propósito antes do abate (ou subir de
//      Tier durante a luta) mudaria o preço do navio que já estava em campo;
//   3. TODO Tier conta e o `base` segura o piso — a curva é
//      `base + perTier × tier`, sem degraus e sem navio morto em Tier 0.
//
// O item 2 é o que quebra em silêncio: nada no jogo reclama se o navio custar
// caro e pagar barato.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// O fleet-event-manager puxa o db-manager no topo, que abre conexão ao subir.
// O save precisa devolver promessa: o manager encadeia `.catch()` no retorno.
const dbPath = require.resolve('../../managers/db-manager.js');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, children: [], paths: [],
  exports: { save: () => Promise.resolve() },
};

const FleetEventManager = require('../../managers/fleet-event-manager.js');
const { FLEET_EVENT }   = require('../../constants/index.js');

const MAPA = FLEET_EVENT.maps[0];   // primeira zona amarela elegível

/** Jogador mínimo que o manager sabe ler. */
function jogador(name, npcKills, extra = {}) {
  return {
    name, npcKills, dead: false, mapLevel: MAPA,
    gold: 0, dobroes: 0,
    ws: { readyState: 1, OPEN: 1, bufferedAmount: 0, send: () => {} },
    ...extra,
  };
}

/** NPCManager de mentira: só o `npcs` que o evento usa. */
function fakeMapManager() {
  return { npcs: new Map(), destroyed: false };
}

/**
 * Monta o manager já com jogadores no mapa e devolve as costuras para
 * inspecionar (eventos de mapa, broadcasts globais, NPCs spawnados).
 */
function montar(players) {
  const mapa       = fakeMapManager();
  const eventos    = [];
  const broadcasts = [];
  const mapaJogadores = new Map(players.map((p, i) => [String(i), p]));

  const wss = { clients: new Set() };
  const mgr = new FleetEventManager(
    wss, mapaJogadores, { [MAPA]: { size: 1200 } },
    () => mapa,
    (ev) => eventos.push(ev),
  );

  // `broadcast` sai por wss.clients; sem cliente nenhum não dá para espiar o
  // fleet_incoming, então o payload é capturado direto do _pending.
  return { mgr, mapa, eventos, broadcasts };
}

/** Roda o ciclo inteiro: anúncio → spawn. Devolve os navios em campo. */
function correrAteSpawn(mgr, mapa) {
  const t0 = Date.now();
  mgr._nextAttemptAt = t0;
  mgr.update(t0);                                       // anúncio
  const pending = mgr._pending;
  mgr.update(t0 + FLEET_EVENT.announceMs);              // spawn
  return { pending, navios: [...mapa.npcs.values()] };
}

describe('Frota de Caçadores — alvo e escala', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('elege o jogador de maior Tier do mapa como caçado', () => {
    const veterano = jogador('Veterano', 640);   // Tier 64
    const novato   = jogador('Novato',    30);   // Tier 3
    const { mgr }  = montar([novato, veterano]);

    const alvo = mgr._huntedOnMap(MAPA);
    expect(alvo.name).toBe('Veterano');
    expect(FLEET_EVENT.tierOf(alvo)).toBe(64);
  });

  it('ignora jogadores mortos e de outros mapas na escolha do alvo', () => {
    const morto  = jogador('Fantasma', 5000, { dead: true });      // Tier 500
    const fora   = jogador('Distante', 3000, { mapLevel: 99 });    // Tier 300
    const vivo   = jogador('Presente',  200);                      // Tier 20
    const { mgr } = montar([morto, fora, vivo]);

    expect(mgr._huntedOnMap(MAPA).name).toBe('Presente');
  });

  it('escala vida e dano por base + perTier × Tier do caçado', () => {
    const alvo = jogador('Alvo', 300);   // Tier 30
    const { mgr, mapa } = montar([alvo]);
    const { navios } = correrAteSpawn(mgr, mapa);

    expect(navios.length).toBeGreaterThan(0);
    for (const n of navios) {
      const def = FLEET_EVENT.ships[n.fleetKey];
      expect(n.maxHp).toBe(def.hp.base     + def.hp.perTier     * 30);
      expect(n.cannonDmg).toBe(def.damage.base + def.damage.perTier * 30);
      expect(n.fleetTier).toBe(30);
    }
  });

  it('cada Tier conta — nenhum degrau entre Tiers vizinhos', () => {
    // A queixa que motivou o `perTier`: subir de Tier tem de mexer no ponteiro
    // sempre, não só ao cruzar uma faixa. Entre 30 e 31 a diferença é
    // exatamente um `perTier`, e o mesmo vale para qualquer par vizinho.
    for (const def of Object.values(FLEET_EVENT.ships)) {
      for (const t of [0, 1, 2, 7, 30, 31, 88, 199]) {
        expect(FLEET_EVENT.atTier(def.hp, t + 1) - FLEET_EVENT.atTier(def.hp, t))
          .toBe(def.hp.perTier);
        expect(FLEET_EVENT.atTier(def.bounty.gold, t + 1) - FLEET_EVENT.atTier(def.bounty.gold, t))
          .toBe(def.bounty.gold.perTier);
      }
    }
  });

  it('paga o bounty pelo Tier congelado, não pelo Tier do momento da morte', () => {
    const alvo   = jogador('Alvo', 300);        // Tier 30 no anúncio
    const killer = jogador('Matador', 100);
    const { mgr, mapa } = montar([alvo, killer]);
    const { navios } = correrAteSpawn(mgr, mapa);

    const navio = navios[0];
    const def   = FLEET_EVENT.ships[navio.fleetKey];

    // O alvo continua abatendo durante a caçada e sobe de Tier — o preço do
    // navio que já está em campo não pode mudar por isso.
    alvo.npcKills = 5000;                        // Tier 500

    mgr.onFleetShipKilled(killer, navio);

    expect(killer.gold).toBe(def.bounty.gold.base     + def.bounty.gold.perTier     * 30);
    expect(killer.dobroes).toBe(def.bounty.dobrao.base + def.bounty.dobrao.perTier * 30);
  });

  it('mapa e dificuldade de mundo não entram na conta do bounty', () => {
    // Mesmo Tier, dois mapas amarelos diferentes → mesmo pagamento.
    const pagamentos = FLEET_EVENT.maps.slice(0, 2).map(lvl => {
      const alvo   = jogador('Alvo', 400, { mapLevel: lvl });   // Tier 40
      const killer = jogador('Matador', 10, { mapLevel: lvl, diffIdx: 4 });
      const mapa   = fakeMapManager();
      const mgr    = new FleetEventManager(
        { clients: new Set() },
        new Map([['a', alvo], ['b', killer]]),
        { [lvl]: { size: 1200 } },
        () => mapa,
        () => {},
      );
      const t0 = Date.now();
      mgr._nextAttemptAt = t0;
      mgr.update(t0);
      mgr.update(t0 + FLEET_EVENT.announceMs);

      const navio = [...mapa.npcs.values()][0];
      const def   = FLEET_EVENT.ships[navio.fleetKey];
      mgr.onFleetShipKilled(killer, navio);
      // Cada iteração sorteia um navio diferente, então comparar o ouro bruto
      // não diria nada. O que tem de bater é o TIER que o pagamento revela:
      // invertendo `base + perTier × tier`, tem de sair 40 nos dois mapas.
      return (killer.gold - def.bounty.gold.base) / def.bounty.gold.perTier;
    });

    expect(pagamentos[0]).toBe(40);
    expect(pagamentos[1]).toBe(40);
  });

  it('alvo Tier 0 ainda spawna navio vivo (o `base` é o piso)', () => {
    const alvo = jogador('Recruta', 4);   // 4 abates → Tier 0
    const { mgr, mapa } = montar([alvo]);
    const { pending, navios } = correrAteSpawn(mgr, mapa);

    expect(pending.tier).toBe(0);
    for (const n of navios) {
      const def = FLEET_EVENT.ships[n.fleetKey];
      expect(n.maxHp).toBe(def.hp.base);
      expect(n.cannonDmg).toBe(def.damage.base);
      expect(n.maxHp).toBeGreaterThan(0);
      expect(n.cannonDmg).toBeGreaterThan(0);
    }
  });

  it('anuncia o nome do caçado e o Tier junto com o aviso', () => {
    const alvo    = jogador('Barba Ruiva', 870);   // Tier 87
    const { mgr } = montar([alvo]);
    const t0 = Date.now();
    mgr._nextAttemptAt = t0;
    mgr.update(t0);

    expect(mgr._pending.targetName).toBe('Barba Ruiva');
    expect(mgr._pending.tier).toBe(87);
  });
});

describe('Frota de Caçadores — sorteio de modelos', () => {
  it('só sorteia navios do catálogo de npc_ships', () => {
    const catalogo = Object.keys(FLEET_EVENT.ships);
    for (const key of FLEET_EVENT.pickShips(20)) {
      expect(catalogo).toContain(key);
    }
    for (const def of Object.values(FLEET_EVENT.ships)) {
      expect(def.model).toMatch(/^\/models\/npc_ships\/.+\.glb$/);
    }
  });

  it('uma frota cheia nunca repete modelo', () => {
    // O saco de sorteio só é reposto quando esvazia: enquanto o pedido couber
    // no catálogo, os três navios saem visualmente distintos.
    const n = Object.keys(FLEET_EVENT.ships).length;
    for (let i = 0; i < 50; i++) {
      const sorteio = FLEET_EVENT.pickShips(n);
      expect(new Set(sorteio).size).toBe(n);
    }
  });

  it('só acontece em zona amarela', () => {
    const { MAP_DEFS } = require('../../constants/index.js');
    expect(FLEET_EVENT.maps.length).toBeGreaterThan(0);
    for (const lvl of FLEET_EVENT.maps) {
      expect(MAP_DEFS[lvl].pvpZone).toBe('yellow');
    }
  });

  // ── O teto ────────────────────────────────────────────────────────────────
  // `base + perTier × tier` não para sozinho. Sem teto, um `npcKills` que só
  // cresce (ou corrompido no banco) constrói um navio de vida arbitrária e um
  // bounty do mesmo tamanho — e o segundo é pior que o primeiro, porque ele
  // IMPRIME ouro.
  describe('teto de Tier', () => {
    it('o Tier lido pelo evento para em TIER_CAP', () => {
      expect(FLEET_EVENT.TIER_CAP).toBe(7000);
      // 10 abates = 1 Tier, então 10× o teto é o dobro dos abates necessários.
      expect(FLEET_EVENT.tierOf(jogador('Lenda', FLEET_EVENT.TIER_CAP * 10 * 2)))
        .toBe(FLEET_EVENT.TIER_CAP);
    });

    it('atributos e bounty param no mesmo ponto', () => {
      const stat = { base: 100, perTier: 10 };
      const noTeto = FLEET_EVENT.atTier(stat, FLEET_EVENT.TIER_CAP);
      // Um `fleetTier` gravado acima do teto (versão antiga do servidor) não
      // pode pagar mais que o teto.
      expect(FLEET_EVENT.atTier(stat, FLEET_EVENT.TIER_CAP + 50_000)).toBe(noTeto);
      expect(noTeto).toBe(100 + 10 * FLEET_EVENT.TIER_CAP);
    });

    it('abaixo do teto nada muda — todo Tier continua contando', () => {
      const stat = { base: 1500, perTier: 450 };
      expect(FLEET_EVENT.atTier(stat, 15)).toBe(1500 + 450 * 15);
      expect(FLEET_EVENT.atTier(stat, 6999)).toBe(1500 + 450 * 6999);
    });
  });

  // Este teste é o guarda do MODO TESTE: enquanto o intervalo de playtest
  // (segundos) estiver em constants/fleet_event.js, a suíte fica vermelha de
  // propósito. É o único aviso automático que impede o valor de escapar num
  // deploy — se ele passar a incomodar, o certo é restaurar a hora cheia, não
  // afrouxar a asserção.
  it('agenda de hora em hora, com jitter menor que o intervalo', () => {
    expect(FLEET_EVENT.intervalMs,
      'MODO TESTE ATIVO em constants/fleet_event.js — restaure ' +
      'firstDelayMs: 15*60*1000, intervalMs: 60*60*1000, jitterMs: 5*60*1000 ' +
      'antes de subir.',
    ).toBe(60 * 60 * 1000);
    expect(FLEET_EVENT.jitterMs).toBeLessThan(FLEET_EVENT.intervalMs);
  });
});
