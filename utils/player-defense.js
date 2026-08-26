// utils/player-defense.js — as defesas do JOGADOR, numa conta só
//
// ── Por que um módulo ────────────────────────────────────────────────────────
// Tudo que machuca um jogador tem de passar pelas mesmas defesas: a redução de
// talento, a do casco da ilha, a redução plana da Carapaça de Kraken, a esquiva,
// a invencibilidade, o Escudo de Ouro, a Carapaça Eriçada e a relíquia
// defensiva do pet. Cada caminho de dano vive num manager diferente, e enquanto
// a conta ficou escrita à mão em cada um aconteceu o previsível: a torre da
// ilha tirava um número FIXO da vida do jogador. Trinta mil de dano, sempre,
// contra qualquer barco — o tanque com meio kit defensivo comprado tomava
// exatamente o mesmo que o novato.
//
// É a mesma história do utils/gold-shield.js, uma camada acima: lá era UMA
// relíquia lida por três managers com números diferentes; aqui é a pilha
// inteira. Um caminho de dano novo agora só precisa chamar `mitigateForPlayer`.
//
// ── Quem usa ─────────────────────────────────────────────────────────────────
//   managers/island-manager.js   a salva da torre da ilha
//
// O tiro (projectile-manager) e o ataque em área do bicho (attack-manager)
// ainda trazem a pilha escrita à mão, na mesma ordem que está aqui. Migrá-los é
// desejável e NÃO é neutro: o caminho do ataque em área não aplica hoje a
// redução de talento nem a plana, e ligá-las de uma vez mexe no balanço de
// todos os bichos do jogo. Fica para uma leva de balanceamento própria.
//
// ── A ordem importa ──────────────────────────────────────────────────────────
// Ela é a do projectile-manager, que é o caminho mais completo do jogo:
//
//   1. ESQUIVA          desviar é não ser atingido, não levar menos — vem antes
//                       de qualquer mitigação
//   2. INVENCIBILIDADE  Névoa Espectral: nada entra
//   3. MITIGAÇÃO        habilidade + talento + casco da ilha + redução plana
//   4. ESCUDO DE OURO   apara uma fração e cobra sobre o dano BRUTO
//   5. CARAPAÇA ERIÇADA mitiga e devolve parte do que mitigou
//   6. PET              a relíquia defensiva intercepta o que sobrou
'use strict';

const { calcProjectileDamage } = require('./combat-calc');
const fx       = require('./talent-effects');
const status   = require('./talent-status');
const { applyGoldShield } = require('./gold-shield');
const { isInvincible }    = require('./invincibility');

/**
 * Passa um golpe pelas defesas de um jogador.
 *
 * Não aplica nada: não mexe no `hp`, não manda mensagem nenhuma. Devolve o que
 * aconteceu para quem chamou aplicar e avisar o cliente — cada manager tem o
 * próprio jeito de mandar (`addEvent` por mapa, `sendTo` no alvo), e é por isso
 * que o efeito colateral fica de fora. A ÚNICA exceção é o ouro do Escudo de
 * Ouro, que já sai debitado pelo utils/gold-shield.js (`goldCost` no resultado
 * é só o aviso de que saiu).
 *
 * @param {Object} target  o jogador que está levando o golpe
 * @param {number} raw     dano bruto, antes de qualquer defesa
 * @param {Object} [ctx]
 * @param {boolean} [ctx.fromNPC=true]    golpe de bicho/torre/ambiente
 * @param {boolean} [ctx.fromPlayer=false] golpe de outro jogador
 * @param {boolean} [ctx.isCrit=false]
 * @param {boolean} [ctx.isAoe=false]
 * @param {number}  [ctx.pen=0]           penetração de armadura do atacante
 * @param {number}  [ctx.allyCount=0]     companheiros de grupo na zona
 * @param {Object}  [ctx.petManager=null] para a interceptação do pet
 * @param {number}  [ctx.now=Date.now()]
 * @returns {{damage:number, dodged:boolean, blocked:boolean,
 *            goldCost:number, reflected:number}}
 */
function mitigateForPlayer(target, raw, ctx = {}) {
  const now  = ctx.now || Date.now();
  const zero = { damage: 0, dodged: false, blocked: false, goldCost: 0, reflected: 0 };
  if (!target || !(raw > 0)) return { ...zero, damage: Math.max(0, Math.round(raw || 0)) };

  // 1. Esquiva — evento discreto: só vira ícone de status quando salvou.
  const dodge = fx.dodgeChance(target, !!target.speed);
  if (dodge > 0 && Math.random() < dodge) {
    status.noteHit(target, 'dodge_chance', now);
    return { ...zero, dodged: true };
  }

  // 2. Invencibilidade (r2 e a Névoa do bestiário).
  if (isInvincible(target, now)) return { ...zero, blocked: true };

  // 3. Mitigação. `procDef` coleciona os talentos que realmente contribuíram
  //    neste golpe — é o que acende o ícone na barra de status do jogador.
  const procDef = [];
  const skillDef = target.skillDefense ? (1 - target.skillDefense) : 1.0;
  const talentDef = 1 - fx.damageReduction(target, {
    fromNPC:    ctx.fromNPC !== false,
    fromPlayer: !!ctx.fromPlayer,
    isCrit:     !!ctx.isCrit,
    isAoe:      !!ctx.isAoe,
    isStill:    !target.speed,
    inParty:    (ctx.allyCount || 0) > 0,
    allyCount:  ctx.allyCount || 0,
    pen:        ctx.pen || 0,
  }, procDef);
  const islandDef = target.shipIslandUpgrades?.defense
    ? (1 - Math.min(target.shipIslandUpgrades.defense * 0.05, 0.80))
    : 1.0;

  let dmg = calcProjectileDamage({
    baseDmg: raw,
    skillDef, talentDef, islandDef,
    talentFlatDef: fx.flatReduction(target),
  });
  status.noteProcs(target, procDef, now);

  // 4. Escudo de Ouro — a conta (e o débito) moram no gold-shield.js.
  const esc = applyGoldShield(target, dmg);
  dmg = esc.damage;

  // 5. Carapaça Eriçada: mitiga e devolve parte do que mitigou. Quem aplica o
  //    reflexo é o chamador — só ele sabe quem deu o golpe.
  let reflected = 0;
  if (target.relicBulwarkExpires && now < target.relicBulwarkExpires) {
    const mitigado = Math.round(dmg * (target.relicBulwarkReduction || 0.4));
    dmg = Math.max(0, dmg - mitigado);
    reflected = Math.round(mitigado * (target.relicBulwarkReflect || 0.3));
  }

  // 6. Pet: a relíquia defensiva intercepta o que sobrou.
  if (ctx.petManager) {
    dmg = ctx.petManager.interceptOwnerDamage(target, dmg);
    if (!(dmg > 0)) {
      return { damage: 0, dodged: false, blocked: true,
               goldCost: esc.goldCost, reflected };
    }
  }

  return { damage: Math.max(0, Math.round(dmg)), dodged: false, blocked: false,
           goldCost: esc.goldCost, reflected };
}

module.exports = { mitigateForPlayer };
