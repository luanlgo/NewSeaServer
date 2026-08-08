/**
 * Testes da canalização de ataque de NPC (managers/attack-manager.js)
 *
 * Dois bugs do Sopro Pútrido (crab_putrid_spray) que este caminho tinha:
 *  1. `ticks` era ignorado no lado do BICHO — o golpe de 5 levas resolvia UMA
 *     vez só (o caminho da relíquia, no monster-skill-manager, sempre ticou).
 *  2. `follow` não re-mirava: o cone congelava na direção do início do cast
 *     enquanto bicho e alvo continuavam andando, e o desenho descolava do dano.
 *
 * Cobre também: golpe de leva única segue com 1 acerto, a canalização para
 * quando o bicho morre, e o bicho não abre outra skill por cima da própria
 * canalização.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AttackManager = require('../../managers/attack-manager.js');
const { ATTACK_DEFS } = require('../../constants/index.js');

const SPRAY = 'crab_putrid_spray';   // ticks {count:5, intervalMs:700}, follow
const SLAM  = 'crab_claw_slam';      // leva única, sem follow

function makeNpc(over = {}) {
  return {
    id: 'npc1', x: 0, z: 0, hp: 500, cannonDmg: 100,
    attacks: [SPRAY, SLAM], _attackCooldowns: {}, dead: false,
    npcModel: '/models/monster/carangueijo.glb',
    ...over,
  };
}
function makePlayer(over = {}) {
  return { id: 'p1', x: 0, z: 40, hp: 100000, maxHp: 100000, mapLevel: 1, dead: false, ...over };
}

/** AttackManager com o addEvent gravado, e `npcs` para o guard de NPC vivo. */
function makeManager(npc) {
  const events = [];
  const am = new AttackManager((e) => events.push(e), null);
  am.pm = { npcs: new Map([[npc.id, npc]]) };
  return { am, events };
}

