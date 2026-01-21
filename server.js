// server.js - 空壳之国（轻量互动版）
// npm i ws
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

/** -----------------------------
 * Utilities
 * ------------------------------ */
function randInt(n) { return Math.floor(Math.random() * n); }
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function now() { return Date.now(); }

function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch {}
}

function isHuman(p) { return p.kind === "human"; }
function isAI(p) { return p.kind === "ai"; }

/** -----------------------------
 * Game data
 * ------------------------------ */
const MAX_TURNS = 8;
const HAND_SIZE = 5;

const DECL_TAGS = [
  { key: "SUPPORT", name: "拉支持" },
  { key: "ATTACK",  name: "搞对手" },
  { key: "MONEY",   name: "搞筹码" },
  { key: "ALLY",    name: "结盟/断盟" },
  { key: "COUP",    name: "准备/发动政变" },
  { key: "VOTE",    name: "冲议题投票" },
  { key: "BLUFF",   name: "打烟雾弹" },
];

const ROLE = {
  NORMAL: "普通",
  POPULIST: "民粹强人",   // 暴力政变：协商/出钱阻止
  AUTOCRAT: "独裁强人",   // 军事接管：短反应阻止
};

const PHASE = {
  LOBBY: "LOBBY",
  PLOTTING: "PLOTTING",
  ACTION: "ACTION",
  REACTION: "REACTION",
  VOTE: "VOTE",
  CRISIS: "CRISIS",
  CLEANUP: "CLEANUP",
  COUP_NEGOTIATION: "COUP_NEGOTIATION",
  COUP_REACTION: "COUP_REACTION",
  END: "END",
};

// 行动牌（一个大堆）：type = ACTION / REACTION
// tag 用于声明判定
// effectKey 在服务器 switch 里结算
function buildActionDeck() {
  const cards = [];
  let id = 1;
  function add(name, type, tag, effectKey, params = {}, copies = 1, text = "") {
    for (let i = 0; i < copies; i++) {
      cards.push({
        id: `C${id++}`,
        name,
        type,
        tag,
        effectKey,
        params,
        text,
      });
    }
  }

  // 支持类
  add("宣传攻势", "ACTION", "SUPPORT", "GAIN_S", { s: 2 }, 4, "+2支持");
  add("基层动员", "ACTION", "SUPPORT", "GAIN_S_GAIN_T", { s: 1, t: 1 }, 3, "+1支持 +1稳定");
  add("危机公关", "ACTION", "SUPPORT", "GAIN_T", { t: 2 }, 3, "+2稳定");

  // 筹码类
  add("募捐活动", "ACTION", "MONEY", "GAIN_M", { m: 3 }, 4, "+3筹码");
  add("政策交易", "ACTION", "MONEY", "GAIN_M_LOSE_T", { m: 2, t: 1 }, 3, "+2筹码 -1稳定");
  add("暗箱运作", "ACTION", "MONEY", "STEAL_M", { m: 2 }, 2, "偷取目标2筹码");

  // 攻击类
  add("媒体操控", "ACTION", "ATTACK", "SHIFT_S", { s: 1 }, 4, "目标-1支持，你+1支持");
  add("丑闻曝光", "ACTION", "ATTACK", "HIT_ST", { s: 1, t: 1 }, 3, "目标-1支持-1稳定");
  add("间谍渗透", "ACTION", "ATTACK", "STEAL_CARD", {}, 2, "偷目标随机1张牌");

  // 背刺（高风险）
  add("政治背叛", "ACTION", "ATTACK", "BETRAY", { s: 2, t: 2 }, 2, "你+2支持，但你-2稳定且不可信+1");
  add("政治暗杀", "ACTION", "ATTACK", "ASSASSIN", {}, 1, "目标支持降到0，你-3稳定");

  // 联盟向
  add("握手协议", "ACTION", "ALLY", "OFFER_ALLIANCE", {}, 3, "向目标提出结盟（需对方接受）");
  add("撕毁协议", "ACTION", "ALLY", "BREAK_ALLIANCE", {}, 2, "单方面断盟");

  // 反应牌（可在 REACTION / COUP 阶段用）
  add("紧急止损", "REACTION", "SUPPORT", "REACT_CANCEL_T_LOSS", {}, 3, "取消本次你受到的稳定损失");
  add("反政变动员", "REACTION", "COUP", "REACT_BLOCK_VIOLENT", {}, 1, "直接阻止暴力政变（一次性）");
  add("将领倒戈", "REACTION", "COUP", "REACT_BLOCK_MILITARY", {}, 1, "直接阻止军事接管（一次性）");

  return shuffle(cards);
}

// 议题牌（每回合翻一张）：含投票效果 + 危机阈值
function buildAgendaDeck() {
  const agendas = [
    {
      id: "A1",
      name: "军事改革",
      text: "通过：赞成者+1稳定；反对者-1支持。",
      crisisNeed: 3,
      crisisText: "若本回合危机贡献总筹码 <3：所有人-1稳定。",
      pass: { yesVoter: { t: +1 }, noVoter: { s: -1 } },
    },
    {
      id: "A2",
      name: "社会福利",
      text: "通过：所有人+1支持；总统额外-1筹码（当作买单）。",
      crisisNeed: 2,
      crisisText: "若危机贡献 <2：所有人-1稳定。",
      pass: { all: { s: +1 }, president: { m: -1 } },
    },
    {
      id: "A3",
      name: "反腐败行动",
      text: "通过：筹码最多者-2筹码；赞成者各+1支持。",
      crisisNeed: 3,
      crisisText: "若危机贡献 <3：支持最高者-1支持（背锅）。",
      pass: { yesVoter: { s: +1 }, richest: { m: -2 } },
      fail: { topSupport: { s: -1 } },
    },
    {
      id: "A4",
      name: "言论自由",
      text: "通过：所有人抽1张行动牌。未通过：所有人-1稳定（舆论反噬）。",
      crisisNeed: 2,
      crisisText: "若危机贡献 <2：所有人-1稳定。",
      pass: { allDraw: 1 },
      fail: { all: { t: -1 } },
    },
    {
      id: "A5",
      name: "选举法改革",
      text: "通过：选举胜利阈值从8降到7（本局永久）。未通过：无事发生。",
      crisisNeed: 2,
      crisisText: "若危机贡献 <2：所有人-1稳定。",
      pass: { electionThreshold: 7 },
    },
    {
      id: "A6",
      name: "重建国家",
      text: "通过：所有人稳定重置为5、手牌补到5；总统+1支持。",
      crisisNeed: 4,
      crisisText: "若危机贡献 <4：所有人-2稳定（重建失败）。",
      pass: { rebuild: true, president: { s: +1 } },
      fail: { all: { t: -1 } },
    },
  ];
  return shuffle(agendas);
}

/** -----------------------------
 * Room state
 * ------------------------------ */
const rooms = new Map();

function createRoom(roomId) {
  const room = {
    id: roomId,
    createdAt: now(),
    started: false,
    turn: 0,
    phase: PHASE.LOBBY,
    phaseEndsAt: null,

    players: [],

    // decks
    actionDeck: [],
    actionDiscard: [],
    agendaDeck: [],
    agendaDiscard: [],

    currentAgenda: null,

    // turn order
    presidentIdx: 0,
    currentIdx: 0,

    // per-round bookkeeping
    electionThreshold: 8,
    allianceBonusUsedThisTurn: new Set(), // players who already received alliance +1S this turn

    // challenges: targetId -> { challengerId, pot }
    challenges: new Map(),

    // alliance offers: { fromId, toId, expiresAt }
    allianceOffer: null,

    // vote
    votes: new Map(), // playerId -> "YES"|"NO"|"ABSTAIN"

    // crisis contributions
    crisisContrib: new Map(), // playerId -> amount

    // coup
    coup: null, // { leaderId, type, contrib:Map, blockedByCard:boolean, endsAt:number }

    actedThisTurn: new Set(),
    reactionContext: null,

    log: [],
  };
  rooms.set(roomId, room);
  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId) || createRoom(roomId);
}

