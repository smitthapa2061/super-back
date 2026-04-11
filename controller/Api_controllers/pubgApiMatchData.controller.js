const axios = require('axios');
const crypto = require('crypto');
const mongoose = require('mongoose');
const MatchSelection = require('../../models/MatchSelection.model');
const MatchData = require('../../models/matchData.model');
const Round = require('../../models/round.model');
const Group = require('../../models/group.model');
const updateTeamsWithApiPlayers = require('./playerCheckandSwitch');
const { getSocket } = require('../../socket');
const { computeOverallMatchDataForRound } = require('../overall.controller');

// ─── MD5 Hash Comparison ──────────────────────────────────────────────────────
const quickHash = (obj) =>
  crypto.createHash('md5').update(JSON.stringify(obj)).digest('hex');

// ─── In-Memory Live Match Cache ───────────────────────────────────────────────
const liveMatchCache = new Map();

// ─── Background Save Queue ────────────────────────────────────────────────────
const saveQueue = [];
let isSaving = false;

// ─── Background Save Worker ───────────────────────────────────────────────────
async function processSaveQueue() {
  if (isSaving) return;
  isSaving = true;

  while (saveQueue.length > 0) {
    const job = saveQueue.shift();
    try {
      await MatchData.updateOne(
        { matchId: job.matchId, userId: job.userId },
        { $set: { teams: job.teams } }
      );
      console.log(c('green', `💾 Saved in background → ${job.matchId}`));
    } catch (err) {
      console.error('Background save error:', err.message);
    }
  }

  isSaving = false;
}

// ─── One-time Index Setup ─────────────────────────────────────────────────────
const ensureIndexes = async () => {
  try {
    const db = mongoose.connection.db;

    await db.collection('matchdatas').createIndex(
      { matchId: 1, userId: 1 },
      { background: true, name: 'matchId_userId' }
    );
    await db.collection('matchselections').createIndex(
      { matchId: 1, isSelected: 1, userId: 1 },
      { background: true, name: 'matchId_isSelected_userId' }
    );
    await db.collection('matchselections').createIndex(
      { isSelected: 1, userId: 1, roundId: 1 },
      { background: true, name: 'isSelected_userId_roundId' }
    );
    await db.collection('matchselections').createIndex(
      { isSelected: 1, isPollingActive: 1, roundId: 1 },
      { background: true, name: 'isSelected_isPollingActive_roundId' }
    );
    await db.collection('rounds').createIndex(
      { apiEnable: 1 },
      { background: true, name: 'apiEnable' }
    );
    await db.collection('groups').createIndex(
      { tournamentId: 1, userId: 1 },
      { background: true, name: 'tournamentId_userId' }
    );

    console.log(c('green', '✔ MongoDB indexes ensured'));
  } catch (err) {
    console.warn('Index setup warning (non-fatal):', err.message);
  }
};

