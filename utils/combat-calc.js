// utils/combat-calc.js
// Fórmulas puras de combate — sem I/O, sem WebSocket, sem DB.
// Importada por projectile-manager.js e pelos testes.

'use strict';

/**
 * Calcula o dano final de um projétil em um alvo.
 *
 * Multiplicadores (todos 1.0 = sem efeito):
 *   baseDmg      — dano base: ammo.damage + cannon.damage
 *   critMult     — 1.5 em crits, 1.0 normal
 *   damageMult   — multiplicador do projétil (depende do navio/cannon)
 *   skillDmg     — bônus de habilidade do atirador  (>1.0)
 *   skillDef     — redução de habilidade do alvo     (<1.0)
 *   talentDmg    — 1 + talentDamageBonus do atirador
 *   talentDef    — 1 - talentDefenseBonus do alvo
 *   islandDef    — 1 - defenseBonus do upgrade de ilha do alvo
 *   islandDmg    — 1 + damageMult do upgrade de ilha do atirador
 *
 * @returns {number} dano final, mínimo 1
 */
function calcProjectileDamage({
  baseDmg,
  critMult   = 1.0,
  damageMult = 1.0,
  skillDmg   = 1.0,
  skillDef   = 1.0,
  talentDmg  = 1.0,
  talentDef  = 1.0,
  islandDef  = 1.0,
  islandDmg  = 1.0,
}) {
  return Math.max(1, Math.round(baseDmg * critMult * damageMult * skillDmg * skillDef * talentDmg * talentDef * islandDef * islandDmg));
}

/**
 * Calcula o ouro final ganho por um kill de NPC.
 *
 * @param {object} params
 * @param {number} params.baseGold       — ouro base sorteado do NPC
 * @param {number} [params.dropBonus]    — bônus de drop do navio (0 = sem bônus)
 * @param {number} [params.killTier]     — floor(npcKills / 10)
 * @param {number} [params.goldPerTier]  — % por tier (padrão 0.01 = +1%/tier)
 * @param {number} [params.talentGoldBonus] — de applyTalentBonuses
 * @returns {number}
 */
function calcKillGold({ baseGold, dropBonus = 0, killTier = 0, goldPerTier = 0.01, talentGoldBonus = 0 }) {
  const cappedTier = Math.min(killTier, 500);
  return Math.floor(
    baseGold
    * (1 + dropBonus)
    * (1 + cappedTier * goldPerTier)
    * (1 + talentGoldBonus)
  );
}

/**
 * Calcula o XP ganho por um kill de NPC.
 *
 * @param {object} params
 * @param {number} params.xpPerKill      — XP base do mapa (MAP_DEFS[n].npc.xpPerKill)
 * @param {number} [params.killTier]     — floor(npcKills / 10)
 * @param {number} [params.talentXpBonus] — de applyTalentBonuses
 * @returns {number}
 */
function calcKillXp({ xpPerKill, killTier = 0, talentXpBonus = 0 }) {
  const cappedTier = Math.min(killTier, 500);
  return Math.floor(xpPerKill * (1 + cappedTier * 0.01) * (1 + talentXpBonus));
}

/**
 * Calcula o número máximo de canhões ao equipar um navio.
 *
 * @param {object} ship                  — definição do navio (SHIP_DEFS[id])
 * @param {number} [talentCannonBonus]   — de applyTalentBonuses (talentCannonBonus)
 * @param {number} [fallback]            — MAX_CANNON_SLOTS (padrão 20)
 * @returns {number}
 */
function calcMaxCannons(ship, talentCannonBonus = 0, fallback = 20) {
  return (ship.maxCannons || ship.cannon || fallback) + talentCannonBonus;
}

/**
 * Remove canhões excedentes ao trocar de navio.
 * Não modifica o array original — retorna um novo array.
 *
 * @param {string[]} cannons   — canhões atualmente equipados
 * @param {number}   maxCannons — novo limite
 * @returns {{ cannons: string[], removed: number }}
 */
function trimCannons(cannons, maxCannons) {
  if (cannons.length <= maxCannons) return { cannons: [...cannons], removed: 0 };
  return {
    cannons: cannons.slice(0, maxCannons),
    removed: cannons.length - maxCannons,
  };
}

module.exports = { calcProjectileDamage, calcKillGold, calcKillXp, calcMaxCannons, trimCannons };