function publicPlayerView(p) {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    online: !!p.ws || p.kind === "ai",
    S: p.S,
    T: p.T,
    M: p.M,
    untrusted: p.untrusted || 0,
    allianceWith: p.allianceWith || null,
    coupW: p.coupW || 0, // 威胁条公开
    exposed: !!p.exposed, // 若独裁政变被拦下，会公开身份（更像众矢之的）
  };
}

function sumContrib(map) {
  let s = 0;
  for (const v of map.values()) s += v;
  return s;
}

function publicState(room) {
  return {
    roomId: room.id,
    started: room.started,
    turn: room.turn,
    phase: room.phase,
    presidentId: room.players[room.presidentIdx]?.id || null,
    currentPlayerId: room.players[room.currentIdx]?.id || null,
    electionThreshold: room.electionThreshold,
    agenda: room.currentAgenda ? {
      id: room.currentAgenda.id,
      name: room.currentAgenda.name,
      text: room.currentAgenda.text,
      crisisNeed: room.currentAgenda.crisisNeed,
      crisisText: room.currentAgenda.crisisText,
    } : null,
    allianceOffer: room.allianceOffer ? { fromId: room.allianceOffer.fromId, toId: room.allianceOffer.toId } : null,
    coup: room.coup ? {
      leaderId: room.coup.leaderId,
      type: room.coup.type,
      // contributions公开显示总量即可（避免过多信息）
      totalContrib: sumContrib(room.coup.contrib),
      endsAt: room.coup.endsAt,
      blockedByCard: !!room.coup.blockedByCard,
    } : null,
    phaseEndsAt: room.phaseEndsAt,
    players: room.players.map(publicPlayerView),
    log: room.log.slice(-120),
  };
}

function privateState(room, playerId) {
  const me = room.players.find(p => p.id === playerId);
  if (!me) return null;
  return {
    me: {
      id: me.id,
      name: me.name,
      role: me.role, // 私密
      S: me.S, T: me.T, M: me.M,
      untrusted: me.untrusted || 0,
      allianceWith: me.allianceWith || null,
      coupW: me.coupW || 0,
      facedownId: me.facedownId || null,
      declaration: { tag: me.declTag || null, text: me.declText || "" },
      hand: me.hand.map(c => ({
        id: c.id, name: c.name, type: c.type, tag: c.tag, text: c.text,
      })),
    }
  };
}

function broadcast(room, obj) {
  room.players.forEach(p => {
    if (isHuman(p)) safeSend(p.ws, obj);
  });
}

function broadcastState(room) {
  const pub = publicState(room);
  broadcast(room, { type: "state", state: pub });
  room.players.forEach(p => {
    if (isHuman(p)) safeSend(p.ws, { type: "private", state: privateState(room, p.id) });
  });
}

function log(room, line) {
  room.log.push(line);
}

/** -----------------------------
 * Core mechanics helpers
 * ------------------------------ */
function drawAction(room) {
  if (room.actionDeck.length === 0) {
    room.actionDeck = shuffle(room.actionDiscard);
    room.actionDiscard = [];
  }
  return room.actionDeck.pop() || null;
}

function drawAgenda(room) {
  if (room.agendaDeck.length === 0) {
    room.agendaDeck = shuffle(room.agendaDiscard);
    room.agendaDiscard = [];
  }
  const a = room.agendaDeck.pop() || null;
  if (a) room.agendaDiscard.push(a);
  return a;
}

function dealHands(room) {
  room.players.forEach(p => {
    while (p.hand.length < HAND_SIZE) {
      const c = drawAction(room);
      if (!c) break;
      p.hand.push(c);
    }
  });
}

function countContributors(map) {
  let n = 0;
  for (const v of map.values()) if (v > 0) n += 1;
  return n;
}

// 联盟收益/代价：
// - 本回合第一次“获得支持 S+”时，盟友也 +1S（每回合每个被动只触发一次：按“收到的人”记）
function applySupport(room, playerId, delta, reason = "") {
  if (delta === 0) return;
  const p = room.players.find(x => x.id === playerId);
  if (!p) return;
  const before = p.S;
  p.S = clamp(p.S + delta, 0, 10);
  if (reason) log(room, `✨ ${p.name} 支持 ${before}→${p.S}（${reason}）`);

  // 联盟被动：只在“获得支持”且 delta>0 时触发
  if (delta > 0 && p.allianceWith) {
    const ally = room.players.find(x => x.id === p.allianceWith);
    if (ally && !room.allianceBonusUsedThisTurn.has(ally.id)) {
      room.allianceBonusUsedThisTurn.add(ally.id);
      const b2 = ally.S;
      ally.S = clamp(ally.S + 1, 0, 10);
      log(room, `🤝 联盟红利：${ally.name} 支持 ${b2}→${ally.S}（盟友顺风车）`);
    }
  }
}

function applyStability(room, playerId, delta, reason = "", opts = {}) {
  if (delta === 0) return;
  const p = room.players.find(x => x.id === playerId);
  if (!p) return;

  // 反应牌“紧急止损”会给玩家一个本轮免疫标记
  if (delta < 0 && p.cancelNextTLoss) {
    p.cancelNextTLoss = false;
    log(room, `🛡️ ${p.name} 触发「紧急止损」：取消本次稳定损失。`);
    return;
  }

  const before = p.T;
  p.T = clamp(p.T + delta, 0, 10);
  if (reason) log(room, `🧱 ${p.name} 稳定 ${before}→${p.T}（${reason}）`);

  // 联盟连坐：只在受到稳定损失（delta<0）时触发，让盟友也 -1T（防止递归）
  if (delta < 0 && p.allianceWith && !opts._noAllianceDamage) {
    const ally = room.players.find(x => x.id === p.allianceWith);
    if (ally) {
      const b2 = ally.T;
      ally.T = clamp(ally.T - 1, 0, 10);
      log(room, `🤝 联盟连坐：${ally.name} 稳定 ${b2}→${ally.T}（盟友背锅）`);
    }
  }
}

function applyMoney(room, playerId, delta, reason = "") {
  if (delta === 0) return;
  const p = room.players.find(x => x.id === playerId);
  if (!p) return;
  const before = p.M;
  p.M = clamp(p.M + delta, 0, 10);
  if (reason) log(room, `💰 ${p.name} 筹码 ${before}→${p.M}（${reason}）`);
}

function removeCardFromHand(player, cardId) {
  const idx = player.hand.findIndex(c => c.id === cardId);
  if (idx < 0) return null;
  return player.hand.splice(idx, 1)[0];
}

function getPlayer(room, playerId) {
  return room.players.find(p => p.id === playerId);
}

function isMyTurn(room, playerId) {
  return room.players[room.currentIdx]?.id === playerId;
}

function nextIdx(room) {
  return (room.currentIdx + 1) % room.players.length;
}

// ——关键修复：行动结束不要依赖 currentIdx（避免 REACTION 结束时跳人）——
function idxOf(room, playerId) {
  return room.players.findIndex(p => p.id === playerId);
}
function nextUnactedIdx(room, startIdx) {
  for (let step = 1; step <= room.players.length; step++) {
    const i = (startIdx + step) % room.players.length;
    const pid = room.players[i]?.id;
    if (pid && !room.actedThisTurn.has(pid)) return i;
  }
  return startIdx;
}

