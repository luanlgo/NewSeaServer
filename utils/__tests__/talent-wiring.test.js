import { describe, it, expect } from 'vitest';
import fx from '../talent-effects.js';
import tl from '../talent-logic.js';
import talents from '../../constants/talents.js';

const { TALENT_DEFS, TALENT_MAX } = talents;

// ─────────────────────────────────────────────────────────────────────────────
// Uma SONDA por talento ligado.
//
// Cada sonda mede a mesma grandeza duas vezes — com o talento zerado e com ele
// no nível máximo — e exige que o número tenha se mexido na direção que a
// descrição promete. É o teste que responde "este talento faz alguma coisa?"
// sem ninguém precisar entrar no jogo e conferir de um em um.
//
// O que ele pega:
//   · talento marcado `wired` cuja chave de stat ninguém lê (efeito morto);
//   · talento que mexe na direção errada (redução que aumenta o dano);
//   · talento novo entrando `wired` sem prova nenhuma — a sonda passa a faltar
//     e o teste de cobertura no fim do arquivo acusa.
//
// O que ele NÃO pega: a função existir, dar o número certo, e o jogo nunca a
// chamar. Essa metade é do talent-derived-single-source.test.js e dos testes de
// integração dos managers.
//
// O player é montado a partir de `talents: { id: nível }` e passa por
// applyTalentBonuses de verdade, então a agregação e a curva de retorno
// decrescente entram no caminho junto.
// ─────────────────────────────────────────────────────────────────────────────

const AGORA = 1_700_000_000_000;

const SHIP_DEFS = { fragata: { hp: 1000, maxCannons: 5 } };

function jogador(id, nivel, extra = {}) {
  const p = {
    hp: 100, maxHp: 100, mana: 0, maxMana: 10,
    activeShip: 'fragata', skills: {}, shipIslandUpgrades: {},
    ...extra,
    talents: nivel > 0 ? { [id]: nivel } : {},
  };
  tl.applyTalentBonuses(p, TALENT_DEFS);
  return p;
}

/** Contextos usados por várias sondas. */
const EM_COMBATE   = { lastCombatTime: AGORA };
const FORA_COMBATE = { lastCombatTime: AGORA - fx.OUT_OF_COMBAT_MS - 1 };
const FERIDO       = { hp: 20, maxHp: 100 };

