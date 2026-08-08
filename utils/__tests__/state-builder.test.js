import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildZone, buildFor, resetViewer, pruneBaseline, packSlim, _baseline, F_DEAD, F_CAST,
} from '../state-builder.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Snapshot de jogador no formato que playerManager.snapshot() produz. */
const mkPlayer = (id, x, z, over = {}) => ({
  id, name: 'Capitao' + id, x, y: 0, z,
  activeShip: 'fragata', rotation: 0, hp: 100, maxHp: 100, speed: 0,
  dead: false, isPlayer: true, mapLevel: 1,
  cannonCooldown: 0, cannonCooldownMax: 5000, cannonRange: 80,
  ...over,
});

/** Snapshot de NPC no formato que npcManager.snapshot() produz. */
const mkNpc = (id, x, z, over = {}) => ({
  id, name: 'Fantasma', x, y: 0, z, rotation: 0, hp: 50, maxHp: 50, speed: 0,
  dead: false, isNPC: true, isBoss: false, mapLevel: 1, ...over,
});

/** Um "viewer" é o objeto vivo do jogador (não o snapshot). */
const mkViewer = (id, x, z) => ({ id, x, z, mapLevel: 1 });

const idsOf = list => (list || []).map(e => (Array.isArray(e) ? e[0] : e.id)).sort((a, b) => a - b);

beforeEach(() => {
  _baseline.clear();
});

// ── Primeira visão ────────────────────────────────────────────────────────────

describe('buildFor — primeira visão', () => {
  it('manda tudo que está no alcance como registro completo', () => {
    const viewer = mkViewer(1, 0, 0);
    const zone = buildZone([mkPlayer(1, 0, 0), mkPlayer(2, 50, 0), mkNpc(9, 80, 0)], 1);

    const msg = buildFor(viewer, zone);
    expect(msg.aoi).toBe(1);
    expect(idsOf(msg.f)).toEqual([1, 2, 9]);
    expect(msg.s).toBeUndefined();
    expect(msg.r).toBeUndefined();
  });

  it('não manda quem está fora do raio de AOI', () => {
    const viewer = mkViewer(1, 0, 0);
    const zone = buildZone([mkPlayer(1, 0, 0), mkPlayer(2, 5000, 0)], 1);

    expect(idsOf(buildFor(viewer, zone).f)).toEqual([1]);
  });

  it('o registro completo preserva os campos estáticos que o cliente precisa', () => {
    const viewer = mkViewer(1, 0, 0);
    const zone = buildZone([mkPlayer(1, 0, 0), mkNpc(9, 10, 0, { npcModel: 'kraken' })], 1);

    const npc = buildFor(viewer, zone).f.find(e => e.id === 9);
    expect(npc.name).toBe('Fantasma');
    expect(npc.npcModel).toBe('kraken');
    expect(npc.isNPC).toBe(true);
    expect(npc.maxHp).toBe(50);
  });
});

// ── Slim e dirty ──────────────────────────────────────────────────────────────

describe('buildFor — atualizações seguintes', () => {
  it('silencia quando nada mudou', () => {
    const viewer = mkViewer(1, 0, 0);
    const ents = () => [mkPlayer(1, 0, 0), mkPlayer(2, 50, 0)];

    buildFor(viewer, buildZone(ents(), 1));
    // Segundo broadcast, mundo idêntico → nada a dizer.
    expect(buildFor(viewer, buildZone(ents(), 1))).toBeNull();
  });

  it('quem já é conhecido e se moveu vem como tupla compacta', () => {
    const viewer = mkViewer(1, 0, 0);
    buildFor(viewer, buildZone([mkPlayer(1, 0, 0), mkPlayer(2, 50, 0)], 1));

    const msg = buildFor(viewer, buildZone([mkPlayer(1, 0, 0), mkPlayer(2, 60, 0)], 1));
    expect(msg.f).toBeUndefined();
    expect(msg.s).toHaveLength(1);
    expect(msg.s[0][0]).toBe(2);
    expect(msg.s[0][1]).toBe(6000); // x, em centi-unidades
  });

  it('mudança só de hp também conta como mudança', () => {
    const viewer = mkViewer(1, 0, 0);
    buildFor(viewer, buildZone([mkPlayer(1, 0, 0), mkNpc(9, 50, 0)], 1));

    const msg = buildFor(viewer, buildZone([mkPlayer(1, 0, 0), mkNpc(9, 50, 0, { hp: 20 })], 1));
    expect(idsOf(msg.s)).toEqual([9]);
    expect(msg.s[0][4]).toBe(20);
  });

  it('movimento abaixo da resolução do fio não gera tráfego', () => {
    const viewer = mkViewer(1, 0, 0);
    buildFor(viewer, buildZone([mkPlayer(1, 0, 0), mkNpc(9, 50, 0)], 1));

    // Deriva abaixo da resolução do fio (1 cm) não deve virar mensagem.
    const msg = buildFor(viewer, buildZone([mkPlayer(1, 0, 0), mkNpc(9, 50.001, 0)], 1));
    expect(msg).toBeNull();
  });
});