function checkWin(room) {
  if (room.phase === PHASE.END) return true;
  const threshold = room.electionThreshold;

  // 立即选举胜利
  const winner = room.players.find(p => p.S >= threshold);
  if (winner) {
    endGame(room, `${winner.name}（选举胜利）`, "支持度冲线，赢得选举。");
    return true;
  }

  return false;
}

function endGame(room, winnerText, endingText) {
  room.phase = PHASE.END;
  room.phaseEndsAt = null;
  log(room, `🏁 终局：${winnerText} —— ${endingText}`);
  broadcastState(room);
}

/** -----------------------------
 * Challenges (质疑押注)
 * ------------------------------ */
function canChallenge(room, challengerId, targetId) {
  const c = getPlayer(room, challengerId);
  const t = getPlayer(room, targetId);
  if (!c || !t) return false;
  if (challengerId === targetId) return false;
  if (c.M < 1 || t.M < 1) return false;
  if (room.challenges.has(targetId)) return false;
  return true;
}

function setChallenge(room, challengerId, targetId) {
  const c = getPlayer(room, challengerId);
  const t = getPlayer(room, targetId);
  if (!c || !t) return;
  c.M -= 1; t.M -= 1;
  room.challenges.set(targetId, { challengerId, pot: 2 });
  log(room, `⚖️ 质疑成立：${c.name} 质疑 ${t.name}（双方各押1筹码进争议池）`);
}

function resolveChallengeIfAny(room, targetId, actualTag) {
  const entry = room.challenges.get(targetId);
  if (!entry) return;
  const target = getPlayer(room, targetId);
  const challenger = getPlayer(room, entry.challengerId);
  if (!target || !challenger) {
    room.challenges.delete(targetId);
    return;
  }
  const declared = target.declTag || "BLUFF";
  const pot = entry.pot || 2;

  // 判定：声明 tag 与 实际 tag 一致则目标赢，否则质疑者赢
  if (declared === actualTag) {
    applyMoney(room, target.id, pot, "争议池获胜");
    applySupport(room, challenger.id, -1, "质疑失败丢脸");
    log(room, `⚖️ 判定：${target.name} 行动与声明一致（${declared}），质疑失败。`);
  } else {
    applyMoney(room, challenger.id, pot, "争议池获胜");
    applySupport(room, target.id, -1, "声明被打脸");
    log(room, `⚖️ 判定：${target.name} 声明(${declared})≠实际(${actualTag})，质疑成功。`);
  }
  room.challenges.delete(targetId);
}

/** -----------------------------
 * Coup (政变)
 * ------------------------------ */
function canPrepCoup(p) {
  return p.role === ROLE.POPULIST || p.role === ROLE.AUTOCRAT;
}

function prepCoup(room, playerId) {
  const p = getPlayer(room, playerId);
  if (!p) return { ok: false, err: "玩家不存在" };
  if (!canPrepCoup(p)) return { ok: false, err: "你不是强人" };
  if (p.M < 1) return { ok: false, err: "筹码不足（需要1）" };
  if ((p.coupW || 0) >= 3) return { ok: false, err: "威胁条已满" };
  p.M -= 1;
  p.coupW = clamp((p.coupW || 0) + 1, 0, 3);
  log(room, `🚩 ${p.name} 提升政变威胁 W=${p.coupW}（花费1筹码）`);
  return { ok: true };
}

function canLaunchCoup(room, p) {
  const W = p.coupW || 0;
  if (W < 3) return { ok: false, reason: "威胁条未满（需W=3）" };
  if (p.role === ROLE.POPULIST) {
    if (p.S < 6) return { ok: false, reason: "支持不足（民粹需S≥6）" };
    if (p.T < 2) return { ok: false, reason: "稳定不足（民粹需T≥2）" };
    return { ok: true };
  }
  if (p.role === ROLE.AUTOCRAT) {
    if (p.S < 7) return { ok: false, reason: "支持不足（独裁需S≥7）" };
    if (p.T < 4) return { ok: false, reason: "稳定不足（独裁需T≥4）" };
    return { ok: true };
  }
  return { ok: false, reason: "你不是强人" };
}

function launchCoup(room, playerId) {
  const p = getPlayer(room, playerId);
  if (!p) return { ok: false, err: "玩家不存在" };
  const chk = canLaunchCoup(room, p);
  if (!chk.ok) return { ok: false, err: chk.reason };

  const type = (p.role === ROLE.POPULIST) ? "VIOLENT" : "MILITARY";
  room.coup = {
    leaderId: p.id,
    type,
    contrib: new Map(),
    blockedByCard: false,
    endsAt: now() + (type === "VIOLENT" ? 30000 : 12000),
  };

  if (type === "VIOLENT") {
    room.phase = PHASE.COUP_NEGOTIATION;
    room.phaseEndsAt = room.coup.endsAt;
    log(room, `🧨 ${p.name} 发动【暴力政变】！30秒协商：至少两人各出≥2筹码 或 总筹码≥4 可阻止。也可打出“反政变动员”。`);
  } else {
    room.phase = PHASE.COUP_REACTION;
    room.phaseEndsAt = room.coup.endsAt;
    log(room, `🪖 ${p.name} 发动【军事接管】！12秒反应：打出“将领倒戈”或 至少两人合计出≥6筹码 才能阻止。`);
  }
  return { ok: true };
}

function contributeToCoup(room, playerId, amount) {
  const coup = room.coup;
  if (!coup) return { ok: false, err: "当前没有政变" };
  if (playerId === coup.leaderId) return { ok: false, err: "发动者不能出钱阻止" };
  const p = getPlayer(room, playerId);
  if (!p) return { ok: false, err: "玩家不存在" };
  const a = clamp(Number(amount || 0), 0, 10);
  if (a <= 0) return { ok: false, err: "贡献必须>0" };
  if (p.M < a) return { ok: false, err: "筹码不足" };

  p.M -= a;
  coup.contrib.set(playerId, (coup.contrib.get(playerId) || 0) + a);
  log(room, `🧾 ${p.name} 为阻止政变贡献 ${a} 筹码。`);
  return { ok: true };
}

function anyContributorAtLeast(contribMap, minEach, needCount) {
  let c = 0;
  for (const v of contribMap.values()) {
    if (v >= minEach) c += 1;
  }
  return c >= needCount;
}

function finalizeCoup(room) {
  const coup = room.coup;
  if (!coup) return;

  const leader = getPlayer(room, coup.leaderId);
  if (!leader) {
    room.coup = null;
    return;
  }

  const total = sumContrib(coup.contrib);
  const contributors = countContributors(coup.contrib);

  if (coup.type === "VIOLENT") {
    const blocked = coup.blockedByCard || (total >= 4 && contributors >= 2) || anyContributorAtLeast(coup.contrib, 2, 2);
    if (blocked) {
      applySupport(room, leader.id, -2, "政变被阻止");
      leader.coupW = 0;
      for (const [pid, amt] of coup.contrib.entries()) {
        if (amt > 0) applySupport(room, pid, +1, "阻止政变（保国派）");
      }
      log(room, `✅ 暴力政变被阻止！`);
      room.coup = null;

      room.phase = PHASE.VOTE;
      room.phaseEndsAt = now() + 20000;
      broadcastState(room);
      maybeRunAI(room);
      return;
    } else {
      endGame(room, `${leader.name}（暴力政变成功）`, "政权被夺取，游戏结束。");
      return;
    }
  } else {
    const blocked = coup.blockedByCard || (total >= 6 && contributors >= 2) || anyContributorAtLeast(coup.contrib, 3, 2);
    if (blocked) {
      applyStability(room, leader.id, -3, "军事接管被阻止");
      leader.coupW = 0;
      leader.exposed = true;
      log(room, `✅ 军事接管被阻止！${leader.name} 身份暴露，军心受挫。`);
      room.coup = null;

      room.phase = PHASE.VOTE;
      room.phaseEndsAt = now() + 20000;
      broadcastState(room);
      maybeRunAI(room);
      return;
    } else {
      endGame(room, `${leader.name}（军事接管成功）`, "军队接管，游戏结束。");
      return;
    }
  }
}

