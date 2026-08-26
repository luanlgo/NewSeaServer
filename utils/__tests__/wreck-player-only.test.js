// ─────────────────────────────────────────────────────────────────────────────
// A ruína da Zona Vermelha só nasce de morte para JOGADOR
//
// Os 10% de ouro são a moeda do PvP: quem afunda alguém tem o que saquear, e
// quem foi afundado tem para quem perder. Cobrando de TODA morte — bicho,
// torre da ilha, aura, DoT — o ouro não ia para ninguém: ele saía do bolso da
// vítima e nascia um destroço no meio do mar para o primeiro que passasse.
//
// Nas ilhas de guilda (mapas 12–14, zona `red`) isso era o caso comum, não a
// exceção: as cinco torres de cada ilha matam sozinhas o dia inteiro.
//
// O modo silencioso de isto voltar a quebrar é alguém acrescentar um caminho de
// morte novo e chamar onPlayerDeath sem o matador. O padrão do argumento é
// `null` justamente para que esse esquecimento erre para o lado seguro (não
// cobra de ninguém) em vez de punir quem morreu para o cenário.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { WreckManager } = require('../../managers/wreck-manager.js');
const { MAP_DEFS, pvpZoneAtLeast } = require('../../constants/maps.js');

/** Primeiro mapa de zona vermelha do jogo — é onde a regra vale. */
const MAPA_RED = Object.keys(MAP_DEFS).map(Number)
  .find(l => pvpZoneAtLeast(l, 'red'));

function barco(id, nome, extra = {}) {
  return {
    id, name: nome, gold: 100_000, x: 10, z: 20, mapLevel: MAPA_RED,
    ws: { readyState: 1, OPEN: 1, bufferedAmount: 0, send: () => {} },
    ...extra,
  };
}

describe('Ruína da Zona Vermelha — só morte para jogador', () => {
  let wm, eventos;

  beforeEach(() => {
    eventos = [];
    wm = new WreckManager(() => {}, (e) => eventos.push(e));
  });

  const ruinas = () => eventos.filter(e => e.type === 'wreck_spawn');

  it('morrer para outro jogador larga a ruína e cobra os 10%', () => {
    const vitima = barco('v', 'Vitima');
    wm.onPlayerDeath(vitima, barco('k', 'Matador'));

    expect(ruinas()).toHaveLength(1);
    expect(ruinas()[0].gold).toBe(10_000);
    expect(vitima.gold).toBe(90_000);
  });

  it('morrer para a TORRE da ilha não larga nada nem custa ouro', () => {
    const vitima = barco('v', 'Vitima');
    // É assim que a torre mata: islandManager.onPlayerKilled(alvo, null, ...)
    // chega em resolvePlayerDeath sem killerId, e o matador vira null.
    wm.onPlayerDeath(vitima, null);

    expect(ruinas()).toHaveLength(0);
    expect(vitima.gold).toBe(100_000);
  });

  it('morrer para um NPC também não', () => {
    const vitima = barco('v', 'Vitima');
    wm.onPlayerDeath(vitima, { id: 'n1', name: 'Kraken', isNPC: true });

    expect(ruinas()).toHaveLength(0);
    expect(vitima.gold).toBe(100_000);
  });

  it('morrer para si mesmo não é uma forma de dar ouro a quem está por perto', () => {
    const vitima = barco('v', 'Vitima');
    wm.onPlayerDeath(vitima, vitima);

    expect(ruinas()).toHaveLength(0);
    expect(vitima.gold).toBe(100_000);
  });

  it('o chamador que esquece o matador erra para o lado seguro', () => {
    const vitima = barco('v', 'Vitima');
    wm.onPlayerDeath(vitima);

    expect(ruinas()).toHaveLength(0);
    expect(vitima.gold).toBe(100_000);
  });

  it('fora da zona vermelha não larga ruína nem para PvP', () => {
    const verde = Object.keys(MAP_DEFS).map(Number)
      .find(l => !pvpZoneAtLeast(l, 'red'));
    const vitima = barco('v', 'Vitima', { mapLevel: verde });
    wm.onPlayerDeath(vitima, barco('k', 'Matador', { mapLevel: verde }));

    expect(ruinas()).toHaveLength(0);
    expect(vitima.gold).toBe(100_000);
  });

  // A zona de espólio (Red+) desvia o pote para o destroço de 1h; a regra de
  // quem morreu para quem vale antes desse desvio, não depois.
  it('a zona de espólio recebe o pote só quando foi PvP', () => {
    const absorvidos = [];
    const absorve = (v, loss) => { absorvidos.push(loss); return true; };

    wm.onPlayerDeath(barco('v', 'Vitima'), null, absorve);
    expect(absorvidos).toHaveLength(0);

    wm.onPlayerDeath(barco('v2', 'Vitima2'), barco('k', 'Matador'), absorve);
    expect(absorvidos).toEqual([10_000]);
    expect(ruinas()).toHaveLength(0);   // absorvido: a ruína de 10s não nasce
  });
});