// ── As sondas ────────────────────────────────────────────────────────────────
// sobe: o número tem de AUMENTAR do nível 0 para o nível máximo.
// desce: tem de DIMINUIR (reduções, recargas, custos).
const SONDAS = {
  // ══ ATAQUE ═════════════════════════════════════════════════════════════════
  atk_artilharia:    { sobe: p => fx.outgoingDamageMult(p, {}) },
  atk_focoarcano:    { sobe: p => fx.relicDamageMult(p) },
  atk_olhoaguia:     { sobe: p => fx.critChance(p, 0) },
  atk_perseguicao:   { extra: EM_COMBATE, sobe: p => fx.speedMult(p, { now: AGORA }) },
  atk_golpecerteiro: { sobe: p => fx.critMult(p, 1.5, 0.5) },
  atk_bateria:       { sobe: p => p.talentCannonBonus },
  atk_perfurante:    { sobe: p => fx.armorPen(p) },
  atk_cacafera:      { sobe: p => fx.outgoingDamageMult(p, { targetIsNPC: true }) },
  atk_arrancada:     { extra: { _moveStartedAt: AGORA }, sobe: p => fx.speedMult(p, { now: AGORA }) },
  atk_corsario:      { sobe: p => fx.outgoingDamageMult(p, { targetIsPlayer: true }) },
  atk_colosso:       { sobe: p => fx.outgoingDamageMult(p, { targetIsBoss: true }) },
  atk_polvoraseca:   { desce: p => fx.reloadMult(p) },
  atk_municao:       { sobe: p => fx.outgoingDamageMult(p, { isSpecialAmmo: true }) },
  atk_salva:         { sobe: p => fx.outgoingDamageMult(p, { isFullSalvo: true }) },
  atk_bracolongo:    { sobe: p => fx.relicRangeMult(p) },
  atk_incendiario:   { sobe: p => (fx.burnDot(p, 1000)?.dmg ?? 0) },
  atk_misericordia:  { sobe: p => fx.outgoingDamageMult(p, { targetHpFrac: 0.20 }) },
  atk_emboscada:     { sobe: p => fx.outgoingDamageMult(p, { isFirstHit: true }) },
  atk_vidente:       { sobe: p => fx.relicCritBonus(p) },
  atk_conjuracao:    { desce: p => fx.relicCastMult(p) },
  atk_frenesi:       { extra: { _frenzyStacks: fx.FRENZY_MAX_STACKS },
                       sobe: p => fx.outgoingDamageMult(p, {}) },
  atk_sanguefrio:    { sobe: p => fx.critMult(p, 1.5, 0.95) },
  atk_ultimorecurso: { sobe: p => fx.outgoingDamageMult(p, { attackerHpFrac: 0.20 }) },
  atk_miralonga:     { sobe: p => fx.cannonRangeMult(p) },
  atk_abordagem:     { sobe: p => fx.outgoingDamageMult(p, { dist: 50 }) },
  atk_bombardeio:    { sobe: p => fx.outgoingDamageMult(p, { targetHasCC: true }) },
  atk_deriva:        { sobe: p => fx.turnRateMult(p, true) },
  atk_tiroduplo:     { sobe: p => fx.doubleShotChance(p) },
  atk_cascata:       { sobe: p => { fx.noteCritRoll(p, true); return fx.critChance(p, 0); } },
  atk_balacorrente:  { sobe: p => fx.pierceChance(p) },
  atk_poderdefogo:   { sobe: p => fx.outgoingDamageMult(p, {}) },
  atk_sobrecarga:    { sobe: p => fx.relicDamageMult(p) },
  atk_carnificina:   { extra: { _killstreakStacks: fx.KILLSTREAK_MAX },
                       sobe: p => fx.outgoingDamageMult(p, {}) },
  atk_ventania:      { extra: { _lastKillAt: AGORA },  sobe: p => fx.speedMult(p, { now: AGORA }) },
  atk_impulsoarcano: { extra: { _lastRelicAt: AGORA }, sobe: p => fx.speedMult(p, { now: AGORA }) },
  // Fúria do Kraken é troca: mais dano E menos redução. As duas metades contam.
  atk_furiakraken:   { sobe:  p => fx.outgoingDamageMult(p, {}),
                       desce: p => fx.damageReduction(p, {}) },

  // ══ DEFESA ═════════════════════════════════════════════════════════════════
  def_cascoferro:    { sobe: p => maxHp(p) },
  def_armadura:      { sobe: p => fx.damageReduction(p, {}) },
  def_calafate:      { sobe: p => fx.hpRegenPerSec(p, AGORA) },
  def_leme:          { sobe: p => fx.turnRateMult(p, false) },
  def_reforcado:     { sobe: p => maxHp(p) },
  def_esquiva:       { sobe: p => fx.dodgeChance(p, false) },
  def_escudoguerra:  { sobe: p => fx.damageReduction(p, { fromNPC: true }) },
  def_couraca:       { sobe: p => fx.damageReduction(p, { fromPlayer: true }) },
  def_cascoliso:     { sobe: p => fx.dragReduction(p) },
  def_vontade:       { desce: p => fx.ccDurationMult(p) },
  def_reparo:        { extra: FORA_COMBATE, sobe: p => fx.hpRegenPerSec(p, AGORA) },
  def_bombeamento:   { extra: FERIDO,       sobe: p => fx.hpRegenPerSec(p, AGORA) },
  def_escorregadio:  { desce: p => fx.slowStrengthMult(p) },
  def_espinhos:      { sobe: p => fx.thornsDamage(p, 1000) },
  def_segundofolego: { extra: FERIDO, sobe: p => fx.secondWindHeal(p, AGORA) },
  def_ancoraviva:    { sobe: p => fx.damageReduction(p, { isStill: true }) },
  def_vigia:         { sobe: p => fx.damageReduction(p, { isCrit: true }) },
  def_fuga:          { extra: FERIDO, sobe: p => fx.speedMult(p, { now: AGORA }) },
  def_ancoragem:     { desce: p => fx.stopTimeMult(p) },
  def_madeiranobre:  { sobe: p => maxHp(p) },
  def_barreira:      { sobe: p => fx.relicShieldAmount(p) },
  def_moral:         { sobe: p => fx.damageReduction(p, { inParty: true, allyCount: 3 }) },
  def_lobodomar:     { sobe: p => fx.damageReduction(p, { inParty: false }) },
  def_recuperacao:   { sobe: p => fx.healingReceivedMult(p) },
  def_teimosia:      { sobe: p => fx.deathSaveChance(p) },
  def_alvodificil:   { sobe: p => fx.dodgeChance(p, true) },
  def_marchare:      { sobe: p => fx.reverseSpeedMult(p) },
  def_fortaleza:     { sobe: p => fx.damageReduction(p, {}) },
  def_absorcao:      { sobe: p => fx.damageToMana(p, 1000) },
  def_sanguessuga:   { sobe: p => fx.lifestealAmount(p, 1000) },
  def_carapaca:      { desce: p => fx.applyDamageReduction(p, 1000, {}) },
  def_sentinela:     { extra: { _sentinelStacks: fx.SENTINEL_MAX_STACKS },
                       sobe: p => fx.damageReduction(p, {}) },
  def_sombra:        { desce: p => fx.stealthRangeMult(p) },
  // Espírito do Vento promete velocidade E esquiva.
  def_espiritovento: { sobe: p => fx.speedMult(p, { now: AGORA }),
                       sobe2: p => fx.dodgeChance(p, false) },
  // Coração do Abismo promete vida E redução.
  def_coracaoabissal:{ sobe: p => maxHp(p),
                       sobe2: p => fx.damageReduction(p, {}) },

  // ══ RECURSO ════════════════════════════════════════════════════════════════
  res_pilhador:      { sobe: p => fx.lootMult(p, 'gold') },
  res_estudioso:     { sobe: p => fx.lootMult(p, 'xp') },
  res_ganancioso:    { sobe: p => fx.lootMult(p, 'dobrao') },
  res_velas:         { sobe: p => fx.speedMult(p, { now: AGORA }) },
  res_manaflow:      { sobe: p => fx.manaRegenMult(p, AGORA) },
  res_reservatorio:  { sobe: p => fx.maxManaBonus(p) },
  res_impulso:       { sobe: p => fx.accelMult(p) },
  res_correnteza:    { extra: FORA_COMBATE, sobe: p => fx.speedMult(p, { now: AGORA }) },
  res_economia:      { desce: p => fx.relicManaCostMult(p) },
  res_concentracao:  { extra: FORA_COMBATE, sobe: p => fx.manaRegenMult(p, AGORA) },
  res_sabedoria:     { sobe: p => fx.lootMult(p, 'xp_boss') },
  res_cofreduplo:    { sobe: p => fx.dobraoDoubleChance(p) },
  res_veiadeouro:    { sobe: p => fx.goldDoubleChance(p) },
  res_colheita:      { sobe: p => fx.manaOnKill(p) },
  res_esquadra:      { sobe: p => fx.partySpeedAura(p) },
  res_tesouroabissal:{ sobe: p => fx.lootMult(p, 'gold') },
};