// ─── Console Logger Utility ───────────────────────────────────────────────────
const chalk = {
  reset:    '\x1b[0m',
  bold:     '\x1b[1m',
  dim:      '\x1b[2m',
  red:      '\x1b[31m',
  green:    '\x1b[32m',
  yellow:   '\x1b[33m',
  cyan:     '\x1b[36m',
  white:    '\x1b[37m',
  bgRed:    '\x1b[41m',
  bgGreen:  '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue:   '\x1b[44m',
};
const c = (color, text) => `${chalk[color]}${text}${chalk.reset}`;

// ─── Log Diff ─────────────────────────────────────────────────────────────────
function logMatchDiff(matchId, lastData, currentData) {
  const timestamp = new Date().toLocaleTimeString();
  const changes = [];

  currentData.teams.forEach((team, ti) => {
    const lastTeam = lastData?.teams?.[ti];
    const tag = team.teamTag || team.teamName || `Slot${team.slot}`;

    if (lastTeam && team.placePoints !== lastTeam.placePoints) {
      changes.push({
        team: tag, slot: team.slot, player: '—', field: 'placePoints',
        old: lastTeam.placePoints, new: team.placePoints
      });
    }

    team.players?.forEach((player, pi) => {
      const lastPlayer = lastTeam?.players?.[pi];
      const TRACKED = [
        'killNum', 'health', 'damage', 'assists', 'knockouts',
        'liveState', 'bHasDied', 'headShotNum', 'survivalTime',
        'rescueTimes', 'inDamage', 'heal', 'rank',
      ];
      TRACKED.forEach(field => {
        const newVal = player[field];
        const oldVal = lastPlayer?.[field];
        if (oldVal !== undefined && newVal !== oldVal) {
          changes.push({
            team: tag,
            slot: team.slot,
            player: player.playerName || player.uId,
            field,
            old: oldVal,
            new: newVal
          });
        }
      });
    });
  });

  if (!changes.length) {
    console.log(`${c('dim', timestamp)} ${c('yellow', '≈')} match=${matchId} — no stat changes`);
    return;
  }

  console.log(`\n${c('bgBlue', c('bold', ` LIVE UPDATE `))} ${c('cyan', matchId)} ${c('dim', `@ ${timestamp}`)}`);
  console.log(c('dim', '─'.repeat(80)));

  const W = { slot: 4, team: 8, player: 18, field: 22, old: 10, new: 10 };
  const row = (slot, team, player, field, oldV, newV) =>
    `  ${String(slot).padStart(W.slot)}  ${String(team).padEnd(W.team)}  ${String(player).padEnd(W.player)}  ${String(field).padEnd(W.field)}  ${String(oldV).padStart(W.old)}  →  ${String(newV).padEnd(W.new)}`;

  console.log(c('dim', row('Slot', 'Team', 'Player', 'Field', 'Before', 'After')));
  console.log(c('dim', '─'.repeat(80)));

  changes.forEach(ch => {
    const isGood   = ['killNum', 'assists', 'knockouts', 'headShotNum', 'heal', 'rescueTimes'].includes(ch.field);
    const isBad    = ['bHasDied', 'liveState'].includes(ch.field) && ch.new > ch.old;
    const isHealth = ch.field === 'health';

    let colored;
    if (isBad)
      colored = c('red',    row(ch.slot, ch.team, ch.player, ch.field, ch.old, ch.new));
    else if (isGood)
      colored = c('green',  row(ch.slot, ch.team, ch.player, ch.field, ch.old, ch.new));
    else if (isHealth && ch.new < ch.old)
      colored = c('yellow', row(ch.slot, ch.team, ch.player, ch.field, ch.old, ch.new));
    else
      colored = row(ch.slot, ch.team, ch.player, ch.field, ch.old, ch.new);

    console.log(colored);
  });

  console.log(c('dim', '─'.repeat(80)));
  console.log(`  ${c('bold', String(changes.length))} change(s) detected\n`);
}

// ─── Log Full Table ───────────────────────────────────────────────────────────
function logFullMatchTable(matchData) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`\n${c('bgGreen', c('bold', ` MATCH SNAPSHOT `))} ${c('cyan', String(matchData.matchId))} ${c('dim', `@ ${timestamp}`)}`);
  console.log(c('dim', '─'.repeat(110)));

  const hdr =
    `  ${'Sl'.padStart(2)}  ${'Team'.padEnd(8)}  ${'Player'.padEnd(18)}` +
    `  ${'HP'.padStart(4)}  ${'Kills'.padStart(5)}  ${'Dmg'.padStart(6)}` +
    `  ${'Assists'.padStart(7)}  ${'KO'.padStart(3)}  ${'State'.padStart(5)}` +
    `  ${'Rank'.padStart(4)}  ${'Died'.padStart(5)}`;
  console.log(c('dim', hdr));
  console.log(c('dim', '─'.repeat(110)));

  matchData.teams?.forEach(team => {
    const tag = team.teamTag || team.teamName || `Slot${team.slot}`;
    team.players?.forEach((p, i) => {
      const died = p.bHasDied ? c('red', 'DEAD ') : c('green', 'ALIVE');
      const hp =
        p.health <= 30 ? c('red',    String(p.health || 0).padStart(4)) :
        p.health <= 70 ? c('yellow', String(p.health || 0).padStart(4)) :
                         String(p.health || 0).padStart(4);
      const line =
        `  ${String(team.slot).padStart(2)}` +
        `  ${(i === 0 ? tag : '').padEnd(8)}` +
        `  ${(p.playerName || p.uId || '?').padEnd(18)}` +
        `  ${hp}` +
        `  ${String(p.killNum   || 0).padStart(5)}` +
        `  ${String(p.damage    || 0).padStart(6)}` +
        `  ${String(p.assists   || 0).padStart(7)}` +
        `  ${String(p.knockouts || 0).padStart(3)}` +
        `  ${String(p.liveState || 0).padStart(5)}` +
        `  ${String(p.rank      || 0).padStart(4)}` +
        `  ${died}`;
      console.log(line);
    });
  });

  console.log(c('dim', '─'.repeat(110)) + '\n');
}

