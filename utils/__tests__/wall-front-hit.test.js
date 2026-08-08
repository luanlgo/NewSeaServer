/**
 * Sonar e Barragem: o dano é a PAREDE, não a área toda.
 *
 * As duas skills desenham uma frente que anda — anéis que se abrem no Sonar,
 * uma parede que avança em passos na Barragem. O `inShape` ignorava isso:
 *
 *   • `ring` batia o DISCO inteiro (0 → radius) em CADA leva, sem faixa e sem
 *     vão. Quem estava colado no bicho levava as quatro ondas sem nenhuma
 *     parede ter encostado, e o setor seguro desenhado não valia nada.
 *   • `line` caía no `length` default de 100 — a Barragem não tem `length`,
 *     tem `width` (lateral) e `band` (espessura). Toda leva batia o mesmo
 *     retângulo colado no bicho, pegando inclusive quem já estava ATRÁS da
 *     parede, que é justamente a jogada certa contra ela.
 *
 * A geometria agora lê a leva atual (`_tickIndex`/`_tickCount`) e o vão
 * (`_gapFacing`), ambos decididos no cast e enviados no telegraph.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const M = require('../../managers/monster-skill-manager.js');
const { ATTACK_DEFS } = require('../../constants/index.js');

const SONAR = ATTACK_DEFS.drake_boss_sonar_rings;
const BARRA = ATTACK_DEFS.drake_boss_creeping_barrage;

/** Entidade na posição dada. */
const em = (x, z) => ({ x, z, id: 'p' });

/** Sonar centrado na origem, leva `k` de `n`, vão em `gap` radianos. */
function sonarLeva(k, gap = 0) {
  return { ...SONAR, _tickIndex: k, _tickCount: SONAR.ticks.count, _gapFacing: gap };
}
const noSonar = (def, x, z) => M.inShape(def, 'ring', 0, 0, 0, 0, null, em(x, z));

/** Barragem apontando para +X (dx=1), leva `k`. */
const naBarragem = (k, x, z) =>
  M.inShape({ ...BARRA, _tickIndex: k }, 'line', 0, 0, 1, 0, null, em(x, z));

/** Distância da frente da onda na leva k. */
const frente = (k) => SONAR.radius * ((k + 1) / SONAR.ticks.count);

/**
 * Um ponto EM CIMA da frente da leva k, do lado OPOSTO ao vão daquela onda.
 * Fixar um ângulo qualquer não serve: o vão gira `gapStep` por onda e acaba
 * caindo em cima do ponto escolhido — foi o que derrubou a 1ª versão deste
 * teste na leva 3, com o código já correto.
 */
