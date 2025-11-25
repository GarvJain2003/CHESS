import React, { useState, useEffect, useMemo, useCallback, useRef, lazy, Suspense } from 'react';
import { Chess } from 'chess.js';
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  onSnapshot,
  collection,
  query,
  where,
  updateDoc,
  getDocs,
  getDoc,
  orderBy,
  limit,
  serverTimestamp,
  arrayUnion,
  addDoc,
  deleteDoc,
  runTransaction
} from 'firebase/firestore';
const Chessboard = lazy(() => import('react-chessboard').then((mod) => ({ default: mod.Chessboard })));
import { ConnectBoardModal } from './ConnectBoardModal';

// --- Firebase Configuration ---
const firebaseConfig = {
  apiKey: import.meta.env.VITE_API_KEY,
  authDomain: import.meta.env.VITE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_APP_ID,
  measurementId: import.meta.env.VITE_MEASUREMENT_ID
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  componentDidCatch(error, errorInfo) { console.error("Uncaught error:", error, errorInfo); }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gray-900 text-white flex flex-col justify-center items-center p-4">
          <h1 className="text-3xl font-bold text-red-500 mb-4">Something went wrong</h1>
          <pre className="bg-gray-800 p-4 rounded overflow-auto max-w-full text-sm text-red-300">
            {this.state.error?.toString()}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="mt-6 px-6 py-2 bg-indigo-600 rounded hover:bg-indigo-700 transition"
          >
            Reload Application
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// --- Sound Effects Manager (lazy-load Tone) ---
let toneLib = null;
let soundThemesCache = null;
const ensureSoundSystem = async () => {
  if (!toneLib) {
    toneLib = await import('tone');
  }
  try {
    await toneLib.start();
  } catch (err) {
    console.warn('Tone start failed', err);
  }
  if (!soundThemesCache) {
    soundThemesCache = {
      default: {
        synth: new toneLib.PolySynth(toneLib.Synth).toDestination(),
        notes: { move: 'C4', capture: 'A3', check: 'G5', gameOver: ['C5', 'G4'] }
      },
      wooden: {
        synth: new toneLib.PolySynth(toneLib.MembraneSynth, {
          envelope: { attack: 0.01, decay: 0.4, sustain: 0.01, release: 0.4 }
        }).toDestination(),
        notes: { move: 'E2', capture: 'C2', check: 'G4', gameOver: ['C4', 'G3'] }
      },
      arcade: {
        synth: new toneLib.PolySynth(toneLib.FMSynth, {
          harmonicity: 8,
          modulationIndex: 2,
          detune: 0,
          envelope: { attack: 0.01, decay: 0.2, sustain: 0, release: 0.2 }
        }).toDestination(),
        notes: { move: 'C5', capture: 'G4', check: 'B5', gameOver: ['C6', 'G5'] }
      }
    };
  }
  return soundThemesCache;
};

const playSound = (type, settings) => {
  if (!settings.soundEnabled) return;
  ensureSoundSystem()
    .then((soundThemes) => {
      const sound = soundThemes[settings.soundTheme];
      if (!sound) return;
      if (type === 'move') sound.synth.triggerAttackRelease(sound.notes.move, '8n');
      else if (type === 'capture') sound.synth.triggerAttackRelease(sound.notes.capture, '8n');
      else if (type === 'check') sound.synth.triggerAttackRelease(sound.notes.check, '16n');
      else if (type === 'game-over') sound.synth.triggerAttackRelease(sound.notes.gameOver, '4n');
    })
    .catch((error) => {
      console.error('Tone.js error:', error);
    });
};

// --------------------- Utility Hooks & Helpers ---------------------



function nowLabel() {
  return `${new Date().toISOString()}`;
}
function logStep(label, extra = {}) {
  console.debug(`[shatranj] ${nowLabel()} — ${label}`, extra);
}

function makeGameId(userUid) {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch (err) {
    console.warn('Falling back to timestamp-based gameId', err);
  }
  return `${userUid}_${Date.now()}`;
}

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

const ChessboardFallback = ({ className = 'h-96' }) => (
  <div className={`flex items-center justify-center ${className} bg-gray-800 rounded-lg`}>
    <p className="text-gray-300 animate-pulse">Loading board...</p>
  </div>
);

// -----------------------------------------------------------------
// --- Tournament Scoring Helper ---
// -----------------------------------------------------------------

/**
 * Increment a player's score in a tournament. Uses a transaction to ensure safe updates.
 * @param {string} tournamentId The ID of the tournament.
 * @param {string} playerUid The UID of the player whose score to increment.
 * @param {number} increment Amount of points to add (e.g. 1 for win, 0.5 for draw).
 */
async function incrementTournamentScore(tournamentId, playerUid, increment) {
  if (!tournamentId || !playerUid || typeof increment !== 'number') return;
  const tRef = doc(db, 'tournaments', tournamentId);
  try {
    await runTransaction(db, async (tx) => {
      const tDoc = await tx.get(tRef);
      if (!tDoc.exists()) return;
      const data = tDoc.data();
      const scores = data.scores || {};
      const current = scores[playerUid] || 0;
      scores[playerUid] = current + increment;
      tx.update(tRef, { scores });
    });
  } catch (err) {
    console.error('Failed to update tournament score', err);
  }
}

// -----------------------------------------------------------------
// --- Tournament & Game Service Functions ---
// -----------------------------------------------------------------

async function createGame({ player1, player2, timeControl, createdByUid, tournamentId = null, tournamentRound = null, inviteOnly = false }) {
  const gameId = makeGameId(createdByUid);
  const gameRef = doc(db, 'games', gameId);
  const playerIds = [player1.uid];
  if (player2) playerIds.push(player2.uid);
  const gameData = {
    mode: 'online',
    timeControl,
    player1,
    player2,
    playerIds: Array.from(new Set(playerIds)),
    fen: new Chess().fen(),
    moves: [],
    chatMessages: [],
    capturedPieces: { w: [], b: [] },
    status: player2 ? 'active' : 'waiting',
    winner: null,
    winReason: null,
    drawOffer: null,
    rematchOffer: null,
    webrtc_signals: { offer: null, answer: null, iceCandidates: [] },
    createdAt: serverTimestamp(),
    player1Time: timeControl,
    player2Time: timeControl,
    lastMoveTimestamp: serverTimestamp(),
    tournamentId,
    tournamentRound,
    createdByUid,
    inviteOnly,
    spectators: [],
    commentators: [],
    spectatorRequests: {}
  };
  await setDoc(gameRef, gameData);
  logStep('create-game-success', { gameId, tournamentId, status: gameData.status });
  return gameId;
}

async function createTournament({ name, maxPlayers, timeControl, hostUid, hostEmail, hostParticipates = true }) {
  // Initialize a scores map. Only add host if they are participating
  const scores = {};
  const players = [];

  if (hostParticipates) {
    scores[hostUid] = 0;
    players.push({ uid: hostUid, email: hostEmail });
  }

  const ref = await addDoc(collection(db, 'tournaments'), {
    name,
    maxPlayers,
    timeControl,
    createdBy: hostUid,
    players,
    scores,
    status: 'lobby',
    currentRound: 0,
    createdAt: serverTimestamp()
  });
  return ref.id;
}

async function joinTournament({ tournamentId, userUid, userEmail }) {
  const tRef = doc(db, 'tournaments', tournamentId);
  // Use transaction to add player and initialize their score to 0 if not present
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(tRef);
    if (!snap.exists()) return;
    const data = snap.data() || {};
    const players = Array.isArray(data.players) ? [...data.players] : [];
    const maxPlayers = data.maxPlayers || 0;
    // Prevent duplicate join
    if (!players.some((p) => p.uid === userUid)) {
      if (maxPlayers && players.length >= maxPlayers) {
        throw new Error('Tournament is full');
      }
      players.push({ uid: userUid, email: userEmail });
    }
    const scores = data.scores || {};
    if (scores[userUid] == null) {
      scores[userUid] = 0;
    }
    tx.update(tRef, { players, scores });
  });
}

async function startTournament(tournamentId) {
  const tRef = doc(db, 'tournaments', tournamentId);
  const snap = await getDoc(tRef);
  if (!snap.exists()) throw new Error('Tournament not found');
  const tData = snap.data();
  if (tData.status !== 'lobby') throw new Error('Tournament already started');
  let players = tData.players || [];
  if (players.length < 2) throw new Error('Need at least 2 players to start');

  // Initialize scores for ALL players if not already present
  const scores = tData.scores || {};
  players.forEach(p => {
    if (scores[p.uid] === undefined) scores[p.uid] = 0;
  });

  // Swiss System: Round 1 is random or seeded. We'll do random.
  players = shuffle(players);
  const roundIndex = 1;
  const roundRef = doc(tRef, 'rounds', `round_${roundIndex}`);
  await setDoc(roundRef, { index: roundIndex, status: 'ongoing', createdAt: serverTimestamp() });
  const matchesCol = collection(roundRef, 'matches');

  // Pairing Logic
  for (let i = 0; i < players.length; i += 2) {
    const p1 = players[i];
    const p2 = players[i + 1];

    if (!p2) {
      // Bye
      const matchRef = doc(matchesCol);
      await setDoc(matchRef, {
        playerWhite: p1.uid,
        playerBlack: null,
        status: 'completed',
        winnerId: p1.uid,
        isBye: true
      });
      await incrementTournamentScore(tournamentId, p1.uid, 1);
      continue;
    }

    const gameId = await createGame({
      player1: p1,
      player2: p2,
      timeControl: tData.timeControl || 300,
      createdByUid: tData.createdBy,
      tournamentId,
      tournamentRound: roundIndex
    });

    const matchRef = doc(matchesCol);
    await setDoc(matchRef, {
      playerWhite: p1.uid,
      playerBlack: p2.uid,
      gameId,
      status: 'ongoing',
      winnerId: null,
      createdAt: serverTimestamp()
    });
  }

  await updateDoc(tRef, { status: 'ongoing', currentRound: roundIndex, scores });
}

// --- FIX: Transaction-Safe Round Completion ---
// --- FIX: Transaction-Safe Round Completion (Swiss System) ---
async function checkRoundCompletion(tournamentId, roundIndex, tRef, roundRef) {
  const matchesCol = collection(roundRef, 'matches');
  const allMatchesSnap = await getDocs(query(matchesCol));
  const allMatches = allMatchesSnap.docs.map((d) => d.data());
  const completedMatches = allMatches.filter((m) => m.status === 'completed');

  if (allMatches.length === 0 || allMatches.length !== completedMatches.length) {
    logStep('round-not-complete', { roundIndex, completed: completedMatches.length, total: allMatches.length });
    return;
  }

  logStep('round-complete-detected', { roundIndex });

  try {
    // 1. Advance Round State via Transaction
    await runTransaction(db, async (transaction) => {
      const tDoc = await transaction.get(tRef);
      if (!tDoc.exists()) throw "Tournament not found";

      const tData = tDoc.data();
      if (tData.currentRound !== roundIndex) return; // Already processed

      // Determine if tournament should end
      // Simple rule: Max rounds = ceil(log2(N)) + 1 or fixed number. Let's use 3 for small, or log2.
      // For now, let's say if only 1 unbeaten player remains or fixed rounds.
      // Let's use a fixed max rounds based on player count: 4 players -> 3 rounds. 8 players -> 3-4 rounds.
      // Simplified: Stop if roundIndex >= 3 (for demo) or if we have a clear winner?
      // Better: Stop if roundIndex >= Math.ceil(Math.log2(tData.players.length)) + 1
      const maxRounds = Math.ceil(Math.log2(tData.players.length || 2)) + (tData.players.length > 4 ? 1 : 0);

      if (roundIndex >= maxRounds) {
        // Calculate Winner
        const scores = tData.scores || {};
        const sortedPlayers = (tData.players || []).sort((a, b) => (scores[b.uid] || 0) - (scores[a.uid] || 0));
        const winnerId = sortedPlayers[0]?.uid || null;

        transaction.update(tRef, { status: 'completed', winnerId: winnerId });
        transaction.update(roundRef, { status: 'completed' });
        return;
      }

      const nextRoundIndex = roundIndex + 1;
      const nextRoundRef = doc(tRef, 'rounds', `round_${nextRoundIndex}`);
      transaction.set(nextRoundRef, { index: nextRoundIndex, status: 'ongoing', createdAt: serverTimestamp() });
      transaction.update(roundRef, { status: 'completed' });
      transaction.update(tRef, { currentRound: nextRoundIndex });
    });

    // 2. Create matches for the next round (Swiss Pairing)
    const tSnap = await getDoc(tRef);
    const tData = tSnap.data();
    if (tData.currentRound !== roundIndex + 1) return;
    if (tData.status === 'completed') return;

    const scores = tData.scores || {};
    // Sort players by Score Descending
    let players = [...(tData.players || [])].sort((a, b) => (scores[b.uid] || 0) - (scores[a.uid] || 0));

    // Simple Swiss Pairing: Pair 1vs2, 3vs4, etc. (ignoring color history/previous opponents for MVP simplicity)
    // TODO: Add check to avoid repeat matchups if possible.

    const nextRoundRef = doc(tRef, 'rounds', `round_${roundIndex + 1}`);
    const nextMatchesCol = collection(nextRoundRef, 'matches');

    const paired = new Set();

    for (let i = 0; i < players.length; i++) {
      if (paired.has(players[i].uid)) continue;

      const p1 = players[i];
      let p2 = null;

      // Find next available player
      for (let j = i + 1; j < players.length; j++) {
        if (!paired.has(players[j].uid)) {
          p2 = players[j];
          break;
        }
      }

      paired.add(p1.uid);

      if (!p2) {
        // Bye
        const matchRef = doc(nextMatchesCol);
        await setDoc(matchRef, {
          playerWhite: p1.uid,
          playerBlack: null,
          status: 'completed',
          winnerId: p1.uid,
          isBye: true
        });
        await incrementTournamentScore(tournamentId, p1.uid, 1);
        continue;
      }

      paired.add(p2.uid);

      const gameId = await createGame({
        player1: p1,
        player2: p2,
        timeControl: tData.timeControl || 300,
        createdByUid: tData.createdBy,
        tournamentId,
        tournamentRound: roundIndex + 1
      });

      const matchRef = doc(nextMatchesCol);
      await setDoc(matchRef, {
        playerWhite: p1.uid,
        playerBlack: p2.uid,
        gameId,
        status: 'ongoing',
        winnerId: null,
        createdAt: serverTimestamp()
      });
    }
    logStep('next-round-created', { tournamentId, roundIndex: roundIndex + 1 });

  } catch (e) {
    console.error("Error advancing round:", e);
  }
}