/** -----------------------------
 * Agenda vote & crisis
 * ------------------------------ */
function autoVoteIfMissing(room) {
  room.players.forEach(p => {
    if (!room.votes.has(p.id)) room.votes.set(p.id, "ABSTAIN");
  });
}

function resolveVote(room) {
  const agenda = room.currentAgenda;
  if (!agenda) return;

  autoVoteIfMissing(room);

  let yes = 0, no = 0;
  for (const p of room.players) {
    const v = room.votes.get(p.id);
    if (v === "YES") yes += 1;
    if (v === "NO") no += 1;
  }
  const passed = yes > no;
  log(room, `🗳️ 投票结果：YES=${yes} / NO=${no} / 通过=${passed ? "是" : "否"}`);

  if (passed) applyAgendaEffects(room, agenda.pass);
  else if (agenda.fail) applyAgendaEffects(room, agenda.fail);

  room.votes.clear();
}

function applyAgendaEffects(room, eff) {
  if (!eff) return;

  const president = room.players[room.presidentIdx];
  const richest = room.players.slice().sort((a, b) => b.M - a.M)[0];
  const topSupport = room.players.slice().sort((a, b) => b.S - a.S)[0];

  if (eff.yesVoter || eff.noVoter) {
    room.players.forEach(p => {
      const v = room.votes.get(p.id) || "ABSTAIN";
      if (v === "YES" && eff.yesVoter) applyDeltaBundle(room, p.id, eff.yesVoter, "议题奖励");
      if (v === "NO" && eff.noVoter) applyDeltaBundle(room, p.id, eff.noVoter, "议题惩罚");
    });
  }

  if (eff.all) {
    room.players.forEach(p => applyDeltaBundle(room, p.id, eff.all, "议题效果"));
  }
  if (eff.president && president) {
    applyDeltaBundle(room, president.id, eff.president, "总统议题效果");
  }
  if (eff.richest && richest) {
    applyDeltaBundle(room, richest.id, eff.richest, "议题指向：筹码最多者");
  }
  if (eff.topSupport && topSupport) {
    applyDeltaBundle(room, topSupport.id, eff.topSupport, "议题指向：支持最高者");
  }
  if (eff.allDraw) {
    const n = Number(eff.allDraw) || 1;
    room.players.forEach(p => {
      for (let i = 0; i < n; i++) {
        const c = drawAction(room);
        if (c) p.hand.push(c);
      }
    });
    log(room, `📥 议题效果：所有人抽${n}张牌。`);
  }
  if (eff.electionThreshold) {
    room.electionThreshold = eff.electionThreshold;
    log(room, `📌 选举阈值变更：支持度达到 ${room.electionThreshold} 即可赢。`);
  }
  if (eff.rebuild) {
    room.players.forEach(p => {
      p.T = 5;
      while (p.hand.length < HAND_SIZE) {
        const c = drawAction(room);
        if (!c) break;
        p.hand.push(c);
      }
      while (p.hand.length > HAND_SIZE) {
        const drop = p.hand.pop();
        room.actionDiscard.push(drop);
      }
    });
    log(room, `🏗️ 重建：所有人稳定重置为5，手牌补到5。`);
  }
}

function applyDeltaBundle(room, playerId, bundle, reasonPrefix) {
  if (!bundle) return;
  if (bundle.s) applySupport(room, playerId, bundle.s, reasonPrefix);
  if (bundle.t) applyStability(room, playerId, bundle.t, reasonPrefix);
  if (bundle.m) applyMoney(room, playerId, bundle.m, reasonPrefix);
}

// 危机：贡献总筹码不足则惩罚；贡献者最多者加成
function resolveCrisis(room) {
  const agenda = room.currentAgenda;
  if (!agenda) return;

  const need = agenda.crisisNeed || 0;
  let total = 0;
  let best = { pid: null, amt: -1 };

  for (const p of room.players) {
    const amt = room.crisisContrib.get(p.id) || 0;
    total += amt;
    if (amt > best.amt) best = { pid: p.id, amt };
  }

  if (need > 0) {
    if (total < need) {
      if (room.currentAgenda.id === "A6") {
        room.players.forEach(p => applyStability(room, p.id, -2, "危机未应对"));
      } else if (room.currentAgenda.id === "A3") {
        const topSupport = room.players.slice().sort((a, b) => b.S - a.S)[0];
        if (topSupport) applySupport(room, topSupport.id, -1, "危机背锅");
        log(room, `🚨 危机未应对：${agenda.crisisText}`);
      } else {
        room.players.forEach(p => applyStability(room, p.id, -1, "危机未应对"));
        log(room, `🚨 危机未应对：${agenda.crisisText}`);
      }
    } else {
      log(room, `✅ 危机应对成功：总贡献 ${total}/${need}`);
      for (const p of room.players) {
        const amt = room.crisisContrib.get(p.id) || 0;
        if (amt > 0) applyStability(room, p.id, +1, "危机应对贡献");
      }
      if (best.pid && best.amt > 0) applySupport(room, best.pid, +1, "危机领导者");
    }
  }

  room.crisisContrib.clear();
}

/** -----------------------------
 * Action resolution
 * ------------------------------ */
function resolveActionCard(room, actorId, card, targetId = null) {
  const actor = getPlayer(room, actorId);
  if (!actor) return;
  const tag = card.tag;

  switch (card.effectKey) {
    case "GAIN_S":
      applySupport(room, actorId, card.params.s || 1, card.name);
      break;

    case "GAIN_T":
      applyStability(room, actorId, card.params.t || 1, card.name);
      break;

    case "GAIN_M":
      applyMoney(room, actorId, card.params.m || 1, card.name);
      break;

    case "GAIN_S_GAIN_T":
      applySupport(room, actorId, card.params.s || 1, card.name);
      applyStability(room, actorId, card.params.t || 1, card.name);
      break;

    case "GAIN_M_LOSE_T":
      applyMoney(room, actorId, card.params.m || 1, card.name);
      applyStability(room, actorId, -(card.params.t || 1), card.name);
      break;

    case "SHIFT_S": {
      const target = getPlayer(room, targetId) || pickOther(room, actorId);
      if (!target) break;
      applySupport(room, target.id, -(card.params.s || 1), `${card.name}（被压）`);
      applySupport(room, actorId, +(card.params.s || 1), `${card.name}（获利）`);
      break;
    }

    case "HIT_ST": {
      const target = getPlayer(room, targetId) || pickOther(room, actorId);
      if (!target) break;
      applySupport(room, target.id, -(card.params.s || 1), `${card.name}`);
      applyStability(room, target.id, -(card.params.t || 1), `${card.name}`);
      break;
    }

    case "STEAL_M": {
      const target = getPlayer(room, targetId) || pickOther(room, actorId);
      if (!target) break;
      const m = card.params.m || 2;
      const take = Math.min(m, target.M);
      target.M -= take;
      actor.M = clamp(actor.M + take, 0, 10);
      log(room, `🧾 ${actor.name} 通过「${card.name}」从 ${target.name} 偷走 ${take} 筹码。`);
      break;
    }

    case "STEAL_CARD": {
      const target = getPlayer(room, targetId) || pickOther(room, actorId);
      if (!target || target.hand.length === 0) break;
      const idx = randInt(target.hand.length);
      const stolen = target.hand.splice(idx, 1)[0];
      actor.hand.push(stolen);
      log(room, `🕵️ ${actor.name} 通过「${card.name}」从 ${target.name} 手里偷走1张牌。`);
      break;
    }

    case "BETRAY": {
      applySupport(room, actorId, card.params.s || 2, card.name);
      applyStability(room, actorId, -(card.params.t || 2), card.name);
      actor.untrusted = clamp((actor.untrusted || 0) + 1, 0, 9);
      log(room, `🧷 ${actor.name} 获得“不可信”标记（谈判会更难）。`);
      break;
    }

    case "ASSASSIN": {
      const target = getPlayer(room, targetId) || pickOther(room, actorId);
      if (!target) break;
      if (target.S < 4) {
        log(room, `❌ ${actor.name} 试图暗杀，但目标支持不足4，行动失败。`);
        break;
      }
      log(room, `☠️ ${actor.name} 对 ${target.name} 发动「政治暗杀」：目标支持归零，但自己-3稳定。`);
      target.S = 0;
      applyStability(room, actorId, -3, card.name);
      break;
    }

    case "OFFER_ALLIANCE": {
      const target = getPlayer(room, targetId) || pickOther(room, actorId);
      if (!target) break;
      if (actor.allianceWith || target.allianceWith) {
        log(room, `🤝 结盟失败：双方之一已有联盟。`);
        break;
      }
      room.allianceOffer = { fromId: actorId, toId: target.id, expiresAt: now() + 15000 };
      room.phase = PHASE.REACTION;
      room.phaseEndsAt = room.allianceOffer.expiresAt;
      room.reactionContext = { type: "ALLIANCE_OFFER", fromId: actorId, toId: target.id };
      log(room, `🤝 ${actor.name} 向 ${target.name} 提出结盟（15秒内可接受）。`);
      break;
    }

    case "BREAK_ALLIANCE": {
      if (!actor.allianceWith) {
        log(room, `🤝 ${actor.name} 试图断盟，但你当前没有盟友。`);
        break;
      }
      const ally = getPlayer(room, actor.allianceWith);
      const aName = ally ? ally.name : "（未知）";
      if (ally) ally.allianceWith = null;
      actor.allianceWith = null;
      log(room, `💥 ${actor.name} 单方面撕毁联盟，与 ${aName} 断盟。`);
      break;
    }

    default:
      log(room, `（未实现的牌效果：${card.effectKey}）`);
  }

  room.actionDiscard.push(card);
  return tag;
}

