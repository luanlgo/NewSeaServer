/**
 * Precisão do canhão — a rolagem é POR TIRO.
 *
 * Era uma por SALVA até 2026-09-04, e o playtest matou a ideia com uma frase:
 * "sinto que estou errando muito mesmo acertando, parece bug". E parecia mesmo,
 * por dois motivos que se somavam:
 *
 *   1. a bordada INTEIRA ia ou não ia — cara-ou-coroa a cada tiro do botão;
 *   2. o projétil reprovado voava para o MESMO ponto e atravessava o casco sem
 *      tirar vida (`proj.miss` só desliga a colisão), o que é literalmente a
 *      aparência de um bug de acerto.
 *
 * Estes testes cobrem os dois: a independência das rolagens e a folga lateral
 * que faz o tiro errado cair NA ÁGUA, visivelmente ao lado.
 *
 * Mesmo truque do cannon-crit: o `db-manager` é substituído no require.cache
 * ANTES do import, senão ele tenta abrir conexão ao subir.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const dbPath = require.resolve('../../managers/db-manager.js');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, children: [], paths: [],
  exports: { save: () => {} },
};

const ProjectileManager = require('../../managers/projectile-manager.js');
const { MISS_CLEARANCE, MISS_SPREAD } = ProjectileManager;
const { MAP_DEFS, HIT_RADIUS, CANNON_DEFS } = require('../../constants/index.js');

const MAP = 2;
const ALVO = { x: 0, z: 100 };          // 100 un ao norte do atirador

let pm, players, npcs, jogador, privados;

/** Dispara e devolve os projéteis criados nesta salva. */
function salva() {
  const antes = new Set(pm.projectiles.keys());
  pm.spawnSalvo(jogador, ALVO.x, ALVO.z);
  return [...pm.projectiles.values()].filter(p => !antes.has(p.id));
}

/** Distância do ponto de queda de um projétil até o ponto MIRADO. */
function desvio(p) {
  return Math.hypot(p.targetX - ALVO.x, p.targetZ - ALVO.z);
}

beforeEach(() => {
  players = new Map();
  npcs = new Map();
  privados = [];
  pm = new ProjectileManager({ clients: new Set() }, players, npcs, null, null, MAP_DEFS);
  pm._broadcastToMap = () => {};
  pm.projectiles = new Map();

  jogador = {
    id: 'p1', dead: false, hp: 1e9, maxHp: 1e9, x: 0, z: 0, mapLevel: MAP,
    // `sendTo` cobra `ws.readyState === ws.OPEN` E `bufferedAmount`: um mock com
    // `readyState: 1` e mais nada e descartado em SILENCIO, e o teste do aviso
    // falha sem nada apontando para o mock.
    ws: { readyState: 1, OPEN: 1, bufferedAmount: 0,
          send: (m) => privados.push(JSON.parse(m)) },
    cannons: ['c1', 'c1', 'c1', 'c1', 'c1', 'c1', 'c1', 'c1'],
    inventory: { ammo: {} }, currentAmmo: 'bala_ferro',
    cannonDamage: 100, cannonRange: 200, cannonCooldownMax: 10,
  };
  players.set('p1', jogador);
});

afterEach(() => vi.restoreAllMocks());

