import { describe, it, expect } from 'vitest';
import st from '../talent-status.js';
import fx from '../talent-effects.js';
import talents from '../../constants/talents.js';

const { TALENT_DEFS } = talents;

// Jogador mínimo: `tal` é o mapa stat → total que applyTalentBonuses monta.
function player(tal = {}, extra = {}) {
  return { hp: 100, maxHp: 100, tal, ...extra };
}

const NOW = 1_700_000_000_000;

// ── A tabela dos 52 ───────────────────────────────────────────────────────────

describe('STATUS_STATS', () => {
  it('cobre 52 stats, nos cinco regimes', () => {
    const stats = Object.keys(st.STATUS_STATS);
    expect(stats).toHaveLength(52);
    const kinds = {};
    for (const k of Object.values(st.STATUS_STATS)) kinds[k] = (kinds[k] || 0) + 1;
    expect(kinds).toEqual({ stack: 4, window: 3, cooldown: 1, cond: 13, hit: 31 });
  });

  it('todo stat da tabela pertence a um talento que existe', () => {
    const reais = new Set(Object.values(TALENT_DEFS).map(d => d.stat));
    for (const stat of Object.keys(st.STATUS_STATS)) {
      expect(reais.has(stat), stat).toBe(true);
      expect(st.ID_BY_STAT[stat], stat).toBeDefined();
    }
  });

  it('nenhum passivo permanente entrou na lista por engano', () => {
    // Se um destes virasse status, ficaria aceso 100% do tempo e não informaria nada.
    for (const stat of ['damage_pct', 'max_hp_flat', 'gold_drop_pct', 'cannon_slots',
                        'mana_regen_pct', 'xp_drop_pct', 'speed_pct']) {
      expect(st.STATUS_STATS[stat], stat).toBeUndefined();
    }
  });
});

// ── Pilhas ────────────────────────────────────────────────────────────────────

describe('pilhas', () => {
  it('Frenesi só aparece com pilha em pé, e leva o número junto', () => {
    const p = player({ frenzy_pct: 10 });
    expect(st.activeStatuses(p, {}, NOW)).toHaveLength(0);

    p._frenzyStacks = 3;
    const [entry] = st.activeStatuses(p, {}, NOW).filter(e => e[0] === 'atk_frenesi');
    expect(entry).toEqual(['atk_frenesi', 3, 0]);
  });

  it('quem não comprou o talento não ganha o ícone nem com pilha suja no objeto', () => {
    const p = player({}, { _frenzyStacks: 4 });
    expect(st.activeStatuses(p, {}, NOW)).toHaveLength(0);
  });

  it('Sentinela leva o tempo que falta da janela de 5s', () => {
    const p = player({ reduction_after_hit_pct: 10 }, {
      _sentinelStacks: 2, _sentinelUntil: NOW + 1800,
    });
    const [entry] = st.activeStatuses(p, {}, NOW).filter(e => e[0] === 'def_sentinela');
    expect(entry[1]).toBe(2);
    expect(entry[2]).toBe(1800);
  });
});

// ── Janelas e recarga ─────────────────────────────────────────────────────────

describe('janelas com relógio', () => {
  it('Ventania vale pelos 5s seguintes ao abate e some depois', () => {
    const p = player({ speed_on_kill_pct: 20 }, { _lastKillAt: NOW - 2000 });
    const dentro = st.activeStatuses(p, {}, NOW).filter(e => e[0] === 'atk_ventania');
    expect(dentro[0][2]).toBe(fx.KILL_SPEED_MS - 2000);

    const fora = st.activeStatuses(p, {}, NOW + fx.KILL_SPEED_MS);
    expect(fora.filter(e => e[0] === 'atk_ventania')).toHaveLength(0);
  });

  it('Segundo Fôlego aparece ENQUANTO está recarregando, não quando está pronto', () => {
    const tal = { second_wind_pct: 20 };
    const recarregando = player(tal, { _secondWindAt: NOW - 10_000 });
    const [entry] = st.activeStatuses(recarregando, {}, NOW).filter(e => e[0] === 'def_segundofolego');
    expect(entry[2]).toBe(fx.SECOND_WIND_CD_MS - 10_000);

    const pronto = player(tal, { _secondWindAt: NOW - fx.SECOND_WIND_CD_MS - 1 });
    expect(st.activeStatuses(pronto, {}, NOW).filter(e => e[0] === 'def_segundofolego')).toHaveLength(0);
  });
});