function pickOther(room, actorId) {
  const others = room.players.filter(p => p.id !== actorId);
  if (others.length === 0) return null;
  return others.slice().sort((a, b) => b.S - a.S)[0];
}

/** -----------------------------
 * Reactions
 * ------------------------------ */
function playReaction(room, playerId, cardId) {
  const p = getPlayer(room, playerId);
  if (!p) return { ok: false, err: "玩家不存在" };

  if (![PHASE.REACTION, PHASE.COUP_NEGOTIATION, PHASE.COUP_REACTION].includes(room.phase)) {
    return { ok: false, err: "当前不能打反应牌" };
  }

  const card = removeCardFromHand(p, cardId);
  if (!card) return { ok: false, err: "手牌不存在" };
  if (card.type !== "REACTION") {
    p.hand.push(card);
    return { ok: false, err: "这不是反应牌" };
  }

  switch (card.effectKey) {
    case "REACT_CANCEL_T_LOSS":
      p.cancelNextTLoss = true;
      log(room, `🛡️ ${p.name} 打出反应牌「${card.name}」：下次稳定损失取消。`);
      break;

    case "REACT_BLOCK_VIOLENT":
      if (room.coup && room.coup.type === "VIOLENT") {
        room.coup.blockedByCard = true;
        log(room, `🧯 ${p.name} 打出「${card.name}」：暴力政变将被阻止！`);
      } else {
        log(room, `（${p.name} 的「${card.name}」未命中：当前不是暴力政变）`);
      }
      break;

    case "REACT_BLOCK_MILITARY":
      if (room.coup && room.coup.type === "MILITARY") {
        room.coup.blockedByCard = true;
        log(room, `🧯 ${p.name} 打出「${card.name}」：军事接管将被阻止！`);
      } else {
        log(room, `（${p.name} 的「${card.name}」未命中：当前不是军事接管）`);
      }
      break;

    default:
      log(room, `（未实现的反应牌：${card.effectKey}）`);
  }

  room.actionDiscard.push(card);
  return { ok: true };
}

/** -----------------------------
 * Game flow
 * ------------------------------ */
function startGame(room) {
  if (room.started) return;
  if (room.players.length < 2) return;

  room.started = true;
  room.turn = 1;
  room.phase = PHASE.PLOTTING;
  room.phaseEndsAt = now() + 30000;

  room.actionDeck = buildActionDeck();
  room.actionDiscard = [];
  room.agendaDeck = buildAgendaDeck();
  room.agendaDiscard = [];

  room.players.forEach(p => {
    p.S = 5; p.T = 5; p.M = 3;
    p.hand = [];
    p.facedownId = null;
    p.declTag = "BLUFF";
    p.declText = "";
    p.untrusted = 0;
    p.allianceWith = null;
    p.coupW = 0;
    p.exposed = false;
    p.cancelNextTLoss = false;
  });

  room.presidentIdx = randInt(room.players.length);
  room.currentIdx = room.presidentIdx;

  // 强人分配：全局仅 1 名强人（随机民粹/独裁）
  const strongIdx = randInt(room.players.length);
  const strongType = randInt(2) === 0 ? ROLE.POPULIST : ROLE.AUTOCRAT;
  room.players.forEach((p, i) => p.role = (i === strongIdx ? strongType : ROLE.NORMAL));

  room.currentAgenda = drawAgenda(room);
  room.allianceBonusUsedThisTurn.clear();
  room.challenges.clear();
  room.allianceOffer = null;
  room.votes.clear();
  room.crisisContrib.clear();
  room.coup = null;

  room.actedThisTurn = new Set();
  room.reactionContext = null;

  log(room, `🎲 游戏开始！总统：${room.players[room.presidentIdx].name}（回合${room.turn}/${MAX_TURNS}）`);
  log(room, `📰 本回合议题：${room.currentAgenda.name} —— ${room.currentAgenda.text}`);
  log(room, `⏳ 密谋阶段 30 秒：选暗置牌 + 选声明标签（可质疑）`);

  dealHands(room);
  broadcastState(room);
  maybeRunAI(room);
}

function advanceRound(room) {
  room.turn += 1;
  room.allianceBonusUsedThisTurn.clear();
  room.challenges.clear();
  room.allianceOffer = null;
  room.votes.clear();
  room.crisisContrib.clear();
  room.coup = null;

  room.actedThisTurn = new Set();
  room.reactionContext = null;

  room.presidentIdx = (room.presidentIdx + 1) % room.players.length;
  room.currentIdx = room.presidentIdx;

  room.currentAgenda = drawAgenda(room);

  room.players.forEach(p => {
    p.facedownId = null;
    p.declTag = "BLUFF";
    p.declText = "";
    p.cancelNextTLoss = false;
  });

  room.phase = PHASE.PLOTTING;
  room.phaseEndsAt = now() + 30000;

  log(room, `🔁 新回合：总统：${room.players[room.presidentIdx].name}（回合${room.turn}/${MAX_TURNS}）`);
  log(room, `📰 本回合议题：${room.currentAgenda.name} —— ${room.currentAgenda.text}`);
  log(room, `⏳ 密谋阶段 30 秒：选暗置牌 + 选声明标签（可质疑）`);

  dealHands(room);
  broadcastState(room);
  maybeRunAI(room);
}

