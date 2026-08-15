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
  it('bicho: marca o jogador e avisa', () => {
    const { npc, ev, am } = fazerBicho('alien_boss_face_choir');
    const v = fazerVitima(0, 20);
    am.tryAttack(npc, v, [v], MAP);
    vi.runAllTimers();
    expect(v._silencedUntil, 'não silenciou').toBeGreaterThan(Date.now());
    expect(ev.some(e => e.type === 'silenced')).toBe(true);
  });

  it('é CURTO — 2 s, e o telegraph é mais longo que ele', () => {
    const d = ATTACK_DEFS.alien_boss_face_choir;
    expect(d.silenceMs).toBeLessThanOrEqual(2000);
    expect(d.castTime, 'aviso curto demais para um silêncio').toBeGreaterThanOrEqual(1500);
  });

  it('não trava navegação nem canhão (só marca _silencedUntil)', () => {
    const { npc, am } = fazerBicho('alien_boss_face_choir');
    const v = fazerVitima(0, 20);
    am.tryAttack(npc, v, [v], MAP);
    vi.runAllTimers();
    expect(v.stunExpires, 'silêncio não pode atordoar').toBeFalsy();
    expect(v.slowMult, 'silêncio não pode lentificar').toBeFalsy();
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
