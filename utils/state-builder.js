// utils/state-builder.js — Monta a mensagem `state` de cada jogador.
//
// Substitui o broadcast antigo, que serializava a lista COMPLETA de entidades do
// mapa uma vez por jogador (O(P²) de JSON.stringify + um deflate por cliente).
//
// Três otimizações, nesta ordem de impacto:
//
//   1. AOI  — o jogador só recebe quem está dentro do raio de visão (utils/aoi.js).
//   2. full/slim — a entidade vai completa só na PRIMEIRA vez que entra na visão
//      daquele jogador; depois vira uma tupla [id,x,z,rot,hp,speed,flags].
//   3. dirty — entidade que não mudou nada desde o último broadcast não é
//      reenviada. Num porto cheio de gente parada isso corta a maior parte.
//
// O corte do (3) é seguro mesmo com AOI: quem acabou de entrar na visão recebe o
// registro `full`, que já carrega os valores atuais. Quem já conhecia a entidade
// tem o último valor porque ele só deixa de ser mandado quando NÃO mudou.
'use strict';

const { SpatialGrid } = require('./aoi');

// Raio de interesse. Folgado de propósito: o cliente esconde tudo além de
// ~220u dentro da névoa, então em 450u a entidade entra na lista muito antes de
// ficar visível — nada aparece do nada na tela.
const AOI_RADIUS = parseInt(process.env.AOI_RADIUS) || 450;
const AOI_CELL   = parseInt(process.env.AOI_CELL)   || 256;

// Flags do slim (bitfield) — mantém a tupla curta em vez de dois booleanos.
const F_DEAD = 1;
const F_CAST = 2;

// Baseline do que cada entidade tinha no último broadcast, para o dirty-check.
// Chave: id da entidade. Valor: a própria tupla slim enviada.
const _baseline = new Map();

const r2 = v => Math.round((v || 0) * 100) / 100;  // registro completo: 1 cm
const c  = v => Math.round((v || 0) * 100);        // slim: centi-unidades INTEIRAS

/**
 * Tupla compacta enviada a quem já conhece a entidade.
 *
 * Posição, rotação e velocidade vão em centi-unidades inteiras. Não é
 * microtimização gratuita: o inteiro é 7,5% MENOR que o float com uma casa
 * (não gasta o caractere do ponto) e ainda assim carrega 10x mais resolução.
 *
 * A resolução importa porque o cliente faz dead reckoning — ele deriva a
 * velocidade da diferença entre dois pacotes, então o degrau do arredondamento
 * vira ruído de VELOCIDADE, amplificado por 1/dt. Com 0,1 de resolução um barco
 * lento (4,5 u/s) andava 0,45 por pacote, que virava 0,4/0,5/0,4 no fio e
 * produzia 25% de pulsação visível. Com 0,01 cai para 3%.
 */
function packSlim(e) {
  const flags = (e.dead ? F_DEAD : 0) | (e.moveState === 'cast' ? F_CAST : 0);
  return [e.id, c(e.x), c(e.z), c(e.rotation), e.hp | 0, c(e.speed), flags];
}

/**
 * Compara a tupla com a do último broadcast. Retorna true (e adota a nova como
 * baseline) se qualquer campo mudou. A comparação é feita nos valores JÁ
 * arredondados: um barco à deriva de 1 cm/s não gera tráfego.
 */
function _isDirty(slim) {
  const b = _baseline.get(slim[0]);
  if (b !== undefined
      && b[1] === slim[1] && b[2] === slim[2] && b[3] === slim[3]
      && b[4] === slim[4] && b[5] === slim[5] && b[6] === slim[6]) {
    return false;
  }
  _baseline.set(slim[0], slim);
  return true;
}

/**
 * Arredonda os floats do registro completo. Mantém os nomes de campo e o
 * formato float (o cliente lê com data.get("x")), mas em 1 cm e não 10 cm: o
 * registro completo é o que o jogador recebe do PRÓPRIO barco a cada pacote, e
 * é justamente nele que a pulsação por quantização mais se nota.
 */
function _roundFull(e) {
  e.x = r2(e.x);
  e.z = r2(e.z);
  if (e.y !== undefined && e.y !== null) e.y = r2(e.y);
  e.rotation = r2(e.rotation);
  e.speed    = r2(e.speed);
  return e;
}

/**
 * Indexa as entidades de UM mapa. Chamado uma vez por broadcast por mapa —
 * o custo é O(N), não O(N²).
 *
 * @param {Array<object>} entities snapshots de players + npcs + bosses do mapa
 */
