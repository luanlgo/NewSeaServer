import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import talents from '../../constants/talents.js';

const { TALENT_DEFS } = talents;

// ─────────────────────────────────────────────────────────────────────────────
// A OUTRA metade do talent-wiring.test.js.
//
// Aquele prova que o stat vira multiplicador. Este prova que alguém no JOGO
// consome esse multiplicador — o caso em que a função existe, devolve o número
// certo, e nenhuma linha de código a chama. O talento fica lindo no painel e
// não faz absolutamente nada.
//
// Um stat pode ser consumido de duas formas, e as duas contam:
//   1. pela função de talent-effects que o lê (`fx.speedMult(...)`);
//   2. lendo a chave crua (`killer.tal?.xp_boss_pct`), que é como o
//      projectile-manager aplica alguns bônus de espólio.
//
// A primeira versão desta varredura só olhava (1) e acusou dois talentos que na
// verdade funcionam — daí a regra dupla.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = path.resolve(import.meta.dirname, '..', '..');

// Código do JOGO. Os utils puros ficam de fora de propósito: uma função de
// talento chamando outra função de talento não prova que o jogo usa nenhuma
// das duas.
const ARQUIVOS = [
  'server.js',
  ...fs.readdirSync(path.join(BASE, 'managers')).map(f => path.join('managers', f)),
];
const CODIGO = ARQUIVOS.map(f => fs.readFileSync(path.join(BASE, f), 'utf8')).join('\n');

/**
 * Quem lê cada stat dentro de utils/talent-effects.js. É um índice de leitura —
 * se um stat passar a ser lido por outra função, é aqui que se atualiza.
 */
const LEITOR = {
  // dano causado
  damage_pct: 'outgoingDamageMult', damage_final_pct: 'outgoingDamageMult',
  kraken_fury_pct: 'outgoingDamageMult', damage_vs_npc_pct: 'outgoingDamageMult',
  damage_vs_player_pct: 'outgoingDamageMult', damage_vs_boss_pct: 'outgoingDamageMult',
  damage_vs_cc_pct: 'outgoingDamageMult', execute_pct: 'outgoingDamageMult',
  opener_pct: 'outgoingDamageMult', damage_close_pct: 'outgoingDamageMult',
  salvo_damage_pct: 'outgoingDamageMult', ammo_damage_pct: 'outgoingDamageMult',
  damage_low_hp_pct: 'outgoingDamageMult', frenzy_pct: 'outgoingDamageMult',
  killstreak_pct: 'outgoingDamageMult', aoe_damage_pct: 'outgoingDamageMult',
  ram_damage_pct: 'outgoingDamageMult',
  crit_chance: 'critChance', crit_chain_pct: 'noteCritRoll',
  crit_damage_pct: 'critMult', crit_damage_high_hp: 'critMult',
  armor_pen_pct: 'armorPen', pierce_chance: 'pierceChance',
  double_shot_chance: 'doubleShotChance', burn_pct: 'burnDot',
  // dano recebido
  damage_reduction_pct: 'damageReduction', damage_reduction_pct_2: 'damageReduction',
  reduction_vs_npc_pct: 'damageReduction', reduction_vs_player_pct: 'damageReduction',
  reduction_still_pct: 'damageReduction', reduction_solo_pct: 'damageReduction',
  reduction_per_ally_pct: 'damageReduction', reduction_after_hit_pct: 'damageReduction',
  crit_taken_reduction: 'damageReduction', abyssal_heart_pct: 'damageReduction',
  reduction_aoe_pct: 'damageReduction', reduction_relic_pct: 'damageReduction',
  dot_reduction_pct: 'damageReduction',
  flat_reduction_pct: 'flatReduction',
  dodge_chance: 'dodgeChance', dodge_moving_chance: 'dodgeChance', wind_spirit_pct: 'dodgeChance',
  thorns_pct: 'thornsDamage', lifesteal_pct: 'lifestealAmount',
  mana_on_hit_flat: 'manaOnHit', death_save_chance: 'deathSaveChance',
  second_wind_pct: 'secondWindHeal',
  // vida e mana
  max_hp_flat: 'recalcMaxHp', max_hp_flat_2: 'recalcMaxHp', max_hp_pct: 'recalcMaxHp',
  healing_received_pct: 'healingReceivedMult', hp_regen_flat: 'hpRegenPerSec',
  hp_regen_low_pct: 'hpRegenPerSec', repair_out_combat_pct: 'hpRegenPerSec',
  max_mana_flat: 'maxManaBonus', mana_regen_pct: 'manaRegenMult',
  mana_out_combat_pct: 'manaRegenMult', mana_on_kill: 'manaOnKill',
  // relíquias e canhão
  relic_damage_pct: 'relicDamageMult', relic_overload_pct: 'relicDamageMult',
  relic_crit_chance: 'relicCritBonus', relic_mana_cost_pct: 'relicManaCostMult',
  relic_cooldown_pct: 'relicCooldownMult', relic_cast_pct: 'relicCastMult',
  relic_range_pct: 'relicRangeMult', shield_on_relic_pct: 'relicShieldAmount',
  reload_pct: 'reloadMult',
  cannon_slots: 'calcMaxCannons',
  // movimento
  speed_pct: 'speedMult', speed_in_combat_pct: 'speedMult', speed_out_combat_pct: 'speedMult',
  speed_low_hp_pct: 'speedMult', burst_speed_pct: 'speedMult',
  speed_on_kill_pct: 'speedMult', speed_on_relic_pct: 'speedMult',
  weather_speed_pct: 'weatherResist',
  party_speed_pct: 'partySpeedAura', turn_speed_pct: 'turnRateMult',
  turn_while_fast_pct: 'turnRateMult', drag_reduction_pct: 'dragReduction',
  accel_pct: 'accelMult', stop_time_pct: 'stopTimeMult',
  reverse_speed_pct: 'reverseSpeedMult',
  // CC e percepção
  cc_resist_pct: 'ccDurationMult', slow_resist_pct: 'slowStrengthMult',
  slow_on_hit_pct: 'slowOnHit',
  slow_pursuers_pct: 'wakeSlow', stealth_range_pct: 'stealthRangeMult',
  fog_vision_pct: 'visionMult', night_vision_pct: 'visionMult',
  // economia
  gold_drop_pct: 'lootMult', dobrao_drop_pct: 'lootMult', xp_drop_pct: 'lootMult',
  xp_boss_pct: 'lootMult', rare_drop_pct: 'lootMult', relic_drop_pct: 'lootMult',
  wreck_loot_pct: 'spoilLootPct', fishing_yield_pct: 'lootMult',
  mission_reward_pct: 'lootMult', bounty_pct: 'lootMult',
  pet_food_pct: 'lootMult', party_loot_pct: 'lootMult',
  abyssal_treasure_pct: 'lootMult',
  shop_discount_pct: 'shopPriceMult',
  gold_double_chance: 'goldDoubleChance', dobrao_double_chance: 'dobraoDoubleChance',
  death_penalty_pct: 'deathPenaltyMult', inventory_slots: 'inventorySlotBonus',
  respawn_time_pct: 'respawnTimeMult', respawn_immunity_ms: 'respawnImmunityBonus',
  arch_cooldown_pct: 'archCooldownMult', dash_cooldown_pct: 'dashCooldownMult',
  // piratas e espólio
  pirate_capacity_flat: 'pirateCapacityBonus', pirate_capacity_pct: 'pirateCapacityBonus',
  pirate_power_pct: 'pirateBattlePowerPct', pirate_command_pct: 'pirateBattlePowerPct',
  pirate_defense_pct: 'pirateDefensePct', pirate_casualty_pct: 'pirateCasualtyReductionPct',
  run_upkeep_pct: 'runUpkeepMult', pirate_price_pct: 'piratePriceMult',
};

