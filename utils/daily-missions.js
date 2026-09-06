// utils/daily-missions.js — o bloco de missões do dia de um jogador.
//
// Mora aqui, e não no server.js, porque é lógica PURA (nada de socket, nada de
// banco) e porque `require('../server.js')` sobe um servidor de verdade — sem
// separar não havia como testar a regra que impede pagar a mesma missão duas
// vezes.
//
// O estado por jogador vive na coluna JSON `daily_missions` (players), escrita
// pelos DOIS caminhos do db-manager (`_flush` urgente e o `batchSave` de 15 s) e
// lida no login por `sanitizeDailyMissions`. Formato:
//
//   { date: 'YYYY-MM-DD', pool: [id…], activeMission: id|null,
//     progress: { id: n }, claimed: { id: bool } }

const { DAILY_MISSIONS, DAILY_MISSION_COUNT } = require('../constants/missions');

/**
 * ⚠️ O dia é UTC (`toISOString`), então ele vira às 21h de Brasília, não à
 * meia-noite. Mudar isso reinicia o dia de todo mundo uma vez — é decisão de
 * produto, não conserto de bug.
 */
function todayDateStr() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

/** Sorteia N missões do dia — mesmas para todos, seed determinística pela data. */
function getDailyMissionPool(dateStr = todayDateStr()) {
  const allDefs = DAILY_MISSIONS || [];
  const count   = DAILY_MISSION_COUNT || 5;
  if (allDefs.length <= count) return allDefs;

  let seed = dateStr.replace(/-/g, '').split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7);
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return Math.abs(seed); };

  const arr = [...allDefs];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, count);
}

/**
 * Confere a FORMA do bloco que veio do banco.
 *
 * `daily_missions` é uma coluna JSON: o que sai dela é o que entrou, e um save
 * antigo (ou um valor mexido à mão) pode trazer `progress` ausente ou com outro
 * tipo. O `buildDailyMissions` faz `progress[id] = …` sem perguntar — com um
 * objeto torto o login inteiro morria ali. Bloco irrecuperável vira `null`, e o
 * dia nasce zerado como sempre foi.
 *
 * Não trata data nem pool: isso é trabalho do `buildDailyMissions`, que já sabe
 * virar o dia e sincronizar com o sorteio.
 */
function sanitizeDailyMissions(bruto) {
  if (!bruto || typeof bruto !== 'object') return null;
  if (typeof bruto.date !== 'string' || !Array.isArray(bruto.pool)) return null;
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  return {
    date:          bruto.date,
    pool:          bruto.pool.filter(id => typeof id === 'string'),
    activeMission: typeof bruto.activeMission === 'string' ? bruto.activeMission : null,
    progress:      obj(bruto.progress),
    claimed:       obj(bruto.claimed),
  };
}

/**
 * Garante que o jogador tem missões do dia; reseta se for outro dia.
 *
 * ⚠️ **O pool GRAVADO manda no resto do dia.** Antes daqui a função rodava o
 * sorteio de novo a cada chamada e mandava o resultado por cima
 * (`dailyMissions.pool = poolIds`), o que fazia o campo salvo no banco ser
 * enfeite: quem mandava era o `constants/missions.js` em memória. Editar aquele
 * arquivo — acrescentar uma missão, tirar outra, trocar a ordem — mudava o
 * sorteio da MESMA data e, no `buildDailyMissions` seguinte, o `delete
 * progress[id]` levava junto o progresso do dia **e a marca de coletada**. Com a
 * marca fora, a recompensa já paga voltava a ser coletável.
 *
 * Agora o sorteio só entra para COMPLETAR: ids salvos que não existem mais são
 * descartados e o buraco é preenchido pelo sorteio do dia. O preço é que dois
 * jogadores podem terminar o dia com pools diferentes se o arquivo mudar no
 * meio — barato perto de pagar a mesma missão duas vezes, e amanhã tudo
 * reconverge sozinho.
 */
function buildDailyMissions(player) {
  const today    = todayDateStr();
  const sorteio  = getDailyMissionPool(today);
  const defsById = new Map((DAILY_MISSIONS || []).map(m => [m.id, m]));
  const bloco    = player.dailyMissions;

  if (!bloco || bloco.date !== today || !Array.isArray(bloco.pool)) {
    player.dailyMissions = {
      date:          today,
      pool:          sorteio.map(m => m.id),
      activeMission: null,
      progress:      Object.fromEntries(sorteio.map(m => [m.id, 0])),
      claimed:       Object.fromEntries(sorteio.map(m => [m.id, false])),
    };
  } else {
    // Mantém o que foi salvo e ainda existe; completa com o sorteio de hoje.
    const ids = bloco.pool.filter(id => defsById.has(id));
    for (const m of sorteio) {
      if (ids.length >= (DAILY_MISSION_COUNT || 5)) break;
      if (!ids.includes(m.id)) ids.push(m.id);
    }
    bloco.pool = ids;

    for (const id of ids) {
      if (!(id in bloco.progress)) bloco.progress[id] = 0;
      if (!(id in bloco.claimed))  bloco.claimed[id]  = false;
    }

    // Poda o que saiu do dia — MENOS a marca de coletada, que fica até o dia
    // virar. É ela que impede a missão de voltar pagável se o pool oscilar.
    const noDia = new Set(ids);
    const todas = new Set([...Object.keys(bloco.progress), ...Object.keys(bloco.claimed)]);
    for (const id of todas) {
      if (noDia.has(id) || bloco.claimed[id] === true) continue;
      delete bloco.progress[id];
      delete bloco.claimed[id];
    }

    if (bloco.activeMission && !noDia.has(bloco.activeMission)) bloco.activeMission = null;
  }

  const dm = player.dailyMissions;
  return dm.pool
    .map(id => defsById.get(id))
    .filter(Boolean)
    .map(m => ({
      id:       m.id,
      icon:     m.icon,
      label:    m.label,
      target:   m.target,
      reward:   m.reward,
      progress: dm.progress[m.id] || 0,
      claimed:  dm.claimed[m.id]  || false,
      active:   dm.activeMission  === m.id,
    }));
}

/**
 * A ficha de uma missão pelo id.
 *
 * Quem precisa de `target`/`reward`/`stat` tem de vir por AQUI, nunca por
 * `getDailyMissionPool().find(...)`: o sorteio é o do DIA, e desde que o pool
 * gravado passou a mandar, o jogador pode carregar um id que não está no
 * sorteio de hoje. Procurar no sorteio devolveria `undefined` e a missão pararia
 * de progredir — e de ser coletável — em silêncio.
 */
function missionDefById(id) {
  return (DAILY_MISSIONS || []).find(m => m.id === id) || null;
}

/** A missão está no quadro DESTE jogador hoje? (a checagem de posse) */
function isMissionInPlayerPool(player, id) {
  return !!player?.dailyMissions?.pool?.includes(id);
}

module.exports = {
  todayDateStr,
  getDailyMissionPool,
  sanitizeDailyMissions,
  buildDailyMissions,
  missionDefById,
  isMissionInPlayerPool,
};