function buildZone(entities, level) {
  const grid     = new SpatialGrid(AOI_CELL);
  const slimById = new Map();
  const dirty    = new Set();

  for (const e of entities) {
    _roundFull(e);
    grid.insert(e.x, e.z, e);
    const slim = packSlim(e);
    slimById.set(e.id, slim);
    if (_isDirty(slim)) dirty.add(e.id);
  }
  return { grid, slimById, dirty, level };
}

/**
 * Monta o `state` de um jogador a partir da zona já indexada.
 * Retorna null quando não há nada a enviar (ninguém entrou, saiu ou se mexeu) —
 * o chamador simplesmente não manda mensagem nesse tick.
 */
function buildFor(viewer, zone) {
  let known = viewer._aoiKnown;
  if (!known) { known = new Set(); viewer._aoiKnown = known; }

  // Trocou de mapa → o cliente deu queue_free em tudo (ver _handle_map_transition
  // em main.gd), então o que ele "conhecia" não existe mais.
  //
  // A detecção é feita aqui, comparando com o mapa do último broadcast, e não em
  // cada handler de transição de propósito: são cinco caminhos que mudam
  // mapLevel (borda, portal, compra de AFK, saída do AFK, expiração do AFK) e
  // esquecer um daria um bug silencioso — o jogador entraria no mapa novo
  // recebendo só `slim` de entidades que ele não tem.
  if (viewer._aoiMap !== zone.level) {
    known.clear();
    viewer._aoiMap = zone.level;
  }

  const visible = zone.grid.query(viewer.x, viewer.z, AOI_RADIUS);

  const f = [];  // entidades novas na visão — registro completo
  const s = [];  // já conhecidas e que mudaram — tupla compacta
  const r = [];  // saíram da visão — só o id

  const seen = new Set();
  for (const e of visible) {
    seen.add(e.id);

    // O próprio barco vai sempre no registro COMPLETO: o HUD lê `cannonCooldown`
    // e `cannonCooldownMax` direto daqui (hud.gd não anima a barra sozinha, ele
    // desenha o valor que o servidor mandou), e esses campos não cabem na tupla
    // slim. O cooldown entra no teste de mudança junto — sem isso a barra
    // congelaria enquanto o barco estivesse parado recarregando.
    if (e.id === viewer.id) {
      const cd = e.cannonCooldown | 0;
      if (!known.has(e.id) || zone.dirty.has(e.id) || viewer._aoiLastCd !== cd) {
        viewer._aoiLastCd = cd;
        known.add(e.id);
        f.push(e);
      }
      continue;
    }

    if (known.has(e.id)) {
      if (zone.dirty.has(e.id)) s.push(zone.slimById.get(e.id));
    } else {
      known.add(e.id);
      f.push(e);
    }
  }

  // Delete durante a iteração de um Set é seguro em JS (a entrada removida
  // simplesmente não é revisitada).
  for (const id of known) {
    // O próprio barco nunca sai da visão: o jogador morto some do snapshot
    // (playerManager pula dead), e mandá-lo em `r` faria o cliente destruir o
    // nó que a câmera segue.
    if (id === viewer.id) continue;
    if (!seen.has(id)) {
      r.push(id);
      known.delete(id);
    }
  }

  if (f.length === 0 && s.length === 0 && r.length === 0) return null;

  // `aoi: 1` marca o formato para o cliente. Precisa ser explícito: uma mensagem
  // só com meta da zona (clima/barco mudou, ninguém se mexeu) não tem f/s/r, e
  // sem a marca o cliente cairia no parser do formato antigo e liberaria todas
  // as entidades por achar que a lista veio vazia.
  const msg = { type: 'state', aoi: 1 };
  if (f.length) msg.f = f;
  if (s.length) msg.s = s;
  if (r.length) msg.r = r;
  return msg;
}

/**
 * Esquece tudo que o jogador conhecia. Chamado na troca de mapa (o cliente
 * dá queue_free em todas as entidades) e no login — sem isso o jogador entraria
 * no mapa novo recebendo só `slim` de entidades que ele não tem mais.
 */
function resetViewer(player) {
  if (player && player._aoiKnown) player._aoiKnown.clear();
}

/**
 * Descarta baselines de entidades que não existem mais. Chamado de tempos em
 * tempos pelo servidor — sem isso o Map cresce com todo NPC que já morreu.
 */
function pruneBaseline(liveIds) {
  if (_baseline.size <= liveIds.size * 2) return 0;
  let removed = 0;
  for (const id of _baseline.keys()) {
    if (!liveIds.has(id)) { _baseline.delete(id); removed++; }
  }
  return removed;
}

module.exports = {
  buildZone, buildFor, resetViewer, pruneBaseline, packSlim,
  AOI_RADIUS, F_DEAD, F_CAST,
  _baseline, // exposto para os testes
};