// --- FIX: Robust Match Update ---
async function updateTournamentMatchResult({ tournamentId, roundIndex, gameId, winnerUid }) {
  logStep('update-tournament-match', { tournamentId, roundIndex, gameId, winnerUid });
  try {
    const tRef = doc(db, 'tournaments', tournamentId);
    const roundRef = doc(tRef, 'rounds', `round_${roundIndex}`);
    const matchesCol = collection(roundRef, 'matches');
    const matchSnap = await getDocs(query(matchesCol, where('gameId', '==', gameId), limit(1)));

    if (matchSnap.empty) throw new Error(`No match found for gameId ${gameId}`);
    const matchDoc = matchSnap.docs[0];
    const matchRef = doc(matchesCol, matchDoc.id);

    // Prevent double updates
    if (matchDoc.data().status === 'completed') {
      await checkRoundCompletion(tournamentId, roundIndex, tRef, roundRef);
      return;
    }

    await updateDoc(matchRef, { status: 'completed', winnerId: winnerUid });
    logStep('match-updated', { matchId: matchDoc.id, winnerUid });
    // Update tournament scores
    try {
      const mData = matchDoc.data();
      const whiteUid = mData.playerWhite;
      const blackUid = mData.playerBlack;
      if (winnerUid) {
        await incrementTournamentScore(tournamentId, winnerUid, 1);
      } else {
        // Draw: award 0.5 to each player if both exist
        if (whiteUid) await incrementTournamentScore(tournamentId, whiteUid, 0.5);
        if (blackUid) await incrementTournamentScore(tournamentId, blackUid, 0.5);
      }
    } catch (err) {
      console.warn('Failed to update tournament scores on match result', err);
    }
    await checkRoundCompletion(tournamentId, roundIndex, tRef, roundRef);
  } catch (err) {
    console.error('Failed to update tournament match result:', err);
  }
}

// --------------------- React Components ---------------------

const AuthForm = ({ onAuthSuccess }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLogin, setIsLogin] = useState(true);
  const [error, setError] = useState('');
  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (isLogin) {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        await createUserWithEmailAndPassword(auth, email, password);
      }
      if (typeof onAuthSuccess === 'function') onAuthSuccess();
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <div className="w-full max-w-md mx-auto p-8 glass rounded-2xl shadow-2xl animate-fade-in">
      <h2 className="text-3xl font-bold text-white text-center mb-6">
        {isLogin ? 'Login' : 'Register'}
      </h2>
      <form onSubmit={handleSubmit}>
        <div className="mb-4">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className="w-full px-4 py-3 bg-gray-900/50 text-white border border-gray-600/50 rounded-xl focus:outline-none focus:ring-2 focus:ring-secondary/50 transition placeholder-gray-400"
            required
          />
        </div>
        <div className="mb-6">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full px-4 py-3 bg-gray-900/50 text-white border border-gray-600/50 rounded-xl focus:outline-none focus:ring-2 focus:ring-secondary/50 transition placeholder-gray-400"
            required
          />
        </div>
        {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
        <button
          type="submit"
          className="w-full bg-gradient-to-r from-secondary to-purple-600 text-white py-3 rounded-xl font-bold hover:shadow-lg hover:scale-[1.02] transition duration-300"
        >
          {isLogin ? 'Login' : 'Register'}
        </button>
      </form>
      <p className="text-center text-gray-400 mt-4">
        <button onClick={() => setIsLogin(!isLogin)} className="text-indigo-400 hover:underline">
          {isLogin ? 'Need an account? Register' : 'Have an account? Login'}
        </button>
      </p>
    </div>
  );
};

const timeControls = [
  { label: '1 min', value: 60 },
  { label: '3 min', value: 180 },
  { label: '5 min', value: 300 },
  { label: '10 min', value: 600 },
  { label: '∞', value: 'unlimited' }
];