// ── Entrada e saída do alcance ────────────────────────────────────────────────

describe('buildFor — entrada e saída da visão', () => {
  it('quem sai do alcance vai em `r` e é esquecido', () => {
    const viewer = mkViewer(1, 0, 0);
    buildFor(viewer, buildZone([mkPlayer(1, 0, 0), mkPlayer(2, 50, 0)], 1));

    const msg = buildFor(viewer, buildZone([mkPlayer(1, 0, 0), mkPlayer(2, 5000, 0)], 1));
    expect(msg.r).toEqual([2]);
    expect(viewer._aoiKnown.has(2)).toBe(false);
  });

  it('quem volta ao alcance vem COMPLETO de novo, não como slim', () => {
    const viewer = mkViewer(1, 0, 0);
    buildFor(viewer, buildZone([mkPlayer(1, 0, 0), mkPlayer(2, 50, 0)], 1));
    buildFor(viewer, buildZone([mkPlayer(1, 0, 0), mkPlayer(2, 5000, 0)], 1));

    // O cliente deu queue_free na entidade — se voltasse como slim ele não teria
    // o que atualizar (nome, modelo, maxHp vêm só no registro completo).
    const msg = buildFor(viewer, buildZone([mkPlayer(1, 0, 0), mkPlayer(2, 60, 0)], 1));
    expect(idsOf(msg.f)).toEqual([2]);
    expect(msg.s).toBeUndefined();
  });

  it('o próprio jogador NUNCA entra na lista de remoção', () => {
    const viewer = mkViewer(1, 0, 0);
    buildFor(viewer, buildZone([mkPlayer(1, 0, 0)], 1));

    // Jogador morreu: playerManager.snapshot() pula os mortos, então ele some da
    // zona. Mandá-lo em `r` faria o cliente destruir o nó que a câmera segue.
    const msg = buildFor(viewer, buildZone([mkNpc(9, 10, 0)], 1));
    expect(msg.r || []).not.toContain(1);
  });
});

// ── O próprio barco ───────────────────────────────────────────────────────────

describe('buildFor — o registro do próprio jogador', () => {
  it('vai sempre completo, porque o HUD lê cannonCooldown dele', () => {
    const viewer = mkViewer(1, 0, 0);
    buildFor(viewer, buildZone([mkPlayer(1, 0, 0)], 1));

    const msg = buildFor(viewer, buildZone([mkPlayer(1, 10, 0)], 1));
    expect(idsOf(msg.f)).toEqual([1]);
    expect(msg.s).toBeUndefined();
    expect(msg.f[0].cannonCooldown).toBeDefined();
    expect(msg.f[0].cannonCooldownMax).toBeDefined();
  });

  it('cooldown mudando sozinho já força o envio (a barra do HUD não anima só)', () => {
    const viewer = mkViewer(1, 0, 0);
    buildFor(viewer, buildZone([mkPlayer(1, 0, 0, { cannonCooldown: 5000 })], 1));

    // Barco parado, recarregando: nada que caiba no slim mudou, mas o HUD
    // precisa do valor novo.
    const msg = buildFor(viewer, buildZone([mkPlayer(1, 0, 0, { cannonCooldown: 4000 })], 1));
    expect(msg).not.toBeNull();
    expect(msg.f[0].cannonCooldown).toBe(4000);
  });

  it('parado e sem cooldown correndo → silêncio', () => {
    const viewer = mkViewer(1, 0, 0);
    const ents = () => [mkPlayer(1, 0, 0, { cannonCooldown: 0 })];
    buildFor(viewer, buildZone(ents(), 1));
    expect(buildFor(viewer, buildZone(ents(), 1))).toBeNull();
  });
});

// ── Troca de mapa ─────────────────────────────────────────────────────────────

describe('buildFor — troca de mapa', () => {
  it('esquece tudo ao mudar de mapa (o cliente liberou as entidades)', () => {
    const viewer = mkViewer(1, 0, 0);
    buildFor(viewer, buildZone([mkPlayer(1, 0, 0), mkNpc(9, 50, 0)], 1));

    // Mesmo id de NPC no mapa novo: sem o reset ele viria como slim e o cliente
    // não teria a entidade para atualizar.
    viewer.mapLevel = 2;
    const msg = buildFor(viewer, buildZone([mkPlayer(1, 0, 0), mkNpc(9, 50, 0)], 2));
    expect(idsOf(msg.f)).toEqual([1, 9]);
    expect(msg.s).toBeUndefined();
  });

  it('resetViewer zera o conhecido', () => {
    const viewer = mkViewer(1, 0, 0);
    buildFor(viewer, buildZone([mkPlayer(1, 0, 0), mkNpc(9, 50, 0)], 1));
    expect(viewer._aoiKnown.size).toBeGreaterThan(0);
    resetViewer(viewer);
    expect(viewer._aoiKnown.size).toBe(0);
  });
});