// ── Condições ─────────────────────────────────────────────────────────────────

describe('condições', () => {
  it('Perseguição em combate, Correnteza fora dele — nunca as duas', () => {
    const tal = { speed_in_combat_pct: 15, speed_out_combat_pct: 20 };

    const brigando = player(tal, { lastCombatTime: NOW });
    const ids1 = st.activeStatuses(brigando, {}, NOW).map(e => e[0]);
    expect(ids1).toContain('atk_perseguicao');
    expect(ids1).not.toContain('res_correnteza');

    const calmo = player(tal, { lastCombatTime: NOW - fx.OUT_OF_COMBAT_MS - 1 });
    const ids2 = st.activeStatuses(calmo, {}, NOW).map(e => e[0]);
    expect(ids2).toContain('res_correnteza');
    expect(ids2).not.toContain('atk_perseguicao');
  });

  it('Último Recurso e Fuga acendem juntos abaixo de 30% de vida', () => {
    const tal = { damage_low_hp_pct: 40, speed_low_hp_pct: 30 };
    const ferido = player(tal, { hp: 25 });
    const ids = st.activeStatuses(ferido, {}, NOW).map(e => e[0]);
    expect(ids).toContain('atk_ultimorecurso');
    expect(ids).toContain('def_fuga');

    const inteiro = player(tal, { hp: 90 });
    expect(st.activeStatuses(inteiro, {}, NOW)).toHaveLength(0);
  });

  it('Lobo do Mar sozinho, Moral de Ferro em grupo', () => {
    const tal = { reduction_solo_pct: 20, reduction_per_ally_pct: 5 };

    const sozinho = st.activeStatuses(player(tal), { inParty: false }, NOW).map(e => e[0]);
    expect(sozinho).toContain('def_lobodomar');
    expect(sozinho).not.toContain('def_moral');

    const acompanhado = st.activeStatuses(player(tal), { inParty: true, allyCount: 2 }, NOW).map(e => e[0]);
    expect(acompanhado).toContain('def_moral');
    expect(acompanhado).not.toContain('def_lobodomar');
  });

  it('Âncora Viva parado, Alvo Difícil em movimento', () => {
    const tal = { reduction_still_pct: 20, dodge_moving_chance: 10 };
    const parado = st.activeStatuses(player(tal), { isStill: true, isMoving: false }, NOW).map(e => e[0]);
    expect(parado).toContain('def_ancoraviva');
    expect(parado).not.toContain('def_alvodificil');

    const andando = st.activeStatuses(player(tal), { isStill: false, isMoving: true }, NOW).map(e => e[0]);
    expect(andando).toContain('def_alvodificil');
    expect(andando).not.toContain('def_ancoraviva');
  });
});

// ── Por golpe ─────────────────────────────────────────────────────────────────

