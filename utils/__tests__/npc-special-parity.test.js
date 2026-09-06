/**
 * Paridade entre o que o DADO do bicho declara e o que o MOTOR do bicho faz.
 *
 * A queixa foi "matei o chefe e ele está usando as relíquias antigas". Ele não
 * estava usando nenhuma: as skills do bestiário têm duas faces lidas por DOIS
 * motores — `MONSTER_RELIC_DEFS` pelo monster-skill-manager (mão do jogador) e
 * `MONSTER_ATTACK_DEFS` pelo attack-manager (o bicho) — e as levas de conserto
 * de agosto/setembro caíram quase todas do lado da relíquia.
 *
 * O que torna isso invisível: `special` sem branch NÃO DÁ ERRO. O golpe cai na
 * resolução comum e vira um círculo ou um aro parado. Sete `special` do
 * bestiário estavam nesse estado do lado do bicho — as QUATRO do Carniceiro do
 * Ossuário entre eles, que é por isso que a queixa apareceu justo lá.
 *
 * Depois vieram as duas decisões do Luang, nesta ordem:
 *   1. os specials órfãos ganharam implementação (collapse, charge, drain…);
 *   2. as nove faces que ainda divergiam CONVERGIRAM — o bestiário inteiro
 *      mostra a mesma skill que a relíquia dele entrega.
 *
 * A (2) aposentou três mecânicas nascidas na (1) — `mark`, `brood` e `bond`
 * eram as versões antigas de três destas mesmas skills. Estão no git.
 *
 * O primeiro bloco é o guarda de verdade: ele lê os dois motores e reprova
 * qualquer `special` novo que entre no dado sem branch em quem vai executá-lo.
 * A convergência em si é guardada no monster-skill-fields.test.js.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const AttackManager = require('../../managers/attack-manager.js');
const worldState = require('../../utils/world-state.js');
const { ATTACK_DEFS, RELIC_DEFS } = require('../../constants/index.js');
const {
  MONSTER_SKILLS, MONSTER_RELIC_DEFS, MONSTER_ATTACK_DEFS,
} = require('../../constants/monster_skills.js');

const RAIZ = path.join(__dirname, '..', '..', 'managers');
const FONTE_BICHO    = fs.readFileSync(path.join(RAIZ, 'attack-manager.js'), 'utf8');
const FONTE_RELIQUIA = fs.readFileSync(path.join(RAIZ, 'monster-skill-manager.js'), 'utf8');

/**
 * O motor conhece este `special`?
 *
 * Procura a comparação literal (`x.special === 'nome'`) em vez de só o nome
 * solto: o nome aparece em comentário e em nome de método, e um teste que
 * casasse com isso passaria justamente no caso que ele existe para pegar.
 */
function motorConhece(fonte, sp) {
  return fonte.includes(`.special === '${sp}'`)
      || fonte.includes(`s.special === '${sp}'`);
}

const MAP = 1;

function fazerBicho(ataqueId, extra = {}) {
  const ev = [];
  const npcs = new Map();
  const npc = {
    id: 'n1', x: 0, z: 0, dead: false, hp: 1e9, maxHp: 1e9, mapLevel: MAP,
    cannonDmg: 100, dmgMult: 1, rotation: 0,
    attacks: [ataqueId], _attackCooldowns: {}, ...extra,
  };
  npcs.set(npc.id, npc);
  const paredes = [];
  const am = new AttackManager(e => ev.push(e), { npcs });
  am.wallManager = { addWall: (_m, w) => paredes.push(w) };
  return { npc, ev, am, paredes };
}
const fazerVitima = (id, x, z) => ({
  id, x, z, dead: false, hp: 1e9, maxHp: 1e9, mapLevel: MAP,
  mana: 60, maxMana: 60, ws: { readyState: 1, OPEN: 1, bufferedAmount: 0, send() {} },
});
const somaDano = (ev) => ev.filter(e => e.type === 'npc_attack_hit')
  .flatMap(e => e.hits || []).reduce((s, h) => s + (h.dmg || 0), 0);