/**
 * Campos "legados" de applyTalentBonuses: alguns bônus chegam ao jogo por um
 * campo pronto no player em vez da função. Também conta como consumo.
 */
const CAMPO_LEGADO = {
  damage_pct: 'talentDamageBonus',
  damage_reduction_pct: 'talentDefenseBonus',
  cannon_slots: 'talentCannonBonus',
  relic_damage_pct: 'talentRelicBonus',
  gold_drop_pct: 'talentGoldBonus',
  dobrao_drop_pct: 'talentDobraoBonus',
  xp_drop_pct: 'talentXpBonus',
  relic_crit_chance: 'talentRelicCritBonus',
  mana_regen_pct: 'talentManaRegenBonus',
};

/** O jogo consome este stat de alguma das três formas? */
function consumidoPeloJogo(stat) {
  const fn = LEITOR[stat];
  if (fn && new RegExp('[._]' + fn + '\\s*\\(').test(CODIGO)) return true;
  // Leitura crua: `killer.tal?.xp_boss_pct`, `p.tal.speed_pct`…
  if (new RegExp('tal\\??\\.' + stat + '\\b').test(CODIGO)) return true;
  const legado = CAMPO_LEGADO[stat];
  if (legado && new RegExp('\\.' + legado + '\\b').test(CODIGO)) return true;
  return false;
}

const LIGADOS = Object.values(TALENT_DEFS).filter(d => d.wired);

describe('todo talento ligado é consumido em algum lugar do jogo', () => {
  for (const def of LIGADOS) {
    it(`${def.id} — ${def.name}`, () => {
      expect(LEITOR[def.stat], `${def.id}: stat "${def.stat}" fora do índice de leitura`).toBeDefined();
      expect(
        consumidoPeloJogo(def.stat),
        `${def.id} está wired mas nada em server.js/managers lê "${def.stat}" `
        + `(nem fx.${LEITOR[def.stat]}(), nem .tal.${def.stat}, nem campo legado)`,
      ).toBe(true);
    });
  }
});

describe('índice de leitura', () => {
  it('cobre todos os 120 stats, ligados ou não', () => {
    const fora = Object.values(TALENT_DEFS).filter(d => !LEITOR[d.stat]).map(d => `${d.id} (${d.stat})`);
    expect(fora, 'stat sem entrada no índice').toEqual([]);
  });

  it('não aponta para stat que nenhum talento usa', () => {
    const reais = new Set(Object.values(TALENT_DEFS).map(d => d.stat));
    const orfaos = Object.keys(LEITOR).filter(s => !reais.has(s));
    expect(orfaos, 'entrada no índice para stat inexistente').toEqual([]);
  });
});
