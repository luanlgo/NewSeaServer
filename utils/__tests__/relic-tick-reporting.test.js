/**
 * Toda leva de relíquia tem de ANUNCIAR o próprio dano.
 *
 * O motor acumulava os acertos das canalizadas e mandava UM
 * `monster_skill_strike` depois da última leva. No Jato do Pescoço isso é 3,5 s
 * depois do clique: durante a canalização inteira não aparecia número nenhum e
 * a skill lia como "não está dando dano" — enquanto o MESMO golpe na mão do
 * bicho relata leva a leva (npc_attack_hit). As duas faces têm de contar no
 * mesmo ritmo.
 *
 * A varredura vale mais que um caso: são 17 relíquias com `ticks`, e a próxima
 * a ganhar levas herda a checagem de graça.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const MonsterSkillManager = require('../../managers/monster-skill-manager.js');
const { RELIC_DEFS } = require('../../constants/relics.js');

const MAP = 1;

/** Relíquias de bestiário que resolvem por LEVAS (`ticks.count > 1`). */
const COM_LEVAS = Object.entries(RELIC_DEFS)
  .filter(([, d]) => d.effect === 'monster_skill' && d.ticks && (d.ticks.count || 1) > 1)
  .map(([id, d]) => [id, d]);

function fazerJogador(x = 0, z = 0) {
  return {
    id: 'p1', x, z, hp: 1e9, maxHp: 1e9, mapLevel: MAP, dead: false,
    rotation: 0, cannonDamage: 100, cannonCount: 4, cannonRange: 300,
  };
}

/**
 * O teste não é sobre geometria — é sobre o ANÚNCIO. Mas não dá para largar um
 * alvo colado no lançador e esperar que toda forma o pegue: a Espiral tem miolo
 * seguro de 22, a Barragem Rolante só ergue a 1ª faixa a 22 un, a Marcha
 * Fúnebre é um anel de 120. Colado, esses três NÃO acertam — e estão certos.
 *
 * Então o alvo é uma FILEIRA no eixo do golpe (+Z, que é para onde o cursor
 * aponta e também a proa, o fallback das canalizadas sem `relic_aim`), com
 * alguns fora do eixo para os anéis e cones largos. Basta um ser atingido em
 * mais de uma leva.
 */
function fazerAlvos() {
  const alvos = [];
  for (let z = 5; z <= 135; z += 10) {
    alvos.push({ id: `z${z}`, x: 0, z, hp: 1e12, maxHp: 1e12, mapLevel: MAP, dead: false });
  }
  for (const [x, z] of [[-30, 40], [30, 40], [-60, 70], [60, 70], [-20, 5], [20, 5]]) {
    alvos.push({ id: `o${x}_${z}`, x, z, hp: 1e12, maxHp: 1e12, mapLevel: MAP, dead: false });
  }
  return alvos;
}

function fazerMotor(npcs) {
  const eventos = [];
  const msm = new MonsterSkillManager({
    projectileManager: { npcs: new Map(npcs.map(n => [n.id, n])) },
    players: new Map(),
    wallManager: { addWall: () => {} },
    addEvent: (e) => eventos.push(e),
    sendTo: () => {},
    relicDamageFor: () => 100,
    relicCanHitPlayer: () => false,
    grantSkillXp: () => {},
    getMapManagerFor: () => null,
    onNpcDamaged: () => {},
    clampToMap: () => {},
  });
  return { msm, eventos };
}

const golpes = (eventos) => eventos.filter(e => e.type === 'monster_skill_strike');

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('a varredura cobre o que existe', () => {
  it('há relíquias com levas para varrer', () => {
    expect(COM_LEVAS.length).toBeGreaterThan(10);
  });
});

/** Lança a relíquia na fileira de alvos e devolve o que foi anunciado. */
function lancar(def) {
  const alvos = fazerAlvos();
  const { msm, eventos } = fazerMotor(alvos);
  msm.cast(fazerJogador(), def, 0, 60, {});
  vi.runAllTimers();
  return { alvos, eventos };
}

describe.each(COM_LEVAS)('%s — %o', (id, def) => {
  it('anuncia MAIS DE UM golpe (uma leva não espera a última)', () => {
    const { eventos } = lancar(def);
    const comDano = golpes(eventos).filter(e => (e.hits || []).length > 0);
    expect(comDano.length, `${def.name}: acertou mas relatou num pacote só`)
      .toBeGreaterThan(1);
  });

  it('cada anúncio de leva vem marcado com `tick` (fluxo, não golpe avulso)', () => {
    const { eventos } = lancar(def);
    // O cliente usa a PRESENÇA de `tick` para escolher a apresentação do
    // número (fluxo pequeno em leque × acerto avulso grande). Sem a marca, as
    // 20 levas do Jato voltam a empilhar no mesmo ponto.
    for (const e of golpes(eventos).filter(e => (e.hits || []).length > 0)) {
      expect(e.tick, `${def.name}: leva sem a marca 'tick'`).toBeDefined();
    }
  });

  it('não conta o dano duas vezes (nada de leva + resumo no fim)', () => {
    const { alvos, eventos } = lancar(def);
    const relatado = golpes(eventos)
      .flatMap(e => e.hits || [])
      .reduce((s, h) => s + h.dmg, 0);
    const aplicado = alvos.reduce((s, a) => s + (a.maxHp - a.hp), 0);
    expect(relatado, `${def.name}: soma anunciada ≠ vida tirada`).toBe(aplicado);
  });
});

describe('golpe de leva ÚNICA continua sendo anunciado como avulso', () => {
  it('Pinça Esmagadora: um só `monster_skill_strike`, sem marca de fluxo', () => {
    const { eventos } = lancar(RELIC_DEFS.r14);
    const g = golpes(eventos);
    expect(g).toHaveLength(1);
    expect(g[0].tick).toBeUndefined();
    expect((g[0].hits || []).length).toBeGreaterThan(0);
  });
});
