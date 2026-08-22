import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import JournalManager from '../../managers/journal-manager.js';

const { SRC, KINDS, ACCRUE_WINDOW_MS } = JournalManager;

// ─────────────────────────────────────────────────────────────────────────────
// O livro-caixa do Diário é OBSERVAÇÃO: ele não move saldo nenhum, só anota o
// que os ~40 pontos que mexem em moeda já fizeram. Duas coisas precisam ser
// verdade para ele servir de extrato:
//
//   1. o que foi anotado bate com o que aconteceu (sinal e valor), e
//   2. a fonte de alta frequência não pode virar uma linha por abate — mas
//      também não pode PERDER nada ao agregar.
//
// A segunda é a que quebra em silêncio: um jogador que desconecta no meio da
// janela levaria embora o último minuto de ganhos se o flush não fosse forçado.
// ─────────────────────────────────────────────────────────────────────────────

/** Socket de mentira que guarda o eco que o servidor mandaria ao cliente. */
function makeWs(sink) {
  return { readyState: 1, OPEN: 1, bufferedAmount: 0,
           send: (s) => sink.push(JSON.parse(s)) };
}

function makeDb(rows) {
  return {
    addJournal: async (playerName, at, kind, data, reportId) => {
      rows.push({ playerName, at, kind, data, reportId });
    },
  };
}

let rows, echo, jm, player;

beforeEach(() => {
  rows   = [];
  echo   = [];
  jm     = new JournalManager(makeDb(rows));
  player = { name: 'Bagatinha', ws: makeWs(echo), gold: 0, dobroes: 0, npcKills: 0 };
});

afterEach(() => { vi.useRealTimers(); });

describe('ledger — a anotação imediata', () => {
  it('grava o delta assinado e ecoa para quem está online', () => {
    jm.ledger(player, SRC.SHOP_CANNON, { gold: -12000 }, { detail: 'c6', n: 3 });

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe(KINDS.LEDGER);
    expect(rows[0].data).toEqual({ source: 'shop_cannon', gold: -12000, detail: 'c6', n: 3 });

    const eco = echo.filter(m => m.type === 'journal_entry');
    expect(eco).toHaveLength(1);
    expect(eco[0].entry.data.gold).toBe(-12000);
  });

  it('omite as moedas zeradas em vez de gravar três zeros por linha', () => {
    jm.ledger(player, SRC.BOSS, { dobroes: 40, gold: 0, xp: 0 });
    expect(rows[0].data).toEqual({ source: 'boss', dobroes: 40 });
  });

  it('descarta o movimento inteiramente zerado', () => {
    // É o caso do talento comprado com ponto grátis do reset: o chamador pode
    // não saber que não houve custo, e o extrato não pode inventar um gasto.
    jm.ledger(player, SRC.TALENT, { gold: 0, dobroes: 0, xp: 0 });
    expect(rows).toHaveLength(0);
    expect(echo).toHaveLength(0);
  });

  it('ledgerByName grava para quem está offline, sem tentar ecoar', () => {
    jm.ledgerByName('Barba Ruiva', SRC.SPOIL_LOOT, { gold: 900 });
    expect(rows).toHaveLength(1);
    expect(rows[0].playerName).toBe('Barba Ruiva');
    expect(echo).toHaveLength(0);
  });
});

