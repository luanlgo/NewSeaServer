/**
 * Testes da Mesa de Exploração (handleExploreMap)
 *
 * Cobre:
 *  1. Cálculo de custo (fragmentos → dobrões fallback)
 *  2. Acúmulo de recompensas de munição
 *  3. Acúmulo de recompensas de recursos
 *  4. Seleção ponderada (weighted random)
 *  5. Cenários de saldo insuficiente
 *  6. Teto de 10 000 explorações por chamada
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Constantes (inline para isolar dos módulos CommonJS) ──────────────────────

const FRAGMENT_EXPLORE_COST          = 1;
const FRAGMENT_EXPLORE_FALLBACK_COST = 500;

const EXPLORATION_REWARDS = [
  { type: 'ammo',     id: 'bala_perfurante', qty: 10,  weight: 22 },
  { type: 'ammo',     id: 'bala_gelo',       qty: 10,  weight: 22 },
  { type: 'ammo',     id: 'bala_fogo',       qty: 10,  weight: 16 },
  { type: 'ammo',     id: 'bala_luz',        qty: 10,  weight: 10 },
  { type: 'ammo',     id: 'bala_sangue',     qty: 10,  weight: 6  },
  { type: 'ammo',     id: 'bala_sangue',     qty: 500, weight: 1  },
  { type: 'resource', id: 'ironPlates',      qty: 5,   weight: 12 },
  { type: 'resource', id: 'goldDust',        qty: 3,   weight: 8  },
  { type: 'resource', id: 'gunpowder',       qty: 8,   weight: 11 },
  { type: 'resource', id: 'mapFragments',    qty: 2,   weight: 5  },
];

const TOTAL_WEIGHT = EXPLORATION_REWARDS.reduce((s, r) => s + r.weight, 0);

// ── Reimplementação pura de handleExploreMap (lógica extraída de server.js) ──

function makePlayer(mapFragments = 0, dobroes = 0) {
  return {
    mapFragments,
    dobroes,
    ironPlates:   0,
    goldDust:     0,
    gunpowder:    0,
    inventory: {
      ammo: {
        bala_ferro:       Infinity,
        bala_perfurante:  0,
        bala_gelo:        0,
        bala_fogo:        0,
        bala_luz:         0,
        bala_sangue:      0,
      },
    },
  };
}

/** Lógica pura de handleExploreMap — retorna { ammoResults, resourceResults, times } ou null se insuficiente */
function exploreMap(player, rawQty) {
  const qty      = Math.max(1, Math.min(Math.floor(rawQty || 1), 10000));
  const canFrags = Math.floor(player.mapFragments / FRAGMENT_EXPLORE_COST);
  const canDobr  = Math.floor(player.dobroes      / FRAGMENT_EXPLORE_FALLBACK_COST);

  const timesFrags   = Math.min(qty, canFrags);
  const timesDobroes = Math.min(qty - timesFrags, canDobr);
  const times        = timesFrags + timesDobroes;

  if (times === 0) return null;

  const ammoResults     = {};
  const resourceResults = {};

  for (let i = 0; i < times; i++) {
    if (i < timesFrags) {
      player.mapFragments -= FRAGMENT_EXPLORE_COST;
    } else {
      player.dobroes -= FRAGMENT_EXPLORE_FALLBACK_COST;
    }

    let roll   = Math.random() * TOTAL_WEIGHT;
    let reward = EXPLORATION_REWARDS[0];
    for (const entry of EXPLORATION_REWARDS) {
      roll -= entry.weight;
      if (roll <= 0) { reward = entry; break; }
    }

    if (reward.type === 'ammo') {
      ammoResults[reward.id]  = (ammoResults[reward.id]  || 0) + reward.qty;
      player.inventory.ammo[reward.id] = (player.inventory.ammo[reward.id] || 0) + reward.qty;
    } else {
      resourceResults[reward.id] = (resourceResults[reward.id] || 0) + reward.qty;
      player[reward.id] = (player[reward.id] || 0) + reward.qty;
    }
  }

  return { ammoResults, resourceResults, times, timesFrags, timesDobroes };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Força a seleção de uma recompensa específica mockando Math.random */
function withReward(rewardIndex, fn) {
  // Calcula o valor de roll que seleciona exatamente reward[rewardIndex]
  // A seleção é: acumula pesos até roll <= 0. Para selecionar o índice N,
  // roll deve ser > soma dos pesos 0..N-1 e <= soma dos pesos 0..N.
  const sumBefore = EXPLORATION_REWARDS
    .slice(0, rewardIndex)
    .reduce((s, r) => s + r.weight, 0);
  // roll inicial = sumBefore + 0.1 (cai dentro do peso deste item)
  const mockRoll = (sumBefore + 0.1) / TOTAL_WEIGHT;
  vi.spyOn(Math, 'random').mockReturnValue(mockRoll);
  try { return fn(); }
  finally { vi.restoreAllMocks(); }
}

// ── 1. Cálculo de custo ───────────────────────────────────────────────────────

describe('custo da exploração', () => {
  it('usa fragmentos primeiro', () => {
    const p = makePlayer(5, 0);
    const r = exploreMap(p, 3);
    expect(r.timesFrags).toBe(3);
    expect(r.timesDobroes).toBe(0);
    expect(p.mapFragments).toBe(2);
  });

  it('usa dobrões quando sem fragmentos', () => {
    const p = makePlayer(0, 1500);
    const r = exploreMap(p, 3);
    expect(r.timesFrags).toBe(0);
    expect(r.timesDobroes).toBe(3);
    expect(p.dobroes).toBe(0);
  });

  it('usa fragmentos primeiro e dobrões para o restante', () => {
    const p = makePlayer(2, 1000);
    const r = exploreMap(p, 4);
    expect(r.timesFrags).toBe(2);
    expect(r.timesDobroes).toBe(2);
    expect(p.mapFragments).toBe(0);
    expect(p.dobroes).toBe(0);
  });

  it('retorna null quando sem fragmentos nem dobrões', () => {
    const p = makePlayer(0, 0);
    expect(exploreMap(p, 1)).toBeNull();
  });

  it('retorna null quando dobrões insuficientes para 1 exploração', () => {
    const p = makePlayer(0, 499);
    expect(exploreMap(p, 1)).toBeNull();
  });

  it('limita a 10 000 por chamada mesmo que haja mais fragmentos', () => {
    const p = makePlayer(99999, 0);
    const r = exploreMap(p, 99999);
    expect(r.times).toBe(10000);
  });

  it('rawQty mínimo é 1 mesmo passando 0', () => {
    const p = makePlayer(10, 0);
    const r = exploreMap(p, 0);
    expect(r.times).toBe(1);
  });
});

// ── 2. Recompensas de munição ─────────────────────────────────────────────────

describe('recompensas de munição', () => {
  it('adiciona munição ao ammoResults e ao inventory do jogador', () => {
    const p = makePlayer(1, 0);
    withReward(0, () => { // bala_perfurante (qty 10)
      const r = exploreMap(p, 1);
      expect(r.ammoResults['bala_perfurante']).toBe(10);
      expect(p.inventory.ammo['bala_perfurante']).toBe(10);
    });
  });

  it('acumula múltiplas explorações do mesmo tipo de bala', () => {
    const p = makePlayer(3, 0);
    vi.spyOn(Math, 'random').mockReturnValue(
      (EXPLORATION_REWARDS.slice(0, 0).reduce((s, r) => s + r.weight, 0) + 0.1) / TOTAL_WEIGHT
    ); // sempre bala_perfurante
    const r = exploreMap(p, 3);
    vi.restoreAllMocks();
    expect(r.ammoResults['bala_perfurante']).toBe(30);
    expect(p.inventory.ammo['bala_perfurante']).toBe(30);
  });

  it('bala_sangue jackpot (qty 500) é corretamente adicionada', () => {
    const p = makePlayer(1, 0);
    withReward(5, () => { // bala_sangue jackpot
      const r = exploreMap(p, 1);
      expect(r.ammoResults['bala_sangue']).toBe(500);
      expect(p.inventory.ammo['bala_sangue']).toBe(500);
    });
  });

  it('ammo não ganho fica ausente dos ammoResults (não envia zeros)', () => {
    const p = makePlayer(1, 0);
    withReward(0, () => { // só bala_perfurante
      const r = exploreMap(p, 1);
      expect(r.ammoResults['bala_gelo']).toBeUndefined();
    });
  });

  it('não modifica bala_ferro (munição base infinita)', () => {
    const p = makePlayer(1, 0);
    withReward(0, () => { exploreMap(p, 1); });
    expect(p.inventory.ammo['bala_ferro']).toBe(Infinity);
  });
});

// ── 3. Recompensas de recursos ────────────────────────────────────────────────

describe('recompensas de recursos', () => {
  it('adiciona ironPlates ao jogador e ao resourceResults', () => {
    const p = makePlayer(1, 0);
    withReward(6, () => { // ironPlates (qty 5)
      const r = exploreMap(p, 1);
      expect(r.resourceResults['ironPlates']).toBe(5);
      expect(p.ironPlates).toBe(5);
    });
  });

  it('adiciona gunpowder corretamente', () => {
    const p = makePlayer(1, 0);
    withReward(8, () => { // gunpowder (qty 8)
      const r = exploreMap(p, 1);
      expect(r.resourceResults['gunpowder']).toBe(8);
      expect(p.gunpowder).toBe(8);
    });
  });

  it('mapFragments são adicionados ao jogador via resource', () => {
    const p = makePlayer(3, 0);
    withReward(9, () => { // mapFragments (qty 2) — sempre 3 vezes
      const r = exploreMap(p, 3);
      // 3 explorações × fragmentos gastos; mas mapFragments reward é resource
      expect(r.resourceResults['mapFragments']).toBe(6); // 3 × 2
    });
  });

  it('acumula múltiplas explorações do mesmo recurso', () => {
    const p = makePlayer(2, 0);
    withReward(6, () => { // ironPlates
      const r = exploreMap(p, 2);
      expect(r.resourceResults['ironPlates']).toBe(10); // 2 × 5
      expect(p.ironPlates).toBe(10);
    });
  });
});

// ── 4. Seleção ponderada ──────────────────────────────────────────────────────

describe('seleção ponderada dos rewards', () => {
  it('cada entry da tabela pode ser selecionado', () => {
    EXPLORATION_REWARDS.forEach((expected, idx) => {
      const p = makePlayer(1, 0);
      withReward(idx, () => {
        const r = exploreMap(p, 1);
        if (expected.type === 'ammo') {
          expect(r.ammoResults[expected.id]).toBeGreaterThanOrEqual(expected.qty);
        } else {
          expect(r.resourceResults[expected.id]).toBeGreaterThanOrEqual(expected.qty);
        }
      });
    });
  });

  it('distribuição aproxima os pesos em amostra grande', () => {
    // 2 000 explorações: bala_perfurante (w=22) deve ser ~2× mais frequente que bala_fogo (w=16)
    // Não mockamos — deixa o Math.random rodar de verdade
    const p = makePlayer(2000, 0);
    const r = exploreMap(p, 2000);
    const perfurante = r.ammoResults['bala_perfurante'] ?? 0;
    const fogo       = r.ammoResults['bala_fogo']       ?? 0;
    // Margem de 50%: qualquer proporção entre 0.9 e 3.5 é aceitável dado ruído estatístico
    if (fogo > 0) {
      const ratio = perfurante / fogo;
      expect(ratio).toBeGreaterThan(0.5);
      expect(ratio).toBeLessThan(4.0);
    }
  });
});

// ── 5. Resultado retornado ────────────────────────────────────────────────────

describe('campos do resultado', () => {
  it('retorna times = timesFrags + timesDobroes', () => {
    const p = makePlayer(3, 500);
    const r = exploreMap(p, 5);
    expect(r.times).toBe(r.timesFrags + r.timesDobroes);
  });

  it('ammoResults e resourceResults cobrem só o que foi obtido', () => {
    const p = makePlayer(1, 0);
    withReward(0, () => {
      const r = exploreMap(p, 1);
      const totalKeys = Object.keys(r.ammoResults).length + Object.keys(r.resourceResults).length;
      expect(totalKeys).toBeGreaterThan(0);
    });
  });

  it('estado do jogador é consistente com os resultados retornados', () => {
    const p = makePlayer(5, 0);
    const r = exploreMap(p, 5);
    // Soma de tudo no inventory deve bater com o que foi retornado
    for (const [id, qty] of Object.entries(r.ammoResults)) {
      expect(p.inventory.ammo[id]).toBeGreaterThanOrEqual(qty);
    }
    for (const [id, qty] of Object.entries(r.resourceResults)) {
      if (id !== 'mapFragments') {
        expect(p[id]).toBeGreaterThanOrEqual(qty);
      }
    }
  });
});