function moveToActionPhase(room) {
  room.phase = PHASE.ACTION;
  room.phaseEndsAt = null;
  room.currentIdx = room.presidentIdx;

  room.actedThisTurn = new Set();
  room.reactionContext = null;

  room.players.forEach(p => {
    if (!p.facedownId && p.hand.length > 0) {
      p.facedownId = p.hand[0].id;
      if (!p.declTag) p.declTag = "BLUFF";
    }
  });

  log(room, `🎭 进入公开行动阶段：按顺序每人一次行动。`);
  broadcastState(room);
  maybeRunAI(room);
}

// ——关键修复：结束行动要明确“谁结束了”——
function finishAction(room, actorId) {
  if (actorId) room.actedThisTurn.add(actorId);

  if (room.actedThisTurn.size >= room.players.length) {
    room.phase = PHASE.VOTE;
    room.phaseEndsAt = now() + 20000;
    log(room, `🗳️ 进入投票阶段（20秒）：对议题投 YES/NO/ABSTAIN`);
    broadcastState(room);
    maybeRunAI(room);
    return;
  }

  const actorIdx = idxOf(room, actorId);
  const base = actorIdx >= 0 ? actorIdx : room.currentIdx;
  room.currentIdx = nextUnactedIdx(room, base);

  room.phase = PHASE.ACTION;
  room.phaseEndsAt = null;

  broadcastState(room);
  maybeRunAI(room);
}

function moveToCrisis(room) {
  room.phase = PHASE.CRISIS;
  room.phaseEndsAt = now() + 15000;
  log(room, `🚨 危机阶段（15秒）：自愿贡献筹码应对（目标 ${room.currentAgenda.crisisNeed}）。`);
  broadcastState(room);
  maybeRunAI(room);
}

function cleanupAndMaybeAdvance(room) {
  room.phase = PHASE.CLEANUP;
  room.phaseEndsAt = null;

  room.players.forEach(p => {
    while (p.hand.length > HAND_SIZE) {
      const drop = p.hand.pop();
      room.actionDiscard.push(drop);
    }
  });

  if (checkWin(room)) return;

  if (room.turn >= MAX_TURNS) {
    const sorted = room.players.slice().sort((a, b) => (b.S - a.S) || (b.T - a.T) || (b.M - a.M));
    const w = sorted[0];
    endGame(room, `${w.name}（时间到胜出）`, `回合到点，按支持/稳定/筹码结算最高者胜。`);
    return;
  }

  advanceRound(room);
}

/** -----------------------------
 * AI
 * ------------------------------ */
function aiChooseDeclTagFromCard(card) {
  if (!card) return "BLUFF";
  return card.tag || "BLUFF";
}

function aiPickTarget(room, meId) {
  const others = room.players.filter(p => p.id !== meId);
  if (others.length === 0) return null;
  return others.slice().sort((a, b) => b.S - a.S)[0].id;
}

function aiMaybeChallenge(room, ai) {
  if (room.phase !== PHASE.PLOTTING) return;
  if (ai.M < 1) return;
  if (Math.random() > 0.25) return;
  const target = room.players.find(p => p.id !== ai.id && p.M >= 1);
  if (!target) return;
  if (canChallenge(room, ai.id, target.id)) setChallenge(room, ai.id, target.id);
}

function aiDoPlotting(room) {
  room.players.forEach(p => {
    if (!isAI(p)) return;
    const actionCards = p.hand.filter(c => c.type === "ACTION");
    const pick = actionCards[0] || p.hand[0];
    if (pick) p.facedownId = pick.id;

    const chosen = p.hand.find(c => c.id === p.facedownId);
    p.declTag = aiChooseDeclTagFromCard(chosen);
    p.declText = (p.declTag === "ATTACK") ? "我要搞人" :
                 (p.declTag === "SUPPORT") ? "我要拉支持" :
                 (p.declTag === "MONEY") ? "我要搞筹码" :
                 (p.declTag === "ALLY") ? "我要谈联盟" :
                 (p.declTag === "COUP") ? "我要搞大事" : "我有计划";
  });

  room.players.forEach(p => { if (isAI(p)) aiMaybeChallenge(room, p); });
}

function aiDoAction(room, ai) {
  if (room.phase === PHASE.ACTION && isMyTurn(room, ai.id)) {
    const chk = canLaunchCoup(room, ai);
    if (chk.ok && Math.random() < 0.35) {
      launchCoup(room, ai.id);
      broadcastState(room);
      return;
    }

    if (canPrepCoup(ai) && ai.M >= 1 && (ai.coupW || 0) < 3 && Math.random() < 0.25) {
      prepCoup(room, ai.id);
    }

    const hasAllyCard = ai.hand.find(c => c.effectKey === "OFFER_ALLIANCE" && c.type === "ACTION");
    if (!ai.allianceWith && hasAllyCard && Math.random() < 0.25) {
      const targetId = aiPickTarget(room, ai.id);
      performPlayCard(room, ai.id, hasAllyCard.id, targetId);
      broadcastState(room);
      return;
    }

    if (ai.facedownId) {
      performPlayCard(room, ai.id, ai.facedownId, aiPickTarget(room, ai.id));
      ai.facedownId = null;

      if (room.phase === PHASE.REACTION && room.reactionContext?.type === "ALLIANCE_OFFER") {
        broadcastState(room);
        return;
      }

      room.phase = PHASE.REACTION;
      room.phaseEndsAt = now() + 10000;
      room.reactionContext = { type: "AFTER_ACTION", afterId: ai.id };
      log(room, `⏱️ 反应窗口 10 秒：可打反应牌。`);
      broadcastState(room);
      return;
    }

    // 没牌也算“行动结束”
    finishAction(room, ai.id);
    return;
  }
}

function aiDoReaction(room, ai) {
  if (![PHASE.REACTION, PHASE.COUP_NEGOTIATION, PHASE.COUP_REACTION].includes(room.phase)) return;
  if (!isAI(ai)) return;

  if (room.coup && ai.id !== room.coup.leaderId) {
    const blockCard = ai.hand.find(c =>
      (room.coup.type === "VIOLENT" && c.effectKey === "REACT_BLOCK_VIOLENT") ||
      (room.coup.type === "MILITARY" && c.effectKey === "REACT_BLOCK_MILITARY")
    );
    if (blockCard && Math.random() < 0.6) {
      playReaction(room, ai.id, blockCard.id);
      return;
    }
    if (ai.M >= 2 && Math.random() < 0.55) {
      contributeToCoup(room, ai.id, Math.min(2, ai.M));
      return;
    }
  }

  if (room.allianceOffer && room.reactionContext?.type === "ALLIANCE_OFFER") {
    if (room.allianceOffer.toId === ai.id) {
      if (!ai.allianceWith && Math.random() < 0.5) {
        acceptAlliance(room, ai.id);
      }
    }
  }
}

function aiDoVote(room, ai) {
  if (room.phase !== PHASE.VOTE) return;
  if (room.votes.has(ai.id)) return;

  const a = room.currentAgenda;
  let v = "ABSTAIN";
  if (a && a.id === "A2") v = "YES";
  else if (a && a.id === "A4") v = "YES";
  else v = (Math.random() < 0.45 ? "YES" : (Math.random() < 0.5 ? "NO" : "ABSTAIN"));

  room.votes.set(ai.id, v);
}

function aiDoCrisis(room, ai) {
  if (room.phase !== PHASE.CRISIS) return;
  const need = room.currentAgenda?.crisisNeed || 0;
  const curTotal = sumContrib(room.crisisContrib);
  if (curTotal >= need) return;
  if (ai.M <= 0) return;
  if (Math.random() < 0.4) {
    const amt = Math.min(1, ai.M);
    ai.M -= amt;
    room.crisisContrib.set(ai.id, (room.crisisContrib.get(ai.id) || 0) + amt);
    log(room, `🧾 ${ai.name} 贡献 ${amt} 筹码应对危机。`);
  }
}

