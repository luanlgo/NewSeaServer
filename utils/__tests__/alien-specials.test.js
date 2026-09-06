/**
 * As quatro mecânicas NOVAS do conjunto alienígena (mapa 10).
 *
 * Todas nasceram do desenho dos bichos, e todas atacam um eixo que o jogo ainda
 * não tinha:
 *   swallow  — tira a vítima do lugar e a segura colada (não é stun)
 *   manaburn — o primeiro golpe que ataca MANA em vez de vida
 *   silence  — trava o uso de relíquia
 *   mirror   — o efeito depende do que o ALVO andou usando
 *
 * O que este arquivo cobre é a promessa da tabela: as duas faces (relíquia do
 * jogador × ataque do bicho) têm de fazer a MESMA coisa.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const MonsterSkillManager = require('../../managers/monster-skill-manager.js');
const AttackManager       = require('../../managers/attack-manager.js');
const { RELIC_DEFS, ATTACK_DEFS } = require('../../constants/index.js');

const MAP = 1;

// ── Lado da RELÍQUIA ────────────────────────────────────────────────────────
function fazerJogador(x = 0, z = 0) {
  return { id: 'p1', x, z, hp: 1e9, maxHp: 1e9, mapLevel: MAP, dead: false,
           rotation: 0, cannonDamage: 100, cannonCount: 4, cannonRange: 200 };
}
function fazerNpc(id, x, z) {
  return { id, x, z, hp: 1e9, maxHp: 1e9, mapLevel: MAP, dead: false };
}
function fazerMotor(npcs = [], jogadores = []) {
  const eventos = [];
  const enviados = [];
  const msm = new MonsterSkillManager({
    projectileManager: { npcs: new Map(npcs.map(n => [n.id, n])) },
    players: new Map(jogadores.map(p => [p.id, p])),
    wallManager: { addWall: () => {} },
    addEvent: (e) => eventos.push(e),
    sendTo: (_ws, m) => enviados.push(m),
    relicDamageFor: () => 100,
    // PvP ligado: silêncio e mana só existem contra JOGADOR.
    relicCanHitPlayer: (c, t) => t.id !== c.id && !t.dead,
    grantSkillXp: () => {},
    getMapManagerFor: () => null,
    onNpcDamaged: () => {},
    clampToMap: () => {},
  });
  return { msm, eventos, enviados };
}

// ── Lado do BICHO ───────────────────────────────────────────────────────────
function fazerBicho(ataque) {
  const ev = [];
  const npcs = new Map();
  const npc = { id: 'n1', x: 0, z: 0, dead: false, hp: 1e9, maxHp: 1e9, mapLevel: MAP,
                cannonDmg: 100, dmgMult: 1, rotation: 0,
                attacks: [ataque], _attackCooldowns: {} };
  npcs.set(npc.id, npc);
  const am = new AttackManager(e => ev.push(e), { npcs });
  return { npc, ev, am };
}
const fazerVitima = (x = 0, z = 20) => ({
  id: 'p1', x, z, dead: false, hp: 1e9, maxHp: 1e9, mapLevel: MAP,
  mana: 60, maxMana: 60, ws: { readyState: 1, send() {} },
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// ═════════════════════════════════════════════════════════════════════════════
describe('ENGOLIR — tira do lugar, segura e cospe', () => {
  it('bicho: a vítima é presa, colada nele e CUSPIDA longe de onde entrou', () => {
    const { npc, am } = fazerBicho('alien_maw_engulf');
    const def = ATTACK_DEFS.alien_maw_engulf;
    const v = fazerVitima(0, 20);
    const entrouEm = { x: v.x, z: v.z };

    am.tryAttack(npc, v, [v], MAP);
    vi.advanceTimersByTime(def.castTime + 10);
    expect(v.stunExpires, 'não foi presa').toBeGreaterThan(Date.now());
    expect(v._swallowedBy).toBe(npc.id);

    // Enquanto engolida, ela acompanha o bicho — o bicho anda, ela vai junto.
    npc.x = 300; npc.z = -120;
    vi.advanceTimersByTime(def.ticks.intervalMs + 10);
    expect(v.x, 'não foi colada no bicho').toBe(300);
    expect(v.z).toBe(-120);

    vi.runAllTimers();
    expect(v._swallowedBy, 'não foi solta').toBeUndefined();
    const andou = Math.hypot(v.x - entrouEm.x, v.z - entrouEm.z);
    expect(andou, 'saiu no mesmo lugar em que entrou').toBeGreaterThan(50);
  });

  it('bicho: engole UMA só, mesmo com vários colados', () => {
    const { npc, am } = fazerBicho('alien_maw_engulf');
    const a = fazerVitima(0, 10); a.id = 'pa';
    const b = fazerVitima(0, 15); b.id = 'pb';
    const c = fazerVitima(0, 20); c.id = 'pc';
    am.tryAttack(npc, a, [a, b, c], MAP);
    vi.runAllTimers();
    const presos = [a, b, c].filter(p => p.stunExpires > 0);
    expect(presos).toHaveLength(1);
    expect(presos[0].id, 'engoliu quem não era o mais perto').toBe('pa');
  });

  it('relíquia: nunca engole BOSS (convenção: chefe só leva slow)', () => {
    const chefe = fazerNpc('chefe', 0, 10);
    chefe.isBoss = true;
    const { msm } = fazerMotor([chefe]);
    msm.cast(fazerJogador(), RELIC_DEFS.r48, 0, 10, {});
    vi.runAllTimers();
    expect(chefe.stunExpires).toBeUndefined();
  });

  // ── Playtest 2026-09-06: "o visual não bate com o dano" ───────────────────
  // Duas causas somadas, e as duas do mesmo tipo: dado que não conta ao motor o
  // que o motor faz.
  it('bicho: UM cast é UMA bocarra — não cinco sobrepostas', () => {
    // `swallow` roda o PRÓPRIO relógio (5 levas de 400 ms) e não estava no
    // SELF_RUN: o laço de levas do _beginCast o chamava 5 vezes, cada chamada
    // abrindo uma bocarra inteira. Eram 25 levas de dano no lugar de 5, e a
    // presa era re-escolhida a cada 400 ms enquanto o desenho ficava parado.
    const { npc, ev, am } = fazerBicho('alien_maw_engulf');
    const v = fazerVitima(0, 20);
    am.tryAttack(npc, v, [v], MAP);
    vi.runAllTimers();

    const engoles = ev.filter(e => e.type === 'relic_effect' && e.effect === 'swallow');
    const cuspidas = ev.filter(e => e.type === 'relic_effect' && e.effect === 'spit_out');
    const levas = ev.filter(e => e.type === 'npc_attack_hit');
    expect(engoles, 'mais de uma bocarra no mesmo cast').toHaveLength(1);
    expect(cuspidas, 'mais de uma cuspida no mesmo cast').toHaveLength(1);
    expect(levas, 'o dano saiu multiplicado')
      .toHaveLength(ATTACK_DEFS.alien_maw_engulf.ticks.count);
  });

  it('as duas faces marcam `atCaster` — o desenho nasce onde o dano é medido', () => {
    // Os dois motores medem do LANÇADOR (`dist2D(npc, p)` / `player.x`), mas o
    // cliente ancora círculo no PONTO MIRADO quando não vem a marca. Eram dois
    // círculos de raio 75 a até 75 un um do outro: dava para estar dentro do
    // desenho e não tomar nada, e para estar fora dele e tomar.
    expect(ATTACK_DEFS.alien_maw_engulf.atCaster, 'face de BICHO sem atCaster').toBe(true);
    expect(RELIC_DEFS.r48.atCaster, 'face de RELÍQUIA sem atCaster').toBe(true);
  });

  it('bicho: o telegraph vai com atCaster — e o dano confere do BICHO', () => {
    const { npc, ev, am } = fazerBicho('alien_maw_engulf');
    // 70 un do bicho: DENTRO do raio 75. Se o círculo fosse medido do ponto
    // mirado o desenho nasceria em cima dela e o teste não distinguiria nada —
    // o que importa é a marca que manda o cliente medir do casco do bicho.
    const v = fazerVitima(0, 70);
    am.tryAttack(npc, v, [v], MAP);

    const tele = ev.find(e => e.type === 'npc_telegraph');
    expect(tele.atCaster, 'o cliente ia desenhar no ponto mirado').toBe(true);
    expect(tele.radius).toBe(ATTACK_DEFS.alien_maw_engulf.radius);

    vi.advanceTimersByTime(ATTACK_DEFS.alien_maw_engulf.castTime + 10);
    expect(v._swallowedBy, 'estava dentro do raio 75 e não foi engolida')
      .toBe(npc.id);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('QUEIMAR MANA — ataca o recurso, não a vida', () => {
  it('bicho: a vítima perde mana e é avisada', () => {
    const { npc, ev, am } = fazerBicho('alien_eyeless_siphon');
    const v = fazerVitima(0, 20);
    const antes = v.mana;
    am.tryAttack(npc, v, [v], MAP);
    vi.runAllTimers();
    expect(v.mana, 'não queimou mana').toBeLessThan(antes);
    expect(ev.some(e => e.type === 'mana_burn'), 'sem aviso de queima').toBe(true);
  });

  it('relíquia: contra NPC (que não tem mana) vira dano extra', () => {
    const alvo = fazerNpc('alvo', 0, 30);
    const { msm } = fazerMotor([alvo]);
    const hpAntes = alvo.hp;
    msm.cast(fazerJogador(), RELIC_DEFS.r50, 0, 30, {});
    vi.runAllTimers();
    expect(hpAntes - alvo.hp, 'o sorvo não fez nada contra NPC').toBeGreaterThan(0);
  });

  it('o dado declara os dois lados da fome', () => {
    expect(RELIC_DEFS.r50.manaBurn).toBeGreaterThan(0);
    expect(RELIC_DEFS.r50.noManaDamagePct).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('SILÊNCIO — trava a relíquia, não o barco', () => {
  // O Coro convergiu em 2026-09-05: as duas faces são a salva de rostos que voa
  // do casco. O `special: 'silence'` saiu do dado junto — silêncio nunca foi um
  // jeito de RESOLVER área, é um debuff no acerto. O eixo continua no jogo, só
  // que agora é cada rosto que encosta em você que o aplica, e só do lado do
  // bicho (NPC não usa relíquia: na mão do jogador seria texto sem efeito).
  it('bicho: o rosto que encosta silencia, e avisa', () => {
    const { npc, ev, am } = fazerBicho('alien_boss_face_choir');
    const v = fazerVitima(0, 20);
    am.tryAttack(npc, v, [v], MAP);
    vi.runAllTimers();
    expect(v._silencedUntil, 'não silenciou').toBeGreaterThan(Date.now());
    expect(ev.some(e => e.type === 'silenced')).toBe(true);
  });

  it('a relíquia NÃO silencia — só a face do bicho carrega o debuff', () => {
    expect(RELIC_DEFS.r52.silenceMs).toBeUndefined();
    expect(ATTACK_DEFS.alien_boss_face_choir.silenceMs).toBeGreaterThan(0);
  });

  it('é CURTO, e a janela para reagir é maior que ele', () => {
    // A janela não é mais só o cast: os rostos ainda têm de VOAR até você. Mas
    // o cast sozinho já tem de cobrir o silêncio — se o castigo durar mais que
    // o aviso, não houve aviso.
    const d = ATTACK_DEFS.alien_boss_face_choir;
    expect(d.silenceMs).toBeLessThanOrEqual(2000);
    expect(d.castTime, 'o silêncio dura mais que o próprio aviso')
      .toBeGreaterThanOrEqual(d.silenceMs);
  });

  it('silêncio não é atordoamento — o barco continua respondendo', () => {
    // `stunChance` do Coro é sorteio POR ROSTO. Travado em 1 (nunca sorteia)
    // para o teste medir o silêncio sozinho, que é o que ele quer isolar.
    const sorteio = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      const { npc, am } = fazerBicho('alien_boss_face_choir');
      const v = fazerVitima(0, 20);
      am.tryAttack(npc, v, [v], MAP);
      vi.runAllTimers();
      expect(v._silencedUntil, 'não silenciou').toBeGreaterThan(Date.now());
      expect(v.stunExpires, 'silêncio não pode atordoar').toBeFalsy();
      expect(v.slowMult, 'silêncio não pode lentificar').toBeFalsy();
    } finally {
      sorteio.mockRestore();
    }
  });

  it('o atordoamento existe, mas é do ROSTO e não do silêncio', () => {
    const sorteio = vi.spyOn(Math, 'random').mockReturnValue(0.0);
    try {
      const { npc, am } = fazerBicho('alien_boss_face_choir');
      const v = fazerVitima(0, 20);
      am.tryAttack(npc, v, [v], MAP);
      vi.runAllTimers();
      expect(v.stunExpires, 'com o sorteio no piso, o rosto tem de atordoar')
        .toBeGreaterThan(Date.now());
    } finally {
      sorteio.mockRestore();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('ESPELHO — devolve o que o alvo andou usando', () => {
  it('bicho: copia a última relíquia de bestiário do jogador', () => {
    const { npc, ev, am } = fazerBicho('alien_boss_cortex_mirror');
    const v = fazerVitima(0, 40);
    v._lastRelicSkill = 'alien_tail_sweep';
    am.tryAttack(npc, v, [v], MAP);
    vi.runAllTimers();
    const espelho = ev.find(e => e.type === 'relic_effect' && e.effect === 'mirror');
    expect(espelho, 'não anunciou a cópia').toBeDefined();
    expect(espelho.copiedSkill).toBe('alien_tail_sweep');
  });

  it('bicho: sem nada para copiar, cai no golpe de reserva', () => {
    const { npc, ev, am } = fazerBicho('alien_boss_cortex_mirror');
    const v = fazerVitima(0, 40);            // jogador novo, sem repertório
    am.tryAttack(npc, v, [v], MAP);
    vi.runAllTimers();
    const espelho = ev.find(e => e.type === 'relic_effect' && e.effect === 'mirror');
    expect(espelho).toBeDefined();
    expect(espelho.copiedSkill).toBe(ATTACK_DEFS.alien_boss_cortex_mirror.fallbackSkill);
  });

  it('espelho NUNCA copia espelho (senão é recursão infinita)', () => {
    const { npc, ev, am } = fazerBicho('alien_boss_cortex_mirror');
    const v = fazerVitima(0, 40);
    v._lastRelicSkill = 'alien_boss_cortex_mirror';
    am.tryAttack(npc, v, [v], MAP);
    vi.runAllTimers();
    const copias = ev.filter(e => e.type === 'relic_effect' && e.effect === 'mirror');
    for (const c of copias) expect(c.copiedSkill).not.toBe('alien_boss_cortex_mirror');
  });

  it('relíquia: copia o último golpe do BICHO mais próximo', () => {
    const alvo = fazerNpc('alvo', 0, 40);
    alvo._lastAttackId = 'alien_tail_sweep';
    const { msm, eventos } = fazerMotor([alvo]);
    msm.cast(fazerJogador(), RELIC_DEFS.r53, 0, 40, {});
    vi.runAllTimers();
    const espelho = eventos.find(e => e.type === 'relic_effect' && e.effect === 'mirror');
    expect(espelho).toBeDefined();
    expect(espelho.copiedSkill).toBe('alien_tail_sweep');
  });
});