// ── packSlim ──────────────────────────────────────────────────────────────────

describe('packSlim', () => {
  it('empacota posição/rotação/velocidade em centi-unidades inteiras', () => {
    const t = packSlim({ id: 7, x: 12.3456, z: -9.8765, rotation: 1.23456, hp: 42, speed: 0.98765 });
    expect(t).toEqual([7, 1235, -988, 123, 42, 99, 0]);
  });

  it('nada de ponto decimal no fio — inteiro é menor E mais preciso que 0,1', () => {
    const t = packSlim({ id: 7, x: 12.3456, z: -9.8765, rotation: 1.2, hp: 42, speed: 1 });
    for (const v of t) expect(Number.isInteger(v)).toBe(true);
  });

  it('empacota dead e cast no bitfield', () => {
    expect(packSlim({ id: 1, dead: true })[6]).toBe(F_DEAD);
    expect(packSlim({ id: 1, moveState: 'cast' })[6]).toBe(F_CAST);
    expect(packSlim({ id: 1, dead: true, moveState: 'cast' })[6]).toBe(F_DEAD | F_CAST);
    expect(packSlim({ id: 1 })[6]).toBe(0);
  });

  it('a tupla tem exatamente 7 posições (o cliente valida size >= 7)', () => {
    expect(packSlim({ id: 1 })).toHaveLength(7);
  });
});

// ── Baseline ──────────────────────────────────────────────────────────────────

describe('pruneBaseline', () => {
  it('descarta entidades que não existem mais', () => {
    const viewer = mkViewer(1, 0, 0);
    const ents = [mkPlayer(1, 0, 0)];
    for (let i = 10; i < 60; i++) ents.push(mkNpc(i, 10, 0));
    buildFor(viewer, buildZone(ents, 1));
    expect(_baseline.size).toBe(51);

    // Só o jogador sobreviveu — o resto era NPC que morreu.
    pruneBaseline(new Set([1]));
    expect(_baseline.size).toBe(1);
  });

  it('não varre à toa quando o mapa está estável', () => {
    const viewer = mkViewer(1, 0, 0);
    buildFor(viewer, buildZone([mkPlayer(1, 0, 0), mkNpc(9, 10, 0)], 1));
    expect(pruneBaseline(new Set([1, 9]))).toBe(0);
  });
});

// ── Simulação do cliente ──────────────────────────────────────────────────────
// O cliente de verdade é GDScript e não roda nesta suíte, então aqui vai um
// modelo dele com EXATAMENTE a mesma lógica de _apply_state_aoi (main.gd):
// `f` cria/atualiza, `s` só atualiza quem já existe, `r` libera. Se o protocolo
// tiver um furo, ele aparece como divergência entre este modelo e o servidor.

class FakeClient {
  constructor(id) { this.id = id; this.entities = new Map(); this.orphanSlims = 0; }

  apply(msg) {
    if (!msg) return; // servidor calou a boca: nada muda
    for (const e of msg.f || []) this.entities.set(e.id, { ...e });
    for (const t of msg.s || []) {
      const ent = this.entities.get(t[0]);
      // O cliente ignora slim de entidade que ele não tem. Se isso acontecer,
      // é atualização perdida — a entidade congela na tela.
      if (!ent) { this.orphanSlims++; continue; }
      // Mesma conversão que apply_slim faz em player.gd: centi → unidades.
      ent.x = t[1] * 0.01; ent.z = t[2] * 0.01; ent.rotation = t[3] * 0.01;
      ent.hp = t[4]; ent.speed = t[5] * 0.01; ent.dead = !!(t[6] & F_DEAD);
    }
    for (const id of msg.r || []) {
      if (id === this.id) continue;
      this.entities.delete(id);
    }
  }
}