function maybeRunAI(room) {
  if (!room.started || room.phase === PHASE.END) return;

  setTimeout(() => {
    if (room.phase === PHASE.PLOTTING) {
      aiDoPlotting(room);
      broadcastState(room);
    }

    if (room.phase === PHASE.ACTION) {
      const cur = room.players[room.currentIdx];
      if (cur && isAI(cur)) {
        aiDoAction(room, cur);
        broadcastState(room);
      }
    }

    if ([PHASE.REACTION, PHASE.COUP_NEGOTIATION, PHASE.COUP_REACTION].includes(room.phase)) {
      room.players.forEach(p => aiDoReaction(room, p));
      broadcastState(room);
    }

    if (room.phase === PHASE.VOTE) {
      room.players.forEach(p => { if (isAI(p)) aiDoVote(room, p); });
      broadcastState(room);
    }

    if (room.phase === PHASE.CRISIS) {
      room.players.forEach(p => { if (isAI(p)) aiDoCrisis(room, p); });
      broadcastState(room);
    }
  }, 350);
}

/** -----------------------------
 * Alliance accept
 * ------------------------------ */
function acceptAlliance(room, playerId) {
  const offer = room.allianceOffer;
  if (!offer) return { ok: false, err: "当前没有联盟提案" };
  if (offer.toId !== playerId) return { ok: false, err: "你不是被提案者" };

  const from = getPlayer(room, offer.fromId);
  const to = getPlayer(room, offer.toId);
  if (!from || !to) return { ok: false, err: "玩家不存在" };
  if (from.allianceWith || to.allianceWith) return { ok: false, err: "双方之一已有联盟" };

  from.allianceWith = to.id;
  to.allianceWith = from.id;
  log(room, `🤝 联盟成立：${from.name} ⇄ ${to.name}（共享红利/连坐伤害）`);

  room.allianceOffer = null;
  return { ok: true };
}

function cancelAllianceOffer(room) {
  if (!room.allianceOffer) return;
  const from = getPlayer(room, room.allianceOffer.fromId);
  const to = getPlayer(room, room.allianceOffer.toId);
  log(room, `🤝 联盟提案过期：${from?.name || "?"} → ${to?.name || "?"}`);
  room.allianceOffer = null;
}

/** -----------------------------
 * Player actions
 * ------------------------------ */
function performPlayCard(room, playerId, cardId, targetId = null) {
  const p = getPlayer(room, playerId);
  if (!p) return { ok: false, err: "玩家不存在" };

  const card = removeCardFromHand(p, cardId);
  if (!card) return { ok: false, err: "手牌不存在" };
  if (card.type !== "ACTION") {
    p.hand.push(card);
    return { ok: false, err: "这不是行动牌" };
  }

  log(room, `▶️ ${p.name} 打出「${card.name}」`);
  const actualTag = resolveActionCard(room, playerId, card, targetId);

  resolveChallengeIfAny(room, playerId, actualTag);

  if (checkWin(room)) return { ok: true };

  if (room.phase === PHASE.REACTION && room.reactionContext?.type === "ALLIANCE_OFFER") {
    return { ok: true, holdTurn: true };
  }

  return { ok: true };
}

function playerAction(room, playerId, action, payload) {
  if (!room.started) return { ok: false, err: "游戏未开始" };

  if (room.phase !== PHASE.ACTION) return { ok: false, err: "当前不是行动阶段" };
  if (!isMyTurn(room, playerId)) return { ok: false, err: "还没轮到你" };

  const actor = getPlayer(room, playerId);
  if (!actor) return { ok: false, err: "玩家不存在" };

  if (action === "PLAY_FACEDOWN") {
    if (!actor.facedownId) return { ok: false, err: "你没有暗置牌" };
    const targetId = payload?.targetId || null;
    const res = performPlayCard(room, playerId, actor.facedownId, targetId);
    actor.facedownId = null;

    if (res.ok && !res.holdTurn) {
      room.phase = PHASE.REACTION;
      room.phaseEndsAt = now() + 10000;
      room.reactionContext = { type: "AFTER_ACTION", afterId: playerId };
      log(room, `⏱️ 反应窗口 10 秒：可打反应牌。`);
      return { ok: true };
    }
    return res;
  }

  if (action === "PREP_COUP") {
    const r = prepCoup(room, playerId);
    if (!r.ok) return r;

    room.phase = PHASE.REACTION;
    room.phaseEndsAt = now() + 8000;
    room.reactionContext = { type: "AFTER_ACTION", afterId: playerId };
    log(room, `⏱️ 反应窗口 8 秒：可打反应牌。`);
    return { ok: true };
  }

  if (action === "LAUNCH_COUP") {
    const r = launchCoup(room, playerId);
    if (!r.ok) return r;
    return { ok: true };
  }

  if (action === "BREAK_ALLIANCE") {
    const allyId = actor.allianceWith;
    if (!allyId) return { ok: false, err: "你没有盟友" };
    const ally = getPlayer(room, allyId);
    if (ally) ally.allianceWith = null;
    actor.allianceWith = null;
    log(room, `💥 ${actor.name} 单方面断盟。`);

    room.phase = PHASE.REACTION;
    room.phaseEndsAt = now() + 8000;
    room.reactionContext = { type: "AFTER_ACTION", afterId: playerId };
    return { ok: true };
  }

  return { ok: false, err: "未知行动" };
}

/** -----------------------------
 * Timers / phase transitions
 * ------------------------------ */
function tickRooms() {
  const t = now();
  for (const room of rooms.values()) {
    if (!room.started) continue;
    if (room.phase === PHASE.END) continue;

    // 政变到点
    if (room.coup && t >= room.coup.endsAt) {
      finalizeCoup(room);
      continue;
    }

    // 联盟提案到点（如果正在等联盟 REACTION，直接结算提案者行动结束）
    if (room.allianceOffer && t >= room.allianceOffer.expiresAt) {
      if (room.phase === PHASE.REACTION && room.reactionContext?.type === "ALLIANCE_OFFER") {
        const actorId = room.reactionContext.fromId;
        cancelAllianceOffer(room);
        room.reactionContext = null;
        finishAction(room, actorId);
        continue;
      } else {
        cancelAllianceOffer(room);
      }
    }

    if (!room.phaseEndsAt) continue;
    if (t < room.phaseEndsAt) continue;

    // phase timeout transitions
    if (room.phase === PHASE.PLOTTING) {
      moveToActionPhase(room);
      continue;
    }

    if (room.phase === PHASE.REACTION) {
      if (room.reactionContext?.type === "ALLIANCE_OFFER") {
        const actorId = room.reactionContext.fromId;
        cancelAllianceOffer(room);
        room.reactionContext = null;
        finishAction(room, actorId);
        continue;
      }

      if (room.reactionContext?.type === "AFTER_ACTION") {
        const actorId = room.reactionContext.afterId;
        room.reactionContext = null;
        finishAction(room, actorId);
        continue;
      }
    }

    if (room.phase === PHASE.VOTE) {
      resolveVote(room);
      moveToCrisis(room);
      continue;
    }

    if (room.phase === PHASE.CRISIS) {
      resolveCrisis(room);
      cleanupAndMaybeAdvance(room);
      continue;
    }
  }
}

setInterval(tickRooms, 250);

/** -----------------------------
 * WebSocket protocol
 * ------------------------------ */
function addHuman(room, ws, name) {
  const id = `H${now()}_${Math.random().toString(16).slice(2, 6)}`;
  room.players.push({
    id, name: name.slice(0, 18), kind: "human", ws,
    hand: [],
    role: ROLE.NORMAL,
  });
  return id;
}