function naParede(k, gap) {
  const a = gap + k * (SONAR.gapStep || 0) + Math.PI;   // oposto ao vão
  const r = frente(k);
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}
/** Distância do passo k da barragem. */
const passo = (k) => BARRA.firstDistance + k * BARRA.stepDistance;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Sonar — só a frente da onda machuca', () => {
  it('quem está colado no bicho NÃO leva (o disco cheio era o bug)', () => {
    for (let k = 0; k < SONAR.ticks.count; k++) {
      // Um pouco fora do centro para não cair no vão por acaso.
      expect(noSonar(sonarLeva(k, Math.PI), 3, 0), `leva ${k}`).toBe(false);
    }
  });

  it('quem está EM CIMA da frente leva', () => {
    const gap = Math.PI;
    for (let k = 0; k < SONAR.ticks.count; k++) {
      const p = naParede(k, gap);
      expect(noSonar(sonarLeva(k, gap), p.x, p.z), `leva ${k}`).toBe(true);
    }
  });

  it('quem está logo atrás da frente já não leva', () => {
    const gap = Math.PI;
    const k = 1;
    const p = naParede(k, gap);
    const escala = (frente(k) - SONAR.band / 2 - 5) / frente(k);
    expect(noSonar(sonarLeva(k, gap), p.x * escala, p.z * escala)).toBe(false);
  });

  it('a onda avança a cada leva (a frente de uma não é a da outra)', () => {
    const raios = [];
    for (let k = 0; k < SONAR.ticks.count; k++) raios.push(frente(k));
    expect(new Set(raios).size).toBe(SONAR.ticks.count);
    // A frente da leva 0 não pode machucar quem está na frente da leva 3.
    const p3 = naParede(3, Math.PI);
    expect(noSonar(sonarLeva(0, Math.PI), p3.x, p3.z)).toBe(false);
  });

  it('o VÃO poupa: no ângulo da brecha não leva, fora dela leva', () => {
    const k = 0;
    const r = frente(k);
    const gap = 0;                       // brecha apontando para +X
    const centro = gap + k * (SONAR.gapStep || 0);
    const dentroDoVao = { x: Math.cos(centro) * r, z: Math.sin(centro) * r };
    expect(noSonar(sonarLeva(k, gap), dentroDoVao.x, dentroDoVao.z),
      'em cima do vão').toBe(false);
    // Do lado oposto, mesma distância: a parede está lá.
    expect(noSonar(sonarLeva(k, gap), -dentroDoVao.x, -dentroDoVao.z),
      'lado oposto ao vão').toBe(true);
  });

  it('o vão GIRA a cada onda (não dá para ficar parado no mesmo lugar)', () => {
    expect(SONAR.gapStep, 'gapStep tem de ser um dado, não default do desenho')
      .toBeGreaterThan(0);
    const gap = 0;
    const r0 = frente(0);
    // O ponto seguro na 1ª onda; na 2ª a mesma direção já não é vão.
    const seguro0 = { x: r0, z: 0 };
    expect(noSonar(sonarLeva(0, gap), seguro0.x, seguro0.z)).toBe(false);
    const r1 = frente(1);
    const mesmaDirecao = { x: r1, z: 0 };
    expect(noSonar(sonarLeva(1, gap), mesmaDirecao.x, mesmaDirecao.z),
      'o vão girou: a mesma direção agora é parede').toBe(true);
  });
});

describe('Barragem — só a faixa daquele passo machuca', () => {
  it('quem está EM CIMA do passo leva', () => {
    for (let k = 0; k < BARRA.stepCount; k++) {
      expect(naBarragem(k, passo(k), 0), `passo ${k}`).toBe(true);
    }
  });

  it('quem já passou PARA TRÁS da parede não leva (a jogada certa)', () => {
    for (let k = 1; k < BARRA.stepCount; k++) {
      const atras = passo(k) - BARRA.band / 2 - 10;
      expect(naBarragem(k, atras, 0), `passo ${k}`).toBe(false);
    }
  });

  it('quem está adiante do passo atual ainda não leva', () => {
    const k = 0;
    expect(naBarragem(k, passo(k) + BARRA.band / 2 + 10, 0)).toBe(false);
  });

  it('a largura lateral é respeitada', () => {
    const k = 2;
    expect(naBarragem(k, passo(k), BARRA.width / 2 - 1), 'dentro').toBe(true);
    expect(naBarragem(k, passo(k), BARRA.width / 2 + 5), 'fora').toBe(false);
  });

  it('cada passo é uma faixa distinta', () => {
    // A faixa do passo 0 não pode alcançar o passo 4.
    expect(naBarragem(0, passo(4), 0)).toBe(false);
    expect(naBarragem(4, passo(0), 0)).toBe(false);
  });
});