beforeEach(() => {
  vi.useFakeTimers();
  // Quatro das skills aqui são ⭐ e o bicho só as escolhe durante a Lua de
  // Sangue — ver utils/star-gate.js. Sem ligar a lua, `tryAttack` não seleciona
  // nada e o teste passaria a medir o vazio em vez do golpe.
  worldState.setBloodMoon(true);
});
afterEach(() => {
  vi.useRealTimers();
  worldState.setBloodMoon(false);
});

// ═════════════════════════════════════════════════════════════════════════════
describe('todo `special` do dado tem branch no motor que vai executá-lo', () => {
  it('face do BICHO: nenhum special órfão no attack-manager', () => {
    const orfaos = [];
    for (const [key, a] of Object.entries(MONSTER_ATTACK_DEFS)) {
      if (!a.special) continue;
      // `soak` é o único que não vira branch: o builder o traduz para
      // `splitDamage`, que o attack-manager já tinha pronto da Maré Partida.
      if (a.special === 'soak') {
        expect(a.splitDamage, `${key}: soak sem splitDamage`).toBe(true);
        continue;
      }
      if (!motorConhece(FONTE_BICHO, a.special)) orfaos.push(`${key} → '${a.special}'`);
    }
    expect(orfaos, 'special declarado que o bicho NUNCA vai executar').toEqual([]);
  });

  it('face da RELÍQUIA: nenhum special órfão no monster-skill-manager', () => {
    const orfaos = [];
    for (const [id, d] of Object.entries(MONSTER_RELIC_DEFS)) {
      if (!d.special || d.disabled) continue;
      if (!motorConhece(FONTE_RELIQUIA, d.special)) orfaos.push(`${id} → '${d.special}'`);
    }
    expect(orfaos).toEqual([]);
  });

  it('nenhum motor guarda branch para um special que ninguém declara', () => {
    // O outro lado da moeda: código que nenhum dado alcança apodrece calado
    // até alguém tentar usá-lo. A exceção é a `chain`, que perdeu o dono na
    // convergência e é mantida viva por um fixture — ver chain-fixture.js.
    // O catálogo INTEIRO, não só o bestiário: `phase` (Névoa Espectral) mora
    // numa skill de fora dele, e olhar só o bestiário a acusaria de órfã.
    const declarados = new Set();
    for (const a of Object.values(ATTACK_DEFS)) if (a.special) declarados.add(a.special);
    for (const r of Object.values(RELIC_DEFS)) if (r.special) declarados.add(r.special);
    const noMotor = new Set(
      [...FONTE_BICHO.matchAll(/\.special === '([a-z]+)'/g)].map(m => m[1])
        .concat([...FONTE_RELIQUIA.matchAll(/\.special === '([a-z]+)'/g)].map(m => m[1])));
    const semDono = [...noMotor].filter(sp => !declarados.has(sp));
    expect(semDono, 'branch de special que nenhuma skill pede').toEqual([]);
  });

  it('specials com relógio próprio estão na lista de resolução ÚNICA', () => {
    // Quem se agenda por dentro não pode passar pelo laço de `ticks` do
    // _beginCast — seriam N simulações sobrepostas. A lista mora no
    // attack-manager (SELF_RUN); aqui só verificamos que ninguém novo escapou.
    for (const sp of ['orb', 'sonar', 'collapse', 'charge', 'summons', 'torpedo']) {
      expect(FONTE_BICHO, `'${sp}' fora do SELF_RUN`)
        .toMatch(new RegExp(`SELF_RUN = new Set\\(\\[[^\\]]*'${sp}'`, 's'));
    }
  });

  it('cada special com timeline própria declara a ocupação dele em busyMs', () => {
    // Sem isto o bicho abre outra skill por cima da que ainda está resolvendo.
    // A conta é contra o dado REAL: o que interessa é que a ocupação cubra a
    // timeline daquela skill, não que ela passe de um número redondo qualquer.
    const casos = {
      collapse: (a) => a.ticks.count * a.ticks.intervalMs,
      charge:   (a) => a.chargeMs,
      torpedo:  (a) => (a.count - 1) * a.salvoMs + a.travelMs,
      // A ESCOLTA é a exceção declarada: ela não tem relógio, fica esperando o
      // bicho acertar. Prendê-lo 10 s à espera de um acerto que talvez não
      // venha o deixaria parado no meio da luta.
      summons:  (a) => (a.summonMode === 'escort' ? 0 : a.lifeMs),
    };
    for (const [key, a] of Object.entries(MONSTER_ATTACK_DEFS)) {
      const esperado = casos[a.special];
      if (!esperado) continue;
      expect(AttackManager.busyMs(a), `${key} (${a.special}) termina antes da hora`)
        .toBeGreaterThanOrEqual(esperado(a));
    }
    const vistos = new Set(Object.values(MONSTER_ATTACK_DEFS)
      .map(a => a.special).filter(sp => casos[sp]));
    expect([...vistos].sort()).toEqual(Object.keys(casos).sort());
  });

  it('`burstAtCenter` chega nas DUAS faces', () => {
    // Campo do topo da skill (é forma, não balanço). Ele existia só no
    // MONSTER_RELIC_DEFS: a Marcha Fúnebre do chefe pararia no último passo do
    // aperto, sem o miolo que a descrição promete.
    for (const [key, s] of Object.entries(MONSTER_SKILLS)) {
      if (!s.burstAtCenter) continue;
      expect(MONSTER_RELIC_DEFS[s.relicId].burstAtCenter, `${s.relicId}`).toBe(true);
      expect(MONSTER_ATTACK_DEFS[key].burstAtCenter, `${key}`).toBe(true);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('MARCHA FÚNEBRE — a arena aperta de verdade (o caso do playtest)', () => {
  const ID = 'charnel_funeral_march';

  it('o anel FECHA passo a passo em vez de ficar parado no raio inicial', () => {
    const { npc, ev, am } = fazerBicho(ID);
    const def = ATTACK_DEFS[ID];
    const v = fazerVitima('p1', 0, 300);
    am.tryAttack(npc, v, [v], MAP);
    vi.runAllTimers();

    const passos = ev.filter(e => e.type === 'relic_collapse_step');
    expect(passos.length, 'nenhum passo de aperto').toBe(def.ticks.count);
    expect(passos[0].radius).toBeGreaterThan(passos[passos.length - 1].radius);
    expect(passos[passos.length - 1].radius).toBeCloseTo(def.finalRadius, 0);
  });

  it('o MIOLO explode no fim — é o golpe que a descrição promete', () => {
    const { npc, ev, am } = fazerBicho(ID);
    const v = fazerVitima('p1', 0, 300);
    am.tryAttack(npc, v, [v], MAP);
    vi.runAllTimers();
    expect(ev.some(e => e.type === 'relic_collapse_burst'), 'sem miolo').toBe(true);
  });

  it('o cerco fecha em volta do BICHO, e arrasta quem está fora', () => {
    const { npc, ev, am } = fazerBicho(ID);
    const def = ATTACK_DEFS[ID];
    // O bicho fora da origem, para separar "centrado nele" de "centrado em 0,0".
    npc.x = 100; npc.z = -50;
    const v = fazerVitima('p1', 100, 250);            // 300 un ao norte dele
    am.tryAttack(npc, v, [v], MAP);
    vi.runAllTimers();

    const passos = ev.filter(e => e.type === 'relic_collapse_step');
    expect(passos[0].originX, 'o aro nasceu longe do bicho').toBe(npc.x);
    expect(passos[0].originZ).toBe(npc.z);

    const dFinal = Math.hypot(v.x - npc.x, v.z - npc.z);
    expect(dFinal, 'ninguém foi arrastado').toBeLessThanOrEqual(def.finalRadius + 1);
    expect(dFinal, 'foi teleportado para cima do bicho').toBeGreaterThan(1);
    expect(passos.some(pa => (pa.pushed || []).length > 0),
      'nenhum empurrão foi anunciado ao cliente').toBe(true);
  });

  it('os espinhos viram PAREDE de verdade, uma coroa por passo', () => {
    const { npc, am, paredes } = fazerBicho(ID);
    const def = ATTACK_DEFS[ID];
    const v = fazerVitima('p1', 0, 300);
    am.tryAttack(npc, v, [v], MAP);
    vi.runAllTimers();
    // Uma coroa por passo MENOS a última — ela é a janela de sair do miolo.
    expect(paredes.length, 'nenhum espinho tangível')
      .toBe(def.spikeCount * (def.phaseCount - 1));
    const n = def.spikeCount;
    expect(paredes[0].hw).toBeGreaterThanOrEqual(Math.PI * def.radius / n);
    // E eles somem sozinhos — ninguém fica preso depois do golpe.
    expect(paredes[0].durationMs).toBeLessThan(def.ticks.count * def.ticks.intervalMs);
  });

  it('a simulação roda UMA vez, não uma por leva', () => {
    // Sem o SELF_RUN seriam 8 apertos sobrepostos (8 × 8 = 64 passos).
    const { npc, ev, am } = fazerBicho(ID);
    const v = fazerVitima('p1', 0, 300);
    am.tryAttack(npc, v, [v], MAP);
    vi.runAllTimers();
    expect(ev.filter(e => e.type === 'relic_collapse_burst').length).toBe(1);
  });

  it('o dano total ficou na faixa das outras lendárias de chefe', () => {
    // O `damageMult` era 5,0 por leva num aro que quase nunca pegava. Cobradas
    // as 8, seriam 40× o canhão do bicho. A conta agora é leva barata + miolo.
    const def = ATTACK_DEFS[ID];
    const teto = def.damageMult * def.ticks.count + def.burstMult;
    expect(teto).toBeLessThan(ATTACK_DEFS.drake_boss_core_overload.damageMult * 1.3);
    expect(teto).toBeGreaterThan(4);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('INVOCAÇÕES — quatro leituras, um motor só', () => {
  it('CAÇADA: os crânios nascem no CASCO do bicho e perseguem', () => {
    const { npc, ev, am } = fazerBicho('charnel_death_mark');
    const def = ATTACK_DEFS.charnel_death_mark;
    npc.x = 200; npc.z = 200;
    const v = fazerVitima('p1', 200, 320);
    am.tryAttack(npc, v, [v], MAP);
    vi.advanceTimersByTime(def.castTime + 10);

    const nascidos = ev.filter(e => e.type === 'relic_summon_spawn');
    expect(nascidos.length, 'ninguém foi invocado').toBe(def.count);
    // `spawnAtCaster`: perto do casco, não no ponto mirado.
    for (const s of nascidos) {
      expect(Math.hypot(s.x - npc.x, s.z - npc.z),
        'nasceu longe do casco').toBeLessThanOrEqual(def.spread + 1);
      expect(s.awake, 'a caçada nasce acordada').toBe(true);
    }

    // Elas ANDAM na direção do alvo — e alcançam, porque são mais rápidas
    // que um barco parado.
    vi.runAllTimers();
    expect(somaDano(ev), 'perseguiram e não bateram').toBeGreaterThan(0);
    expect(ev.filter(e => e.type === 'relic_summon_end').length).toBe(def.count);
  });

  it('CAÇADA: quem foge o bastante não é alcançado', () => {
    const { npc, ev, am } = fazerBicho('charnel_death_mark');
    const def = ATTACK_DEFS.charnel_death_mark;
    const v = fazerVitima('p1', 0, 60);
    am.tryAttack(npc, v, [v], MAP);
    vi.advanceTimersByTime(def.castTime + 10);
    // Longe o bastante para os 5 s de vida a `moveSpeed` não cobrirem.
    v.x = 8000; v.z = 8000;
    vi.runAllTimers();
    expect(somaDano(ev), 'alcançou quem estava a 11 mil unidades').toBe(0);
    expect(ev.filter(e => e.type === 'relic_summon_end' && e.hit === false).length)
      .toBe(def.count);
  });

  // O ninho é plantado onde o alvo ESTAVA quando o cast começou. Um barco anda
  // ~50 un no 1,1 s de cast, e o `triggerRadius` é 55 — sair de perto é o
  // comportamento normal, não uma exceção. Por isso os dois testes movem o
  // jogador durante o cast: um alvo parado em cima do próprio ninho acorda a
  // ninhada no primeiro passo, e aí não haveria emboscada nenhuma para medir.
  it('EMBOSCADA: a ninhada nasce DORMINDO e não acorda sozinha', () => {
    const { npc, ev, am } = fazerBicho('charnel_brood_hatch');
    const def = ATTACK_DEFS.charnel_brood_hatch;
    const v = fazerVitima('p1', 0, 120);
    am.tryAttack(npc, v, [v], MAP);
    v.x = 9000; v.z = 9000;                     // saiu durante o cast
    vi.advanceTimersByTime(def.castTime + 10);

    const nascidos = ev.filter(e => e.type === 'relic_summon_spawn');
    expect(nascidos.length).toBe(def.count);
    expect(nascidos.every(s => s.awake === false), 'nasceu acordada').toBe(true);

    vi.runAllTimers();
    const movimentos = ev.filter(e => e.type === 'relic_summon_move');
    expect(movimentos.some(m => m.awake), 'acordou sem ninguém perto').toBe(false);
    expect(somaDano(ev), 'bateu sem ter acordado').toBe(0);
  });

  it('EMBOSCADA: quem volta e encosta acorda a cria — e aí ela alcança', () => {
    const { npc, ev, am } = fazerBicho('charnel_brood_hatch');
    const def = ATTACK_DEFS.charnel_brood_hatch;
    const v = fazerVitima('p1', 0, 120);
    am.tryAttack(npc, v, [v], MAP);
    v.x = 9000; v.z = 9000;
    vi.advanceTimersByTime(def.castTime + 10);

    const ninho = ev.find(e => e.type === 'relic_summon_spawn');
    expect(ninho.awake).toBe(false);
    v.x = ninho.x; v.z = ninho.z;               // passou por cima do ovo
    vi.runAllTimers();
    // Encostar no ovo acorda E investe no MESMO passo (a distância já é menor
    // que o `catchRadius`), então o sinal do acerto é o `end` com `hit`, não um
    // `move` acordado — este não chega a ser emitido.
    expect(ev.some(e => e.type === 'relic_summon_end' && e.hit),
      'passou por cima do ovo e nada aconteceu').toBe(true);
    expect(somaDano(ev), 'acordou e não bateu').toBeGreaterThan(0);
  });

  it('SALVA: os rostos saem do CASCO e voam de uma vez', () => {
    const { npc, ev, am } = fazerBicho('alien_boss_face_choir');
    const def = ATTACK_DEFS.alien_boss_face_choir;
    npc.x = -300; npc.z = 40;
    const v = fazerVitima('p1', -300, 150);
    am.tryAttack(npc, v, [v], MAP);
    vi.advanceTimersByTime(def.castTime + 10);

    const nascidos = ev.filter(e => e.type === 'relic_summon_spawn');
    expect(nascidos.length).toBe(def.count);
    for (const s of nascidos) {
      expect(Math.hypot(s.x - npc.x, s.z - npc.z)).toBeLessThanOrEqual(def.spread + 1);
    }
    vi.runAllTimers();
    expect(somaDano(ev)).toBeGreaterThan(0);
  });

  it('ESCOLTA: fica em órbita e só salta quando o BICHO acerta', () => {
    const { npc, ev, am } = fazerBicho('charnel_chain_bond');
    const def = ATTACK_DEFS.charnel_chain_bond;
    const v = fazerVitima('p1', 0, 40);
    am.tryAttack(npc, v, [v], MAP);
    vi.advanceTimersByTime(def.castTime + 10);

    const arm = ev.find(e => e.type === 'relic_summon_spawn');
    expect(arm, 'a escolta não foi armada').toBeDefined();
    expect(arm.mode).toBe('escort');
    expect(arm.count).toBe(def.count);
    expect(npc._summonEscort.expira, 'a janela não pode abrir sem o 1º salto').toBe(0);

    // Sem acerto, nada acontece — nem com o tempo passando.
    vi.advanceTimersByTime(def.durationMs * 2);
    expect(ev.some(e => e.type === 'relic_summon_leap'), 'saltou sozinha').toBe(false);

    // Um golpe qualquer do bicho que ACERTE passa pelo laço onde mora o gancho.
    am._resolveAttack(npc, {
      ...ATTACK_DEFS.charnel_funeral_march, shape: 'circle', special: null,
      radius: 200, damageMult: 1, ticks: null, burstAtCenter: false,
    }, v.x, v.z, [v], MAP);

    const saltos = ev.filter(e => e.type === 'relic_summon_leap');
    expect(saltos.length, 'o bicho acertou e a escolta não saltou').toBe(1);
    expect(saltos[0].count, 'as três saltam JUNTAS').toBe(def.count);
    expect(npc._summonEscort.expira, 'o 1º salto abre a janela').toBeGreaterThan(0);
  });

  it('ESCOLTA: o salto não dispara a si mesmo (guarda de reentrância)', () => {
    // O próprio salto causa dano, que volta ao laço de acerto — sem a trava
    // seria recursão infinita até a pilha estourar.
    const { npc, ev, am } = fazerBicho('charnel_chain_bond');
    const def = ATTACK_DEFS.charnel_chain_bond;
    const v = fazerVitima('p1', 0, 40);
    am.tryAttack(npc, v, [v], MAP);
    vi.advanceTimersByTime(def.castTime + 10);

    expect(() => am.notifyNpcHit(npc, v, MAP)).not.toThrow();
    expect(ev.filter(e => e.type === 'relic_summon_leap').length).toBe(1);
  });

  it('ESCOLTA: a recarga limita as salvas dentro da janela', () => {
    const { npc, ev, am } = fazerBicho('charnel_chain_bond');
    const def = ATTACK_DEFS.charnel_chain_bond;
    const v = fazerVitima('p1', 0, 40);
    am.tryAttack(npc, v, [v], MAP);
    vi.advanceTimersByTime(def.castTime + 10);

    // Martela o gancho durante a janela inteira: a recarga é quem decide.
    for (let t = 0; t < def.durationMs; t += 100) {
      am.notifyNpcHit(npc, v, MAP);
      vi.advanceTimersByTime(100);
    }
    const saltos = ev.filter(e => e.type === 'relic_summon_leap').length;
    const teto = Math.ceil(def.durationMs / def.leapCooldownMs);
    expect(saltos).toBeGreaterThan(1);
    expect(saltos, 'a recarga não segurou nada').toBeLessThanOrEqual(teto);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('CARDUME DE TORPEDOS — a salva teleguiada', () => {
  const ID = 'turtle_boss_broadside';

  it('sai um torpedo por vez, cada um com o próprio voo', () => {
    const { npc, ev, am } = fazerBicho(ID);
    const def = ATTACK_DEFS[ID];
    const v = fazerVitima('p1', 0, 120);
    am.tryAttack(npc, v, [v], MAP);
    vi.advanceTimersByTime(def.castTime + 10);

    // O primeiro sai na hora; os outros vêm de `salvoMs` em `salvoMs`.
    expect(ev.filter(e => e.type === 'relic_torpedo').length).toBe(1);
    vi.runAllTimers();
    const saidas = ev.filter(e => e.type === 'relic_torpedo');
    expect(saidas.length).toBe(def.count);
    expect(saidas.every(t => t.travelMs === def.travelMs)).toBe(true);
    expect(somaDano(ev), 'a salva não machucou ninguém').toBeGreaterThan(0);
  });

  it('RE-MIRA na chegada: quem anda pouco continua sendo acertado', () => {
    const { npc, ev, am } = fazerBicho(ID);
    const def = ATTACK_DEFS[ID];
    const v = fazerVitima('p1', 0, 120);
    am.tryAttack(npc, v, [v], MAP);
    vi.advanceTimersByTime(def.castTime + 10);

    const t0 = ev.find(e => e.type === 'relic_torpedo');
    expect(t0.homed, 'não travou no alvo dentro do cone').toBe(true);
    expect(t0.targetId, 'o cliente precisa do alvo para curvar o desenho').toBe('p1');

    // Deriva menor que `homingRadius`: o estouro tem de acompanhar.
    v.z += def.homingRadius * 0.5;
    vi.advanceTimersByTime(def.travelMs + 10);
    expect(somaDano(ev), 'andou um pouco e o torpedo perdeu').toBeGreaterThan(0);
  });

  it('quem ganha a corrida escapa — o homing tem corda', () => {
    const { npc, ev, am } = fazerBicho(ID);
    const def = ATTACK_DEFS[ID];
    const v = fazerVitima('p1', 0, 120);
    am.tryAttack(npc, v, [v], MAP);
    vi.advanceTimersByTime(def.castTime + 10);
    v.x = 6000; v.z = 6000;                    // muito além do homingRadius
    vi.runAllTimers();
    expect(somaDano(ev), 'o torpedo seguiu até o outro lado do mapa').toBe(0);
  });

  it('sem ninguém no cone os torpedos abrem em leque e vão reto', () => {
    const { npc, ev, am } = fazerBicho(ID);
    const def = ATTACK_DEFS[ID];
    // Alvo válido para o cast, mas fora do cone no instante do disparo.
    const v = fazerVitima('p1', 0, 120);
    am.tryAttack(npc, v, [v], MAP);
    vi.advanceTimersByTime(def.castTime + 10);
    v.x = -4000;
    vi.runAllTimers();
    const saidas = ev.filter(e => e.type === 'relic_torpedo');
    expect(saidas.length).toBe(def.count);
    const reto = saidas.filter(t => !t.homed);
    expect(reto.length, 'ninguém no cone e mesmo assim travou').toBeGreaterThan(0);
    // Leque: os que vão reto não apontam todos para o mesmo ponto.
    const angulos = new Set(reto.map(t => Math.round(
      Math.atan2(t.toZ - t.fromZ, t.toX - t.fromX) * 100)));
    expect(angulos.size, 'o leque não abriu').toBeGreaterThan(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('TROMBA DO ARAUTO — a orbe que GRUDA', () => {
  const ID = 'abyss_herald_embrace';

  it('alcançar não acaba o golpe: ela cola e continua moendo', () => {
    const { npc, ev, am } = fazerBicho(ID);
    const def = ATTACK_DEFS[ID];
    const v = fazerVitima('p1', 0, 60);
    am.tryAttack(npc, v, [v], MAP);
    // Tempo de sobra para alcançar (60 un a 34 un/s), mas MENOS que a vida.
    vi.advanceTimersByTime(def.castTime + def.lifeMs * 0.6);

    expect(ev.some(e => e.type === 'npc_orb_end'),
      'estourou ao encostar — o sticky não pegou').toBe(false);
    const moendo = ev.filter(e => e.type === 'npc_orb_move');
    expect(moendo.length, 'a tromba não andou').toBeGreaterThan(3);
    // E ela ficou EM CIMA do alvo, não parada onde encostou.
    const ultimo = moendo[moendo.length - 1];
    expect(Math.hypot(ultimo.x - v.x, ultimo.z - v.z)).toBeLessThan(1);
    expect(somaDano(ev), 'grudou e não moeu').toBeGreaterThan(0);
  });

  it('acompanha quem se mexe, e estoura só no fim da vida', () => {
    const { npc, ev, am } = fazerBicho(ID);
    const def = ATTACK_DEFS[ID];
    const v = fazerVitima('p1', 0, 40);
    am.tryAttack(npc, v, [v], MAP);
    vi.advanceTimersByTime(def.castTime + def.orbTickMs * 4);
    v.x = 60; v.z = 60;                        // deriva curta: ela alcança de novo
    vi.runAllTimers();

    expect(ev.filter(e => e.type === 'npc_orb_end').length,
      'não estourou no fim da vida').toBe(1);
  });

  it('a orbe COMUM continua estourando ao alcançar', () => {
    // O `sticky` é o que separa as duas, e é um campo do topo: se ele vazasse
    // para a Orbe Caçadora, ela deixaria de ser um projétil teleguiado.
    expect(ATTACK_DEFS.drake_hunter_orb.sticky).toBeFalsy();
    const { npc, ev, am } = fazerBicho('drake_hunter_orb');
    const def = ATTACK_DEFS.drake_hunter_orb;
    const v = fazerVitima('p1', 0, 30);
    am.tryAttack(npc, v, [v], MAP);
    vi.advanceTimersByTime(def.castTime + def.orbTickMs * 3);
    expect(ev.some(e => e.type === 'npc_orb_end'), 'a orbe comum não estourou')
      .toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('SOBRECARGA DO NÚCLEO — a carga passou a existir', () => {
  const ID = 'drake_boss_core_overload';

  it('a explosão só sai depois dos 5 s de carga, não no fim do cast', () => {
    const { npc, ev, am } = fazerBicho(ID);
    const def = ATTACK_DEFS[ID];
    const v = fazerVitima('p1', 0, 60);
    am.tryAttack(npc, v, [v], MAP);

    vi.advanceTimersByTime(def.castTime + 10);
    expect(somaDano(ev), 'detonou sem carregar').toBe(0);
    // O segundo aviso é o que torna a janela jogável.
    const avisos = ev.filter(e => e.type === 'npc_telegraph');
    expect(avisos.length, 'a carga não foi anunciada').toBeGreaterThanOrEqual(2);
    expect(avisos[avisos.length - 1].duration).toBe(def.chargeMs);

    vi.runAllTimers();
    expect(somaDano(ev), 'a carga completou e não explodiu').toBeGreaterThan(0);
  });

  it('dano no chefe durante a carga CANCELA tudo', () => {
    const { npc, ev, am } = fazerBicho(ID);
    const def = ATTACK_DEFS[ID];
    const v = fazerVitima('p1', 0, 60);
    am.tryAttack(npc, v, [v], MAP);
    vi.advanceTimersByTime(def.castTime + 500);

    npc.hp -= def.interruptDamage;           // um tiro basta: interruptDamage 1
    vi.runAllTimers();

    expect(ev.some(e => e.type === 'monster_skill_interrupted'),
      'não anunciou a interrupção').toBe(true);
    expect(somaDano(ev), 'explodiu mesmo interrompido').toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('SANGUESSUGA — o bicho bebe o que tira', () => {
  it.each(['turtle_boss_gorge_drain', 'alien_boss_gut_drain'])('%s cura o bicho', (id) => {
    const { npc, ev, am } = fazerBicho(id);
    npc.hp = 1000; npc.maxHp = 1e6;
    const v = fazerVitima('p1', 0, 30);
    am.tryAttack(npc, v, [v], MAP);
    vi.runAllTimers();

    const dano = somaDano(ev);
    expect(dano, 'não machucou').toBeGreaterThan(0);
    expect(npc.hp, 'sorveu e não curou').toBeGreaterThan(1000);
    const curou = ev.filter(e => e.type === 'npc_drain_heal')
      .reduce((s, e) => s + e.amount, 0);
    expect(curou / dano).toBeCloseTo(ATTACK_DEFS[id].drainHealPct, 1);
  });

  it('com a vida cheia não anuncia cura nenhuma', () => {
    const { npc, ev, am } = fazerBicho('turtle_boss_gorge_drain');
    npc.hp = 500; npc.maxHp = 500;
    const v = fazerVitima('p1', 0, 30);
    am.tryAttack(npc, v, [v], MAP);
    vi.runAllTimers();
    expect(npc.hp).toBe(500);
    expect(ev.some(e => e.type === 'npc_drain_heal')).toBe(false);
  });
});