describe('cliente simulado — sincronia ao longo do tempo', () => {
  it('nunca recebe slim de entidade que não tem, e converge com o servidor', () => {
    // Mundo pequeno para forçar MUITA entrada e saída do raio de AOI.
    const world = [];
    for (let i = 1; i <= 30; i++) {
      world.push({ id: i, x: (i % 6) * 200 - 500, z: Math.floor(i / 6) * 200 - 500, vx: 0, vz: 0 });
    }

    const viewerId = 1;
    const viewer = { id: viewerId, x: 0, z: 0, mapLevel: 1 };
    const client = new FakeClient(viewerId);

    let framesWithTraffic = 0;
    for (let frame = 0; frame < 300; frame++) {
      // Todo mundo passeia; alguns dão saltos grandes para atravessar a fronteira
      // do AOI nos dois sentidos.
      for (const e of world) {
        if (frame % 7 === 0) { e.vx = (Math.random() - 0.5) * 120; e.vz = (Math.random() - 0.5) * 120; }
        e.x = Math.max(-900, Math.min(900, e.x + e.vx));
        e.z = Math.max(-900, Math.min(900, e.z + e.vz));
      }
      const me = world.find(e => e.id === viewerId);
      viewer.x = me.x; viewer.z = me.z;

      const snaps = world.map(e => mkPlayer(e.id, e.x, e.z));
      const zone = buildZone(snaps, 1);
      const msg = buildFor(viewer, zone);
      if (msg) framesWithTraffic++;
      client.apply(msg);

      // O que o cliente tem tem que ser exatamente o que está no raio de visão.
      const expected = new Set(
        snaps.filter(s => Math.hypot(s.x - viewer.x, s.z - viewer.z) <= 450).map(s => s.id)
      );
      expect(new Set(client.entities.keys())).toEqual(expected);
    }

    expect(client.orphanSlims).toBe(0);
    expect(framesWithTraffic).toBeGreaterThan(0); // a simulação de fato exercitou o caminho
  });

  it('as posições no cliente batem com as do servidor (na resolução do fio)', () => {
    const viewer = { id: 1, x: 0, z: 0, mapLevel: 1 };
    const client = new FakeClient(1);

    let x2 = 100;
    for (let frame = 0; frame < 50; frame++) {
      x2 += 3.33333; // valor com dízima, para o arredondamento não ser trivial
      const snaps = [mkPlayer(1, 0, 0), mkPlayer(2, x2, 0)];
      client.apply(buildFor(viewer, buildZone(snaps, 1)));
    }

    // Depois de 50 frames sem nunca ter recebido a entidade 2 inteira de novo,
    // o cliente tem que estar na posição atual, não numa defasada.
    expect(client.entities.get(2).x).toBeCloseTo(Math.round(x2 * 100) / 100, 6);
  });

  it('entidade que sai e volta não deixa fantasma nem perde dados estáticos', () => {
    const viewer = { id: 1, x: 0, z: 0, mapLevel: 1 };
    const client = new FakeClient(1);

    client.apply(buildFor(viewer, buildZone([mkPlayer(1, 0, 0), mkNpc(9, 100, 0, { npcModel: 'kraken' })], 1)));
    expect(client.entities.get(9).npcModel).toBe('kraken');

    // Sai do alcance
    client.apply(buildFor(viewer, buildZone([mkPlayer(1, 0, 0), mkNpc(9, 5000, 0)], 1)));
    expect(client.entities.has(9)).toBe(false);

    // Volta — precisa reaparecer COM os campos estáticos, senão o cliente
    // recriaria o navio sem modelo.
    client.apply(buildFor(viewer, buildZone([mkPlayer(1, 0, 0), mkNpc(9, 120, 0, { npcModel: 'kraken' })], 1)));
    expect(client.entities.get(9).npcModel).toBe('kraken');
  });

  it('troca de mapa: o cliente limpa tudo e o servidor remanda tudo', () => {
    const viewer = { id: 1, x: 0, z: 0, mapLevel: 1 };
    const client = new FakeClient(1);
    client.apply(buildFor(viewer, buildZone([mkPlayer(1, 0, 0), mkNpc(9, 50, 0)], 1)));
    expect(client.entities.size).toBe(2);

    // O cliente dá queue_free em tudo na transição (main.gd) — o modelo faz igual.
    client.entities.clear();
    viewer.mapLevel = 2;

    const msg = buildFor(viewer, buildZone([mkPlayer(1, 0, 0), mkNpc(9, 50, 0)], 2));
    client.apply(msg);
    expect(client.orphanSlims).toBe(0);
    expect(client.entities.size).toBe(2);
  });
});

// ── Regressão de escala ───────────────────────────────────────────────────────

describe('escala — 200 jogadores no mesmo mapa', () => {
  it('cada jogador recebe uma fração do mapa, não o mapa inteiro', () => {
    // 200 barcos espalhados num mapa 2400x2400 (mapa 4).
    const snaps = [];
    for (let i = 1; i <= 200; i++) {
      snaps.push(mkPlayer(i, (i % 20) * 120 - 1200, Math.floor(i / 20) * 240 - 1200));
    }
    const zone = buildZone(snaps, 1);
    const viewer = { id: 1, x: snaps[0].x, z: snaps[0].z, mapLevel: 1 };

    const msg = buildFor(viewer, zone);
    const total = (msg.f || []).length + (msg.s || []).length;
    expect(total).toBeLessThan(60);   // não os 200
    expect(total).toBeGreaterThan(0);
  });
});
