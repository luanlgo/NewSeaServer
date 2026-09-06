// utils/allies.js
//
// Quem está do MEU lado: companheiro de grupo ou de guilda.
//
// Existe como módulo pelo mesmo motivo que utils/invincibility.js e
// utils/shield.js existem: a resposta precisa ser IDÊNTICA nos dois portões por
// onde passa todo dano de jogador para jogador, e guarda duplicada é guarda que
// diverge. Os dois portões são:
//
//   • projectile-manager.hit()  — canhão (e, por tabela, os DoTs que ele planta)
//   • relicCanHitPlayer()       — relíquia, aura, arpão e o `_targetsIn` do motor
//                                 do bestiário, ou seja as 34 relíquias de bicho
//
// Nada mais precisa consultar isto: todo o resto do dano ao jogador ou vem de
// NPC/torre (não tem lado), ou já passa por um desses dois.
//
// ── Por que a MIRA também some, e não só o dano ─────────────────────────────
// O `relicCanHitPlayer` é o mesmo portão que ESCOLHE alvo (ver o arpão, que
// varre a linha e fica com o primeiro que ele aprova). Então recusar o aliado
// aqui não é só "bate por zero": ele deixa de ser candidato. O arpão atravessa
// o companheiro e fisga quem está atrás, e as áreas param de contá-lo.
//
// ── O que NÃO entra ────────────────────────────────────────────────────────
// A bala de cura. Ela é o caso em que mirar no aliado é exatamente a intenção,
// e quem trata disso é o ramo próprio dela no projectile-manager — este módulo
// só responde "são do mesmo lado?", quem decide o que fazer com a resposta é o
// chamador.

'use strict';

/**
 * `a` e `b` são do mesmo lado?
 *
 * Os dois managers entram por parâmetro em vez de virarem estado do módulo: o
 * projectile-manager já os carrega como campo (`this.partyManager`,
 * `this.guildManager`) e o server.js os tem no escopo, então não há nada a
 * ganhar escondendo a dependência — e um módulo com estado global quebraria os
 * testes, que montam managers de mentira por chamada.
 *
 * Ausência de manager é tratada como "sem lado", nunca como erro: em teste é
 * comum passar só um dos dois.
 *
 * @param {Object} a jogador
 * @param {Object} b jogador
 * @param {{areAllies?: Function}}     [partyManager]
 * @param {{areGuildMates?: Function}} [guildManager]
 * @returns {boolean}
 */
function isAlly(a, b, partyManager, guildManager) {
  if (!a || !b) return false;
  // Ninguém é aliado de si mesmo. Não é filosofia: os dois chamadores usam esta
  // resposta para PULAR o alvo, e devolver `true` aqui faria o lançador sumir
  // das próprias áreas — que é uma regra diferente (e que cada relíquia já
  // resolve por conta, via `target.id === caster.id`).
  if (a.id === b.id) return false;

  if (partyManager && partyManager.areAllies
      && partyManager.areAllies(a.id, b.id)) return true;

  // Guilda casa por NOME (é assim que o guild-manager indexa: `byPlayer` é
  // playerName → guildId), enquanto grupo casa por id. Os dois helpers já
  // existiam e são os mesmos que o chat e a cor do minimapa usam — reaproveitar
  // é o que garante que "aliado" queira dizer a mesma coisa na tela e no dano.
  if (guildManager && guildManager.areGuildMates
      && guildManager.areGuildMates(a.name, b.name)) return true;

  return false;
}

module.exports = { isAlly };