describe('por golpe', () => {
  it('nasce do proc do golpe e vive LINGER_MS', () => {
    const p = player({ damage_vs_boss_pct: 25 });
    // Nada acontece sem golpe: um talento "por golpe" não é um estado.
    expect(st.activeStatuses(p, {}, NOW)).toHaveLength(0);

    const procs = [];
    fx.outgoingDamageMult(p, { targetIsBoss: true }, procs);
    expect(procs).toContain('damage_vs_boss_pct');
    st.noteProcs(p, procs, NOW);

    const [entry] = st.activeStatuses(p, {}, NOW).filter(e => e[0] === 'atk_colosso');
    expect(entry[2]).toBe(st.LINGER_MS);

    expect(st.activeStatuses(p, {}, NOW + st.LINGER_MS)).toHaveLength(0);
  });

  it('o proc coletado é só o que a condição do golpe deixou passar', () => {
    const p = player({ damage_vs_boss_pct: 25, damage_vs_player_pct: 20, execute_pct: 30 });
    const procs = [];
    fx.outgoingDamageMult(p, { targetIsBoss: true, targetHpFrac: 0.9 }, procs);
    st.noteProcs(p, procs, NOW);

    const ids = st.activeStatuses(p, {}, NOW).map(e => e[0]);
    expect(ids).toContain('atk_colosso');
    expect(ids).not.toContain('atk_corsario');       // o alvo não era jogador
    expect(ids).not.toContain('atk_misericordia');   // o alvo estava com 90% de vida
  });

  it('noteHit serve aos efeitos discretos, que não passam por multiplicador', () => {
    const p = player({ pierce_chance: 30 });
    st.noteHit(p, 'pierce_chance', NOW);
    expect(st.activeStatuses(p, {}, NOW).map(e => e[0])).toContain('atk_balacorrente');
  });

  it('o proc renovado reinicia o relógio em vez de somar', () => {
    const p = player({ damage_vs_boss_pct: 25 });
    st.noteHit(p, 'damage_vs_boss_pct', NOW);
    st.noteHit(p, 'damage_vs_boss_pct', NOW + 1000);
    const [entry] = st.activeStatuses(p, {}, NOW + 1000).filter(e => e[0] === 'atk_colosso');
    expect(entry[2]).toBe(st.LINGER_MS);
  });

  it('stat que não vira status é ignorado pelo coletor', () => {
    const p = player({ damage_pct: 20 });
    st.noteProcs(p, ['damage_pct'], NOW);
    expect(st.activeStatuses(p, {}, NOW)).toHaveLength(0);
  });
});

// ── Empacotamento ─────────────────────────────────────────────────────────────

describe('lista enviada', () => {
  it('respeita o teto de ícones', () => {
    const tal = {};
    for (const stat of Object.keys(st.STATUS_STATS)) tal[stat] = 10;
    const p = player(tal, { hp: 10, lastCombatTime: NOW, _frenzyStacks: 1, _killstreakStacks: 1 });
    for (const stat of Object.keys(st.STATUS_STATS)) st.noteHit(p, stat, NOW);
    expect(st.activeStatuses(p, {}, NOW).length).toBeLessThanOrEqual(st.MAX_STATUS);
  });

  it('a ordem é estável entre duas apurações iguais', () => {
    const p = player({ damage_low_hp_pct: 40, speed_low_hp_pct: 30, reduction_solo_pct: 20 }, { hp: 20 });
    const a = st.activeStatuses(p, {}, NOW).map(e => e[0]);
    const b = st.activeStatuses(p, {}, NOW).map(e => e[0]);
    expect(a).toEqual(b);
  });

  it('nenhum talento aparece duas vezes', () => {
    const p = player({ speed_on_kill_pct: 20, frenzy_pct: 10 }, {
      _lastKillAt: NOW - 500, _frenzyStacks: 2,
    });
    st.noteHit(p, 'speed_on_kill_pct', NOW);   // mesmo stat por dois caminhos
    const ids = st.activeStatuses(p, {}, NOW).map(e => e[0]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── Assinatura (o que decide reenviar) ────────────────────────────────────────

describe('signature', () => {
  it('não muda enquanto só o relógio corre — é o cliente que conta', () => {
    const p = player({ speed_on_kill_pct: 20 }, { _lastKillAt: NOW });
    const a = st.signature(st.activeStatuses(p, {}, NOW), NOW);
    const b = st.signature(st.activeStatuses(p, {}, NOW + 900), NOW + 900);
    expect(b).toBe(a);
  });

  it('muda quando uma pilha sobe', () => {
    const p = player({ frenzy_pct: 10 }, { _frenzyStacks: 2 });
    const a = st.signature(st.activeStatuses(p, {}, NOW), NOW);
    p._frenzyStacks = 3;
    const b = st.signature(st.activeStatuses(p, {}, NOW), NOW);
    expect(b).not.toBe(a);
  });

  it('muda quando uma janela é renovada', () => {
    const p = player({ speed_on_kill_pct: 20 }, { _lastKillAt: NOW });
    const a = st.signature(st.activeStatuses(p, {}, NOW + 2000), NOW + 2000);
    p._lastKillAt = NOW + 2000;                       // abateu de novo
    const b = st.signature(st.activeStatuses(p, {}, NOW + 2000), NOW + 2000);
    expect(b).not.toBe(a);
  });
});