describe('canalização de ataque de NPC (ticks)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('o Sopro Pútrido bate 5 vezes, não uma', () => {
    const npc = makeNpc();
    const player = makePlayer();
    const { am } = makeManager(npc);
    const def = ATTACK_DEFS[SPRAY];
    expect(def.ticks).toEqual({ count: 5, intervalMs: 700 });

    am._beginCast(npc, def, player, [player], 1);

    vi.advanceTimersByTime(def.castTime);            // 1º tick sai no fim do cast
    const depoisDoCast = player.hp;
    expect(depoisDoCast).toBeLessThan(100000);

    vi.advanceTimersByTime(4 * def.ticks.intervalMs); // os 4 restantes
    const dano = 100000 - player.hp;
    const porTick = Math.floor(npc.cannonDmg * def.damageMult);
    expect(dano).toBe(porTick * 5);
  });

  it('golpe de leva única continua batendo uma vez só', () => {
    const npc = makeNpc();
    const player = makePlayer({ z: 30 });
    const { am } = makeManager(npc);
    const def = ATTACK_DEFS[SLAM];
    expect(def.ticks).toBeUndefined();

    am._beginCast(npc, def, player, [player], 1);
    vi.advanceTimersByTime(def.castTime + 5000);

    expect(100000 - player.hp).toBe(Math.floor(npc.cannonDmg * def.damageMult));
  });

  it('re-mira no alvo vivo a cada tick e avisa o cliente do giro', () => {
    const npc = makeNpc();
    const player = makePlayer({ x: 0, z: 40 });   // alvo ao NORTE
    const { am, events } = makeManager(npc);
    const def = ATTACK_DEFS[SPRAY];

    am._beginCast(npc, def, player, [player], 1);
    vi.advanceTimersByTime(def.castTime);

    const aim1 = events.filter(e => e.type === 'npc_skill_aim').pop();
    expect(aim1).toBeDefined();
    expect(aim1.dirZ).toBeCloseTo(1, 5);          // aponta pro norte
    expect(aim1.dirX).toBeCloseTo(0, 5);

    // O alvo corre para o LESTE no meio da canalização.
    player.x = 40; player.z = 0;
    vi.advanceTimersByTime(def.ticks.intervalMs);

    const aim2 = events.filter(e => e.type === 'npc_skill_aim').pop();
    expect(aim2.dirX).toBeCloseTo(1, 5);          // o cone acompanhou
    expect(aim2.dirZ).toBeCloseTo(0, 5);
  });

  it('o dano acompanha a re-mirada (quem foge do cone inicial ainda leva)', () => {
    const npc = makeNpc();
    const player = makePlayer({ x: 0, z: 40 });
    const { am } = makeManager(npc);
    const def = ATTACK_DEFS[SPRAY];

    am._beginCast(npc, def, player, [player], 1);
    vi.advanceTimersByTime(def.castTime);
    const hpDepoisDo1 = player.hp;

    // Vai para trás do bicho: fora do cone ORIGINAL (norte), dentro do novo.
    player.x = 0; player.z = -40;
    vi.advanceTimersByTime(def.ticks.intervalMs);

    expect(player.hp).toBeLessThan(hpDepoisDo1);
  });

  it('o telegraph leva `ticks` e `follow` para o cliente', () => {
    const npc = makeNpc();
    const player = makePlayer();
    const { am, events } = makeManager(npc);
    const def = ATTACK_DEFS[SPRAY];

    am._beginCast(npc, def, player, [player], 1);

    const tele = events.find(e => e.type === 'npc_telegraph');
    expect(tele).toBeDefined();
    // Sem `ticks` no payload o cliente encerrava o giro do cone e o rastreio no
    // fim do CAST, enquanto o dano seguia por mais 2,8 s.
    expect(tele.ticks).toEqual({ count: 5, intervalMs: 700 });
    expect(tele.follow).toBe(true);
    expect(tele.vfx).toBe('crab_putrid_spray');
  });

  it('golpe de leva única manda ticks nulo (cliente trata como 1 leva)', () => {
    const npc = makeNpc();
    const player = makePlayer();
    const { am, events } = makeManager(npc);

    am._beginCast(npc, ATTACK_DEFS[SLAM], player, [player], 1);

    expect(events.find(e => e.type === 'npc_telegraph').ticks).toBeNull();
  });

  it('cada tick manda o próprio npc_attack_hit na posição re-mirada', () => {
    const npc = makeNpc();
    const player = makePlayer({ x: 0, z: 40 });
    const { am, events } = makeManager(npc);
    const def = ATTACK_DEFS[SPRAY];

    am._beginCast(npc, def, player, [player], 1);
    vi.advanceTimersByTime(def.castTime);
    player.x = 40; player.z = 0;                 // corre para o leste
    vi.advanceTimersByTime(4 * def.ticks.intervalMs);

    const hits = events.filter(e => e.type === 'npc_attack_hit');
    expect(hits).toHaveLength(5);                // um impacto por leva
    expect(hits[hits.length - 1].x).toBeCloseTo(40, 5);  // acompanhou o alvo
    expect(hits[hits.length - 1].z).toBeCloseTo(0, 5);
  });

  it('o Sopro aplica slow de 20% e renova a cada leva', () => {
    const npc = makeNpc();
    const player = makePlayer();
    const { am } = makeManager(npc);
    const def = ATTACK_DEFS[SPRAY];
    expect(def.cc).toEqual({ slowPct: 0.20, slowMs: 1500 });

    am._beginCast(npc, def, player, [player], 1);
    vi.advanceTimersByTime(def.castTime);

    expect(player.slowMult).toBeCloseTo(0.8, 5);        // 20% mais lento
    const apos1 = player.slowExpires;

    vi.advanceTimersByTime(def.ticks.intervalMs);
    expect(player.slowExpires).toBeGreaterThan(apos1);  // a leva seguinte renovou
  });

  it('golpe sem cc não mexe na velocidade do alvo', () => {
    const npc = makeNpc();
    const player = makePlayer({ z: 30 });
    const { am } = makeManager(npc);

    am._beginCast(npc, ATTACK_DEFS[SLAM], player, [player], 1);
    vi.advanceTimersByTime(ATTACK_DEFS[SLAM].castTime + 100);

    expect(player.slowMult).toBeUndefined();
  });

  it('a Investida acerta o CORREDOR (o dash não pode mover a origem antes)', () => {
    const npc = makeNpc();
    // Alvo no meio do caminho: o bicho corre 160 e passa por cima dele.
    const player = makePlayer({ x: 0, z: 80 });
    const { am } = makeManager(npc);
    const def = ATTACK_DEFS['crab_burrow_rush'];
    expect(def.dash).toBe(true);

    am._beginCast(npc, def, player, [player], 1);
    vi.advanceTimersByTime(def.castTime + 100);

    // Antes da correção a faixa era medida a partir do FIM da investida,
    // apontando de volta — e ninguém no corredor levava dano.
    expect(player.hp).toBeLessThan(100000);
    expect(npc.z).toBeCloseTo(def.length, 5);   // o bicho viajou de verdade
  });

  it('a Investida acerta a IRRUPÇÃO no fim do corredor', () => {
    const npc = makeNpc();
    const def = ATTACK_DEFS['crab_burrow_rush'];
    // De lado, fora da faixa (largura 35 → meia-largura 17,5), mas dentro do
    // círculo de irrupção (55) centrado no fim do corredor.
    const player = makePlayer({ x: 40, z: def.length });
    const { am } = makeManager(npc);

    am._beginCast(npc, def, { x: 0, z: 200, dead: false, mapLevel: 1, id: 'alvo' }, [player], 1);
    vi.advanceTimersByTime(def.castTime + 100);

    expect(def.eruptRadius).toBe(55);
    expect(player.hp).toBeLessThan(100000);
  });

  it('quem está longe do corredor e da irrupção não leva nada', () => {
    const npc = makeNpc();
    const def = ATTACK_DEFS['crab_burrow_rush'];
    const player = makePlayer({ x: 150, z: 0 });   // bem para o lado
    const { am } = makeManager(npc);

    am._beginCast(npc, def, { x: 0, z: 200, dead: false, mapLevel: 1, id: 'alvo' }, [player], 1);
    vi.advanceTimersByTime(def.castTime + 100);

    expect(player.hp).toBe(100000);
  });

  it('o telegraph leva eruptRadius (2D, 3D e dano no mesmo número)', () => {
    const npc = makeNpc();
    const { am, events } = makeManager(npc);
    const def = ATTACK_DEFS['crab_burrow_rush'];

    am._beginCast(npc, def, makePlayer({ z: 100 }), [], 1);

    expect(events.find(e => e.type === 'npc_telegraph').eruptRadius).toBe(55);
  });

  it('o cone respeita a abertura em GRAUS (não bate 360° em volta do bicho)', () => {
    const npc = makeNpc();
    const frente = makePlayer({ id: 'frente', x: 0, z: 30 });   // dentro do cone
    const atras  = makePlayer({ id: 'atras',  x: 0, z: -30 });  // atrás do bicho
    const { am } = makeManager(npc);
    const def = ATTACK_DEFS[SLAM];                              // cone de 70°

    am._beginCast(npc, def, frente, [frente, atras], 1);
    vi.advanceTimersByTime(def.castTime + 100);

    expect(frente.hp).toBeLessThan(100000);
    expect(atras.hp).toBe(100000);   // antes da conversão grau→rad, levava igual
  });

  it('não bate sem follow quando o alvo sai da área (o cone fica plantado)', () => {
    const npc = makeNpc();
    const player = makePlayer({ x: 0, z: 30 });
    const { am } = makeManager(npc);
    const def = ATTACK_DEFS[SLAM];        // sem follow

    am._beginCast(npc, def, player, [player], 1);
    player.x = 0; player.z = -60;         // fugiu para trás
    vi.advanceTimersByTime(def.castTime + 100);

    expect(player.hp).toBe(100000);
  });

  it('a canalização para quando o bicho morre no meio', () => {
    const npc = makeNpc();
    const player = makePlayer();
    const { am } = makeManager(npc);
    const def = ATTACK_DEFS[SPRAY];

    am._beginCast(npc, def, player, [player], 1);
    vi.advanceTimersByTime(def.castTime);
    const hpApos1 = player.hp;

    npc.dead = true;
    vi.advanceTimersByTime(4 * def.ticks.intervalMs);

    expect(player.hp).toBe(hpApos1);      // nenhum tick fantasma
  });

  it('cancelCast limpa os ticks pendentes', () => {
    const npc = makeNpc();
    const player = makePlayer();
    const { am } = makeManager(npc);
    const def = ATTACK_DEFS[SPRAY];

    am._beginCast(npc, def, player, [player], 1);
    vi.advanceTimersByTime(def.castTime);
    const hpApos1 = player.hp;

    am.cancelCast(npc);
    vi.advanceTimersByTime(4 * def.ticks.intervalMs);

    expect(player.hp).toBe(hpApos1);
    expect(npc._tickTimers).toBeNull();
  });

  it('o bicho não abre outra skill por cima da própria canalização', () => {
    const npc = makeNpc();
    const player = makePlayer();
    const { am } = makeManager(npc);
    const def = ATTACK_DEFS[SPRAY];
    const canalMs = (def.ticks.count - 1) * def.ticks.intervalMs;

    const t0 = Date.now();
    am._beginCast(npc, def, player, [player], 1);
    vi.advanceTimersByTime(def.castTime);

    // A pausa até o próximo ataque cobre a canalização inteira (+800ms mínimos).
    expect(npc._nextAttackTime - t0).toBeGreaterThanOrEqual(canalMs + 800);
  });
});
