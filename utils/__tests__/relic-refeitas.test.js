/**
 * As relíquias refeitas de 2026-09-03.
 *
 * Cinco mudanças, todas nascidas do mesmo diagnóstico: a face JOGÁVEL de uma
 * skill de bicho não herda a leitura da face do bicho. O que se lê bem de fora,
 * olhando um monstro, pode ser ilegível quando o efeito nasce em cima do seu
 * próprio casco — e uma salva que cai toda de uma vez não é decisão nenhuma
 * quando é você quem escolhe onde ela cai.
 *
 *   • Salva de Morteiro (r19) e Tentáculos do Abismo (r20) viraram CHUVA
 *     MIRADA: uma queda por vez, cada uma em cima de onde o alvo está.
 *   • Salva de Bombordo (r35) virou Cardume de Torpedos: seis torpedos em
 *     sequência saindo do casco.
 *   • Descarga em Cadeia (r36) virou Rastilho de Raios: uma linha reta de
 *     raios caindo passo a passo.
 *   • Campo Estático (r38) virou Campo Voltaico: círculo em volta do casco que
 *     descarrega em quem ficou dentro.
 *
 * Nos três últimos casos a face do BICHO ficou como estava — a divergência é
 * declarada dentro do bloco `relic`, e o guarda dela mora em
 * monster-skill-fields.test.js.
 *
 * ── Segunda leva, 2026-09-04 ────────────────────────────────────────────────
 * Cinco ajustes e seis refeitas, com um achado no meio: três sintomas sem nada
 * em comum (Pilares sem dano, Faróis sem dano, Prisão sem paredes desenhadas)
 * eram UMA linha — o `...effectPayload` espalhado num `addEvent` sobrescrevia o
 * `type` do evento, porque ele começa com `type: 'relic_used'`.
 *
 *   • Marcha Fúnebre (r47): os espinhos viraram parede de verdade.
 *   • Salva de Espinhos (r55): alcance de bicho na mão do jogador.
 *   • Pilares do Juízo (r57): cast longo demais para acertar quem navega.
 *   • Lente do Abismo (r61): ganhou a pancada de abertura (`burstPct`).
 *   • Teia de Raios (r39) → Tarrafa de Raios: rede que cai e prende 2 s.
 *   • Sentença (r44) e Ninhada (r45) → invocações que caçam / emboscam.
 *   • Grilhões (r46) → Escolta de Ossos: saltam quando VOCÊ acerta.
 *   • Coro dos Rostos (r52) → Coro dos Afogados: salva de cinco rostos.
 *   • Abraço do Arauto (r60) → Tromba do Arauto: orbe GRUDENTA.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const MonsterSkillManager = require('../../managers/monster-skill-manager.js');
const { RELIC_DEFS } = require('../../constants/relics.js');

const MAP = 1;

function fazerJogador(x = 0, z = 0) {
  return {
    id: 'p1', x, z, hp: 100000, maxHp: 100000, mapLevel: MAP, dead: false,
    rotation: 0, cannonDamage: 100, cannonCount: 4, cannonRange: 120,
  };
}

function fazerNpc(id, x, z) {
  return { id, x, z, hp: 100000, maxHp: 100000, mapLevel: MAP, dead: false };
}

function fazerMotor(npcs = []) {
  const eventos = [];
  const paredes = [];
  const mapa = new Map(npcs.map(n => [n.id, n]));
  const msm = new MonsterSkillManager({
    projectileManager: { npcs: mapa },
    players: new Map(),
    wallManager: { addWall: (lvl, w) => paredes.push({ lvl, ...w }) },
    addEvent: (e) => eventos.push(e),
    sendTo: () => {},
    relicDamageFor: () => 100,
    relicCanHitPlayer: () => false,      // sem PvP nestes testes
    grantSkillXp: () => {},
    getMapManagerFor: () => null,
    onNpcDamaged: () => {},
    clampToMap: () => {},
  });
  return { msm, eventos, paredes };
}

const strikes = (ev) => ev.filter(e => e.type === 'monster_skill_strike');
const dano    = (ev) => strikes(ev).flatMap(e => e.hits || []);
const casts   = (ev) => ev.filter(e => e.type === 'monster_skill_cast');

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// ═════════════════════════════════════════════════════════════════════════════
describe('Salva de Morteiro e Tentáculos — chuva mirada, não salva', () => {
  it.each([['r19', 6], ['r20', 5]])('%s cai uma de cada vez', (id, quantas) => {
    const def = RELIC_DEFS[id];
    expect(def.dropIntervalMs, `${id} sem intervalo de queda`).toBeGreaterThan(0);
    expect(def.dropWarnMs, `${id} sem janela de fuga`).toBeGreaterThan(0);
    // A janela de aviso tem de caber DENTRO do intervalo, senão duas quedas
    // ficam anunciadas ao mesmo tempo e a leitura de "uma por vez" se perde.
    expect(def.dropWarnMs).toBeLessThanOrEqual(def.dropIntervalMs);

    const alvo = fazerNpc('alvo', 0, 60);
    const { msm, eventos } = fazerMotor([alvo]);
    msm.cast(fazerJogador(), def, 0, 60, {});
    vi.runAllTimers();
    // Um aviso e um estouro por queda — não um cast único com N sub-áreas.
    expect(casts(eventos).length).toBe(quantas);
    expect(strikes(eventos).length).toBe(quantas);
  });

  it('cada queda mira ONDE O ALVO ESTÁ, não onde ele estava', () => {
    const alvo = fazerNpc('alvo', 0, 60);
    const { msm, eventos } = fazerMotor([alvo]);
    msm.cast(fazerJogador(), RELIC_DEFS.r19, 0, 60, {});

    // Primeira queda anunciada em cima dele.
    vi.advanceTimersByTime(RELIC_DEFS.r19.castMs + 10);
    expect(casts(eventos)[0].targetZ).toBeCloseTo(60, 1);

    // Ele foge 200 un; a próxima queda tem de segui-lo.
    alvo.x = 200;
    vi.advanceTimersByTime(RELIC_DEFS.r19.dropIntervalMs + 10);
    expect(casts(eventos)[1].targetX).toBeCloseTo(200, 1);
    vi.runAllTimers();
  });

  it('quem se mexe entre uma queda e outra não come as seis', () => {
    const alvo = fazerNpc('alvo', 0, 60);
    const { msm, eventos } = fazerMotor([alvo]);
    msm.cast(fazerJogador(), RELIC_DEFS.r19, 0, 60, {});

    // Anda o relógio em passos curtos e, a CADA marcação nova, rema para longe
    // dela. Avançar de queda em queda não serve: a janela de aviso e o intervalo
    // se sobrepõem no tempo, então um laço grosso reage tarde e o teste passaria
    // a medir a própria desatenção em vez da skill.
    let vistas = 0;
    for (let t = 0; t < 8000; t += 50) {
      vi.advanceTimersByTime(50);
      const cs = casts(eventos);
      if (cs.length > vistas) {
        vistas = cs.length;
        alvo.x = cs[cs.length - 1].targetX + 400;
      }
    }
    expect(vistas, 'nenhuma queda chegou a ser anunciada').toBe(6);
    expect(dano(eventos).length).toBe(0);
  });

  it('o tentáculo agarra por menos tempo do que o intervalo entre braços', () => {
    // Root maior que o intervalo = agarrou uma vez, agarrou até o fim.
    expect(RELIC_DEFS.r20.cc.rootMs).toBeLessThanOrEqual(RELIC_DEFS.r20.dropIntervalMs);
  });

  it('a face do BICHO continua largando tudo de uma vez', () => {
    const { MONSTER_ATTACK_DEFS } = require('../../constants/monster_skills');
    expect(MONSTER_ATTACK_DEFS.crab_boss_mortar.dropIntervalMs).toBeFalsy();
    expect(MONSTER_ATTACK_DEFS.crab_boss_tentacles.dropIntervalMs).toBeFalsy();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Cardume de Torpedos (r35) — seis, um atrás do outro', () => {
  const DEF = () => RELIC_DEFS.r35;

  it('voltou a ser usável e dropável', () => {
    const { SKILLS_BY_SOURCE } = require('../../constants/monster_skills');
    expect(DEF().disabled).toBe(false);
    expect(SKILLS_BY_SOURCE.tartaruga_boss).toContain('r35');
  });

  it('dispara `count` torpedos, todos saindo do casco', () => {
    const alvo = fazerNpc('alvo', 0, 60);
    const { msm, eventos } = fazerMotor([alvo]);
    msm.cast(fazerJogador(0, 0), DEF(), 0, 120, {});
    vi.runAllTimers();

    const tiros = eventos.filter(e => e.type === 'relic_torpedo');
    expect(tiros.length).toBe(DEF().count);
    for (const t of tiros) {
      expect(Math.hypot(t.fromX, t.fromZ), 'torpedo nasceu longe do casco')
        .toBeLessThan(1);
    }
  });

  it('não saem todos no mesmo instante', () => {
    const { msm, eventos } = fazerMotor([fazerNpc('alvo', 0, 60)]);
    msm.cast(fazerJogador(), DEF(), 0, 120, {});
    vi.advanceTimersByTime(DEF().castMs + 10);
    expect(eventos.filter(e => e.type === 'relic_torpedo').length).toBe(1);
    vi.runAllTimers();
  });

  it('trava o inimigo à frente em vez de ir para o ponto do cursor', () => {
    // Cursor reto para o norte; o bicho está 25 un para o lado, dentro do cone.
    const alvo = fazerNpc('alvo', 25, 60);
    const { msm, eventos } = fazerMotor([alvo]);
    msm.cast(fazerJogador(), DEF(), 0, 200, {});
    vi.runAllTimers();

    const tiro = eventos.find(e => e.type === 'relic_torpedo');
    expect(tiro.homed).toBe(true);
    expect(Math.hypot(tiro.toX - 25, tiro.toZ - 60)).toBeLessThan(1);
    expect(dano(eventos).some(h => h.id === 'alvo')).toBe(true);
  });

  it('sem ninguém à frente, vai reto e abre em leque', () => {
    const { msm, eventos } = fazerMotor([]);
    msm.cast(fazerJogador(), DEF(), 0, 200, {});
    vi.runAllTimers();

    const tiros = eventos.filter(e => e.type === 'relic_torpedo');
    expect(tiros.every(t => t.homed === false)).toBe(true);
    const angulos = tiros.map(t => Math.atan2(t.toZ - t.fromZ, t.toX - t.fromX));
    // Leque de verdade: os seis não podem estar todos no mesmo ângulo.
    expect(new Set(angulos.map(a => a.toFixed(3))).size).toBeGreaterThan(1);
    // ...e nenhum passa da metade da abertura declarada.
    const meio = (DEF().fanAngle * Math.PI / 180) / 2;
    for (const a of angulos) {
      const dif = Math.abs(Math.atan2(Math.sin(a - Math.PI / 2), Math.cos(a - Math.PI / 2)));
      expect(dif).toBeLessThanOrEqual(meio + 1e-6);
    }
  });

  it('ignora quem está fora do cone de mira', () => {
    const atras = fazerNpc('atras', 0, -60);        // pelas costas
    const { msm, eventos } = fazerMotor([atras]);
    msm.cast(fazerJogador(), DEF(), 0, 200, {});
    vi.runAllTimers();
    expect(eventos.filter(e => e.type === 'relic_torpedo')
      .every(t => t.homed === false)).toBe(true);
    expect(dano(eventos).some(h => h.id === 'atras')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Rastilho de Raios (r36) — a linha que anda', () => {
  const DEF = () => RELIC_DEFS.r36;

  it('voltou a ser usável e dropável', () => {
    const { SKILLS_BY_SOURCE } = require('../../constants/monster_skills');
    expect(DEF().disabled).toBe(false);
    expect(SKILLS_BY_SOURCE.cobra).toContain('r36');
  });

  it('tem uma leva por passo — sobrar leva é raio repetido no mesmo lugar', () => {
    expect(DEF().ticks.count).toBe(DEF().stepCount);
  });

  it('o raio de perto cai ANTES do de longe', () => {
    const perto = fazerNpc('perto', 0, DEF().firstDistance);
    const longe = fazerNpc('longe', 0,
      DEF().firstDistance + (DEF().stepCount - 1) * DEF().stepDistance);
    const { msm, eventos } = fazerMotor([perto, longe]);
    msm.cast(fazerJogador(), DEF(), 0, 300, {});

    vi.advanceTimersByTime(DEF().castMs + 10);
    const cedo = dano(eventos).map(h => h.id);
    expect(cedo).toContain('perto');
    expect(cedo).not.toContain('longe');

    vi.runAllTimers();
    expect(dano(eventos).map(h => h.id)).toContain('longe');
  });

  it('quem sai DE LADO escapa — a linha é estreita', () => {
    const fora = fazerNpc('fora', DEF().width, DEF().firstDistance);
    const { msm, eventos } = fazerMotor([fora]);
    msm.cast(fazerJogador(), DEF(), 0, 300, {});
    vi.runAllTimers();
    expect(dano(eventos).length).toBe(0);
  });

  it('a face do BICHO virou a MESMA linha (convergência 2026-09-05)', () => {
    // Este teste dizia o contrário até 05/09: a cadeia era a face do bicho e o
    // rastilho, a da relíquia. O relato foi "matei o chefe e ele está usando as
    // relíquias antigas" — e estava mesmo, porque era assim de propósito.
    const { MONSTER_ATTACK_DEFS } = require('../../constants/monster_skills');
    const a = MONSTER_ATTACK_DEFS.drake_chain_arc;
    expect(a.shape).toBe('line');
    expect(a.vfx).toBe('drake_bolt_trail');
    // E os passos do bicho cobrem o alcance que ele anuncia — uma linha que
    // termina antes do `rangeMax` deixaria o bicho atirar no vazio.
    expect(a.firstDistance + (a.stepCount - 1) * a.stepDistance)
      .toBeGreaterThanOrEqual(a.rangeMax * 0.9);
    expect(a.ticks.count, 'ticks tem de bater com stepCount').toBe(a.stepCount);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Campo Voltaico (r38) — o círculo que anda com o casco', () => {
  const DEF = () => RELIC_DEFS.r38;

  it('voltou a ser usável e dropável', () => {
    const { SKILLS_BY_SOURCE } = require('../../constants/monster_skills');
    expect(DEF().disabled).toBe(false);
    expect(SKILLS_BY_SOURCE.cobra).toContain('r38');
  });

  it('o `special` fantasma saiu — o motor nunca teve branch para ele', () => {
    expect(DEF().special).toBeNull();
    expect(DEF().atCaster).toBe(true);
  });

  it('pega quem ficou dentro e poupa quem saiu a tempo', () => {
    const dentro = fazerNpc('dentro', 0, 20);
    const fora   = fazerNpc('fora', 0, DEF().radius + 30);
    const { msm, eventos } = fazerMotor([dentro, fora]);
    msm.cast(fazerJogador(), DEF(), 0, 0, {});
    vi.runAllTimers();

    const ids = dano(eventos).map(h => h.id);
    expect(ids).toContain('dentro');
    expect(ids).not.toContain('fora');
    // Descarga elétrica emperra quem levou.
    expect(dentro.slowExpires).toBeGreaterThan(0);
  });

  it('o círculo acompanha o barco durante a carga', () => {
    const alvo = fazerNpc('alvo', 300, 0);
    const jogador = fazerJogador(0, 0);
    const { msm, eventos } = fazerMotor([alvo]);
    msm.cast(jogador, DEF(), 0, 0, {});

    // O barco navega até perto do bicho enquanto o campo carrega.
    jogador.x = 300;
    vi.runAllTimers();

    expect(dano(eventos).some(h => h.id === 'alvo'),
      'o campo ficou plantado onde o cast começou').toBe(true);
    // E o anúncio final sai de onde o casco ESTÁ — é dele que saem os arcos.
    expect(strikes(eventos)[0].originX).toBeCloseTo(300, 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SEGUNDA LEVA — 2026-09-04
// ═════════════════════════════════════════════════════════════════════════════

describe('o `type` do evento não pode ser engolido pelo effectPayload', () => {
  // A raiz dos três sintomas. `effectPayload` é a resposta PRIVADA ao lançador e
  // começa com `type: 'relic_used'`; espalhado num addEvent ele entra por último
  // e sobrescreve o tipo do próprio evento.
  it.each([
    ['r57', 'monster_skill_strike'],
    ['r58', 'monster_skill_strike'],
    ['r59', 'monster_skill_obstacles'],
  ])('%s emite %s de verdade, não um relic_used disfarçado', (id, tipo) => {
    const alvo = fazerNpc('alvo', 0, 30);
    const { msm, eventos } = fazerMotor([alvo]);
    msm.cast(fazerJogador(), RELIC_DEFS[id], 0, 30, { type: 'relic_used', mana: 5 });
    vi.runAllTimers();
    expect(eventos.some(e => e.type === tipo), `nenhum ${tipo} saiu`).toBe(true);
    expect(eventos.some(e => e.type === 'relic_used'),
      'evento de mapa saiu com o tipo da resposta privada').toBe(false);
  });
});

describe('Pilares do Juízo (r57) — dá para acertar quem está navegando', () => {
  it('a carga encurtou para caber na fuga', () => {
    // O alvo anda ~45 un/s e a posição é travada no cast: o castTime É a
    // distância de fuga. Com o raio da coluna, tem de sobrar acerto.
    const fuga = 45 * (RELIC_DEFS.r57.castMs / 1000);
    expect(fuga, 'a fuga durante a carga passou do raio da coluna: ninguém leva')
      .toBeLessThan(RELIC_DEFS.r57.radius * 1.3);
  });

  it('o dano chega com os números', () => {
    const alvo = fazerNpc('alvo', 0, 40);
    const { msm, eventos } = fazerMotor([alvo]);
    msm.cast(fazerJogador(), RELIC_DEFS.r57, 0, 40, {});
    vi.runAllTimers();
    expect(dano(eventos).some(h => h.id === 'alvo')).toBe(true);
  });
});

describe('Marcha Fúnebre (r47) — os espinhos são PAREDE', () => {
  it('planta espinhos de verdade, um anel por passo', () => {
    const { msm, paredes } = fazerMotor([fazerNpc('alvo', 0, 60)]);
    msm.cast(fazerJogador(), RELIC_DEFS.r47, 0, 0, {});
    vi.runAllTimers();
    const n = RELIC_DEFS.r47.spikeCount;
    expect(paredes.length, 'nenhum espinho virou colisão').toBeGreaterThanOrEqual(n);
    // Um anel por PASSO, não por leva — reposicionar a cada leva daria tranco.
    expect(paredes.length).toBe(n * RELIC_DEFS.r47.phaseCount);
  });

  it('o anel SELA: o arco entre dois espinhos cabe no comprimento de um', () => {
    const { msm, paredes } = fazerMotor([]);
    msm.cast(fazerJogador(), RELIC_DEFS.r47, 0, 0, {});
    vi.runAllTimers();
    const n = RELIC_DEFS.r47.spikeCount;
    // Primeiro anel: o de maior raio, e portanto o mais fácil de vazar.
    const primeiro = paredes.slice(0, n);
    const raio = Math.hypot(primeiro[0].x, primeiro[0].z);
    const arco = (2 * Math.PI * raio) / n;
    expect(arco, 'sobra vão entre dois espinhos vizinhos')
      .toBeLessThanOrEqual(primeiro[0].hw * 2);
  });

  it('a Espiral (r25) continua SEM parede — só a Marcha ficou tangível', () => {
    const { msm, paredes } = fazerMotor([]);
    msm.cast(fazerJogador(), RELIC_DEFS.r25, 0, 0, {});
    vi.runAllTimers();
    expect(paredes).toHaveLength(0);
  });
});

describe('Lente do Abismo (r61) — pancada ao encostar + corrosão', () => {
  it('a leva 0 bate DUAS vezes: a abertura e o tique', () => {
    const alvo = fazerNpc('alvo', 0, 60);
    const { msm, eventos } = fazerMotor([alvo]);
    msm.cast(fazerJogador(), RELIC_DEFS.r61, 0, 200, {});
    vi.advanceTimersByTime(RELIC_DEFS.r61.castMs + 20);
    const nas0 = strikes(eventos).filter(e => e.tick === 0)
      .flatMap(e => e.hits).filter(h => h.id === 'alvo');
    expect(nas0.length, 'a abertura não saiu junto com o primeiro tique').toBe(2);
    vi.runAllTimers();
  });

  it('as levas seguintes batem só uma vez', () => {
    const alvo = fazerNpc('alvo', 0, 60);
    const { msm, eventos } = fazerMotor([alvo]);
    msm.cast(fazerJogador(), RELIC_DEFS.r61, 0, 200, {});
    vi.runAllTimers();
    const na1 = strikes(eventos).filter(e => e.tick === 1)
      .flatMap(e => e.hits).filter(h => h.id === 'alvo');
    expect(na1.length).toBe(1);
  });
});

describe('Salva de Espinhos (r55) — alcance de relíquia, não de bicho', () => {
  it('encolheu para caber na tela', () => {
    const { MONSTER_ATTACK_DEFS } = require('../../constants/monster_skills');
    expect(RELIC_DEFS.r55.length).toBeLessThan(70);
    // E continua bem menor que a face do bicho, que cobre arena.
    expect(RELIC_DEFS.r55.length)
      .toBeLessThan(MONSTER_ATTACK_DEFS.alien_boss_spine_volley.length);
  });
});

describe('Tarrafa de Raios (r39) — a rede que prende', () => {
  it('prende por 2 s quem estava embaixo', () => {
    const alvo = fazerNpc('alvo', 0, 60);
    const { msm, eventos } = fazerMotor([alvo]);
    msm.cast(fazerJogador(), RELIC_DEFS.r39, 0, 60, {});
    vi.runAllTimers();
    expect(dano(eventos).some(h => h.id === 'alvo')).toBe(true);
    expect(alvo.stunExpires, 'a rede caiu e não prendeu ninguém').toBeGreaterThan(0);
    expect(RELIC_DEFS.r39.cc.stunMs).toBe(2000);
  });
});

describe('Crânio Faminto (r44) — invocação que CAÇA', () => {
  it('sobem do mar no ponto mirado e perseguem', () => {
    const alvo = fazerNpc('alvo', 0, 90);
    const { msm, eventos } = fazerMotor([alvo]);
    msm.cast(fazerJogador(), RELIC_DEFS.r44, 0, 40, {});
    vi.advanceTimersByTime(RELIC_DEFS.r44.castMs + 10);

    const nascidos = eventos.filter(e => e.type === 'relic_summon_spawn');
    expect(nascidos.length).toBe(RELIC_DEFS.r44.count);
    expect(nascidos.every(e => e.mode === 'hunt' && e.awake === true)).toBe(true);

    vi.runAllTimers();
    expect(dano(eventos).some(h => h.id === 'alvo'),
      'os crânios nunca alcançaram ninguém').toBe(true);
    expect(eventos.some(e => e.type === 'relic_summon_end' && e.hit)).toBe(true);
  });

  it('trocam de presa quando a primeira morre', () => {
    // Longe o bastante para os cranios ainda estarem no caminho quando a presa
    // cai: matar o alvo no colo deles so provaria que eles ja tinham batido.
    const morto = fazerNpc('morto', 0, 170);
    const outro = fazerNpc('outro', 0, 195);
    const { msm, eventos } = fazerMotor([morto, outro]);
    msm.cast(fazerJogador(), RELIC_DEFS.r44, 0, 40, {});
    vi.advanceTimersByTime(RELIC_DEFS.r44.castMs + 10);
    morto.dead = true;
    vi.runAllTimers();
    expect(dano(eventos).some(h => h.id === 'outro')).toBe(true);
    expect(dano(eventos).some(h => h.id === 'morto'),
      'bateram num alvo ja morto').toBe(false);
  });
});

describe('Ninhada à Espreita (r45) — invocação que ESPERA', () => {
  it('nasce dormindo e não persegue ninguém sozinha', () => {
    const longe = fazerNpc('longe', 0, 600);
    const { msm, eventos } = fazerMotor([longe]);
    msm.cast(fazerJogador(), RELIC_DEFS.r45, 0, 40, {});
    vi.advanceTimersByTime(RELIC_DEFS.r45.castMs + 10);
    expect(eventos.filter(e => e.type === 'relic_summon_spawn')
      .every(e => e.awake === false)).toBe(true);
    vi.runAllTimers();
    expect(dano(eventos).length, 'a emboscada foi atrás de quem estava longe').toBe(0);
  });

  it('acorda e investe em quem chega perto', () => {
    const { msm, eventos } = fazerMotor([]);
    msm.cast(fazerJogador(), RELIC_DEFS.r45, 0, 40, {});
    vi.advanceTimersByTime(RELIC_DEFS.r45.castMs + 10);

    // O curioso encosta num dos ninhos DEPOIS de eles estarem postos.
    const ninho = eventos.find(e => e.type === 'relic_summon_spawn');
    const curioso = fazerNpc('curioso', ninho.x + 10, ninho.z);
    msm.ctx.projectileManager.npcs.set(curioso.id, curioso);

    vi.runAllTimers();
    expect(dano(eventos).some(h => h.id === 'curioso'),
      'ninguém acordou com o vizinho colado').toBe(true);
  });
});

describe('Escolta de Ossos (r46) — as três saltam juntas', () => {
  const armar = () => {
    const alvo = fazerNpc('alvo', 0, 40);
    const jogador = fazerJogador();
    const { msm, eventos } = fazerMotor([alvo]);
    msm.cast(jogador, RELIC_DEFS.r46, 0, 0, {});
    vi.advanceTimersByTime(RELIC_DEFS.r46.castMs + 10);
    return { msm, eventos, jogador, alvo };
  };
  const saltos = (ev) => ev.filter(e => e.type === 'relic_summon_leap');

  it('espera sem abrir a janela — o relógio começa no primeiro salto', () => {
    const { eventos, jogador } = armar();
    expect(jogador._summonEscort.vivas).toBe(RELIC_DEFS.r46.count);
    expect(jogador._summonEscort.expira, 'a janela abriu sozinha').toBe(0);
    vi.advanceTimersByTime(60000);      // um minuto parado
    expect(jogador._summonEscort, 'a escolta expirou sem nunca ter batido').toBeTruthy();
    expect(saltos(eventos)).toHaveLength(0);
  });

  it('as TRÊS saltam de uma vez, num golpe só', () => {
    const { msm, eventos, jogador, alvo } = armar();
    msm.notifyPlayerHit(jogador, alvo);

    const s = saltos(eventos);
    expect(s).toHaveLength(1);
    expect(s[0].count, 'saltou menos que a escolta inteira')
      .toBe(RELIC_DEFS.r46.count);
    // Uma salva = UM golpe. Três resoluções seriam triplicar o dano junto com a
    // mudança de leitura, que é exatamente o que o dado não pediu.
    expect(strikes(eventos).filter(e => e.skill === RELIC_DEFS.r46.skill))
      .toHaveLength(1);
    expect(dano(eventos).some(h => h.id === 'alvo')).toBe(true);
    // E nenhuma caveira é consumida: quem acaba com a escolta é a janela.
    expect(jogador._summonEscort.vivas).toBe(RELIC_DEFS.r46.count);
  });

  it('uma salva de quatro balas não vira quatro saltos', () => {
    const { msm, eventos, jogador, alvo } = armar();
    for (let i = 0; i < 4; i++) msm.notifyPlayerHit(jogador, alvo);
    expect(saltos(eventos)).toHaveLength(1);
  });

  it('dentro da janela ela salta de novo, respeitando a recarga', () => {
    const { msm, eventos, jogador, alvo } = armar();
    msm.notifyPlayerHit(jogador, alvo);
    vi.advanceTimersByTime(RELIC_DEFS.r46.leapCooldownMs + 20);
    msm.notifyPlayerHit(jogador, alvo);
    expect(saltos(eventos)).toHaveLength(2);
  });

  it('a janela fecha, a escolta some e o desenho é avisado', () => {
    const { msm, eventos, jogador, alvo } = armar();
    msm.notifyPlayerHit(jogador, alvo);
    vi.advanceTimersByTime(RELIC_DEFS.r46.durationMs + 200);
    expect(jogador._summonEscort, 'a escolta ficou depois da janela').toBeNull();
    const fim = eventos.filter(e => e.type === 'relic_summon_end');
    expect(fim, 'o cliente nunca soube que a escolta acabou').toHaveLength(1);
    // E depois disso ela não salta mais.
    msm.notifyPlayerHit(jogador, alvo);
    expect(saltos(eventos)).toHaveLength(1);
  });

  it('o dano do próprio salto não dispara outro salto (recursão)', () => {
    // O salto causa dano, que volta em _damage, que chamaria notifyPlayerHit de
    // novo. Sem a trava de reentrância isso é pilha estourada, não bug de saldo.
    const { msm, eventos, jogador, alvo } = armar();
    msm.notifyPlayerHit(jogador, alvo);
    expect(saltos(eventos)).toHaveLength(1);
  });
});

describe('Coro dos Afogados (r52) — salva de cinco rostos', () => {
  it('saem do CASCO, não do cursor', () => {
    const alvo = fazerNpc('alvo', 0, 120);
    const { msm, eventos } = fazerMotor([alvo]);
    msm.cast(fazerJogador(0, 0), RELIC_DEFS.r52, 0, 120, {});
    vi.advanceTimersByTime(RELIC_DEFS.r52.castMs + 10);
    const nascidos = eventos.filter(e => e.type === 'relic_summon_spawn');
    expect(nascidos).toHaveLength(RELIC_DEFS.r52.count);
    for (const e of nascidos) {
      expect(Math.hypot(e.x, e.z), 'rosto nasceu longe do casco')
        .toBeLessThanOrEqual(RELIC_DEFS.r52.spread + 1);
    }
    vi.runAllTimers();
    expect(dano(eventos).some(h => h.id === 'alvo')).toBe(true);
  });

  it('o stun é sorteio por rosto, não garantia', () => {
    expect(RELIC_DEFS.r52.stunChance).toBeGreaterThan(0);
    expect(RELIC_DEFS.r52.stunChance).toBeLessThan(0.5);
    // E o silêncio, que era leitura de chefe, saiu da face jogável.
    expect(RELIC_DEFS.r52.special).toBe('summons');
  });
});

describe('Tromba do Arauto (r60) — a orbe que GRUDA', () => {
  it('alcançar não acaba o golpe: ela continua moendo', () => {
    const alvo = fazerNpc('alvo', 0, 40);
    const { msm, eventos } = fazerMotor([alvo]);
    msm.cast(fazerJogador(), RELIC_DEFS.r60, 0, 40, {});
    vi.runAllTimers();

    // Muito mais de um acerto: a tromba tica enquanto dura.
    const meus = dano(eventos).filter(h => h.id === 'alvo');
    expect(meus.length, 'estourou no primeiro contato, como a Orbe').toBeGreaterThan(5);
    // E o fim sai UMA vez só.
    expect(eventos.filter(e => e.type === 'relic_orb_end')).toHaveLength(1);
  });

  it('a Orbe Caçadora (r37) continua estourando ao alcançar', () => {
    const alvo = fazerNpc('alvo', 0, 40);
    const { msm, eventos } = fazerMotor([alvo]);
    msm.cast(fazerJogador(), RELIC_DEFS.r37, 0, 40, {});
    vi.runAllTimers();
    expect(RELIC_DEFS.r37.sticky).toBeFalsy();
    expect(eventos.filter(e => e.type === 'relic_orb_end')).toHaveLength(1);
  });

  it('emperra quem fica dentro', () => {
    const alvo = fazerNpc('alvo', 0, 40);
    const { msm } = fazerMotor([alvo]);
    msm.cast(fazerJogador(), RELIC_DEFS.r60, 0, 40, {});
    vi.runAllTimers();
    expect(alvo.slowExpires).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Terceira passada — 2026-09-04 (playtest)
// ═════════════════════════════════════════════════════════════════════════════

describe('Cardume de Torpedos (r35) — teleguiado de verdade', () => {
  it('a deriva no voo cabe dentro do estouro', () => {
    // O alvo é travado no disparo; o tempo de voo é a distância que ele anda.
    // Se a deriva passar do raio, a salva erra por construção — que era o bug.
    const deriva = 45 * (RELIC_DEFS.r35.travelMs / 1000);
    expect(deriva, 'o alvo sai do estouro só andando reto')
      .toBeLessThan(RELIC_DEFS.r35.radius);
  });

  it('re-mira na chegada: estoura EM CIMA de quem andou', () => {
    const alvo = fazerNpc('alvo', 0, 60);
    const { msm, eventos } = fazerMotor([alvo]);
    msm.cast(fazerJogador(), RELIC_DEFS.r35, 0, 200, {});
    vi.advanceTimersByTime(RELIC_DEFS.r35.castMs + 10);

    const tiro = eventos.find(e => e.type === 'relic_torpedo');
    expect(tiro.targetId, 'o cliente não sabe quem seguir').toBe('alvo');

    // Ele foge 30 un de lado — longe do ponto anunciado, perto o bastante para
    // o torpedo ainda alcançar.
    alvo.x = 30;
    vi.runAllTimers();
    const meu = strikes(eventos).find(e => e.hits.some(h => h.id === 'alvo'));
    expect(meu, 'o torpedo estourou no vazio').toBeDefined();
    expect(meu.originX, 'estourou no ponto do disparo, não no alvo').toBeCloseTo(30, 0);
  });

  it('quem ganha a corrida escapa — a corda tem tamanho', () => {
    const alvo = fazerNpc('alvo', 0, 60);
    const { msm, eventos } = fazerMotor([alvo]);
    msm.cast(fazerJogador(), RELIC_DEFS.r35, 0, 200, {});
    vi.advanceTimersByTime(RELIC_DEFS.r35.castMs + 10);
    alvo.x = RELIC_DEFS.r35.homingRadius * 3;   // muito além do alcance de re-mira
    vi.runAllTimers();
    expect(dano(eventos).some(h => h.id === 'alvo')).toBe(false);
  });
});

describe('Crânio Faminto (r44) — sobe em volta do CASCO', () => {
  it('nasce no barco, não no cursor', () => {
    const { msm, eventos } = fazerMotor([fazerNpc('alvo', 0, 300)]);
    msm.cast(fazerJogador(0, 0), RELIC_DEFS.r44, 0, 250, {});
    vi.advanceTimersByTime(RELIC_DEFS.r44.castMs + 10);
    for (const e of eventos.filter(x => x.type === 'relic_summon_spawn')) {
      expect(Math.hypot(e.x, e.z), 'crânio nasceu longe do casco')
        .toBeLessThanOrEqual(RELIC_DEFS.r44.spread + 1);
    }
    vi.runAllTimers();
  });

  it('a emboscada (r45) continua nascendo NO CURSOR', () => {
    // As duas dividem o motor, e a diferença é justamente essa: uma persegue
    // (sai de você), a outra é plantada (sai de onde você escolheu).
    expect(RELIC_DEFS.r45.spawnAtCaster).toBeFalsy();
    const { msm, eventos } = fazerMotor([]);
    msm.cast(fazerJogador(0, 0), RELIC_DEFS.r45, 0, 250, {});
    vi.advanceTimersByTime(RELIC_DEFS.r45.castMs + 10);
    const nasc = eventos.filter(e => e.type === 'relic_summon_spawn');
    expect(nasc.length).toBeGreaterThan(0);
    for (const e of nasc) {
      expect(e.z, 'a ninhada foi posta no barco em vez do ponto mirado')
        .toBeGreaterThan(150);
    }
    vi.runAllTimers();
  });
});

describe('Campo Voltaico (r38) — raio que sai de baixo do casco', () => {
  it('o círculo é bem maior que o barco', () => {
    // Barco tem raio ~14. Um campo de 46 mal saía de baixo dele.
    expect(RELIC_DEFS.r38.radius).toBeGreaterThanOrEqual(90);
  });
});
