/**
 * As relíquias que o playtest de 2026-08-22 disse "não fazer nada".
 *
 * Cinco delas falhavam pelo MESMO motivo estrutural, e é um motivo que não dá
 * erro nenhum: o campo `special` estava no dado desde que a skill nasceu e não
 * existia branch nenhum para ele no motor. `mark`, `brood` e `static` caíam na
 * resolução genérica, ou seja a Sentença do Crânio explodia no ar em pontos
 * sorteados em vez de carimbar alguém, e a Ninhada largava dano no cast em vez
 * de pôr ovos. Nada quebrava — a skill só não era a skill.
 *
 * Estes testes são o guarda contra a volta disso: cada um afirma o COMPORTAMENTO
 * que dá nome à relíquia, não os números dela. Rebalancear raio ou dano não
 * derruba nenhum; apagar o branch de novo derruba todos.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const MonsterSkillManager = require('../../managers/monster-skill-manager');
const { RELIC_DEFS } = require('../../constants/relics');

const MAP = 3;

function fazerJogador(x = 0, z = 0) {
  return {
    id: 'p1', x, z, hp: 1e9, maxHp: 1e9, mana: 0, maxMana: 30, mapLevel: MAP,
    dead: false, rotation: 0, cannonDamage: 100, cannonCount: 4, cannonRange: 300,
  };
}

function alvo(id, x, z, extra = {}) {
  return { id, x, z, hp: 1e12, maxHp: 1e12, mapLevel: MAP, dead: false, ...extra };
}

function fazerMotor(npcs) {
  const eventos = [];
  const msm = new MonsterSkillManager({
    projectileManager: { npcs: new Map(npcs.map(n => [n.id, n])) },
    players: new Map(),
    wallManager: { addWall: () => {} },
    addEvent: (e) => eventos.push(e),
    sendTo: () => {},
    relicDamageFor: (_p, d) => Math.round(400 * (d.damagePct ?? 1)),
    relicCanHitPlayer: () => false,
    grantSkillXp: () => {},
    getMapManagerFor: () => null,
    onNpcDamaged: () => {},
    clampToMap: () => {},
  });
  return { msm, eventos };
}

const tipos = (ev, t) => ev.filter(e => e.type === t);
const levouDano = (a) => a.maxHp - a.hp > 0;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// ═════════════════════════════════════════════════════════════════════════════
describe('r44 Sentença do Crânio — a marca ANDA com quem foi carimbado', () => {
  it('carimba quem está perto do cursor e estoura NELE, não onde ele estava', () => {
    // O alvo é carimbado a (0,60) e navega para (0,140) antes do pavio queimar.
    // Com a resolução genérica antiga a explosão cairia lá atrás, em volta do
    // cursor — que é a razão de a relíquia "não estar dando o dano".
    const a = alvo('fugitivo', 0, 60);
    const { msm, eventos } = fazerMotor([a]);
    msm.cast(fazerJogador(), RELIC_DEFS.r44, 0, 60, {});

    vi.advanceTimersByTime(RELIC_DEFS.r44.castMs + 10);
    expect(tipos(eventos, 'relic_mark_set').map(e => e.targetId)).toContain('fugitivo');
    expect(levouDano(a), 'a marca não pode bater no instante do carimbo').toBe(false);

    a.x = 0; a.z = 140;                        // ele fugiu — e a marca foi junto
    vi.advanceTimersByTime(RELIC_DEFS.r44.fuseMs + 50);

    const estouro = tipos(eventos, 'relic_mark_burst').find(e => e.targetId === 'fugitivo');
    expect(estouro, 'o pavio queimou e nada estourou').toBeDefined();
    expect(estouro.z).toBe(140);
    expect(levouDano(a)).toBe(true);
  });

  it('não carimba ninguém quando não há ninguém no alcance', () => {
    const longe = alvo('longe', 0, 900);
    const { msm, eventos } = fazerMotor([longe]);
    msm.cast(fazerJogador(), RELIC_DEFS.r44, 0, 60, {});
    vi.runAllTimers();
    expect(tipos(eventos, 'relic_mark_set')).toHaveLength(0);
    expect(levouDano(longe)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('r45 Ninhada Pútrida — o ovo espera, e PULA em quem chega perto', () => {
  it('põe os ovos no cast sem machucar ninguém ainda', () => {
    const a = alvo('parado', 0, 300);
    const { msm, eventos } = fazerMotor([a]);
    msm.cast(fazerJogador(), RELIC_DEFS.r45, 0, 60, {});
    vi.advanceTimersByTime(RELIC_DEFS.r45.castMs + 10);

    const ninhada = tipos(eventos, 'relic_brood_lay')[0];
    expect(ninhada, 'a ninhada não foi posta').toBeDefined();
    expect(ninhada.eggs).toHaveLength(RELIC_DEFS.r45.count);
    expect(levouDano(a), 'o cast não pode dar dano — o ovo ainda nem chocou').toBe(false);
  });

  it('quem passa perto de um ovo o faz pular e leva a explosão', () => {
    const { msm, eventos } = fazerMotor([]);
    const jogador = fazerJogador();
    msm.cast(jogador, RELIC_DEFS.r45, 0, 60, {});
    vi.advanceTimersByTime(RELIC_DEFS.r45.castMs + 10);

    // Um bicho entra na área DEPOIS de os ovos estarem postos, colado no
    // primeiro deles. O ovo é uma ameaça paciente: quem chega decide a hora.
    const ovo = tipos(eventos, 'relic_brood_lay')[0].eggs[0];
    const bicho = alvo('curioso', ovo.x + 8, ovo.z);
    msm.ctx.projectileManager.npcs.set(bicho.id, bicho);

    vi.advanceTimersByTime(600);
    const pulo = tipos(eventos, 'relic_brood_jump')[0];
    expect(pulo, 'o ovo não reagiu a quem chegou perto').toBeDefined();
    expect(pulo.targetId).toBe('curioso');
    expect(levouDano(bicho)).toBe(true);
  });

  it('o que sobrar estoura sozinho no fim da chocagem', () => {
    const { msm, eventos } = fazerMotor([]);
    msm.cast(fazerJogador(), RELIC_DEFS.r45, 0, 60, {});
    vi.runAllTimers();
    expect(tipos(eventos, 'relic_brood_burst')).toHaveLength(RELIC_DEFS.r45.count);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('r25/r47 — o anel é PAREDE: ele empurra para dentro', () => {
  it.each([['r25', 'Espiral do Abismo'], ['r47', 'Marcha Fúnebre']])(
    '%s %s varre para dentro quem o anel alcança', (id) => {
      // O alvo começa DENTRO do anel inicial e longe do miolo — é exatamente
      // quem a coroa vai alcançar quando ela apertar. Quem estava fora do anel
      // desde o começo nunca foi cercado, e não é empurrado (nem deve ser: a
      // parede fecha para dentro, ela não sai puxando gente de longe).
      const def = RELIC_DEFS[id];
      const dentro = alvo('dentro', 0, def.radius - 15);
      const { msm } = fazerMotor([dentro]);
      msm.cast(fazerJogador(), def, 0, 0, {});
      vi.runAllTimers();

      const dist = Math.hypot(dentro.x, dentro.z);
      const ate  = def.collapseTo || def.finalRadius;
      expect(dist, `${id}: ninguém foi empurrado — o anel continua sendo enfeite`)
        .toBeLessThanOrEqual(ate + 1);
    });

  it.each([['r25'], ['r47']])('%s explode no MIOLO no fim', (id) => {
    const def = RELIC_DEFS[id];
    const meio = alvo('meio', 0, 0);
    const { msm, eventos } = fazerMotor([meio]);
    msm.cast(fazerJogador(), def, 0, 0, {});
    vi.runAllTimers();

    const burst = tipos(eventos, 'relic_collapse_burst');
    expect(burst, `${id}: a explosão central da descrição não existe`).toHaveLength(1);
    expect(levouDano(meio), `${id}: quem ficou no centro saiu ileso`).toBe(true);
  });

  it('o chefe leva o roçar mas NÃO é arrastado (convenção do projeto)', () => {
    const def = RELIC_DEFS.r47;
    const chefe = alvo('chefe', 0, def.radius - 15, { isBoss: true });
    const { msm } = fazerMotor([chefe]);
    msm.cast(fazerJogador(), def, 0, 0, {});
    vi.runAllTimers();
    expect(chefe.z, 'chefe não é deslocado').toBe(def.radius - 15);
    expect(levouDano(chefe), 'chefe continua levando o roçar').toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('r41 Sonar do Abismo — a onda varre SEM buraco', () => {
  it('cada distância do raio é alcançada por alguma onda', () => {
    // O bug: sem simulador a frente pulava `radius/4` (≈24 un) sobre uma faixa
    // de 11, então mais da metade do raio nunca era tocada. Uma fileira de
    // alvos cobrindo o raio inteiro prova que agora não sobra vão.
    const def = RELIC_DEFS.r41;
    const fila = [];
    for (let d = 6; d < def.radius; d += 6) fila.push(alvo(`d${d}`, 0, d));
    const { msm } = fazerMotor(fila);
    msm.cast(fazerJogador(), def, 0, 0, {});
    vi.runAllTimers();

    const ilesos = fila.filter(a => !levouDano(a)).map(a => a.id);
    // A brecha que gira pode poupar alguns, mas não METADE do raio.
    expect(ilesos.length, `passaram ilesos: ${ilesos.join(', ')}`)
      .toBeLessThan(fila.length / 2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('r48 Bocarra Torácica — a mordida alcança alguém', () => {
  it('engole quem está no raio, prende e cospe atrás', () => {
    const presa = alvo('presa', 0, 40);
    const { msm, eventos } = fazerMotor([presa]);
    msm.cast(fazerJogador(), RELIC_DEFS.r48, 0, 40, {});
    vi.advanceTimersByTime(RELIC_DEFS.r48.castMs + 50);

    const engolir = tipos(eventos, 'relic_effect').find(e => e.effect === 'swallow');
    expect(engolir, 'ninguém foi engolido — a bocarra não alcançou').toBeDefined();
    expect(presa.stunExpires).toBeGreaterThan(Date.now());

    vi.runAllTimers();
    expect(levouDano(presa)).toBe(true);
    expect(tipos(eventos, 'relic_effect').some(e => e.effect === 'spit_out')).toBe(true);
  });

  it('contra CHEFE não engole, mas morde: a relíquia deixou de ser inútil nele', () => {
    const chefe = alvo('chefe', 0, 40, { isBoss: true });
    const { msm, eventos } = fazerMotor([chefe]);
    msm.cast(fazerJogador(), RELIC_DEFS.r48, 0, 40, {});
    vi.runAllTimers();

    expect(levouDano(chefe), 'o chefe saiu ileso — era o bug').toBe(true);
    expect(chefe.z, 'chefe não é deslocado').toBe(40);
    expect(chefe.stunExpires, 'chefe não é preso').toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('r50 Sorvo sem Olhos — o sorvo BEBE, não só queima', () => {
  it('devolve mana ao lançador ao sorver um bicho', () => {
    const bicho = alvo('bicho', 0, 40);
    const { msm } = fazerMotor([bicho]);
    const p = fazerJogador();
    p.mana = 0;
    msm.cast(p, RELIC_DEFS.r50, 0, 40, {});
    vi.runAllTimers();
    expect(p.mana, 'a relíquia continua sendo só despesa').toBeGreaterThan(0);
    expect(p.mana).toBeLessThanOrEqual(p.maxMana);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('r24 Pústulas Virulentas — encostou, ficou envenenado e lento', () => {
  it('deixa DoT de veneno e slow em quem tocou a bile', () => {
    // O anel é SELADO e o miolo é abrigo (`sealed_ring`): quem está no centro
    // do cast não toca em bile nenhuma. O alvo tem de estar NA COROA, a
    // `spread` do ponto mirado.
    const bicho = alvo('bicho', 0, 60 + RELIC_DEFS.r24.spread);
    const { msm } = fazerMotor([bicho]);
    msm.cast(fazerJogador(), RELIC_DEFS.r24, 0, 60, {});
    vi.runAllTimers();

    const veneno = (bicho.dots || []).find(d => d.effect === 'poison');
    expect(veneno, 'a bile não envenenou ninguém').toBeDefined();
    expect(veneno.dmg).toBeGreaterThan(0);
    expect(bicho.slowMult, 'a bile não emperrou ninguém').toBeLessThan(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('canalizadas — o giro tem teto e vai no ar', () => {
  it.each([['r15'], ['r18'], ['r30'], ['r51']])(
    '%s anuncia a mira a cada leva (senão o desenho congela para os outros)', (id) => {
      const def = RELIC_DEFS[id];
      const { msm, eventos } = fazerMotor([alvo('alvo', 0, 40)]);
      msm.cast(fazerJogador(), def, 0, 40, {});
      vi.runAllTimers();
      expect(tipos(eventos, 'relic_skill_aim').length,
        `${def.name}: ninguém fora do lançador sabe para onde o golpe aponta`)
        .toBeGreaterThan(1);
    });

  it('o feixe não salta para o cursor: o giro respeita o turnRate', () => {
    // O cast sai apontando para +Z e o cursor é jogado para -Z (180° de uma
    // vez). Sem cap, a PRIMEIRA leva já saía invertida e colava no alvo: era o
    // "acerto garantido, sem jogada possível". Com cap, cada leva anda no
    // máximo `turnRate × intervalo`.
    //
    // A mira é renovada a cada leva porque o servidor descarta `relic_aim` com
    // mais de 1 s (sem mira fresca a canalizada cai na proa) — e é isso que o
    // cliente faz de verdade, mandando a posição do cursor a ~15 Hz.
    const def = RELIC_DEFS.r30;
    const p = fazerJogador();
    const { msm, eventos } = fazerMotor([alvo('alvo', 0, 40)]);
    msm.cast(p, def, 0, 40, {});

    const passo = def.turnRate * (def.ticks.intervalMs / 1000);
    vi.advanceTimersByTime(def.castMs);
    for (let i = 0; i < def.ticks.count; i++) {
      p._relicAim = { x: 0, z: -200, t: Date.now() };
      vi.advanceTimersByTime(def.ticks.intervalMs);
    }

    const miras = tipos(eventos, 'relic_skill_aim')
      .map(e => Math.atan2(e.dirZ, e.dirX));
    expect(miras.length).toBeGreaterThan(2);
    for (let i = 1; i < miras.length; i++) {
      const d = Math.abs(Math.atan2(Math.sin(miras[i] - miras[i - 1]),
                                    Math.cos(miras[i] - miras[i - 1])));
      expect(d, `leva ${i}: o feixe girou ${d.toFixed(2)} rad de uma vez`)
        .toBeLessThanOrEqual(passo + 1e-6);
    }
    // E girou de verdade — um cap que trava tudo também estaria errado.
    const total = Math.abs(Math.atan2(Math.sin(miras[miras.length - 1] - miras[0]),
                                      Math.cos(miras[miras.length - 1] - miras[0])));
    expect(total, 'o feixe não seguiu o cursor de jeito nenhum').toBeGreaterThan(passo);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('as cinco desativadas saem do drop mas ficam no dado', () => {
  const DESATIVADAS = ['r35', 'r36', 'r38', 'r39', 'r46'];

  it.each(DESATIVADAS)('%s está marcada como desativada', (id) => {
    expect(RELIC_DEFS[id], `${id} sumiu do RELIC_DEFS — desativar não é apagar`).toBeDefined();
    expect(RELIC_DEFS[id].disabled).toBe(true);
  });

  it('nenhuma delas entra no pool de drop de bicho nenhum', () => {
    const { SKILLS_BY_SOURCE } = require('../../constants/monster_skills');
    const dropaveis = new Set(Object.values(SKILLS_BY_SOURCE).flat());
    for (const id of DESATIVADAS) expect(dropaveis.has(id)).toBe(false);
  });

  it('o bicho continua com o ataque — só a face jogável saiu', () => {
    const { MONSTER_ATTACK_DEFS } = require('../../constants/monster_skills');
    expect(MONSTER_ATTACK_DEFS.drake_lightning_web).toBeDefined();
    expect(MONSTER_ATTACK_DEFS.turtle_boss_broadside).toBeDefined();
  });
});