describe('accrue — a janela das fontes de alta frequência', () => {
  it('não grava nada enquanto a janela está aberta', () => {
    for (let i = 0; i < 30; i++) jm.accrue(player, SRC.NPC_KILL, { gold: 100, xp: 12 });
    expect(rows).toHaveLength(0);
  });

  it('fecha a janela vencida somando tudo numa linha só, com a contagem', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    for (let i = 0; i < 37; i++) jm.accrue(player, SRC.NPC_KILL, { gold: 100, xp: 12 });

    jm.sweep([player]);
    expect(rows).toHaveLength(0);            // janela ainda aberta

    vi.setSystemTime(ACCRUE_WINDOW_MS + 1);
    jm.sweep([player]);

    expect(rows).toHaveLength(1);
    expect(rows[0].data).toEqual({ source: 'npc_kill', gold: 3700, xp: 444, n: 37 });
  });

  it('separa as fontes: partilha de grupo não vira abate de NPC', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    jm.accrue(player, SRC.NPC_KILL,    { gold: 100 });
    jm.accrue(player, SRC.PARTY_SHARE, { gold: 50 });
    jm.accrue(player, SRC.GOLD_STOLEN, { gold: -20 });

    vi.setSystemTime(ACCRUE_WINDOW_MS + 1);
    jm.sweep([player]);

    const porFonte = Object.fromEntries(rows.map(r => [r.data.source, r.data]));
    expect(Object.keys(porFonte).sort()).toEqual(['gold_stolen', 'npc_kill', 'party_share']);
    expect(porFonte.gold_stolen.gold).toBe(-20);
  });

  it('flushPlayer(force) fecha a janela ABERTA — o último minuto antes do logout', () => {
    jm.accrue(player, SRC.NPC_KILL, { gold: 800, xp: 60 });
    jm.flushPlayer(player, false);
    expect(rows).toHaveLength(0);   // sem force, a janela nova continua de pé

    jm.flushPlayer(player, true);
    expect(rows).toHaveLength(1);
    expect(rows[0].data.gold).toBe(800);
  });

  it('flush duplo não grava a mesma leva duas vezes', () => {
    jm.accrue(player, SRC.NPC_KILL, { gold: 800 });
    jm.flushPlayer(player, true);
    jm.flushPlayer(player, true);
    expect(rows).toHaveLength(1);
  });

  it('ignora o acúmulo zerado — um abate sem drop não abre balde', () => {
    jm.accrue(player, SRC.NPC_KILL, { gold: 0, xp: 0, dobroes: 0 });
    jm.flushPlayer(player, true);
    expect(rows).toHaveLength(0);
  });
});

describe('checkTier — a subida de Tier de abates', () => {
  it('a primeira chamada só memoriza: relogar não inventa subida', () => {
    player.npcKills = 70;
    jm.checkTier(player);
    expect(rows).toHaveLength(0);
  });

  it('grava quando o Tier passa de faixa, com o número de abates', () => {
    player.npcKills = 69;
    jm.checkTier(player);          // memoriza Tier 6
    player.npcKills = 70;
    jm.checkTier(player);

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe(KINDS.TIER_UP);
    expect(rows[0].data).toEqual({ tier: 7, from: 6, kills: 70 });
  });

  it('não grava nada nos abates que ficam dentro da mesma faixa', () => {
    player.npcKills = 70;
    jm.checkTier(player);
    for (let k = 71; k < 80; k++) { player.npcKills = k; jm.checkTier(player); }
    expect(rows).toHaveLength(0);
  });

  it('o Tier que CAI (XP roubado no PvP) não vira linha, mas reajusta a régua', () => {
    player.npcKills = 80;
    jm.checkTier(player);          // memoriza Tier 8
    player.npcKills = 70;          // 5% dos abates mudaram de dono
    jm.checkTier(player);
    expect(rows).toHaveLength(0);

    // E voltar a subir tem de gravar de novo, a partir do valor rebaixado.
    player.npcKills = 80;
    jm.checkTier(player);
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toEqual({ tier: 8, from: 7, kills: 80 });
  });
});

describe('o livro-caixa não move saldo', () => {
  it('nem ledger nem accrue encostam no ouro do jogador', () => {
    player.gold = 5000;
    player.dobroes = 100;
    jm.ledger(player, SRC.SHOP_AMMO, { gold: -1200 });
    jm.accrue(player, SRC.NPC_KILL,  { gold: 300, dobroes: 5 });
    jm.flushPlayer(player, true);

    expect(player.gold).toBe(5000);
    expect(player.dobroes).toBe(100);
  });

  it('falha de banco não derruba o fluxo que gerou o evento', async () => {
    const quebrado = new JournalManager({ addJournal: async () => { throw new Error('DB fora'); } });
    const erros = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => quebrado.ledger(player, SRC.BOSS, { dobroes: 10 })).not.toThrow();
    await Promise.resolve();
    erros.mockRestore();
  });
});