/** Vida máxima passando pela mesma função que o servidor usa. */
function maxHp(p) {
  tl.recalcMaxHp(p, SHIP_DEFS, TALENT_DEFS);
  return p.maxHp;
}

// ── Execução ─────────────────────────────────────────────────────────────────

const LIGADOS = Object.values(TALENT_DEFS).filter(d => d.wired);

describe('todo talento ligado realmente muda alguma coisa', () => {
  for (const def of LIGADOS) {
    const sonda = SONDAS[def.id];

    it(`${def.id} — ${def.name}`, () => {
      expect(sonda, `${def.id} está marcado wired mas não tem sonda`).toBeDefined();

      for (const chave of ['sobe', 'sobe2', 'desce', 'desce2']) {
        const medir = sonda[chave];
        if (!medir) continue;

        const zero = medir(jogador(def.id, 0,          sonda.extra));
        const cheio = medir(jogador(def.id, TALENT_MAX, sonda.extra));

        expect(Number.isFinite(zero),  `${def.id}: medida com 0 não é número`).toBe(true);
        expect(Number.isFinite(cheio), `${def.id}: medida no máximo não é número`).toBe(true);

        if (chave.startsWith('sobe')) {
          expect(cheio, `${def.id} (${def.stat}) não aumentou: ${zero} → ${cheio}`).toBeGreaterThan(zero);
        } else {
          expect(cheio, `${def.id} (${def.stat}) não diminuiu: ${zero} → ${cheio}`).toBeLessThan(zero);
        }
      }
    });
  }
});

// ── Cobertura ────────────────────────────────────────────────────────────────

describe('cobertura das sondas', () => {
  it('todo talento ligado tem sonda', () => {
    const semSonda = LIGADOS.filter(d => !SONDAS[d.id]).map(d => `${d.id} (${d.stat})`);
    expect(semSonda, 'talentos wired sem prova de que funcionam').toEqual([]);
  });

  it('nenhuma sonda aponta para talento inexistente ou desligado', () => {
    const orfas = Object.keys(SONDAS).filter(id => !TALENT_DEFS[id]?.wired);
    expect(orfas, 'sonda para talento que não existe ou não está wired').toEqual([]);
  });

  it('o número de ligados bate com o que o painel promete', () => {
    // Se este número mudar sem querer, alguém ligou ou desligou um talento sem
    // reparar — e o painel passa a mentir na etiqueta "efeito não aplicado".
    expect(LIGADOS.length).toBe(87);
    expect(Object.values(TALENT_DEFS).filter(d => !d.wired).length).toBe(33);
  });
});

// ── Os desligados ────────────────────────────────────────────────────────────

describe('talentos ainda não ligados', () => {
  it('nenhum deles move um multiplicador por acidente', () => {
    // Um talento sem `wired` que já mexesse em algo estaria mentindo para o
    // outro lado: o painel diz "não aplicado" e o efeito existe.
    const DESLIGADOS = Object.values(TALENT_DEFS).filter(d => !d.wired);
    for (const def of DESLIGADOS) {
      expect(SONDAS[def.id], `${def.id} não é wired mas tem sonda`).toBeUndefined();
    }
  });
});