const CreateTournamentModal = ({ user, onClose, onCreate }) => {
  const [name, setName] = useState("Garv's Birthday Bash 🥳");
  const [maxPlayers, setMaxPlayers] = useState(8);
  const [timeControl, setTimeControl] = useState(300);
  const [hostParticipates, setHostParticipates] = useState(true);
  const handleSubmit = async () => {
    if (!name || !user) return;
    try {
      const tournamentId = await createTournament({
        name,
        maxPlayers,
        timeControl,
        hostUid: user.uid,
        hostEmail: user.email,
        hostParticipates
      });
      onCreate(tournamentId);
    } catch (e) {
      console.error('Failed to create tournament', e);
    }
  };
  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex justify-center items-center z-50">
      <div className="bg-gray-800 p-8 rounded-lg shadow-2xl w-full max-w-md">
        <h2 className="text-3xl font-bold text-white text-center mb-6">Create Tournament</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300">Tournament Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-4 py-2 bg-gray-900/50 text-white border border-gray-600/50 rounded-xl focus:ring-2 focus:ring-secondary/50 outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300">Max Players</label>
            <select
              value={maxPlayers}
              onChange={(e) => setMaxPlayers(Number(e.target.value))}
              className="w-full px-4 py-2 bg-gray-900/50 text-white border border-gray-600/50 rounded-xl focus:ring-2 focus:ring-secondary/50 outline-none"
            >
              <option value={4}>4 Players</option>
              <option value={8}>8 Players</option>
              <option value={16}>16 Players</option>
              <option value={32}>32 Players</option>
              <option value={50}>50 Players</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300">Time Control</label>
            <select
              value={timeControl}
              onChange={(e) => setTimeControl(Number(e.target.value))}
              className="w-full px-4 py-2 bg-gray-900/50 text-white border border-gray-600/50 rounded-xl focus:ring-2 focus:ring-secondary/50 outline-none"
            >
              {timeControls.map((tc) => (
                <option key={tc.value} value={tc.value}>
                  {tc.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center space-x-2 pt-2">
            <input
              type="checkbox"
              id="host-participates"
              checked={hostParticipates}
              onChange={(e) => setHostParticipates(e.target.checked)}
              className="w-4 h-4"
            />
            <label htmlFor="host-participates" className="text-sm text-gray-300">
              I want to play in this tournament
            </label>
          </div>
        </div>
        <div className="flex justify-end space-x-4 mt-8">
          <button
            onClick={onClose}
            className="bg-gray-700/50 text-white py-2 px-6 rounded-xl hover:bg-gray-600 transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="bg-gradient-to-r from-green-500 to-emerald-600 text-white py-2 px-6 rounded-xl hover:shadow-lg hover:scale-105 transition font-bold"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
};

const TournamentLobby = ({ user, tournamentId, setView, onGameStart }) => {
  const [tournamentData, setTournamentData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!tournamentId) return;
    const tRef = doc(db, 'tournaments', tournamentId);
    const unsubscribe = onSnapshot(
      tRef,
      (docSnap) => {
        if (docSnap.exists()) {
          setTournamentData({ id: docSnap.id, ...docSnap.data() });
          setLoading(false);
        } else {
          setError('Tournament not found.');
          setLoading(false);
        }
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      }
    );
    return () => unsubscribe();
  }, [tournamentId]);

  const [roundMatches, setRoundMatches] = useState([]);
  useEffect(() => {
    if (!tournamentId || !tournamentData || tournamentData.status !== 'ongoing') return;
    const roundIndex = tournamentData.currentRound;
    const roundRef = doc(db, 'tournaments', tournamentId, 'rounds', `round_${roundIndex}`);
    const matchesCol = collection(roundRef, 'matches');
    const unsub = onSnapshot(
      matchesCol,
      (querySnapshot) => {
        const list = querySnapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
        setRoundMatches(list);
      },
      (err) => {
        console.error('TournamentLobby: error subscribing to round matches:', err);
      }
    );
    return () => unsub();
  }, [tournamentId, tournamentData]);
  const handleJoin = async () => {
    try {
      await joinTournament({ tournamentId: tournamentData.id, userUid: user.uid, userEmail: user.email });
    } catch (e) {
      console.error('Failed to join tournament', e);
    }
  };
  const handleStart = async () => {
    try {
      await startTournament(tournamentData.id);
    } catch (e) {
      console.error('Failed to start tournament', e);
    }
  };

  // --- Admin Functions ---
  const handleForceResult = async (gameId, winnerUid) => {
    if (!confirm('Are you sure you want to force this result? This cannot be undone.')) return;
    try {
      if (gameId) {
        await updateDoc(doc(db, 'games', gameId), {
          status: 'finished',
          winner: winnerUid ? { uid: winnerUid } : null,
          winReason: 'Admin Decision'
        });
        await updateTournamentMatchResult({
          tournamentId: tournamentData.id,
          roundIndex: tournamentData.currentRound,
          gameId: gameId,
          winnerUid: winnerUid
        });
      }
    } catch (e) {
      console.error('Force result failed', e);
      alert('Failed to force result: ' + e.message);
    }
  };

  const handleKickPlayer = async (playerUid) => {
    if (!confirm('Kick this player? They will be removed from the tournament.')) return;
    try {
      const updatedPlayers = tournamentData.players.filter(p => p.uid !== playerUid);
      await updateDoc(doc(db, 'tournaments', tournamentData.id), {
        players: updatedPlayers
      });
    } catch (e) {
      console.error('Kick failed', e);
    }
  };

  if (loading) return <p>Loading Tournament...</p>;
  if (error) return <p className="text-red-500">{error}</p>;
  if (!tournamentData) return <p>No tournament data.</p>;
  const { name, status, players, maxPlayers, createdBy } = tournamentData;
  const isHost = user.uid === createdBy;
  const isPlayer = players.some((p) => p.uid === user.uid);
  const canJoin = !isPlayer && status === 'lobby' && players.length < maxPlayers;
  const canStart = isHost && status === 'lobby' && players.length >= 2;

  // Sort players for standings
  const sortedPlayers = [...players].sort((a, b) => {
    const scoreA = tournamentData.scores?.[a.uid] || 0;
    const scoreB = tournamentData.scores?.[b.uid] || 0;
    return scoreB - scoreA;
  });

  return (
    <div className="w-full max-w-6xl mx-auto p-8 glass rounded-2xl shadow-2xl animate-fade-in">
      <button onClick={() => setView('lobby')} className="text-indigo-400 hover:underline mb-4">
        &larr; Back to Lobby
      </button>
      <div className="flex justify-between items-center mb-2">
        <h2 className="text-4xl font-bold text-white text-center flex-grow">{name}</h2>
        {isHost && <span className="bg-red-600 text-white px-3 py-1 rounded text-sm font-bold">HOST ADMIN</span>}
      </div>
      <p className="text-center text-xl text-yellow-400 mb-2 font-mono uppercase tracking-widest">{status}</p>

      {/* Shareable Tournament Link */}
      <div className="bg-gray-700 p-3 rounded-lg mb-6 flex items-center justify-between">
        <div className="flex-grow overflow-hidden">
          <p className="text-xs text-gray-400 mb-1">Share this tournament:</p>
          <p className="text-sm text-gray-300 font-mono truncate">
            {typeof window !== 'undefined' ? `${window.location.origin}?tournamentId=${tournamentId}` : tournamentId}
          </p>
        </div>
        <button
          onClick={() => {
            const url = typeof window !== 'undefined' ? `${window.location.origin}?tournamentId=${tournamentId}` : tournamentId;
            navigator.clipboard.writeText(url).then(() => {
              alert('Tournament link copied to clipboard!');
            }).catch(() => {
              alert('Failed to copy link');
            });
          }}
          className="ml-4 bg-indigo-600 text-white px-4 py-2 rounded-md hover:bg-indigo-700 text-sm flex-shrink-0"
        >
          Copy Link
        </button>
      </div>

      {status === 'lobby' && (
        <div className="text-center">
          <h3 className="text-2xl text-white mb-4">Waiting for Players ({players.length} / {maxPlayers})</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
            {players.map((p) => (
              <div key={p.uid} className="bg-gray-700 p-4 rounded-md flex items-center justify-between">
                <span className="text-white font-bold">{p.email}</span>
                <div className="flex items-center space-x-2">
                  {p.uid === createdBy && <span className="text-xs bg-yellow-500 text-black px-2 py-1 rounded">HOST</span>}
                  {isHost && p.uid !== user.uid && (
                    <button onClick={() => handleKickPlayer(p.uid)} className="text-xs bg-red-500 hover:bg-red-600 text-white px-2 py-1 rounded">Kick</button>
                  )}
                </div>
              </div>
            ))}
          </div>
          {canJoin && (
            <button
              onClick={handleJoin}
              className="w-full max-w-md bg-gradient-to-r from-green-500 to-emerald-600 text-white font-bold py-4 px-8 rounded-full hover:shadow-xl hover:scale-105 transition text-xl"
            >
              Join Tournament
            </button>
          )}
          {isPlayer && !isHost && (
            <p className="text-green-400 text-lg animate-pulse">
              You are in! Waiting for host to start...
            </p>
          )}
          {canStart && (
            <button
              onClick={handleStart}
              className="w-full max-w-md bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-bold py-4 px-8 rounded-full hover:shadow-xl hover:scale-105 transition text-xl"
            >
              Start Tournament
            </button>
          )}
        </div>
      )}

      {(status === 'ongoing' || status === 'completed') && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Standings Panel */}
          <div className="lg:col-span-1 bg-gray-900 p-6 rounded-xl shadow-inner h-fit">
            <h3 className="text-xl font-bold text-white mb-4 border-b border-gray-700 pb-2">Standings</h3>
            <table className="w-full text-left text-gray-300">
              <thead>
                <tr className="text-xs uppercase text-gray-500">
                  <th className="py-2">#</th>
                  <th className="py-2">Player</th>
                  <th className="py-2 text-center">W-L-D</th>
                  <th className="py-2 text-right">Pts</th>
                  {isHost && <th className="py-2 text-right">Action</th>}
                </tr>
              </thead>
              <tbody>
                {sortedPlayers.map((p, idx) => {
                  // Calculate W-L-D
                  // Note: This requires iterating through all rounds which we don't have easily accessible here without fetching all rounds.
                  // For now, we'll just show the score. To show W-L-D properly we'd need to aggregate it on the tournament doc or fetch all rounds.
                  // Let's stick to just score for now but improve the styling.
                  return (
                    <tr key={p.uid} className={`border-b border-gray-800 last:border-0 ${p.uid === user.uid ? 'bg-indigo-900/50' : ''}`}>
                      <td className="py-3 pl-2 font-mono text-gray-500">{idx + 1}</td>
                      <td className="py-3 font-medium text-white truncate max-w-[120px]">
                        {p.email.split('@')[0]}
                        {p.uid === user.uid && <span className="ml-2 text-xs text-indigo-400">(You)</span>}
                      </td>
                      <td className="py-3 text-center text-gray-500 text-xs">-</td>
                      <td className="py-3 text-right font-bold text-yellow-400 pr-2">
                        {tournamentData.scores?.[p.uid] || 0}
                      </td>
                      {isHost && p.uid !== user.uid && (
                        <td className="py-3 text-right">
                          <button onClick={() => handleKickPlayer(p.uid)} className="text-xs text-red-400 hover:text-red-300">Kick</button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Main Content Area */}
          <div className="lg:col-span-2 space-y-6">
            {status === 'completed' && (
              <div className="bg-gradient-to-r from-yellow-600 to-yellow-800 p-6 rounded-xl text-center shadow-lg mb-6">
                <h2 className="text-3xl font-bold text-white mb-2">🏆 Tournament Champion 🏆</h2>
                <p className="text-2xl text-white font-bold">
                  {tournamentData.winnerId
                    ? (players.find((p) => p.uid === tournamentData.winnerId)?.email || 'Unknown')
                    : 'Draw'}
                </p>
              </div>
            )}

            {status === 'ongoing' && (
              <div>
                <h3 className="text-2xl text-white mb-4 flex justify-between items-center">
                  <span>Round {tournamentData.currentRound}</span>
                  <span className="text-sm font-normal text-gray-400 bg-gray-800 px-3 py-1 rounded-full">Swiss System</span>
                </h3>
                <div className="space-y-3">
                  {roundMatches.length === 0 && <p className="text-gray-400 italic">Generating pairings...</p>}
                  {roundMatches.map((m) => {
                    const p1 = players.find((p) => p.uid === m.playerWhite);
                    const p2 = players.find((p) => p.uid === m.playerBlack);
                    const isBye = m.isBye;
                    const youInMatch = user && (m.playerWhite === user.uid || m.playerBlack === user.uid);
                    const canJoinMatch = m.status === 'ongoing' && youInMatch;
                    const canWatch = m.status === 'ongoing' && !youInMatch && !isBye;

                    // Mock spectator count for now since we don't have real-time spectator count per match in tournament data yet
                    // Ideally we would fetch this from the game doc, but for list view we might skip or show generic "Live"

                    return (
                      <div key={m.id} className="bg-gray-700 p-4 rounded-lg flex flex-col gap-4 shadow-md hover:bg-gray-650 transition">
                        <div className="flex flex-col sm:flex-row justify-between items-center w-full">
                          <div className="flex items-center space-x-4 mb-3 sm:mb-0 w-full sm:w-auto justify-center sm:justify-start">
                            <div className="text-right">
                              <p className={`font-bold ${m.winnerId === m.playerWhite ? 'text-green-400' : 'text-white'}`}>
                                {p1?.email.split('@')[0] || 'Unknown'}
                              </p>
                              <p className="text-xs text-gray-400">White</p>
                            </div>
                            <span className="text-gray-500 font-bold">vs</span>
                            <div className="text-left">
                              <p className={`font-bold ${m.winnerId === m.playerBlack ? 'text-green-400' : 'text-white'}`}>
                                {isBye ? 'BYE' : (p2?.email.split('@')[0] || 'Unknown')}
                              </p>
                              <p className="text-xs text-gray-400">{isBye ? '-' : 'Black'}</p>
                            </div>
                          </div>

                          <div className="flex items-center space-x-3">
                            {m.status === 'completed' && (
                              <span className="px-3 py-1 bg-gray-800 text-green-400 text-xs font-bold uppercase rounded-full border border-green-900">
                                Finished
                              </span>
                            )}
                            {canJoinMatch && (
                              <button
                                onClick={() => onGameStart(m.gameId)}
                                className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 font-bold shadow-sm"
                              >
                                Play
                              </button>
                            )}
                            {canWatch && (
                              <button
                                onClick={() => onGameStart(m.gameId)}
                                className="bg-gray-600 text-white px-4 py-2 rounded-md hover:bg-gray-500 font-bold shadow-sm flex items-center"
                              >
                                <span className="mr-2">👁️</span> Watch
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Admin Controls for Host */}
                        {isHost && m.status === 'ongoing' && !isBye && (
                          <div className="border-t border-gray-600 pt-2 mt-2 w-full">
                            <p className="text-xs text-gray-400 mb-1 font-bold uppercase">Admin Controls (Force Result)</p>
                            <div className="flex space-x-2">
                              <button onClick={() => handleForceResult(m.gameId, m.playerWhite)} className="flex-1 bg-green-900 hover:bg-green-800 text-green-100 text-xs py-1 rounded">
                                Win White
                              </button>
                              <button onClick={() => handleForceResult(m.gameId, null)} className="flex-1 bg-gray-600 hover:bg-gray-500 text-gray-100 text-xs py-1 rounded">
                                Draw
                              </button>
                              <button onClick={() => handleForceResult(m.gameId, m.playerBlack)} className="flex-1 bg-green-900 hover:bg-green-800 text-green-100 text-xs py-1 rounded">
                                Win Black
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const GameSetup = ({ user, onGameStart, onStartVsComputer, onStartOfflineGame, onShowConnectModal, onShowCreateTournamentModal, onSelectTournament }) => {
  const [openGames, setOpenGames] = useState([]);
  const [openTournaments, setOpenTournaments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTime, setSelectedTime] = useState(300);
  const [searching, setSearching] = useState(false);
  // Whether the created game should be invite only (not listed publicly)
  const [inviteOnly, setInviteOnly] = useState(false);
  const requestRefRef = useRef(null);
  const gameListenerUnsubRef = useRef(null);
  useEffect(() => {
    const qGames = query(collection(db, 'games'), where('status', '==', 'waiting'), limit(20));
    const unsubGames = onSnapshot(
      qGames,
      (querySnapshot) => {
        const games = querySnapshot.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          // Only include games that are not inviteOnly
          .filter((g) => !g.inviteOnly);
        setOpenGames(games);
        setLoading(false);
      },
      (err) => {
        console.error('GameSetup: error subscribing to open games:', err);
        setLoading(false);
      }
    );
    const qTournaments = query(collection(db, 'tournaments'), where('status', '==', 'lobby'), limit(20));
    const unsubTournaments = onSnapshot(
      qTournaments,
      (querySnapshot) => {
        const tournaments = querySnapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
        setOpenTournaments(tournaments);
      },
      (err) => {
        console.error('GameSetup: error subscribing to open tournaments:', err);
      }
    );
    return () => {
      unsubGames();
      unsubTournaments();
    };
  }, []);
  const handleCreateGame = async () => {
    setLoading(true);
    try {
      const gameId = await createGame({ player1: { uid: user.uid, email: user.email }, player2: null, timeControl: selectedTime, createdByUid: user.uid, tournamentId: null, tournamentRound: null, inviteOnly });
      onGameStart(gameId);
    } catch (err) {
      console.error('GameSetup: create game failed:', err);
    } finally {
      setLoading(false);
    }
  };
  const handleJoinGame = async (gameId) => {
    setLoading(true);
    const startTs = Date.now();
    logStep('start-join', { gameId });
    try {
      const gameRef = doc(db, 'games', gameId);
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(gameRef);
        if (!snap.exists()) throw new Error('Game not found');
        const data = snap.data();
        if (data.status !== 'waiting') throw new Error('Game is not available to join');
        if (data.player2 && data.player2.uid) throw new Error('Game already has a second player');
        if (data.player1?.uid === user.uid) throw new Error('You cannot join your own waiting game');
        const updated = {
          player2: { uid: user.uid, email: user.email },
          playerIds: Array.from(new Set([data.player1.uid, user.uid])),
          status: 'active',
          lastMoveTimestamp: serverTimestamp(),
          player1Time: data.player1Time != null ? data.player1Time : data.timeControl || selectedTime,
          player2Time: data.player2Time != null ? data.player2Time : data.timeControl || selectedTime
        };
        tx.update(gameRef, updated);
      });
      logStep('transaction-committed-navigate', { gameId, durationMs: Date.now() - startTs });
      onGameStart(gameId);
    } catch (err) {
      console.warn('GameSetup: join game failed (transaction):', err.message || err);
    } finally {
      setLoading(false);
    }
  };
  const startQuickMatch = async () => {
    if (!user) return;
    setSearching(true);
    const startTs = Date.now();
    logStep('start-quickmatch', { selectedTime });
    try {
      const waitingQuery = query(
        collection(db, 'games'),
        where('status', '==', 'waiting'),
        where('timeControl', '==', selectedTime),
        orderBy('createdAt', 'asc'),
        limit(1)
      );
      const waitingSnap = await getDocs(waitingQuery);
      if (!waitingSnap.empty) {
        const gameDoc = waitingSnap.docs[0];
        const gameIdToClaim = gameDoc.id;
        try {
          await runTransaction(db, async (tx) => {
            const gRef = doc(db, 'games', gameIdToClaim);
            const gSnap = await tx.get(gRef);
            if (!gSnap.exists()) throw new Error('Game not found');
            const data = gSnap.data();
            if (data.status !== 'waiting') throw new Error('Not joinable');
            if (data.player1?.uid === user.uid) throw new Error('Cannot join your own game');
            tx.update(gRef, {
              player2: { uid: user.uid, email: user.email },
              playerIds: Array.from(new Set([data.player1.uid, user.uid])),
              status: 'active',
              lastMoveTimestamp: serverTimestamp(),
              player1Time: data.player1Time != null ? data.player1Time : data.timeControl || selectedTime,
              player2Time: data.player2Time != null ? data.player2Time : data.timeControl || selectedTime
            });
          });
          logStep('quickmatch-claimed-existing', { gameIdToClaim, durationMs: Date.now() - startTs });
          setSearching(false);
          onGameStart(gameIdToClaim);
          return;
        } catch (claimErr) {
          console.warn('GameSetup: claiming waiting game failed (race) -> fallback to request', claimErr.message || claimErr);
        }
      }
      // create matchmaking request
      const reqRef = await addDoc(collection(db, 'matchmaking_requests'), {
        uid: user.uid,
        email: user.email,
        timeControl: selectedTime,
        createdAt: serverTimestamp()
      });
      requestRefRef.current = reqRef;
      logStep('quickmatch-request-created', { reqId: reqRef.id });
      const reqSnap = await getDoc(reqRef);
      const reqData = reqSnap.exists() ? reqSnap.data() : null;
      const reqCreatedAtSec = reqData?.createdAt?.seconds || Math.floor(Date.now() / 1000);
      const gamesQuery = query(
        collection(db, 'games'),
        where('playerIds', 'array-contains', user.uid),
        where('status', '==', 'active'),
        orderBy('createdAt', 'desc'),
        limit(5)
      );
      const unsub = onSnapshot(
        gamesQuery,
        async (snap) => {
          try {
            if (snap.empty) return;
            for (const docSnap of snap.docs) {
              const game = docSnap.data();
              if (!game || !Array.isArray(game.playerIds) || !game.playerIds.includes(user.uid)) continue;
              const gameCreatedAtSec = game.createdAt?.seconds || 0;
              if (gameCreatedAtSec + 2 < reqCreatedAtSec) continue;
              logStep('quickmatch-matched-observed', { gameId: docSnap.id, durationMs: Date.now() - startTs });
              if (requestRefRef.current) {
                try {
                  await deleteDoc(requestRefRef.current);
                } catch (e) {
                  console.warn('failed to delete matchmaking request', e);
                }
                requestRefRef.current = null;
              }
              setSearching(false);
              if (gameListenerUnsubRef.current) {
                gameListenerUnsubRef.current();
                gameListenerUnsubRef.current = null;
              }
              setTimeout(() => onGameStart(docSnap.id), 120);
              return;
            }
          } catch (err) {
            console.error('GameSetup quick-match snapshot handler error:', err);
          }
        },
        (err) => {
          console.error('GameSetup: error listening for active game:', err);
        }
      );
      gameListenerUnsubRef.current = unsub;
    } catch (err) {
      console.error('GameSetup: quick-match flow failed:', err);
      setSearching(false);
    }
  };
  const cancelQuickMatch = async () => {
    setSearching(false);
    if (requestRefRef.current) {
      try {
        await deleteDoc(requestRefRef.current);
      } catch (e) {
        console.warn('cancelQuickMatch: failed to delete request', e);
      }
      requestRefRef.current = null;
    }
    if (gameListenerUnsubRef.current) {
      try {
        gameListenerUnsubRef.current();
      } catch (err) {
        console.warn('cancelQuickMatch: failed to unsubscribe listener', err);
      }
      gameListenerUnsubRef.current = null;
    }
  };
  useEffect(() => {
    return () => {
      if (gameListenerUnsubRef.current) {
        try {
          gameListenerUnsubRef.current();
        } catch (err) {
          console.warn('GameSetup: failed to unsubscribe game listener', err);
        }
        gameListenerUnsubRef.current = null;
      }
      if (requestRefRef.current) {
        try {
          deleteDoc(requestRefRef.current);
        } catch (err) {
          console.warn('GameSetup: cleanup failed to delete request', err);
        }
        requestRefRef.current = null;
      }
    };
  }, []);
  return (
    <div className="w-full max-w-4xl mx-auto p-8 glass rounded-2xl shadow-2xl animate-fade-in">
      <h2 className="text-3xl font-bold text-white text-center mb-6">Game Lobby</h2>
      <div className="mb-6">
        <button
          onClick={onShowCreateTournamentModal}
          className="w-full bg-gradient-to-r from-yellow-500 to-orange-500 text-gray-900 font-bold py-3 px-6 rounded-xl hover:shadow-lg hover:scale-[1.02] transition duration-300 text-lg"
        >
          🎉 Create Birthday Tournament
        </button>
      </div>
      <div className="flex flex-col sm:flex-row justify-center items-center space-y-4 sm:space-y-0 sm:space-x-4 mb-6">
        <div className="flex bg-gray-700 rounded-md p-1">
          {timeControls.map((tc) => (
            <button
              key={tc.value}
              onClick={() => setSelectedTime(tc.value)}
              className={`px-4 py-2 text-sm font-medium rounded-md transition ${selectedTime === tc.value ? 'bg-indigo-600 text-white' : 'text-gray-300 hover:bg-gray-600'}`}
            >
              {tc.label}
            </button>
          ))}
        </div>
        <button
          onClick={handleCreateGame}
          className="w-full sm:w-auto bg-gradient-to-r from-green-500 to-emerald-600 text-white font-bold py-2 px-6 rounded-xl hover:shadow-lg hover:scale-105 transition duration-300 disabled:bg-gray-500 disabled:opacity-50"
          disabled={loading}
        >
          Create Game
        </button>
      </div>
      {/* Invite-only toggle */}
      <div className="flex items-center justify-center mb-6 space-x-2">
        <input
          type="checkbox"
          id="invite-only-toggle"
          checked={inviteOnly}
          onChange={(e) => setInviteOnly(e.target.checked)}
          className="w-5 h-5"
        />
        <label htmlFor="invite-only-toggle" className="text-gray-300 text-sm">
          Invite Only (do not list publicly)
        </label>
      </div>
      <div className="flex flex-col sm:flex-row justify-center items-center flex-wrap gap-4 mb-6">
        <button
          onClick={onStartVsComputer}
          className="flex-1 bg-gradient-to-r from-blue-500 to-cyan-600 text-white font-bold py-2 px-6 rounded-xl hover:shadow-lg hover:scale-105 transition duration-300"
        >
          Play vs Computer
        </button>
        <button
          onClick={onStartOfflineGame}
          className="flex-1 bg-gradient-to-r from-teal-500 to-emerald-500 text-white font-bold py-2 px-6 rounded-xl hover:shadow-lg hover:scale-105 transition duration-300"
        >
          Pass & Play
        </button>
        <button
          onClick={onShowConnectModal}
          className="flex-1 bg-gradient-to-r from-purple-500 to-pink-600 text-white font-bold py-2 px-6 rounded-xl hover:shadow-lg hover:scale-105 transition duration-300"
        >
          Connect Board
        </button>
        {!searching ? (
          <button
            onClick={startQuickMatch}
            className="flex-1 bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-bold py-2 px-6 rounded-xl hover:shadow-lg hover:scale-105 transition duration-300"
          >
            Quick Match
          </button>
        ) : (
          <button
            onClick={cancelQuickMatch}
            className="flex-1 bg-gradient-to-r from-red-500 to-pink-600 text-white font-bold py-2 px-6 rounded-xl hover:shadow-lg hover:scale-105 transition duration-300"
          >
            Cancel Search
          </button>
        )}
      </div>
      <h3 className="text-2xl text-white mb-4">Open Tournaments</h3>
      <div className="h-40 overflow-y-auto bg-gray-900 p-4 rounded-md mb-6">
        {loading && <p className="text-gray-400">Loading...</p>}
        {!loading && openTournaments.length === 0 && <p className="text-gray-400">No open tournaments. Create one!</p>}
        {openTournaments.map((t) => (
          <div
            key={t.id}
            className="flex justify-between items-center p-3 mb-2 bg-gray-700 rounded-md"
          >
            <div>
              <p className="font-bold text-white">{t.name}</p>
              <p className="text-sm text-gray-400">{t.players.length} / {t.maxPlayers} players</p>
            </div>
            <span className="text-sm font-mono bg-gray-600 px-2 py-1 rounded-md">{t.timeControl === 'unlimited' ? '∞' : (t.timeControl / 60)} min</span>
            <button
              onClick={() => onSelectTournament(t.id)}
              className="bg-indigo-600 text-white py-1 px-4 rounded-md hover:bg-indigo-700 transition duration-300"
            >
              View
            </button>
          </div>
        ))}
      </div>
      <h3 className="text-2xl text-white mb-4">Open Online Games</h3>
      <div className="h-64 overflow-y-auto bg-gray-900 p-4 rounded-md">
        {loading && <p className="text-gray-400">Loading...</p>}
        {!loading && openGames.length === 0 && <p className="text-gray-400">No open games. Create one!</p>}
        {openGames.map((g) => (
          <div
            key={g.id}
            className="flex justify-between items-center p-3 mb-2 bg-gray-700 rounded-md"
          >
            <p className="font-bold text-white">{g.player1?.email || 'Unknown'}</p>
            <span className="text-sm font-mono bg-gray-600 px-2 py-1 rounded-md">{g.timeControl === 'unlimited' ? '∞' : (g.timeControl / 60)} | 0</span>
            {g.player1?.uid !== user.uid && (
              <button
                onClick={() => handleJoinGame(g.id)}
                className="bg-indigo-600 text-white py-1 px-4 rounded-md hover:bg-indigo-700 transition duration-300"
                disabled={loading}
              >
                Join
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

const ProfilePage = ({ user, setView, onReviewGame }) => {
  const [pastGames, setPastGames] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'games'), where('status', '==', 'finished'), where('playerIds', 'array-contains', user.uid), limit(50));
    getDocs(q).then((querySnapshot) => {
      const games = querySnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      const sortedGames = games.sort((a, b) => (b.createdAt?.toDate?.() || 0) - (a.createdAt?.toDate?.() || 0));
      setPastGames(sortedGames);
      setLoading(false);
    });
  }, [user]);
  return (
    <div className="w-full max-w-4xl mx-auto p-8 glass rounded-2xl shadow-2xl animate-fade-in">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-3xl font-bold text-white">Your Profile</h2>
        <button onClick={() => setView('lobby')} className="bg-gray-600 text-white py-2 px-4 rounded-md hover:bg-gray-700">
          Back to Lobby
        </button>
      </div>
      <div className="h-96 overflow-y-auto bg-gray-900 p-4 rounded-md">
        {loading && <p className="text-gray-400">Loading game history...</p>}
        {!loading && pastGames.length === 0 && <p className="text-gray-400">You haven't completed any games yet.</p>}
        {pastGames.map((game) => {
          const result = game.winner ? (game.winner.uid === user.uid ? 'Won' : 'Lost') : 'Draw';
          const resultColor = result === 'Won' ? 'text-green-400' : 'text-red-400';
          return (
            <button
              key={game.id}
              onClick={() => onReviewGame(game)}
              className="w-full grid grid-cols-3 gap-4 items-center p-3 mb-2 bg-gray-700 rounded-md text-left hover:bg-gray-600 transition"
            >
              <div>
                <p className="text-white">vs {user.uid === game.player1.uid ? game.player2?.email : game.player1?.email}</p>
                {game.tournamentId && <span className="text-xs text-yellow-400">Tournament</span>}
              </div>
              <div className="text-center">
                <p className={`font-bold ${resultColor}`}>{result}</p>
              </div>
              <div className="text-right text-gray-400 text-sm">
                <p>{new Date(game.createdAt?.toDate?.() || Date.now()).toLocaleDateString()}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

const GameReviewPage = ({ user, gameData, setView }) => {
  const [moveIndex, setMoveIndex] = useState(-1);
  const reviewFen = useMemo(() => {
    const reviewGame = new Chess();
    for (let i = 0; i <= moveIndex; i++) {
      if (gameData.moves[i]) {
        reviewGame.move(gameData.moves[i].san);
      }
    }
    return reviewGame.fen();
  }, [moveIndex, gameData.moves]);

  const handleNext = () =>
    setMoveIndex((prev) => Math.min(prev + 1, gameData.moves.length - 1));
  const handlePrev = () =>
    setMoveIndex((prev) => Math.max(prev - 1, -1));
  const handleStart = () => setMoveIndex(-1);
  const handleEnd = () => setMoveIndex(gameData.moves.length - 1);

  const opponent =
    user.uid === gameData.player1.uid ? gameData.player2 : gameData.player1;

  return (
    <div className="flex flex-col lg:flex-row gap-8">
      <div className="w-full lg:w-2/3">
        <Suspense fallback={<ChessboardFallback />}>
          <Chessboard
            position={reviewFen}
            arePiecesDraggable={false}
            customBoardStyle={{
              borderRadius: '8px',
              boxShadow: '0 5px 15px rgba(0, 0, 0, 0.5)',
            }}
          />
        </Suspense>
      </div>
      <div className="w-full lg:w-1/3 p-6 glass rounded-2xl shadow-2xl">
        <h3 className="text-2xl font-bold mb-4 border-b border-gray-600 pb-2">
          Game Review
        </h3>
        <p className="mb-4">
          Reviewing your game against {opponent?.email || 'N/A'}.
        </p>
        <div className="space-y-2 mb-6">
          <p>
            <strong>White:</strong> {gameData.player1?.email}
          </p>
          <p>
            <strong>Black:</strong> {gameData.player2?.email}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 mb-4">
          <button onClick={handleStart} className="bg-gray-600 py-2 rounded-md hover:bg-gray-700">Start</button>
          <button onClick={handleEnd} className="bg-gray-600 py-2 rounded-md hover:bg-gray-700">End</button>
          <button onClick={handlePrev} className="bg-blue-600 py-2 rounded-md hover:bg-blue-700">Previous</button>
          <button onClick={handleNext} className="bg-blue-600 py-2 rounded-md hover:bg-blue-700">Next</button>
        </div>
        <button onClick={() => setView('profile')} className="w-full mt-6 bg-gray-600 text-white py-2 rounded-md hover:bg-gray-700 transition">Back to Profile</button>
      </div>
    </div>
  );
};

const GameClocks = ({ gameData, game, onTimeout }) => {
  const [whiteTime, setWhiteTime] = useState(gameData.player1Time || 0);
  const [blackTime, setBlackTime] = useState(gameData.player2Time || 0);

  useEffect(() => {
    setWhiteTime(gameData.player1Time || 0);
    setBlackTime(gameData.player2Time || 0);

    if (gameData.timeControl === 'unlimited') return;

    const interval = setInterval(() => {
      try {
        if (!game || gameData.status !== 'active' || game.isGameOver()) {
          clearInterval(interval);
          return;
        }
        const nowMs = Date.now();
        const lastMoveMs = gameData.lastMoveTimestamp?.toMillis
          ? gameData.lastMoveTimestamp.toMillis()
          : gameData.lastMoveTimestamp?.seconds
            ? gameData.lastMoveTimestamp.seconds * 1000
            : nowMs;
        const elapsed = Math.max(0, (nowMs - lastMoveMs) / 1000);
        let curWhite = Math.max(0, (gameData.player1Time || 0) - (game.turn() === 'w' ? elapsed : 0));
        let curBlack = Math.max(0, (gameData.player2Time || 0) - (game.turn() === 'b' ? elapsed : 0));
        setWhiteTime(Math.floor(curWhite));
        setBlackTime(Math.floor(curBlack));
        if (curWhite <= 0) { onTimeout('white'); clearInterval(interval); }
        else if (curBlack <= 0) { onTimeout('black'); clearInterval(interval); }
      } catch (err) { console.warn('clock tick error', err); }
    }, 1000);
    return () => clearInterval(interval);
  }, [gameData, game, onTimeout]);

  const formatTime = (seconds) => {
    if (gameData.timeControl === 'unlimited') return '∞';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const getClockColor = (time) => {
    if (time <= 10) return 'text-red-500 animate-pulse';
    if (time <= 30) return 'text-yellow-400';
    return 'text-white';
  };

  return (
    <div className="w-full flex flex-wrap md:flex-nowrap justify-between items-center gap-2 mb-4">
      <div className="flex-1 min-w-[140px] bg-gray-900 p-3 rounded-md text-center">
        <p className="truncate text-sm sm:text-base font-bold">{gameData.player2?.email || 'Black'}</p>
        <p className={`text-2xl font-mono ${game?.turn() === 'b' ? 'text-green-400' : getClockColor(blackTime)}`}>{formatTime(blackTime)}</p>
      </div>
      <div className="flex-1 min-w-[140px] bg-gray-900 p-3 rounded-md text-center">
        <p className="truncate text-sm sm:text-base font-bold">{gameData.player1?.email || 'White'}</p>
        <p className={`text-2xl font-mono ${game?.turn() === 'w' ? 'text-green-400' : getClockColor(whiteTime)}`}>{formatTime(whiteTime)}</p>
      </div>
    </div>
  );
};

const PromotionDialog = ({ onSelectPromotion, color }) => {
  const pieces = ['q', 'r', 'b', 'n'];
  const pieceColor = color === 'white' ? 'w' : 'b';
  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex justify-center items-center z-50">
      <div className="glass p-8 rounded-2xl shadow-2xl border border-white/10 animate-fade-in">
        <h3 className="text-2xl text-white font-bold text-center mb-6">Promote Pawn to:</h3>
        <div className="flex justify-center space-x-4">
          {pieces.map((piece) => (
            <button key={piece} onClick={() => onSelectPromotion(piece)} className="bg-gray-700 p-2 rounded-md hover:bg-gray-600 transition">
              <img src={`https://images.chesscomfiles.com/chess-themes/pieces/neo/150/${pieceColor}${piece}.png`} alt={piece} className="w-16 h-16" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

const ChatBox = ({ user, gameId, messages }) => {
  const [newMessage, setNewMessage] = useState('');
  const messagesEndRef = useRef(null);
  const scrollToBottom = () => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); };
  useEffect(() => { scrollToBottom(); }, [messages?.length]);
  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (newMessage.trim() === '' || !gameId) return;
    await updateDoc(doc(db, 'games', gameId), { chatMessages: arrayUnion({ text: newMessage, senderEmail: user.email, createdAt: new Date() }) });
    setNewMessage('');
  };
  return (
    <div className="mt-6">
      <h3 className="text-xl font-bold mb-2">Chat</h3>
      <div className="h-32 overflow-y-auto bg-gray-900 p-2 rounded-md mb-2">
        {messages?.map((msg, index) => (
          <div key={index} className="mb-2">
            <span className={`font-bold ${msg.senderEmail === user.email ? 'text-indigo-400' : 'text-purple-400'}`}>
              {msg.senderEmail === user.email ? 'You' : msg.senderEmail.split('@')[0]}:
            </span>
            <span className="text-gray-300 ml-2">{msg.text}</span>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <form onSubmit={handleSendMessage} className="flex space-x-2">
        <input type="text" value={newMessage} onChange={(e) => setNewMessage(e.target.value)} placeholder="Type a message..." className="flex-grow bg-gray-700 text-white px-3 py-2 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        <button type="submit" className="bg-indigo-600 text-white font-bold py-2 px-4 rounded-md hover:bg-indigo-700">Send</button>
      </form>
    </div>
  );
};

const GameOverDialog = ({ gameData, user, onViewProfile, onRematch, onLeave, isSpectator = false }) => {
  if (!gameData || gameData.status !== 'finished') return null;
  const isPlayer = !!user && (gameData.player1?.uid === user.uid || gameData.player2?.uid === user.uid);
  const winner = gameData.winner;
  const reason = gameData.winReason || 'Checkmate';
  if (!isPlayer || isSpectator) {
    const winnerName = winner ? winner.email.split('@')[0] : 'Draw';
    return (
      <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex justify-center items-center z-50">
        <div className="glass p-10 rounded-2xl shadow-2xl text-center space-y-3 border border-white/10 animate-fade-in">
          <h2 className="text-3xl font-bold">Game Finished</h2>
          <p className="text-lg text-gray-300">
            {winner ? `${winnerName} won by ${reason}` : `Draw (${reason})`}
          </p>
          <button onClick={onLeave} className="bg-gray-600 px-6 py-2 rounded-md hover:bg-gray-700">Leave</button>
        </div>
      </div>
    );
  }
  const isWinner = winner && winner.uid === user.uid;
  const myPlayerKey = user.uid === gameData.player1.uid ? 'player1' : 'player2';
  const opponentPlayerKey = myPlayerKey === 'player1' ? 'player2' : 'player1';
  let message = winner ? (isWinner ? 'You Won!' : `${winner.email.split('@')[0]} Won!`) : "It's a Draw!";

  const handleRematchOffer = () => { onRematch(myPlayerKey); };

  if (gameData.mode === 'online' && gameData.rematchOffer && gameData.rematchOffer !== myPlayerKey) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-80 flex justify-center items-center z-50">
        <div className="bg-gray-800 p-10 rounded-lg shadow-2xl text-center">
          <h2 className="text-3xl font-bold mb-4">Rematch Offer</h2>
          <p className="text-lg text-gray-400 mb-8">{gameData[opponentPlayerKey].email} has offered a rematch.</p>
          <div className="flex justify-center space-x-4">
            <button onClick={() => onRematch('accept')} className="bg-green-600 px-6 py-2 rounded-md hover:bg-green-700">Accept</button>
            <button onClick={onLeave} className="bg-red-600 px-6 py-2 rounded-md hover:bg-red-700">Decline</button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex justify-center items-center z-50">
      <div className="glass p-10 rounded-2xl shadow-2xl text-center border border-white/10 animate-fade-in">
        <h2 className="text-4xl font-bold mb-4">{message}</h2>
        <p className="text-lg text-gray-400 mb-8">by {reason}</p>
        <div className="flex justify-center space-x-4">
          <button onClick={onViewProfile} className="bg-purple-600 px-6 py-2 rounded-md hover:bg-purple-700">Profile</button>
          {gameData.mode === 'online' && !gameData.tournamentId && (gameData.rematchOffer === myPlayerKey ? (
            <p className="text-yellow-400 px-6 py-2">Rematch offer sent...</p>
          ) : (
            <button onClick={handleRematchOffer} className="bg-green-600 px-6 py-2 rounded-md hover:bg-green-700">Rematch</button>
          ))}
          <button onClick={onLeave} className="bg-gray-600 px-6 py-2 rounded-md hover:bg-gray-700">Leave Game</button>
        </div>
      </div>
    </div>
  );
};

const GameActions = ({ user, gameData, gameId }) => {
  if (!gameData || gameData.status !== 'active') return null;
  // Do not render game actions for spectators
  if (!user || !gameData.player1 || !gameData.player2 || ![gameData.player1.uid, gameData.player2.uid].includes(user.uid)) {
    return null;
  }
  const gameRef = doc(db, 'games', gameId);
  const myPlayerKey = user.uid === gameData.player1.uid ? 'player1' : 'player2';
  const handleResign = async () => {
    const opponent = myPlayerKey === 'player1' ? gameData.player2 : gameData.player1;
    await updateDoc(gameRef, { status: 'finished', winner: opponent, winReason: 'Resignation' });
    if (gameData.tournamentId) {
      await updateTournamentMatchResult({
        tournamentId: gameData.tournamentId,
        roundIndex: gameData.tournamentRound,
        gameId: gameId,
        winnerUid: opponent.uid,
      });
    }
  };
  const handleOfferDraw = async () => { await updateDoc(gameRef, { drawOffer: myPlayerKey }); };
  const handleAcceptDraw = async () => {
    await updateDoc(gameRef, { status: 'finished', winner: null, winReason: 'Draw by Agreement', drawOffer: null });
    if (gameData.tournamentId) {
      await updateTournamentMatchResult({
        tournamentId: gameData.tournamentId,
        roundIndex: gameData.tournamentRound,
        gameId: gameId,
        winnerUid: null,
      });
    }
  };
  const handleDeclineDraw = async () => { await updateDoc(gameRef, { drawOffer: null }); };
  const opponentPlayerKey = myPlayerKey === 'player1' ? 'player2' : 'player1';
  if (gameData.drawOffer === opponentPlayerKey) {
    return (
      <div className="mt-4 flex space-x-2">
        <button onClick={handleAcceptDraw} className="w-full bg-green-600 text-white py-2 rounded-md hover:bg-green-700">Accept Draw</button>
        <button onClick={handleDeclineDraw} className="w-full bg-red-600 text-white py-2 rounded-md hover:bg-red-700">Decline</button>
      </div>
    );
  }
  if (gameData.drawOffer === myPlayerKey) { return <p className="mt-4 text-center text-yellow-400">Draw offer sent...</p>; }
  return (
    <div className="mt-4 flex space-x-2">
      <button onClick={handleOfferDraw} className="w-full bg-gray-500 text-white py-2 rounded-md hover:bg-gray-600">Offer Draw</button>
      <button onClick={handleResign} className="w-full bg-red-800 text-white py-2 rounded-md hover:bg-red-900">Resign</button>
    </div>
  );
};

const CapturedPiecesPanel = ({ pieces, color }) => {
  const pieceOrder = { p: 1, n: 2, b: 3, r: 4, q: 5 };
  const getPieceImage = (piece) => `https://images.chesscomfiles.com/chess-themes/pieces/neo/150/${color}${piece}.png`;
  const sortedPieces = [...(pieces || [])].sort((a, b) => pieceOrder[a] - pieceOrder[b]);
  return (
    <div className="flex items-center flex-wrap gap-1 h-8 my-1 px-2">
      {sortedPieces.map((p, i) => (
        <img key={i} src={getPieceImage(p)} alt={p} className="h-6 w-6" />
      ))}
    </div>
  );
};

const SettingsDialog = ({ settings, setSettings, onClose }) => {
  const handleSoundToggle = (e) => { setSettings((s) => ({ ...s, soundEnabled: e.target.checked })); };
  const handleThemeChange = (e) => { setSettings((s) => ({ ...s, soundTheme: e.target.value })); };
  const handlePremoveToggle = (e) => { setSettings((s) => ({ ...s, premovesEnabled: e.target.checked })); };
  const handleHighlightToggle = (e) => { setSettings((s) => ({ ...s, highlightMoves: e.target.checked })); };
  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex justify-center items-center z-50">
      <div className="glass p-8 rounded-2xl shadow-2xl w-full max-w-md border border-white/10 animate-fade-in">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl text-white font-bold">Settings</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">&times;</button>
        </div>
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <label htmlFor="sound-toggle" className="text-lg text-gray-300">Enable Sounds</label>
            <input type="checkbox" id="sound-toggle" checked={settings.soundEnabled} onChange={handleSoundToggle} className="w-5 h-5" />
          </div>
          {settings.soundEnabled && (
            <div className="flex items-center justify-between">
              <label htmlFor="sound-theme" className="text-lg text-gray-300">Sound Theme</label>
              <select id="sound-theme" value={settings.soundTheme} onChange={handleThemeChange} className="bg-gray-700 text-white p-2 rounded-md">
                <option value="default">Classic</option>
                <option value="wooden">Wooden</option>
                <option value="arcade">Arcade</option>
              </select>
            </div>
          )}
          <div className="flex items-center justify-between">
            <label htmlFor="premove-toggle" className="text-lg text-gray-300">Enable Premoves</label>
            <input type="checkbox" id="premove-toggle" checked={settings.premovesEnabled} onChange={handlePremoveToggle} className="w-5 h-5" />
          </div>
          <div className="flex items-center justify-between">
            <label htmlFor="highlight-toggle" className="text-lg text-gray-300">Highlight Legal Moves</label>
            <input type="checkbox" id="highlight-toggle" checked={settings.highlightMoves} onChange={handleHighlightToggle} className="w-5 h-5" />
          </div>
        </div>
      </div>
    </div>
  );
};

const VideoChat = ({ gameData, gameId, user }) => {
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const processedCandidatesRef = useRef(new Set());
  const signalingUnsubRef = useRef(null);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(false);

  // Only players or the tournament host can participate in video chat
  const isHost = user.uid === gameData.createdByUid;
  const player1Uid = gameData.player1?.uid;
  const player2Uid = gameData.player2?.uid;
  const isPlayer = user.uid === player1Uid || user.uid === player2Uid;
  const canJoinVideo = isPlayer;

  useEffect(() => {
    if (!gameId || !canJoinVideo) return;
    let mounted = true;
    const gameRef = doc(db, 'games', gameId);
    const processedCandidates = processedCandidatesRef.current;

    const servers = {
      iceServers: [{ urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }],
      iceCandidatePoolSize: 10
    };

    const init = async () => {
      if (!mounted || pcRef.current) return;

      pcRef.current = new RTCPeerConnection(servers);

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (!mounted) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }

        localStreamRef.current = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;

        // Add tracks to PC
        stream.getTracks().forEach((track) => {
          pcRef.current.addTrack(track, stream);
        });
      } catch (err) {
        console.error('getUserMedia error', err);
        return;
      }

      // Handle remote track
      pcRef.current.ontrack = (ev) => {
        if (remoteVideoRef.current && ev.streams && ev.streams[0]) {
          remoteVideoRef.current.srcObject = ev.streams[0];
        }
      };

      // Handle ICE candidates
      pcRef.current.onicecandidate = (event) => {
        if (event.candidate) {
          const candidateJSON = event.candidate.toJSON();
          // Add uid to candidate to know who sent it
          updateDoc(gameRef, {
            'webrtc_signals.iceCandidates': arrayUnion({ ...candidateJSON, uid: user.uid })
          }).catch(e => console.warn('ice write failed', e));
        }
      };

      // Listen for signaling data
      signalingUnsubRef.current = onSnapshot(gameRef, async (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        const signals = data.webrtc_signals;
        if (!signals || !pcRef.current) return;

        // Logic for Host: They act as a "viewer" but also send streams.
        // For 1-on-1 stability, if Host joins, they might disrupt the P2P flow if we don't handle it carefully.
        // CURRENT LIMITATION: The current simple 1-on-1 signaling (Offer/Answer) only supports 2 peers.

        // If I am Player 2 (Answerer), listen for Offer
        if (user.uid === player2Uid && signals.offer && !signals.answer) {
          try {
            if (!pcRef.current.remoteDescription) {
              await pcRef.current.setRemoteDescription(new RTCSessionDescription(signals.offer));
              const answer = await pcRef.current.createAnswer();
              await pcRef.current.setLocalDescription(answer);
              await updateDoc(gameRef, { 'webrtc_signals.answer': { sdp: answer.sdp, type: answer.type } });
            }
          } catch (err) { console.error('answer flow error', err); }
        }

        // If I am Player 1 (Offerer), listen for Answer
        if (user.uid === player1Uid && signals.answer && !pcRef.current.remoteDescription) {
          try {
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(signals.answer));
          } catch (err) { console.error('setRemoteDescription for answer failed', err); }
        }

        // Handle ICE Candidates
        if (signals.iceCandidates) {
          for (const cand of signals.iceCandidates) {
            // Ignore my own candidates
            if (cand.uid === user.uid) continue;

            const key = JSON.stringify(cand);
            if (!processedCandidatesRef.current.has(key)) {
              processedCandidatesRef.current.add(key);
              try {
                await pcRef.current.addIceCandidate(new RTCIceCandidate(cand));
              } catch (e) { console.warn('addIceCandidate failed', e); }
            }
          }
        }
      });

      // If I am Player 1, create Offer if none exists
      if (user.uid === player1Uid) {
        const snap = await getDoc(gameRef);
        const existing = snap.exists() ? snap.data().webrtc_signals : null;
        if (!existing || !existing.offer) {
          try {
            const offer = await pcRef.current.createOffer();
            await pcRef.current.setLocalDescription(offer);
            await updateDoc(gameRef, { 'webrtc_signals.offer': { sdp: offer.sdp, type: offer.type } });
          } catch (err) { console.error('offer flow error', err); }
        }
      }
    };

    init();

    return () => {
      mounted = false;
      if (signalingUnsubRef.current) signalingUnsubRef.current();
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop());
        localStreamRef.current = null;
      }
      processedCandidates.clear();
    };
  }, [gameId, user.uid, canJoinVideo, player1Uid, player2Uid]);

  const toggleAudio = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(t => t.enabled = !t.enabled);
      setIsAudioMuted(!isAudioMuted);
    }
  };
  const toggleVideo = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach(t => t.enabled = !t.enabled);
      setIsVideoMuted(!isVideoMuted);
    }
  };

  if (!canJoinVideo) {
    let message = "Video chat is available for players only.";
    if (isHost) {
      message = "Video chat is currently limited to players due to technical constraints. As host, you can monitor the game via the board.";
    }
    return <div className="mt-6 p-4 bg-gray-800 rounded-lg text-center text-gray-400">{message}</div>;
  }

  return (
    <div className="mt-6">
      <h3 className="text-xl font-bold mb-4">Video Chat</h3>
      <div className="flex space-x-4">
        <div className="relative bg-gray-900 rounded-lg overflow-hidden w-1/2 aspect-video">
          <video ref={localVideoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
          <div className="absolute bottom-2 left-2 bg-black bg-opacity-50 px-2 py-1 rounded text-xs text-white">You</div>
          <div className="absolute top-2 right-2 flex space-x-2">
            <button onClick={toggleAudio} className={`p-1 rounded-full ${isAudioMuted ? 'bg-red-500' : 'bg-gray-600'}`}>{isAudioMuted ? '🔇' : '🎤'}</button>
            <button onClick={toggleVideo} className={`p-1 rounded-full ${isVideoMuted ? 'bg-red-500' : 'bg-gray-600'}`}>{isVideoMuted ? '📷' : '📹'}</button>
          </div>
        </div>
        <div className="relative bg-gray-900 rounded-lg overflow-hidden w-1/2 aspect-video">
          <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
          <div className="absolute bottom-2 left-2 bg-black bg-opacity-50 px-2 py-1 rounded text-xs text-white">Opponent</div>
        </div>
      </div>
    </div>
  );
};

// --------------------- Main App Component ---------------------

export default function App() {
  const [user, setUser] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [view, setView] = useState('lobby');
  const [gameId, setGameId] = useState(null);
  const [tournamentId, setTournamentId] = useState(null);
  const [gameData, setGameData] = useState(null);
  const [reviewGameData, setReviewGameData] = useState(null);
  const [promotionMove, setPromotionMove] = useState(null);
  const [showSettings, setShowSettings] = useState(false);

  const [mobileAccordion, setMobileAccordion] = useState('moves');
  const [settings, setSettings] = useState(() => {
    const savedSettings = localStorage.getItem('chess-settings');
    return savedSettings ? JSON.parse(savedSettings) : { soundEnabled: true, soundTheme: 'default', premovesEnabled: false, highlightMoves: true };
  });
  const [premove, setPremove] = useState(null);
  const [optionSquares, setOptionSquares] = useState({});
  const [moveFrom, setMoveFrom] = useState(null);
  const [moveHighlight, setMoveHighlight] = useState(null);
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [showCreateTournamentModal, setShowCreateTournamentModal] = useState(false);
  const gameDataRef = useRef(gameData);
  const handleHardwareMoveRef = useRef(null);

  useEffect(() => { gameDataRef.current = gameData; }, [gameData]);
  useEffect(() => { localStorage.setItem('chess-settings', JSON.stringify(settings)); }, [settings]);

  const fen = gameData ? gameData.fen : 'start';
  const game = useMemo(() => { try { return new Chess(fen === 'start' ? undefined : fen); } catch { return null; } }, [fen]);

  const makeAIMove = useCallback(() => {
    if (!game || game.turn() !== 'b' || game.isGameOver()) return;
    const possibleMoves = game.moves({ verbose: true });
    if (possibleMoves.length === 0) return;
    const bestMove = possibleMoves[Math.floor(Math.random() * possibleMoves.length)];
    const gameCopy = new Chess(fen);
    const result = gameCopy.move(bestMove.san);
    const currentCaptured = gameData?.capturedPieces || { w: [], b: [] };
    const newCaptured = { w: [...(currentCaptured.w || [])], b: [...(currentCaptured.b || [])] };
    if (result && result.captured) { newCaptured.b.push(result.captured); }
    const isGameOver = gameCopy.isGameOver();
    const newStatus = isGameOver ? 'finished' : 'active';
    let winner = null;
    let winReason = null;
    if (isGameOver) {
      if (gameCopy.isCheckmate()) {
        // AI (Black) won
        winner = gameData.player2;
        winReason = 'Checkmate';
      } else {
        winReason = 'Draw';
      }
    }

    setGameData((prev) => ({
      ...prev,
      fen: gameCopy.fen(),
      moves: [...(prev?.moves || []), { san: bestMove.san, from: result?.from, to: result?.to, time: 0, moveNumber: (prev?.moves || []).length + 1 }],
      capturedPieces: newCaptured,
      lastMove: result ? { from: result.from, to: result.to, san: result.san, moveNumber: (prev?.moves || []).length + 1 } : prev?.lastMove,
      status: newStatus,
      winner: winner,
      winReason: winReason
    }));
  }, [game, fen, gameData]);

  useEffect(() => {
    if (gameData?.mode === 'computer' && game?.turn() === 'b' && !game?.isGameOver()) {
      const timer = setTimeout(makeAIMove, 500);
      return () => clearTimeout(timer);
    }
  }, [fen, gameData, game, makeAIMove]);

  useEffect(() => {
    if (gameData?.lastMove?.from && gameData?.lastMove?.to) { setMoveHighlight({ from: gameData.lastMove.from, to: gameData.lastMove.to }); } else { setMoveHighlight(null); }
  }, [gameData?.lastMove]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (!currentUser) { setGameId(null); setGameData(null); setView('lobby'); }
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Prefetch chessboard chunk once authenticated to remove first-load delay when entering a game
  useEffect(() => {
    if (!isAuthReady || !user) return;
    import('react-chessboard').catch(() => { });
  }, [isAuthReady, user]);

  useEffect(() => {
    if (!gameId || gameId.startsWith('local_')) {
      if (gameId === null) setGameData(null);
      return;
    }
    const unsubscribe = onSnapshot(doc(db, 'games', gameId), (docSnap) => {
      if (docSnap.exists()) { setGameData({ ...docSnap.data() }); } else { setGameId(null); setGameData(null); setView('lobby'); }
    });
    return () => unsubscribe();
  }, [gameId]);

  useEffect(() => {
    if (gameData?.status === 'finished' && gameData.tournamentId && user) {
      const q = query(collection(db, 'games'), where('tournamentId', '==', gameData.tournamentId), where('playerIds', 'array-contains', user.uid), where('status', '==', 'active'), orderBy('createdAt', 'desc'), limit(1));
      getDocs(q).then((snap) => { snap.docs.forEach((docSnap) => { if (docSnap.id !== gameId) { handleStartGame(docSnap.id); } }); });
    }
  }, [gameData?.status, gameData?.tournamentId, gameId, user]);

  const makeMove = useCallback(async (move) => {
    const gameCopy = new Chess(fen);
    const result = gameCopy.move(move);
    if (result === null) return null;
    if (settings.soundEnabled) {
      if (gameCopy.isGameOver()) playSound('game-over', settings);
      else if (gameCopy.inCheck()) playSound('check', settings);
      else if (result.captured) playSound('capture', settings);
      else playSound('move', settings);
    }
    const isGameOver = gameCopy.isGameOver();
    const newStatus = isGameOver ? 'finished' : 'active';
    let winner = null;
    let winReason = null;
    if (isGameOver) {
      if (gameCopy.isCheckmate()) { winner = result.color === 'w' ? gameData.player1 : gameData.player2; winReason = 'Checkmate'; } else { winReason = 'Draw'; }
    }
    const currentCaptured = gameData.capturedPieces || { w: [], b: [] };
    const newCaptured = { w: [...currentCaptured.w], b: [...currentCaptured.b] };
    if (result.captured) { if (result.color === 'w') newCaptured.w.push(result.captured); else newCaptured.b.push(result.captured); }

    if (gameData.mode === 'online') {
      const timeSinceLastMove = Date.now() / 1000 - (gameData.lastMoveTimestamp?.seconds || Date.now() / 1000);
      const timeTaken = Math.round(timeSinceLastMove);
      const timeUpdate = {};
      if (result.color === 'w') { timeUpdate.player1Time = Math.max(0, (gameData.player1Time || 0) - timeSinceLastMove); } else { timeUpdate.player2Time = Math.max(0, (gameData.player2Time || 0) - timeSinceLastMove); }

      if (gameData.timeControl === 'unlimited') {
        // Reset times to avoid any accidental timeouts or negative values, though UI handles it.
        // Actually, just don't update them or keep them at 0/null.
        // Let's just clear the timeUpdate object so we don't write new times to DB.
        delete timeUpdate.player1Time;
        delete timeUpdate.player2Time;
      }

      const gameRef = doc(db, 'games', gameId);
      const newMoveObj = { san: result.san, from: result.from, to: result.to, time: timeTaken, moveNumber: (gameData.moves || []).length + 1 };
      const lastMoveObj = { from: result.from, to: result.to, san: result.san, moveNumber: newMoveObj.moveNumber };

      const gameUpdate = { fen: gameCopy.fen(), moves: [...(gameData.moves || []), newMoveObj], capturedPieces: newCaptured, status: newStatus, winner: winner, winReason: winReason, lastMoveTimestamp: serverTimestamp(), lastMove: lastMoveObj, drawOffer: null, ...timeUpdate };

      await updateDoc(gameRef, gameUpdate);
      if (gameUpdate.status === 'finished' && gameData.tournamentId) {
        await updateTournamentMatchResult({ tournamentId: gameData.tournamentId, roundIndex: gameData.tournamentRound, gameId: gameId, winnerUid: winner ? winner.uid : null });
      }
      await addDoc(collection(doc(db, 'games', gameId), 'game_events'), { moveNumber: newMoveObj.moveNumber, playerColor: result.color, move: result.san, timestamp: serverTimestamp() });
    } else {
      const moveNumber = (gameData.moves || []).length + 1;
      setGameData((prev) => ({ ...prev, fen: gameCopy.fen(), moves: [...(prev.moves || []), { san: result.san, from: result.from, to: result.to, time: 0, moveNumber }], capturedPieces: newCaptured, status: newStatus, winner: winner, winReason: winReason, lastMove: { from: result.from, to: result.to, san: result.san, moveNumber } }));
    }
    return result;
  }, [fen, gameData, gameId, settings]);

  const handleHardwareMove = useCallback(async (moveData) => {
    console.log('Applying hardware move:', moveData);
    if (!moveData || !moveData.from || !moveData.to) { console.error('Invalid hardware payload:', moveData); return false; }
    const result = await makeMove({ from: moveData.from, to: moveData.to, promotion: moveData.promotion || 'q' });
    const ok = result !== null;
    if (ok) { console.log('Hardware move applied successfully:', moveData); } else { console.warn('Hardware move rejected:', moveData); }
    return ok;
  }, [makeMove]);

  useEffect(() => { handleHardwareMoveRef.current = handleHardwareMove; }, [handleHardwareMove]);



  useEffect(() => {
    const isMyTurn = (gameData?.mode === 'computer' && game?.turn() === 'w') || gameData?.mode === 'offline' || (gameData?.mode === 'online' && ((user?.uid === gameData?.player1?.uid && game?.turn() === 'w') || (user?.uid === gameData?.player2?.uid && game?.turn() === 'b')));
    if (premove && isMyTurn) {
      try {
        const gameCopy = new Chess(fen);
        const move = gameCopy.move({ from: premove.from, to: premove.to, promotion: premove.promotion });
        if (move) { makeMove(premove); }
      } catch (e) { console.warn('Premove failed', e); } finally { setPremove(null); }
    }
  }, [fen, premove, game, gameData, user, makeMove]);

  async function onDrop(sourceSquare, targetSquare) {
    setMoveFrom(null);
    setOptionSquares({});
    if (!game || !gameData) return false;
    if (gameData.status !== 'active' || promotionMove) return false;
    const isMyTurn = (gameData.mode === 'computer' && game.turn() === 'w') || gameData.mode === 'offline' || (gameData.mode === 'online' && ((user?.uid === gameData.player1?.uid && game.turn() === 'w') || (user?.uid === gameData.player2?.uid && game.turn() === 'b')));
    if (!isMyTurn) {
      if (settings.premovesEnabled && gameData.mode === 'online') { setPremove({ from: sourceSquare, to: targetSquare }); }
      return false;
    }
    const gameCopy = new Chess(fen);
    const moves = gameCopy.moves({ square: sourceSquare, verbose: true });
    const move = moves.find((m) => m.to === targetSquare);
    if (!move) return false;
    if (move.flags.includes('p')) { setPromotionMove({ from: sourceSquare, to: targetSquare }); return false; }
    const moveResult = await makeMove({ from: sourceSquare, to: targetSquare });
    return moveResult !== null;
  }

  const handleSelectPromotion = (piece) => {
    if (!promotionMove) return;
    makeMove({ from: promotionMove.from, to: promotionMove.to, promotion: piece });
    setPromotionMove(null);
  };

  const handleSquareRightClick = () => { setPremove(null); };

  function onSquareClick(square) {
    if (moveFrom && optionSquares[square]) { onDrop(moveFrom, square); return; }
    if (!settings.highlightMoves) { setOptionSquares({}); setMoveFrom(null); return; }
    const isMyTurn = (gameData.mode === 'computer' && game.turn() === 'w') || gameData.mode === 'offline' || (gameData.mode === 'online' && ((user.uid === gameData.player1?.uid && game.turn() === 'w') || (user.uid === gameData.player2?.uid && game.turn() === 'b')));
    if (!isMyTurn) return;
    const piece = game.get(square);
    if (piece && piece.color === game.turn()) {
      const moves = game.moves({ square, verbose: true });
      if (moves.length === 0) { setOptionSquares({}); setMoveFrom(null); return; }
      setMoveFrom(square);
      const newSquares = {};
      moves.forEach((move) => {
        const isCapture = Boolean(move.captured) || (move.flags && move.flags.includes('c'));
        newSquares[move.to] = { background: isCapture ? 'radial-gradient(circle, rgba(255,0,0,.55) 85%, transparent 85%)' : 'radial-gradient(circle, rgba(0,0,0,.12) 25%, transparent 25%)', borderRadius: '50%', transition: 'background-color 120ms ease, box-shadow 120ms ease' };
      });
      newSquares[square] = { background: 'rgba(255, 255, 0, 0.4)', transition: 'background-color 120ms ease, box-shadow 120ms ease' };
      setOptionSquares(newSquares);
    } else { setMoveFrom(null); setOptionSquares({}); }
  }

  useEffect(() => {
    if (gameData?.mode !== 'hardware_test' || !gameData?.boardCode) return;
    console.log(`Subscribing to hardware moves for board: ${gameData.boardCode}`);
    const unsubscribe = onSnapshot(doc(db, 'hardware_moves', gameData.boardCode), (docSnap) => {
      if (!docSnap.exists()) return;
      const moveData = docSnap.data();
      const lastMoveInState = gameDataRef.current.moves.length > 0 ? gameDataRef.current.moves[gameDataRef.current.moves.length - 1] : null;
      if (moveData && moveData.from && (!lastMoveInState || moveData.seq > (lastMoveInState.seq || 0))) {
        console.log('Received new hardware move:', moveData);
        handleHardwareMoveRef.current(moveData);
      }
    }, (error) => console.error('Error listening to hardware moves:', error));
    return () => unsubscribe();
  }, [gameData?.mode, gameData?.boardCode]);

  const playerOrientation = useMemo(() => {
    if (!user || !gameData) return 'white';
    if (gameData.mode === 'offline' || gameData.mode === 'hardware_test') return 'white';
    if (gameData.player1?.uid === user.uid) return 'white';
    if (gameData.player2?.uid === user.uid) return 'black';
    return 'white';
  }, [user, gameData]);

  const renderGameStatus = () => {
    if (!gameData || gameData.status === 'finished') return null;
    if (gameData.status === 'waiting') return <p className="text-yellow-400 animate-pulse">Waiting for an opponent...</p>;
    if (!game) return <p className="text-red-500">Error: Invalid board state.</p>;
    const turnColor = game.turn() === 'w' ? 'White' : 'Black';
    const isMyTurn = (gameData.mode === 'computer' && game?.turn() === 'w') || gameData.mode === 'offline' || gameData.mode === 'hardware_test' || (gameData.mode === 'online' && ((user.uid === gameData.player1?.uid && game?.turn() === 'w') || (user.uid === gameData.player2?.uid && game?.turn() === 'b')));
    if (gameData.mode === 'hardware_test') return <p className="text-xl text-green-400">{turnColor}'s turn</p>;
    return <p className={`text-xl ${isMyTurn ? 'text-green-400' : 'text-gray-400'}`}>{turnColor}'s turn {isMyTurn ? '(Your Move)' : ''}</p>;
  };

  // Custom leave game behavior: if this game is part of a tournament, return to tournament lobby
  const leaveGame = () => {
    setGameId(null);
    // Only redirect to tournament lobby if the GAME ITSELF was part of a tournament
    if (gameData?.tournamentId) {
      setTournamentId(gameData.tournamentId);
      setView('tournament_lobby');
    } else {
      // Otherwise, clear tournament state and go to main lobby
      setTournamentId(null);
      setView('lobby');
    }
  };
  const handleStartGame = (id) => { logStep('handleStartGame', { id }); setGameId(id); setView('game'); };
  const handleStartVsComputer = () => { setGameData({ mode: 'computer', fen: new Chess().fen(), moves: [], chatMessages: [], capturedPieces: { w: [], b: [] }, player1: { uid: user.uid, email: user.email }, player2: { uid: 'AI', email: 'Computer' }, status: 'active', lastMove: null }); setGameId('local_computer_game'); setView('game'); };
  const handleStartOfflineGame = () => { setGameData({ mode: 'offline', fen: new Chess().fen(), moves: [], capturedPieces: { w: [], b: [] }, player1: { email: 'White' }, player2: { email: 'Black' }, status: 'active', lastMove: null }); setGameId('local_offline_game'); setView('game'); };

  const handleTimeout = useCallback(async (color) => {
    if (!gameData || gameData.status !== 'active') return;
    const gameRef = doc(db, 'games', gameId);
    const winner = color === 'white' ? gameData.player2 : gameData.player1;
    await updateDoc(gameRef, { status: 'finished', winner, winReason: 'Timeout' });
    if (gameData.tournamentId) {
      await updateTournamentMatchResult({
        tournamentId: gameData.tournamentId,
        roundIndex: gameData.tournamentRound,
        gameId: gameId,
        winnerUid: winner.uid,
      });
    }
  }, [gameData, gameId]);

  const handleConnectHardwareGame = async (gameDetails) => {
    const safeBoardCode = gameDetails.boardCode.trim();
    console.log('Connecting to board:', safeBoardCode);
    try {
      await setDoc(doc(db, 'boards', safeBoardCode), {
        players: [user.uid],
        createdAt: serverTimestamp(),
        player1Name: gameDetails.whiteName,
        player2Name: gameDetails.blackName,
      });
      console.log('Successfully created board players doc.');
    } catch (err) {
      console.error('Failed to create board players doc:', err);
      return;
    }
    setGameData({ mode: 'hardware_test', fen: new Chess().fen(), moves: [], capturedPieces: { w: [], b: [] }, player1: { email: gameDetails.whiteName }, player2: { email: gameDetails.blackName }, status: 'active', lastMove: null, boardCode: safeBoardCode });
    setGameId(`local_hardware_${safeBoardCode}`);
    setView('game');
    setShowConnectModal(false);
  };

  const handleReviewGame = (gameToReview) => { setReviewGameData(gameToReview); setView('review'); };
  const handleShowCreateTournamentModal = () => { setShowCreateTournamentModal(true); };
  const handleSelectTournament = (id) => { setTournamentId(id); setView('tournament_lobby'); };
  const handleCreateTournamentSuccess = (id) => { setShowCreateTournamentModal(false); setTournamentId(id); setView('tournament_lobby'); };

  const handleRematch = useCallback(async (action) => {
    try {
      if (!gameData || gameData.mode !== 'online') return;
      if (gameData.tournamentId) { logStep('rematch-disabled', { reason: 'tournament game' }); return; }

      const gameRef = doc(db, 'games', gameId);
      const p1 = gameData.player1;
      const p2 = gameData.player2;

      if (!p1 || !p2) {
        console.error('Cannot rematch: missing player data');
        return;
      }

      const myPlayerKey = user.uid === p1.uid ? 'player1' : 'player2';

      if (action === 'accept') {
        const newGameId = makeGameId(user.uid);
        const newGameRef = doc(db, 'games', newGameId);
        const timeControl = gameData.timeControl || 300;

        await setDoc(newGameRef, {
          mode: gameData.mode,
          timeControl: timeControl,
          player1: p2,
          player2: p1,
          playerIds: [p2.uid, p1.uid],
          fen: new Chess().fen(),
          moves: [],
          chatMessages: [],
          capturedPieces: { w: [], b: [] },
          status: 'active',
          winner: null,
          winReason: null,
          drawOffer: null,
          rematchOffer: null,
          webrtc_signals: { offer: null, answer: null, iceCandidates: [] },
          createdAt: serverTimestamp(),
          player1Time: timeControl,
          player2Time: timeControl,
          lastMoveTimestamp: serverTimestamp(),
          tournamentId: null,
          tournamentRound: null,
          createdByUid: user.uid
        });

        await updateDoc(gameRef, { rematchedGameId: newGameId });
      } else {
        await updateDoc(gameRef, { rematchOffer: myPlayerKey });
      }
    } catch (err) {
      console.error('Rematch error:', err);
    }
  }, [gameData, gameId, user]);

  useEffect(() => { if (gameData?.rematchedGameId) { handleStartGame(gameData.rematchedGameId); } }, [gameData?.rematchedGameId]);

  const renderContent = () => {
    if (!isAuthReady) return <div className="flex justify-center items-center h-64"><p>Authenticating...</p></div>;
    if (!user) return <AuthForm onAuthSuccess={() => { }} />;
    switch (view) {
      case 'review': return <GameReviewPage user={user} gameData={reviewGameData} setView={setView} />;
      case 'profile': return <ProfilePage user={user} setView={setView} onReviewGame={handleReviewGame} />;
      case 'tournament_lobby': return <TournamentLobby user={user} tournamentId={tournamentId} setView={setView} onGameStart={handleStartGame} />;
      case 'game': {
        if (gameId && !gameData) return <div className="flex justify-center items-center h-64"><p className="text-2xl animate-pulse">Loading game...</p></div>;
        if (!gameId || !gameData) { setView('lobby'); return null; }
        const premoveSquareStyles = premove ? { [premove.from]: { backgroundColor: 'rgba(255, 255, 0, 0.4)' }, [premove.to]: { backgroundColor: 'rgba(255, 255, 0, 0.4)' } } : {};
        const lastMoveStyles = moveHighlight ? { [moveHighlight.from]: { backgroundColor: 'rgba(255, 255, 0, 0.4)', transition: 'background-color 120ms ease, box-shadow 120ms ease' }, [moveHighlight.to]: { backgroundColor: 'rgba(255, 255, 0, 0.4)', transition: 'background-color 120ms ease, box-shadow 120ms ease' } } : {};
        // Determine if current user is a spectator (not one of the players) for online games
        const isSpectator = gameData && gameData.mode === 'online' && user && Array.isArray(gameData.playerIds) && !gameData.playerIds.includes(user.uid);
        return (
          <div className="relative">
            <GameOverDialog gameData={gameData} user={user} onViewProfile={() => setView('profile')} onLeave={leaveGame} onRematch={handleRematch} isSpectator={isSpectator} />
            <div className="relative flex flex-col lg:flex-row gap-8">
              {promotionMove && <PromotionDialog color={playerOrientation} onSelectPromotion={handleSelectPromotion} />}
              <div className="w-full lg:w-2/3">
                <CapturedPiecesPanel pieces={playerOrientation === 'white' ? gameData.capturedPieces.b : gameData.capturedPieces.w} color={playerOrientation === 'white' ? 'w' : 'b'} />
                <Suspense fallback={<ChessboardFallback className="h-[520px]" />}>
                  <Chessboard position={fen} onPieceDrop={onDrop} boardOrientation={playerOrientation} onSquareClick={onSquareClick} onSquareRightClick={handleSquareRightClick} customSquareStyles={{ ...optionSquares, ...premoveSquareStyles, ...lastMoveStyles }} customBoardStyle={{ borderRadius: '8px', boxShadow: '0 5px 15px rgba(0, 0, 0, 0.5)' }} />
                </Suspense>
                <CapturedPiecesPanel pieces={playerOrientation === 'white' ? gameData.capturedPieces.w : gameData.capturedPieces.b} color={playerOrientation === 'white' ? 'b' : 'w'} />
              </div>
              <div className="w-full lg:w-1/3 p-6 glass rounded-2xl shadow-2xl relative flex flex-col h-[800px]">
                {/* --- Header Section: Clocks & Info --- */}
                <div className="flex-shrink-0 mb-4">
                  {gameData.mode === 'online' && <GameClocks gameData={gameData} game={game} onTimeout={handleTimeout} />}

                  {/* Game Info Summary */}
                  <div className="bg-gray-900 p-3 rounded-md mb-2">
                    {gameData.tournamentId && <div className="mb-2 p-2 bg-yellow-900/50 rounded text-center"><p className="text-yellow-300 font-bold text-sm">Tournament Match (Round {gameData.tournamentRound})</p></div>}
                    <div className="text-center mb-2">{renderGameStatus()}</div>
                    <div className="flex justify-between text-sm text-gray-300 px-2">
                      <span>⚪ {gameData.player1?.email?.split('@')[0] || 'White'}</span>
                      <span>⚫ {gameData.player2?.email?.split('@')[0] || 'Black'}</span>
                    </div>
                  </div>
                </div>

                {/* --- Scrollable Content Area --- */}
                <div className="flex-grow overflow-y-auto space-y-4 pr-2 custom-scrollbar">

                  {/* 1. Video Chat Section */}
                  {gameData.mode === 'online' && (
                    <div className="bg-gray-900 rounded-lg p-2">
                      <VideoChat gameData={gameData} gameId={gameId} user={user} />
                    </div>
                  )}

                  {/* 2. Moves Section (Collapsible) */}
                  <div className="bg-gray-900 rounded-lg overflow-hidden">
                    <button
                      onClick={() => setMobileAccordion(mobileAccordion === 'moves' ? '' : 'moves')}
                      className="w-full px-4 py-2 bg-gray-700 hover:bg-gray-600 flex justify-between items-center transition"
                    >
                      <span className="font-bold text-white">Move History</span>
                      <span className="text-gray-400">{mobileAccordion === 'moves' ? '▼' : '▶'}</span>
                    </button>

                    {/* Always show if desktop, or if toggled open. For this "Stacked" view, let's default to OPEN but collapsible. 
                        Actually, let's use the state to toggle visibility. Default 'moves' to open? 
                        Let's reuse 'mobileAccordion' state for this collapsible section. 
                    */}
                    {mobileAccordion === 'moves' && (
                      <div className="p-2 h-48 overflow-y-auto bg-gray-800/50 inner-shadow">
                        {(() => {
                          const moves = gameData.moves || [];
                          const lastMoveNumber = gameData.lastMove?.moveNumber || null;
                          const rows = [];
                          for (let i = 0; i < moves.length; i += 2) {
                            rows.push({ num: Math.floor(i / 2) + 1, white: moves[i], black: moves[i + 1] });
                          }
                          if (rows.length === 0) return <p className="text-gray-400 text-sm p-2">No moves yet.</p>;
                          return rows.map((row) => (
                            <div key={row.num} className="grid grid-cols-[30px,1fr,1fr] items-center gap-2 px-2 py-1 rounded hover:bg-gray-700/50 text-sm">
                              <div className="text-gray-500 font-mono text-xs">{row.num}.</div>
                              <div className={`px-2 py-0.5 rounded ${lastMoveNumber === row.white?.moveNumber ? 'bg-yellow-600/40 text-yellow-200' : 'text-gray-300'}`}>
                                {row.white?.san || '...'}
                              </div>
                              <div className={`px-2 py-0.5 rounded ${lastMoveNumber === row.black?.moveNumber ? 'bg-yellow-600/40 text-yellow-200' : 'text-gray-300'}`}>
                                {row.black?.san || '...'}
                              </div>
                            </div>
                          ));
                        })()}
                      </div>
                    )}
                  </div>

                  {/* 3. Chat Section */}
                  <div className="bg-gray-900 rounded-lg p-3 flex-grow flex flex-col min-h-[200px]">
                    <ChatBox user={user} gameId={gameId} messages={gameData.chatMessages || []} />
                  </div>

                  {/* Spectator Requests / Info */}
                  {gameData.mode === 'online' && gameData.spectatorRequests && (
                    <div className="text-center">
                      <div className="inline-flex items-center bg-gray-700 px-3 py-1 rounded-full text-xs text-gray-300">
                        <span className="mr-2">👁️</span>
                        {Object.values(gameData.spectatorRequests).filter(r => r.status === 'accepted').length} Spectators
                      </div>
                    </div>
                  )}
                </div>

                {/* --- Footer Section: Actions --- */}
                <div className="mt-4 pt-4 border-t border-gray-700 space-y-2 flex-shrink-0">
                  {gameData.mode === 'online' && <GameActions user={user} gameData={gameData} gameId={gameId} />}

                  {/* Share Link (Collapsible or just small) */}
                  {gameData.mode === 'online' && gameData.status === 'waiting' && user.uid === gameData.player1?.uid && (
                    <div className="text-xs text-center text-gray-500 cursor-pointer hover:text-gray-300" onClick={() => navigator.clipboard.writeText(window.location.href)}>
                      Click to copy invite link
                    </div>
                  )}

                  <button onClick={leaveGame} className="w-full bg-gray-700 text-gray-300 py-2 rounded-md hover:bg-gray-600 hover:text-white transition text-sm font-medium">
                    Leave Game
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      }
      case 'lobby':
      default:
        return (
          <GameSetup user={user} onGameStart={handleStartGame} onStartVsComputer={handleStartVsComputer} onStartOfflineGame={handleStartOfflineGame} onShowConnectModal={() => setShowConnectModal(true)} onShowCreateTournamentModal={handleShowCreateTournamentModal} onSelectTournament={handleSelectTournament} />
        );
    }
  };

  // Join tournament if ?tournamentId=... is present in URL after auth is ready
  useEffect(() => {
    if (!isAuthReady || !user) return;
    // Only handle once
    if (tournamentId) return;
    const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const urlTournamentId = params && params.get('tournamentId');
    if (!urlTournamentId) return;

    // Simply navigate to the tournament lobby
    setTournamentId(urlTournamentId);
    setView('tournament_lobby');
  }, [isAuthReady, user, tournamentId]);

  // Join game if ?gameId=... is present in URL after auth is ready
  useEffect(() => {
    if (!isAuthReady || !user) return;
    // Only handle once
    if (gameId) return;
    const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const urlGameId = params && params.get('gameId');
    if (!urlGameId) return;
    // Fetch game and join or spectate accordingly
    (async () => {
      try {
        const gRef = doc(db, 'games', urlGameId);
        const snap = await getDoc(gRef);
        if (!snap.exists()) return;
        const data = snap.data();
        if (!data) return;
        // If we are host
        if (data.player1?.uid === user.uid) {
          setGameId(urlGameId);
          setView('game');
          return;
        }
        // If waiting for opponent and we can join
        if (data.status === 'waiting' && !data.player2) {
          try {
            await runTransaction(db, async (tx) => {
              const ds = await tx.get(gRef);
              if (!ds.exists()) throw new Error('Game not found');
              const d = ds.data();
              if (d.status !== 'waiting' || d.player2) return;
              if (d.player1?.uid === user.uid) return;
              tx.update(gRef, {
                player2: { uid: user.uid, email: user.email },
                playerIds: Array.from(new Set([d.player1.uid, user.uid])),
                status: 'active',
                lastMoveTimestamp: serverTimestamp(),
                player1Time: d.player1Time != null ? d.player1Time : d.timeControl || 300,
                player2Time: d.player2Time != null ? d.player2Time : d.timeControl || 300
              });
            });
          } catch (e) {
            console.warn('URL join: failed to join game', e);
          }
        }
        // Open the game (spectate or play)
        setGameId(urlGameId);
        setView('game');
      } catch (err) {
        console.warn('URL join error', err);
      }
    })();
  }, [isAuthReady, user, gameId]);
  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-gray-900 text-white p-4 sm:p-6 md:p-8 flex flex-col items-center">
        <header className="w-full max-w-6xl flex justify-between items-center mb-8">
          <h1 className="text-4xl font-bold tracking-wider">Shatranj</h1>
          {user && (
            <div className="flex items-center space-x-4">
              <p className="text-gray-300 hidden sm:block">{user.email}</p>
              <button onClick={() => setView('profile')} className="bg-purple-600 px-4 py-2 rounded-md hover:bg-purple-700 transition">Profile</button>
              <button onClick={() => signOut(auth)} className="bg-red-600 px-4 py-2 rounded-md hover:bg-red-700 transition">Logout</button>
              <button onClick={() => setShowSettings(true)} className="p-2 rounded-full hover:bg-gray-700 transition">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
              </button>
            </div>
          )}
        </header>
        <main className="w-full max-w-6xl flex-grow">
          {showSettings && <SettingsDialog settings={settings} setSettings={setSettings} onClose={() => setShowSettings(false)} />}
          {showConnectModal && <ConnectBoardModal onClose={() => setShowConnectModal(false)} onConnect={handleConnectHardwareGame} />}
          {showCreateTournamentModal && <CreateTournamentModal user={user} onClose={() => setShowCreateTournamentModal(false)} onCreate={handleCreateTournamentSuccess} />}
          {renderContent()}
        </main>
      </div>
    </ErrorBoundary>
  );
}