// ═════════════════════════════════════════════════════════════════════════════
describe('a rolagem é por TIRO, não por salva', () => {
  it('a mesma salva sai com uns acertando e outros não', () => {
    jogador.cannonAccuracy = 0.5;
    // 8 canhões × 40 salvas: se a rolagem fosse por salva, TODA salva teria 0 ou
    // 8 erros e nunca um número no meio.
    let misturadas = 0;
    for (let i = 0; i < 40; i++) {
      const tiros = salva();
      const erros = tiros.filter(p => p.miss).length;
      if (erros > 0 && erros < tiros.length) misturadas++;
      pm.projectiles.clear();
    }
    expect(misturadas, 'nenhuma salva teve acerto E erro juntos — ainda é por salva')
      .toBeGreaterThan(30);
  });

  it('a média continua sendo a precisão da ficha', () => {
    // O ponto que faz a troca ser barata: por salva e por tiro têm o MESMO valor
    // esperado (N×a acertos). Só a variância muda.
    jogador.cannonAccuracy = 0.5;
    let acertos = 0, total = 0;
    for (let i = 0; i < 200; i++) {
      for (const p of salva()) { total++; if (!p.miss) acertos++; }
      pm.projectiles.clear();
    }
    expect(acertos / total).toBeGreaterThan(0.44);
    expect(acertos / total).toBeLessThan(0.56);
  });

  it('precisão 1 nunca erra e precisão 0 nunca acerta', () => {
    jogador.cannonAccuracy = 1;
    expect(salva().every(p => !p.miss)).toBe(true);
    pm.projectiles.clear();
    jogador.cannonAccuracy = 0;
    expect(salva().every(p => p.miss)).toBe(true);
  });

  it('o NPC não tem o campo e continua acertando como sempre', () => {
    delete jogador.cannonAccuracy;
    jogador.isNPC = true;
    expect(salva().every(p => !p.miss)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('o tiro que erra CAI NA ÁGUA', () => {
  it('passa longe o bastante do ponto mirado para não atravessar o casco', () => {
    // Esta é a metade que consertou o "parece bug": sem o desvio, a bala
    // reprovada voa para o mesmo ponto e ATRAVESSA o navio sem tirar vida.
    jogador.cannonAccuracy = 0;
    for (const p of salva()) {
      expect(desvio(p), 'a bala errada caiu em cima do alvo')
        .toBeGreaterThan(HIT_RADIUS);
    }
  });

  it('quem acerta continua caindo dentro da dispersão de sempre', () => {
    jogador.cannonAccuracy = 1;
    // `spreadRadius` a 100 un = min(12, max(3, 8)) = 8.
    for (const p of salva()) {
      expect(desvio(p)).toBeLessThanOrEqual(8.001);
    }
  });

  it('a bordada inteira cabe no anel externo da mira', () => {
    // O cliente desenha DOIS anéis no retículo (main.gd `_update_aim_indicator`):
    // o vivo no `spreadRadius`, onde cai quem acerta, e um fraco por fora em
    // hypot(spread, MISS_CLEARANCE + MISS_SPREAD), que é o teto da salva.
    //
    // O playtest de 04/09 pegou a bala errada caindo MUITO além disso — até 38
    // un num retículo de 12 — porque o desvio se SOMAVA à dispersão em vez de
    // trocar a componente de través dela. Se este teto subir, o anel do cliente
    // tem de subir junto: os números moram nos dois lados.
    jogador.cannonAccuracy = 0.5;
    const spread = 8;   // 100 un × 0.08, o mesmo do teste de cima
    const teto   = Math.hypot(spread, MISS_CLEARANCE + MISS_SPREAD);
    for (let i = 0; i < 100; i++) {
      for (const p of salva()) {
        expect(desvio(p), 'a salva vazou do anel externo da mira')
          .toBeLessThanOrEqual(teto + 0.001);
      }
      pm.projectiles.clear();
    }
  });

  it('erra para os DOIS lados — não é sempre a mesma boreste', () => {
    jogador.cannonAccuracy = 0;
    // Tiro para o norte: o desvio perpendicular aparece no X.
    const lados = new Set();
    for (let i = 0; i < 30; i++) {
      for (const p of salva()) lados.add(Math.sign(p.targetX - ALVO.x));
      pm.projectiles.clear();
    }
    expect(lados.has(1) && lados.has(-1),
      'todas as balas erradas foram para o mesmo lado').toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('o aviso de "Errou!"', () => {
  const avisos = () => privados.filter(m => m.type === 'salvo_miss');

  it('sai quando a salva INTEIRA erra', () => {
    jogador.cannonAccuracy = 0;
    salva();
    expect(avisos()).toHaveLength(1);
  });

  it('NÃO sai quando alguma bala entrou — o número já conta a história', () => {
    jogador.cannonAccuracy = 1;
    salva();
    expect(avisos()).toHaveLength(0);
  });

  it('num navio de um canhão só, meia bordada continua avisando', () => {
    // O caso em que o aviso ainda importa: com UM tiro, "a salva inteira errou"
    // e "aquele tiro errou" são a mesma coisa, e sem o aviso não há nada na
    // tela dizendo o que houve.
    jogador.cannons = ['c1'];
    jogador.cannonAccuracy = 0;
    salva();
    expect(avisos()).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('a ficha do canhão', () => {
  it('todo canhão tem precisão, e ela sobe com o tier', () => {
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
    let anterior = 0;
    for (const id of ids) {
      const a = CANNON_DEFS[id].accuracy;
      expect(a, `${id} sem precisão na ficha`).toBeGreaterThan(0);
      expect(a, `${id} não é melhor que o anterior`).toBeGreaterThanOrEqual(anterior);
      anterior = a;
    }
  });

  it('o c6 não nasce no teto — a pesquisa precisa ter para onde subir', () => {
    expect(CANNON_DEFS.c6.accuracy).toBeLessThan(0.70);
  });
});
