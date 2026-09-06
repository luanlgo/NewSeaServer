// utils/shield.js — escudo que ABSORVE dano, separado da vida.
//
// ── Por que isto virou um módulo ────────────────────────────────────────────
// A Barreira Arcana (def_barreira) prometia um escudo desde que a árvore de
// talentos existe, e o server.js a implementava assim:
//
//     player.hp = Math.min(player.maxHp, player.hp + barreira);
//
// Isso é CURA. Com a vida cheia não fazia nada, não aparecia nada na tela e não
// aguentava golpe nenhum — o playtest de 09/2026 resumiu em quatro palavras:
// "nem percebi esse escudo". Agora existe uma poça de pontos que fica NA FRENTE
// da vida e vence sozinha.
//
// O módulo existe pela mesma razão do utils/invincibility.js: o dano ao jogador
// chega por TREZE caminhos diferentes (tiro, ataque de NPC, torre de ilha, as
// 34 skills do bestiário, relíquia de outro jogador, dano contínuo…), cada um
// num manager. Com a conta copiada em cada um, o próximo caminho de dano nasce
// sem escudo — foi exatamente o que aconteceu com a bolha de invencibilidade
// quando o motor do bestiário entrou.
//
// ── Contrato ───────────────────────────────────────────────────────────────
// `entity.shield = { hp, expires }`. Quem dá é `grant()`, quem gasta é
// `absorb()`, e ninguém mais mexe nesses campos. O `absorb` devolve o dano que
// SOBROU para a vida — o chamador continua fazendo a subtração dele.
'use strict';

// ── Aviso ao dono ──────────────────────────────────────────────────────────
// O escudo precisa APARECER (foi essa a queixa), e quem sabe desenhar é o
// cliente. Em vez de fazer os treze pontos de dano mandarem mensagem cada um, o
// módulo recebe UM notificador no boot (server.js) e avisa sozinho de dentro do
// `grant`/`absorb`. Sem notificador ele continua funcionando em silêncio — é o
// que os testes usam.
let _notify = null;

/** server.js chama isto uma vez, no boot. */
function setNotifier(fn) { _notify = typeof fn === 'function' ? fn : null; }

function _say(e, msg) { if (_notify) { try { _notify(e, msg); } catch (_) { /* nunca derruba o dano */ } } }

/** Pontos de escudo de pé agora (0 se venceu ou não existe). */
function shieldHp(e, now = Date.now()) {
  const s = e && e.shield;
  if (!s || !s.hp || s.hp <= 0) return 0;
  if (s.expires && now >= s.expires) return 0;
  return s.hp;
}

/**
 * Ergue (ou reforça) o escudo.
 *
 * Escudos NÃO se somam: o novo vale se for maior que o de pé, e nos dois casos
 * o prazo é renovado. Somar deixaria o jogador empilhar Barreira Arcana com
 * relíquia barata em sequência até virar uma segunda barra de vida.
 *
 * @returns {number} os pontos de escudo que ficaram de pé
 */
function grant(e, amount, durMs, now = Date.now()) {
  if (!e || !(amount > 0)) return shieldHp(e, now);
  const atual = shieldHp(e, now);
  const hp    = Math.max(atual, Math.round(amount));
  e.shield = { hp, expires: now + durMs, max: hp };
  _say(e, { type: 'shield_up', hp, max: hp, durationMs: durMs });
  return hp;
}

/**
 * Gasta escudo contra um golpe.
 *
 * @returns {{dmg:number, absorbed:number, broke:boolean}} `dmg` é o que sobrou
 *          para a vida; `broke` diz se o escudo acabou NESTE golpe (é o que o
 *          cliente usa para estourar a bolha em vez de só encolhê-la).
 */
function absorb(e, dmg, now = Date.now()) {
  const s = shieldHp(e, now);
  if (s <= 0 || !(dmg > 0)) return { dmg, absorbed: 0, broke: false };
  const absorbed = Math.min(s, dmg);
  const resto    = s - absorbed;
  const max = e.shield.max || s;
  if (resto > 0) {
    e.shield.hp = resto;
    _say(e, { type: 'shield_hit', hp: resto, max, absorbed });
  } else {
    e.shield = null;
    _say(e, { type: 'shield_down', absorbed });
  }
  return { dmg: dmg - absorbed, absorbed, broke: resto <= 0 };
}

/** Derruba o escudo (morte, renascimento, troca de mapa). */
function clear(e) {
  if (e && e.shield) { e.shield = null; _say(e, { type: 'shield_down', absorbed: 0 }); }
}

module.exports = { shieldHp, grant, absorb, clear, setNotifier };