function addAI(room) {
  const id = `A${now()}_${Math.random().toString(16).slice(2, 6)}`;
  room.players.push({
    id, name: `AI_${room.players.length + 1}`, kind: "ai",
    ws: null,
    hand: [],
    role: ROLE.NORMAL,
  });
  return id;
}

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    const type = data.type;
    const roomId = data.roomId;

    if (type === "join") {
      const room = getRoom(roomId);
      const name = (data.name || "玩家").trim();

      const humanCount = room.players.filter(isHuman).length;
      if (humanCount >= 2) {
        safeSend(ws, { type: "error", message: "房间已满（最多2名真人）" });
        return;
      }

      const pid = addHuman(room, ws, name);
      ws._roomId = roomId;
      ws._playerId = pid;

      log(room, `👤 ${name} 加入房间。`);
      safeSend(ws, { type: "joined", playerId: pid, state: publicState(room) });
      safeSend(ws, { type: "private", state: privateState(room, pid) });
      broadcastState(room);
      return;
    }

    if (type === "add_ai") {
      const room = getRoom(roomId);
      if (room.started) { safeSend(ws, { type: "error", message: "游戏已开始，不能加AI" }); return; }
      const count = clamp(Number(data.count || 1), 1, 3);
      for (let i = 0; i < count; i++) addAI(room);
      log(room, `🤖 添加 AI x${count}`);
      broadcastState(room);
      return;
    }

    if (type === "start") {
      const room = getRoom(roomId);
      if (room.started) return;
      if (room.players.length < 2) { safeSend(ws, { type: "error", message: "至少需要2名玩家（可加AI）" }); return; }
      startGame(room);
      return;
    }

    if (type === "plot_set_facedown") {
      const room = getRoom(roomId);
      const pid = ws._playerId;
      const p = getPlayer(room, pid);
      if (!room.started || room.phase !== PHASE.PLOTTING) { safeSend(ws, { type: "error", message: "当前不是密谋阶段" }); return; }
      if (!p) return;
      const cardId = data.cardId;
      if (!p.hand.find(c => c.id === cardId)) { safeSend(ws, { type: "error", message: "你没有这张牌" }); return; }
      p.facedownId = cardId;
      broadcastState(room);
      return;
    }

    if (type === "plot_set_declaration") {
      const room = getRoom(roomId);
      const pid = ws._playerId;
      const p = getPlayer(room, pid);
      if (!room.started || room.phase !== PHASE.PLOTTING) { safeSend(ws, { type: "error", message: "当前不是密谋阶段" }); return; }
      if (!p) return;
      const tag = String(data.tag || "BLUFF");
      const okTag = DECL_TAGS.some(x => x.key === tag) ? tag : "BLUFF";
      p.declTag = okTag;
      p.declText = String(data.text || "").slice(0, 60);
      log(room, `📝 ${p.name} 声明：${okTag}${p.declText ? " - " + p.declText : ""}`);
      broadcastState(room);
      return;
    }

    if (type === "challenge") {
      const room = getRoom(roomId);
      const pid = ws._playerId;
      if (!room.started || room.phase !== PHASE.PLOTTING) { safeSend(ws, { type: "error", message: "质疑只能在密谋阶段发起" }); return; }
      const targetId = data.targetId;
      if (!canChallenge(room, pid, targetId)) { safeSend(ws, { type: "error", message: "无法质疑（筹码不足/重复质疑/目标不合法）" }); return; }
      setChallenge(room, pid, targetId);
      broadcastState(room);
      return;
    }

    if (type === "action") {
      const room = getRoom(roomId);
      const pid = ws._playerId;
      const res = playerAction(room, pid, data.actionKey, data.payload || {});
      if (!res.ok) safeSend(ws, { type: "error", message: res.err });
      broadcastState(room);
      maybeRunAI(room);
      return;
    }

    if (type === "vote") {
      const room = getRoom(roomId);
      const pid = ws._playerId;
      if (!room.started || room.phase !== PHASE.VOTE) { safeSend(ws, { type: "error", message: "当前不是投票阶段" }); return; }
      const choice = String(data.choice || "ABSTAIN");
      const v = ["YES", "NO", "ABSTAIN"].includes(choice) ? choice : "ABSTAIN";
      room.votes.set(pid, v);
      log(room, `🗳️ ${getPlayer(room, pid)?.name || "玩家"} 投票：${v}`);
      broadcastState(room);
      return;
    }

    if (type === "crisis_contribute") {
      const room = getRoom(roomId);
      const pid = ws._playerId;
      if (!room.started || room.phase !== PHASE.CRISIS) { safeSend(ws, { type: "error", message: "当前不是危机阶段" }); return; }
      const p = getPlayer(room, pid);
      if (!p) return;
      const amt = clamp(Number(data.amount || 0), 0, 10);
      if (amt <= 0) { safeSend(ws, { type: "error", message: "贡献必须>0" }); return; }
      if (p.M < amt) { safeSend(ws, { type: "error", message: "筹码不足" }); return; }
      p.M -= amt;
      room.crisisContrib.set(pid, (room.crisisContrib.get(pid) || 0) + amt);
      log(room, `🧾 ${p.name} 贡献 ${amt} 筹码应对危机。`);
      broadcastState(room);
      return;
    }

    if (type === "coup_contribute") {
      const room = getRoom(roomId);
      const pid = ws._playerId;
      if (!room.started || ![PHASE.COUP_NEGOTIATION, PHASE.COUP_REACTION].includes(room.phase)) {
        safeSend(ws, { type: "error", message: "当前不是政变阻止阶段" }); return;
      }
      const res = contributeToCoup(room, pid, data.amount);
      if (!res.ok) safeSend(ws, { type: "error", message: res.err });
      broadcastState(room);
      maybeRunAI(room);
      return;
    }

    if (type === "reaction") {
      const room = getRoom(roomId);
      const pid = ws._playerId;
      const res = playReaction(room, pid, data.cardId);
      if (!res.ok) safeSend(ws, { type: "error", message: res.err });
      broadcastState(room);
      maybeRunAI(room);
      return;
    }

    if (type === "accept_alliance") {
      const room = getRoom(roomId);
      const pid = ws._playerId;
      if (!room.started || room.phase !== PHASE.REACTION || !room.allianceOffer) {
        safeSend(ws, { type: "error", message: "当前没有可接受的联盟提案" }); return;
      }
      const res = acceptAlliance(room, pid);
      if (!res.ok) {
        safeSend(ws, { type: "error", message: res.err });
        broadcastState(room);
        return;
      }

      // 接受后：结算“提案者”的行动结束，轮到下一个未行动者
      if (room.reactionContext?.type === "ALLIANCE_OFFER") {
        const actorId = room.reactionContext.fromId;
        room.reactionContext = null;
        finishAction(room, actorId);
        return; // finishAction 已广播
      }

      broadcastState(room);
      return;
    }

    if (type === "chat") {
      const room = getRoom(roomId);
      const pid = ws._playerId;
      const p = getPlayer(room, pid);
      if (!p) return;
      const text = String(data.text || "").slice(0, 200);
      log(room, `💬 ${p.name}: ${text}`);
      broadcastState(room);
      return;
    }

    if (type === "ping_state") {
      const room = getRoom(roomId);
      safeSend(ws, { type: "state", state: publicState(room) });
      safeSend(ws, { type: "private", state: privateState(room, ws._playerId) });
      return;
    }
  });

  ws.on("close", () => {
    const roomId = ws._roomId;
    const pid = ws._playerId;
    if (!roomId || !pid) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const idx = room.players.findIndex(p => p.id === pid);
    if (idx >= 0) {
      const name = room.players[idx].name;
      room.players.splice(idx, 1);
      log(room, `👋 ${name} 断开连接。`);

      if (room.players.length === 0) {
        rooms.delete(roomId);
      } else {
        endGame(room, "对局终止", "有人离开房间。");
      }
    }
  });
});

console.log(`✅ Server running on ws://localhost:${PORT}`);