// ─── Polling State ────────────────────────────────────────────────────────────
const userPollState = new Map();
const userKeyToDbId = new Map();
const lastMatchDataByUserMatch = {};
const lastHashByUserMatch = {};

const MIN_INTERVAL        = 2000;
const MAX_INTERVAL        = 15000;
const INITIAL_INTERVAL    = 2000;
const NO_CHANGE_THRESHOLD = 1;

// ─── Main Updater ─────────────────────────────────────────────────────────────
function startLiveMatchUpdater() {
  const io = getSocket();
  console.log('Socket.IO instance connected:', !!io);

  // Always safe guard indexes - only run if DB connected
  if (mongoose.connection.readyState === 1) {
    ensureIndexes();
  } else {
    mongoose.connection.once('open', ensureIndexes);
  }

  const getOrInitUserState = (userKey) => {
    const key = String(userKey);
    let s = userPollState.get(key);
    if (!s) {
      s = { intervalMs: INITIAL_INTERVAL, noChangeCount: 0, timer: null };
      userPollState.set(key, s);
    }
    return s;
  };

  const adjustIntervalForUser = (userKey, hadChanges) => {
    const s = getOrInitUserState(userKey);
    if (hadChanges) {
      s.noChangeCount = 0;
      s.intervalMs = Math.max(MIN_INTERVAL, s.intervalMs - 1000);
    } else {
      s.noChangeCount += 1;
      if (s.noChangeCount >= NO_CHANGE_THRESHOLD) {
        s.intervalMs = Math.min(MAX_INTERVAL, s.intervalMs + 1000);
      }
    }
    console.log(
      `${c('dim', `[${new Date().toLocaleTimeString()}]`)} ${c('cyan', '⏱')} ` +
      `interval=${s.intervalMs / 1000}s  stable=${s.noChangeCount}`
    );
  };

  const scheduleNextUserPoll = (userKey) => {
    const s = getOrInitUserState(userKey);
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(async () => {
      const hadChanges = await pollForUser(userKey);
      adjustIntervalForUser(userKey, hadChanges);
      scheduleNextUserPoll(userKey);
    }, s.intervalMs);
  };

  // ─── Merge Player Data ──────────────────────────────────────────────────────
  const mergePlayerData = (dbPlayer, apiPlayer, groupPlayers = []) => {
    if (!dbPlayer || !apiPlayer) return dbPlayer || apiPlayer;
    const safePic = (pic) => pic && pic.trim() ? pic : undefined;
    const grpPlayer = groupPlayers.find(
      gp => String(gp.playerId).trim() === String(apiPlayer.uId).trim()
    );
    return {
      ...dbPlayer,
      ...apiPlayer,
      _id:           dbPlayer._id,
      uId:           dbPlayer.uId,
      playerName:    dbPlayer.playerName,
      picUrl:        safePic(dbPlayer.picUrl)     || safePic(grpPlayer?.photo) || safePic(apiPlayer.picUrl)     || '',
      showPicUrl:    safePic(dbPlayer.showPicUrl) || safePic(grpPlayer?.photo) || safePic(apiPlayer.showPicUrl) || '',
      teamIdfromApi: apiPlayer.teamId,
      location:      apiPlayer.location || { x: 0, y: 0, z: 0 },
      bHasDied:      apiPlayer.liveState === 5 || dbPlayer.bHasDied
    };
  };

  // ─── Core Match Update ──────────────────────────────────────────────────────
  const updateMatchDataWithLiveStats = async (matchId, userId) => {
    const matchData = await MatchData.findOne({ matchId, userId });
    if (!matchData) {
      console.log('No MatchData found for matchId:', matchId);
      return null;
    }

    const selectedMatch = await MatchSelection.findOne({ matchId, isSelected: true, userId });
    const tournamentId = selectedMatch?.tournamentId;
    if (!tournamentId) {
      console.log('Cannot find tournamentId for matchId:', matchId);
      return null;
    }

    const group = await Group.findOne({ tournamentId, userId }).populate('slots.team');
    if (!group) {
      console.log('No group found for tournament:', tournamentId.toString());
      return null;
    }

    // Fetch API players
    const PUBG_API_URL = process.env.PUBG_API_URL || 'http://localhost:10086';
    let apiPlayers = [];
    try {
      const playersRes = await axios.get(`${PUBG_API_URL}/gettotalplayerlist`, { timeout: 5000 });
      apiPlayers = playersRes.data.playerInfoList || [];
    } catch (err) {
      console.warn(`⚠️  Could not connect to PUBG API at ${PUBG_API_URL}:`, err.code);
      console.log('Continuing without API data...');
      return matchData.toObject();
    }

    await updateTeamsWithApiPlayers(apiPlayers, matchId, userId);

    const normalizeId = id => (id ? String(id).trim() : '');

    for (const team of matchData.teams) {
      const newTeamPlayers = [];
      const usedUIds = new Set();

      const groupSlot      = group.slots.find(s => s.team?._id.toString() === team.teamId.toString());
      const groupPlayers   = groupSlot?.team?.players || [];
      const teamApiPlayers = apiPlayers.filter(p => Number(p.teamId) === Number(team.slot));
      const matchDataByUid = new Map((team.players || []).map(p => [normalizeId(p.uId), p]));

      for (const apiPlayer of teamApiPlayers) {
        if (newTeamPlayers.length >= 4) break;
        const uid = normalizeId(apiPlayer.uId);
        if (usedUIds.has(uid)) continue;

        const matchPlayer = matchDataByUid.get(uid);
        const grpPlayer   = groupPlayers.find(p => normalizeId(p.playerId) === uid);

        let finalPlayer;
        if (matchPlayer || grpPlayer) {
          finalPlayer = {
            ...apiPlayer,
            _id:                   new mongoose.Types.ObjectId(),
            uId:                   uid,
            playerOpenId:          matchPlayer?.playerOpenId  || grpPlayer?.playerOpenId  || apiPlayer.playerOpenId || '',
            playerName:            matchPlayer?.playerName?.trim() || grpPlayer?.playerName?.trim() || apiPlayer.playerName,
            picUrl:                matchPlayer?.picUrl?.trim() || grpPlayer?.photo?.trim() || apiPlayer.picUrl || '',
            showPicUrl:            '',
            teamIdfromApi:         team.slot,
            location:              apiPlayer.location || { x: 0, y: 0, z: 0 },
            bHasDied:              apiPlayer.liveState === 5,
            health:                apiPlayer.health               || 0,
            healthMax:             apiPlayer.healthMax            || 100,
            liveState:             apiPlayer.liveState            || 0,
            killNum:               apiPlayer.killNum              || 0,
            killNumBeforeDie:      apiPlayer.killNumBeforeDie     || 0,
            damage:                apiPlayer.damage               || 0,
            assists:               apiPlayer.assists              || 0,
            knockouts:             apiPlayer.knockouts            || 0,
            headShotNum:           apiPlayer.headShotNum          || 0,
            survivalTime:          apiPlayer.survivalTime         || 0,
            isFiring:              apiPlayer.isFiring             || false,
            isOutsideBlueCircle:   apiPlayer.isOutsideBlueCircle || false,
            inDamage:              apiPlayer.inDamage             || 0,
            driveDistance:         apiPlayer.driveDistance        || 0,
            marchDistance:         apiPlayer.marchDistance        || 0,
            outsideBlueCircleTime: apiPlayer.outsideBlueCircleTime|| 0,
            rescueTimes:           apiPlayer.rescueTimes          || 0,
            gotAirDropNum:         apiPlayer.gotAirDropNum        || 0,
            maxKillDistance:       apiPlayer.maxKillDistance      || 0,
            killNumInVehicle:      apiPlayer.killNumInVehicle     || 0,
            killNumByGrenade:      apiPlayer.killNumByGrenade     || 0,
            AIKillNum:             apiPlayer.AIKillNum            || 0,
            BossKillNum:           apiPlayer.BossKillNum          || 0,
            useSmokeGrenadeNum:    apiPlayer.useSmokeGrenadeNum   || 0,
            useFragGrenadeNum:     apiPlayer.useFragGrenadeNum    || 0,
            useBurnGrenadeNum:     apiPlayer.useBurnGrenadeNum    || 0,
            useFlashGrenadeNum:    apiPlayer.useFlashGrenadeNum   || 0,
            PoisonTotalDamage:     apiPlayer.PoisonTotalDamage    || 0,
            UseSelfRescueTime:     apiPlayer.UseSelfRescueTime    || 0,
            UseEmergencyCallTime:  apiPlayer.UseEmergencyCallTime || 0,
            heal:                  apiPlayer.heal                 || 0,
            teamId:                apiPlayer.teamId,
            teamName:              apiPlayer.teamName             || '',
            character:             apiPlayer.character            || 'None',
            playerKey:             apiPlayer.playerKey            || 0,
          };
        } else {
          finalPlayer = {
            ...apiPlayer,
            _id:           new mongoose.Types.ObjectId(),
            uId:           uid,
            teamIdfromApi: team.slot,
            location:      apiPlayer.location || { x: 0, y: 0, z: 0 },
            bHasDied:      apiPlayer.liveState === 5,
            picUrl:        apiPlayer.picUrl || '',
            showPicUrl:    '',
            playerName:    apiPlayer.playerName,
          };
        }

        newTeamPlayers.push(finalPlayer);
        usedUIds.add(uid);
      }

      // Assign placePoints from rank
      const teamRank = newTeamPlayers.length
        ? Math.min(...newTeamPlayers.map(p => p.rank || 0))
        : 0;

      team.placePoints = ((rank) => {
        switch (rank) {
          case 1: return 10;
          case 2: return 6;
          case 3: return 5;
          case 4: return 4;
          case 5: return 3;
          case 6: return 2;
          case 7: return 1;
          case 8: return 1;
          default: return 0;
        }
      })(teamRank);

      team.players = newTeamPlayers;
    }

    // ── Store in memory immediately (no await DB save here) ──────────────────
    const updatedObject = matchData.toObject();
    const cacheKey = `${String(userId)}:${String(matchId)}`;
    liveMatchCache.set(cacheKey, updatedObject);

    // ── Push to background save queue ────────────────────────────────────────
    saveQueue.push({
      matchId,
      userId,
      teams: updatedObject.teams,
    });

    // Kick off background saver (non-blocking)
    processSaveQueue();

    return updatedObject;
  };

  // ─── Per-User Poller ────────────────────────────────────────────────────────
  const pollForUser = async (userKey) => {
    if (!userKey) {
      console.log('[POLL] No userKey provided, skipping');
      return false;
    }

    if (mongoose.connection.readyState !== 1) {
      console.log(`[POLL user ${userKey}] DB not ready, skipping`);
      return false;
    }

    let hadChanges = false;
    const dbUserId =
      userKeyToDbId.get(String(userKey)) ||
      (mongoose.Types.ObjectId.isValid(String(userKey))
        ? new mongoose.Types.ObjectId(String(userKey))
        : userKey);

    try {
      const apiEnabledRounds = await Round.find({ apiEnable: true });
      if (!apiEnabledRounds.length) {
        console.log(`[user ${userKey}] No rounds with API enabled`);
        return false;
      }

      const roundIds = apiEnabledRounds.map(r => r._id.toString());
      const selectedMatches = await MatchSelection.find({
        isSelected: true,
        userId:     dbUserId,
        roundId:    { $in: roundIds }
      });

      if (!selectedMatches.length) {
        console.log(`[user ${userKey}] No selected matches in API-enabled rounds`);
        return false;
      }

      for (const selected of selectedMatches) {
        const selUserId = selected.userId;

        if (!selected.isPollingActive) {
          console.log(`[user ${userKey}] Polling not active for match: ${selected.matchId}`);
          continue;
        }

        const updatedMatchData = await updateMatchDataWithLiveStats(selected.matchId, selUserId);
        if (!updatedMatchData) continue;

        // Read from memory cache (already stored by updateMatchDataWithLiveStats)
        const cacheKey    = `${String(userKey)}:${String(selected.matchId)}`;
        const memoryMatch = liveMatchCache.get(cacheKey) || updatedMatchData;

        const snapshotKey  = `${String(userKey)}:${String(selected.matchId)}`;
        const currentData  = memoryMatch;
        const currentHash  = quickHash(currentData);
        const lastHash     = lastHashByUserMatch[snapshotKey];
        const lastData     = lastMatchDataByUserMatch[snapshotKey];

        // Helper: emit socket events immediately from memory
        const emitUpdates = async () => {
          // Emit live match data straight from memory — no DB round-trip
          io.emit('liveMatchUpdate', memoryMatch);
          try {
            const overallTeams = await computeOverallMatchDataForRound(
              selected.tournamentId, selected.roundId, selected.matchId, selUserId
            );
            io.emit('overallDataUpdate', {
              tournamentId: selected.tournamentId,
              roundId:      selected.roundId,
              matchId:      selected.matchId,
              teams:        overallTeams,
              createdAt:    new Date()
            });
          } catch (overallError) {
            console.warn('Failed to compute overall data:', overallError.message);
          }
        };

        if (!lastHash) {
          // First load — show full snapshot table
          logFullMatchTable(memoryMatch);
          await emitUpdates();
          lastMatchDataByUserMatch[snapshotKey] = currentData;
          lastHashByUserMatch[snapshotKey]      = currentHash;
          hadChanges = true;
        } else if (currentHash !== lastHash) {
          // Hash mismatch — show only what changed
          logMatchDiff(selected.matchId, lastData, currentData);
          await emitUpdates();
          lastMatchDataByUserMatch[snapshotKey] = currentData;
          lastHashByUserMatch[snapshotKey]      = currentHash;
          hadChanges = true;
        } else {
          // Hashes match — no changes
          console.log(
            `${c('dim', `[${new Date().toLocaleTimeString()}]`)} ` +
            `${c('yellow', '≈')} match=${selected.matchId} — no changes`
          );
        }
      }
    } catch (err) {
      console.error(`[user ${userKey}] Poll error:`, err);
    }

    return hadChanges;
  };

  // ─── User Discovery ─────────────────────────────────────────────────────────
  const discoverAndStartPollingUsers = async () => {
    try {
      if (mongoose.connection.readyState !== 1) {
        console.log('[discovery] DB not ready, skipping');
        return;
      }
      const apiEnabledRounds = await Round.find({ apiEnable: true });
      if (!apiEnabledRounds.length) {
        console.log('[discovery] No API-enabled rounds found');
        return;
      }

      const roundIds = apiEnabledRounds.map(r => r._id.toString());
      const selectedMatches = await MatchSelection.find({
        isSelected:      true,
        userId:          { $exists: true, $ne: null },
        roundId:         { $in: roundIds },
        isPollingActive: true,
      });

      const activeUserKeys = [];
      for (const s of selectedMatches) {
        const key = String(s.userId);
        userKeyToDbId.set(key, s.userId);
        activeUserKeys.push(key);
      }

      const activeUserIds = [...new Set(activeUserKeys)];

      // Start polling for newly active users
      for (const uid of activeUserIds) {
        const state = getOrInitUserState(uid);
        if (!state.timer) {
          console.log(`[discovery] FETCHER STARTED → ${uid}`);
          scheduleNextUserPoll(uid);
        }
      }

      // Pause polling for users no longer active
      for (const existingUid of Array.from(userPollState.keys())) {
        if (!activeUserIds.includes(existingUid)) {
          const st = userPollState.get(existingUid);
          if (st?.timer) {
            clearTimeout(st.timer);
            st.timer = null;
          }
          st.noChangeCount = 0;
          st.intervalMs    = MAX_INTERVAL;
          console.log(`[discovery] FETCHER STOPPED → ${existingUid}`);
        }
      }
    } catch (e) {
      console.error('[discovery] Error:', e);
    }
  };

  // ─── Background Save Interval (flush any leftover jobs) ──────────────────
  setInterval(() => {
    if (saveQueue.length > 0) {
      processSaveQueue();
    }
  }, 2000);

  // Boot
  discoverAndStartPollingUsers();
  setInterval(discoverAndStartPollingUsers, 10000);
}

module.exports = { startLiveMatchUpdater };