describe('as outras formas não foram afetadas', () => {
  it('Rugido (ring com miolo seguro) segue igual', () => {
    const roar = ATTACK_DEFS.crab_boss_roar;
    expect(roar.band, 'o Rugido não tem band — cai no ramo antigo').toBeUndefined();
    expect(M.inShape(roar, 'ring', 0, 0, 0, 0, null, em(roar.safeRadius / 2, 0)),
      'miolo é seguro').toBe(false);
    expect(M.inShape(roar, 'ring', 0, 0, 0, 0, null, em(roar.radius - 1, 0)),
      'dentro do anel machuca').toBe(true);
  });

  it('Jato do Pescoço (line com length) segue igual', () => {
    const beam = ATTACK_DEFS.leviathan_neck_beam;
    expect(beam.stepCount, 'o Jato não tem stepCount').toBeUndefined();
    expect(M.inShape(beam, 'line', 0, 0, 1, 0, null, em(beam.length / 2, 0))).toBe(true);
    expect(M.inShape(beam, 'line', 0, 0, 1, 0, null, em(beam.length + 20, 0))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// O Sonar de verdade é SIMULADO (special: 'sonar'), não amostrado em 4 levas.
// Os testes acima cobrem a conta por leva, que ficou como reserva. Estes aqui
// rodam o caminho real e medem o que o jogador sente: a onda passou por mim?
// ─────────────────────────────────────────────────────────────────────────────
describe('Sonar simulado — a onda varre TUDO no caminho', () => {
  const AttackManager = require('../../managers/attack-manager.js');

  /** Enfileira um jogador a cada 10 un, todos no mesmo ângulo, e conta acertos. */
  function varrer() {
    const dists = [];
    for (let d = 10; d <= SONAR.radius; d += 10) dists.push(d);
    const npc = {
      id: 'n', x: 0, z: 0, dead: false, hp: 1e9, maxHp: 1e9, cannonDmg: 100,
      dmgMult: 1, attacks: ['drake_boss_sonar_rings'], _attackCooldowns: {},
    };
    const alvo = { id: 'alvo', x: 0, z: 0, dead: false, hp: 1e12, maxHp: 1e12, mapLevel: 1 };
    const povo = dists.map((d, i) => ({
      id: 'p' + i, x: d, z: 0, dead: false, hp: 1e12, maxHp: 1e12, mapLevel: 1,
    }));
    const ev = [];
    const am = new AttackManager(e => ev.push(e), null);
    am.tryAttack(npc, alvo, [alvo, ...povo], 1);
    vi.runAllTimers();

    const conta = {};
    for (const h of ev.filter(e => e.type === 'npc_attack_hit').flatMap(e => e.hits || [])) {
      conta[h.id] = (conta[h.id] || 0) + 1;
    }
    return { dists, povo, conta };
  }

  it('a skill está marcada como simulada', () => {
    expect(SONAR.special).toBe('sonar');
    expect(SONAR.expandMs).toBeGreaterThan(0);
  });

  it('NENHUMA distância dentro do raio fica de fora (o buraco era o bug)', () => {
    const { dists, povo, conta } = varrer();
    const vazios = povo.map((p, i) => [dists[i], conta[p.id] || 0])
      .filter(([, n]) => n === 0)
      .map(([d]) => d);
    expect(vazios, `distâncias nunca atingidas: ${vazios}`).toHaveLength(0);
  });

  it('cada onda acerta no MÁXIMO uma vez (o dano total não inflou)', () => {
    const { povo, conta } = varrer();
    for (const p of povo) {
      expect(conta[p.id], `${p.id} levou demais`).toBeLessThanOrEqual(SONAR.ringCount);
    }
  });

  it('o vão poupa: alguém escapa de pelo menos uma onda', () => {
    const { povo, conta } = varrer();
    const poupados = povo.filter(p => (conta[p.id] || 0) < SONAR.ringCount);
    expect(poupados.length, 'o vão tem de valer para alguém').toBeGreaterThan(0);
  });

  it('além do raio ninguém é tocado', () => {
    const npc = {
      id: 'n', x: 0, z: 0, dead: false, hp: 1e9, maxHp: 1e9, cannonDmg: 100,
      dmgMult: 1, attacks: ['drake_boss_sonar_rings'], _attackCooldowns: {},
    };
    const alvo = { id: 'alvo', x: 0, z: 0, dead: false, hp: 1e12, maxHp: 1e12, mapLevel: 1 };
    const longe = { id: 'longe', x: SONAR.radius + 60, z: 0, dead: false,
                    hp: 1e12, maxHp: 1e12, mapLevel: 1 };
    const ev = [];
    const am = new AttackManager(e => ev.push(e), null);
    am.tryAttack(npc, alvo, [alvo, longe], 1);
    vi.runAllTimers();
    const levou = ev.filter(e => e.type === 'npc_attack_hit')
      .flatMap(e => e.hits || []).some(h => h.id === 'longe');
    expect(levou).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Salva de Bombordo: setores ALTERNADOS. A promessa da skill é "ache o RITMO,
// não o lugar" — metade do disco dispara por leva e a outra metade é abrigo.
// O `circle` do servidor ignorava os setores e batia o disco inteiro: correr
// para a metade segura não adiantava absolutamente nada.
// ─────────────────────────────────────────────────────────────────────────────
describe('Salva de Bombordo — só a metade que dispara machuca', () => {
  const SALVA = ATTACK_DEFS.turtle_boss_broadside;

  /** Ponto no centro do setor `i`, a meio raio. */
  function noSetor(i) {
    const a = (SALVA.sectorOffset || 0)
            + (Math.PI * 2 * (i + 0.5)) / SALVA.sectorCount;
    const r = SALVA.radius * 0.5;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r, id: 'p' };
  }
  const naLeva = (k, e) =>
    M.inShape({ ...SALVA, _tickIndex: k }, 'circle', 0, 0, 0, 0, null, e);

  it('a skill declara os setores', () => {
    expect(SALVA.sectorCount).toBeGreaterThan(1);
    expect(SALVA.sectorCount % 2).toBe(0);   // alternar exige par
  });

  it('leva PAR acerta os setores pares e poupa os ímpares', () => {
    for (let i = 0; i < SALVA.sectorCount; i++) {
      expect(naLeva(0, noSetor(i)), `setor ${i}`).toBe(i % 2 === 0);
    }
  });

  it('leva ÍMPAR inverte — o abrigo troca de lado', () => {
    for (let i = 0; i < SALVA.sectorCount; i++) {
      expect(naLeva(1, noSetor(i)), `setor ${i}`).toBe(i % 2 === 1);
    }
  });

  it('existe abrigo em TODA leva (senão a mecânica é mentira)', () => {
    for (let k = 0; k < SALVA.ticks.count; k++) {
      const seguros = [];
      for (let i = 0; i < SALVA.sectorCount; i++) {
        if (!naLeva(k, noSetor(i))) seguros.push(i);
      }
      expect(seguros.length, `leva ${k} não tem abrigo`).toBeGreaterThan(0);
    }
  });

  it('fora do raio ninguém leva, esteja no setor que estiver', () => {
    for (let i = 0; i < SALVA.sectorCount; i++) {
      const p = noSetor(i);
      const longe = { x: p.x * 4, z: p.z * 4, id: 'p' };
      expect(naLeva(0, longe)).toBe(false);
    }
  });

  it('as outras skills `circle` não foram afetadas', () => {
    const frenzy = ATTACK_DEFS.crab_tidal_frenzy;
    expect(frenzy.sectorCount, 'a Fúria não tem setores').toBeUndefined();
    expect(M.inShape(frenzy, 'circle', 0, 0, 0, 0, null,
      { x: frenzy.radius * 0.5, z: 0, id: 'p' })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `atCaster`: a Salva nasce no lançador e ANDA com ele. Antes ficava plantada
// onde o alvo estava no cast — o boss podia sair de dentro da própria salva, e
// a leitura era "saia do círculo" em vez de "circule o boss no setor certo".
// ─────────────────────────────────────────────────────────────────────────────
describe('Salva de Bombordo acompanha o lançador', () => {
  const AttackManager = require('../../managers/attack-manager.js');
  const SALVA = ATTACK_DEFS.turtle_boss_broadside;

  it('a skill está marcada como presa ao lançador', () => {
    expect(SALVA.atCaster).toBe(true);
  });

  it('o telegraph avisa o cliente para ancorar no bicho', () => {
    const npc = { id: 'n1', x: 0, z: 0, dead: false, hp: 1e9, maxHp: 1e9,
                  cannonDmg: 100, dmgMult: 1,
                  attacks: ['turtle_boss_broadside'], _attackCooldowns: {} };
    const alvo = { id: 'p1', x: 0, z: 150, dead: false, hp: 1e9, maxHp: 1e9, mapLevel: 1 };
    const ev = [];
    new AttackManager(e => ev.push(e), null).tryAttack(npc, alvo, [alvo], 1);
    const tel = ev.find(e => e.type === 'npc_telegraph');
    expect(tel.atCaster).toBe(true);
  });

  it('quem colar no bicho leva; quem ficar onde o cast mirou, não', () => {
    const npc = { id: 'n1', x: 0, z: 0, dead: false, hp: 1e9, maxHp: 1e9,
                  cannonDmg: 100, dmgMult: 1,
                  attacks: ['turtle_boss_broadside'], _attackCooldowns: {} };
    // O alvo do cast fica no limite do alcance; a área tem de nascer no BICHO.
    // `rangeMax` limita onde o cast pode mirar, então o alvo precisa caber nele
    // — mirar além disso não gera cast nenhum e o teste passaria por engano.
    const mira = Math.min(SALVA.radius, SALVA.rangeMax) * 0.85;
    const alvo = { id: 'alvo', x: 0, z: mira, dead: false,
                   hp: 1e12, maxHp: 1e12, mapLevel: 1 };
    // Sonda plantada onde a área ficaria se ainda fosse centrada no ALVO:
    // dentro do círculo antigo, fora do novo.
    const soFora = { id: 'soFora', x: 0, z: mira + SALVA.radius * 0.8,
                     dead: false, hp: 1e12, maxHp: 1e12, mapLevel: 1 };
    // Colado no bicho, num setor que dispara na leva 0 (centro do setor 0).
    const meio = (Math.PI * 2 * 0.5) / SALVA.sectorCount;
    const perto = { id: 'perto', x: Math.cos(meio) * SALVA.radius * 0.4,
                    z: Math.sin(meio) * SALVA.radius * 0.4,
                    dead: false, hp: 1e12, maxHp: 1e12, mapLevel: 1 };

    const ev = [];
    const am = new AttackManager(e => ev.push(e), null);
    am.tryAttack(npc, alvo, [alvo, perto, soFora], 1);
    vi.runAllTimers();

    const acertos = ev.filter(e => e.type === 'npc_attack_hit').flatMap(e => e.hits || []);
    expect(acertos.some(h => h.id === 'perto'), 'colado no bicho tem de levar').toBe(true);
    expect(acertos.some(h => h.id === 'soFora'),
      'fora do raio CONTADO DO BICHO não pode levar').toBe(false);
  });

  it('a área ANDA: o bicho se move e a salva vai junto', () => {
    const npc = { id: 'n1', x: 0, z: 0, dead: false, hp: 1e9, maxHp: 1e9,
                  cannonDmg: 100, dmgMult: 1,
                  attacks: ['turtle_boss_broadside'], _attackCooldowns: {} };
    // Fica parado bem longe da origem, mas no caminho para onde o bicho vai.
    const destino = { x: 600, z: 0 };
    const meio = (Math.PI * 2 * 0.5) / SALVA.sectorCount;
    const parado = { id: 'parado',
                     x: destino.x + Math.cos(meio) * SALVA.radius * 0.4,
                     z: destino.z + Math.sin(meio) * SALVA.radius * 0.4,
                     dead: false, hp: 1e12, maxHp: 1e12, mapLevel: 1 };
    const alvo = { id: 'alvo', x: 0, z: 50, dead: false, hp: 1e12, maxHp: 1e12, mapLevel: 1 };

    const ev = [];
    const am = new AttackManager(e => ev.push(e), null);
    am.tryAttack(npc, alvo, [alvo, parado], 1);
    // Deixa o cast resolver a 1ª leva e então NAVEGA o bicho até o destino.
    vi.advanceTimersByTime(SALVA.castTime + 1);
    const antes = ev.filter(e => e.type === 'npc_attack_hit')
      .flatMap(e => e.hits || []).filter(h => h.id === 'parado').length;
    expect(antes, 'longe do bicho, ainda não levou').toBe(0);

    npc.x = destino.x; npc.z = destino.z;
    vi.runAllTimers();

    const depois = ev.filter(e => e.type === 'npc_attack_hit')
      .flatMap(e => e.hits || []).filter(h => h.id === 'parado').length;
    expect(depois, 'o bicho chegou perto: a salva veio junto').toBeGreaterThan(0);
  });
});
