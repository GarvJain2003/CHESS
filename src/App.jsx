import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
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
    serverTimestamp
} from 'firebase/firestore';

// --- Firebase Configuration ---
// Using hardcoded values to resolve local build environment issues.
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

// --- Helper Components ---

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
            onAuthSuccess();
        } catch (err) {
            setError(err.message);
        }
    };

    return (
        <div className="w-full max-w-md mx-auto p-8 bg-gray-800 rounded-lg shadow-lg">
            <h2 className="text-3xl font-bold text-white text-center mb-6">{isLogin ? 'Login' : 'Register'}</h2>
            <form onSubmit={handleSubmit}>
                <div className="mb-4">
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="w-full px-4 py-2 bg-gray-700 text-white border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500" required />
                </div>
                <div className="mb-6">
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" className="w-full px-4 py-2 bg-gray-700 text-white border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500" required />
                </div>
                {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
                <button type="submit" className="w-full bg-indigo-600 text-white py-2 rounded-md hover:bg-indigo-700 transition duration-300">
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

const GameSetup = ({ user, onGameStart, onStartVsComputer }) => {
    const [openGames, setOpenGames] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const q = query(collection(db, 'games'), where('status', '==', 'waiting'), limit(20));
        const unsubscribe = onSnapshot(q, (querySnapshot) => {
            const games = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setOpenGames(games);
            setLoading(false);
        });
        return () => unsubscribe();
    }, []);

    const handleCreateGame = async () => {
        setLoading(true);
        const gameId = user.uid + "_" + Date.now();
        const gameRef = doc(db, 'games', gameId);
        const initialTime = 300; // 5 minutes in seconds

        await setDoc(gameRef, {
            mode: 'online',
            player1: { uid: user.uid, email: user.email },
            player2: null,
            playerIds: [user.uid],
            fen: new Chess().fen(),
            moves: [],
            status: 'waiting',
            winner: null,
            createdAt: serverTimestamp(),
            player1Time: initialTime,
            player2Time: initialTime,
            lastMoveTimestamp: serverTimestamp(),
        });
        onGameStart(gameId);
    };
    
    const handleJoinGame = async (gameId) => {
        setLoading(true);
        const gameRef = doc(db, 'games', gameId);
        const gameDoc = await getDoc(gameRef);
        if (gameDoc.exists()) {
             await updateDoc(gameRef, {
                player2: { uid: user.uid, email: user.email },
                playerIds: [gameDoc.data().player1.uid, user.uid],
                status: 'active',
                lastMoveTimestamp: serverTimestamp(), 
            });
            onGameStart(gameId);
        }
    };

    return (
        <div className="w-full max-w-2xl mx-auto p-8 bg-gray-800 rounded-lg shadow-lg">
            <h2 className="text-3xl font-bold text-white text-center mb-6">Game Lobby</h2>
            <div className="flex justify-center items-center space-x-4 mb-6">
                 <button onClick={handleCreateGame} className="bg-green-600 text-white font-bold py-2 px-6 rounded-md hover:bg-green-700 transition duration-300 disabled:bg-gray-500" disabled={loading}>
                    Create Online Game
                </button>
                <button onClick={onStartVsComputer} className="bg-blue-600 text-white font-bold py-2 px-6 rounded-md hover:bg-blue-700 transition duration-300">
                    Play vs Computer
                </button>
            </div>
            <h3 className="text-2xl text-white mb-4">Open Online Games</h3>
            <div className="h-64 overflow-y-auto bg-gray-900 p-4 rounded-md">
                {loading && <p className="text-gray-400">Loading...</p>}
                {!loading && openGames.length === 0 && <p className="text-gray-400">No open games. Create one!</p>}
                {openGames.map(g => (
                    <div key={g.id} className="flex justify-between items-center p-3 mb-2 bg-gray-700 rounded-md">
                        <p className="font-bold text-white">{g.player1.email}</p>
                        {g.player1.uid !== user.uid && (
                             <button onClick={() => handleJoinGame(g.id)} className="bg-indigo-600 text-white py-1 px-4 rounded-md hover:bg-indigo-700 transition duration-300" disabled={loading}>
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
        
        const q = query(
            collection(db, 'games'), 
            where('status', '==', 'finished'), 
            where('playerIds', 'array-contains', user.uid),
            limit(50)
        );

        getDocs(q).then(querySnapshot => {
            const games = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            const sortedGames = games.sort((a, b) => b.createdAt.toDate() - a.createdAt.toDate());
            setPastGames(sortedGames);
            setLoading(false);
        });
    }, [user]);

    return (
        <div className="w-full max-w-4xl mx-auto p-8 bg-gray-800 rounded-lg shadow-lg">
            <div className="flex justify-between items-center mb-6">
                <h2 className="text-3xl font-bold text-white">Your Profile</h2>
                <button onClick={() => setView('lobby')} className="bg-gray-600 text-white py-2 px-4 rounded-md hover:bg-gray-700">Back to Lobby</button>
            </div>
            <p className="text-lg text-gray-300 mb-6">Email: {user.email}</p>
            <h3 className="text-2xl text-white mb-4">Completed Games</h3>
            <div className="h-96 overflow-y-auto bg-gray-900 p-4 rounded-md">
                {loading && <p className="text-gray-400">Loading game history...</p>}
                {!loading && pastGames.length === 0 && <p className="text-gray-400">You haven't completed any games yet.</p>}
                {pastGames.map(game => {
                    const opponent = user.uid === game.player1.uid ? game.player2 : game.player1;
                    const result = game.winner ? (game.winner.uid === user.uid ? 'Won' : 'Lost') : 'Draw';
                    const resultColor = result === 'Won' ? 'text-green-400' : 'text-red-400';

                    return (
                        <button key={game.id} onClick={() => onReviewGame(game)} className="w-full grid grid-cols-3 gap-4 items-center p-3 mb-2 bg-gray-700 rounded-md text-left hover:bg-gray-600 transition">
                            <div><p className="text-white">vs {opponent?.email || 'N/A'}</p></div>
                            <div className="text-center"><p className={`font-bold ${resultColor}`}>{result}</p></div>
                            <div className="text-right text-gray-400 text-sm"><p>{new Date(game.createdAt?.toDate()).toLocaleDateString()}</p></div>
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
            reviewGame.move(gameData.moves[i].san);
        }
        return reviewGame.fen();
    }, [moveIndex, gameData.moves]);
    
    const handleNext = () => setMoveIndex(prev => Math.min(prev + 1, gameData.moves.length - 1));
    const handlePrev = () => setMoveIndex(prev => Math.max(prev - 1, -1));
    const handleStart = () => setMoveIndex(-1);
    const handleEnd = () => setMoveIndex(gameData.moves.length - 1);

    const opponent = user.uid === gameData.player1.uid ? gameData.player2 : gameData.player1;

    return (
         <div className="flex flex-col lg:flex-row gap-8">
            <div className="w-full lg:w-2/3">
                <Chessboard 
                    position={reviewFen} 
                    arePiecesDraggable={false}
                    customBoardStyle={{ borderRadius: '8px', boxShadow: '0 5px 15px rgba(0, 0, 0, 0.5)' }} 
                />
            </div>
            <div className="w-full lg:w-1/3 p-6 bg-gray-800 rounded-lg shadow-lg">
                <h3 className="text-2xl font-bold mb-4 border-b border-gray-600 pb-2">Game Review</h3>
                <p className="mb-4">Reviewing your game against {opponent?.email || 'N/A'}.</p>
                <div className="space-y-2 mb-6">
                   <p><strong>White:</strong> {gameData.player1?.email}</p>
                   <p><strong>Black:</strong> {gameData.player2?.email}</p>
                </div>
                
                <h4 className="text-xl font-bold mt-6 mb-2">Controls</h4>
                <div className="grid grid-cols-2 gap-2 mb-4">
                    <button onClick={handleStart} className="bg-gray-600 py-2 rounded-md hover:bg-gray-700">Start</button>
                    <button onClick={handleEnd} className="bg-gray-600 py-2 rounded-md hover:bg-gray-700">End</button>
                    <button onClick={handlePrev} className="bg-blue-600 py-2 rounded-md hover:bg-blue-700">Previous</button>
                    <button onClick={handleNext} className="bg-blue-600 py-2 rounded-md hover:bg-blue-700">Next</button>
                </div>

                <h4 className="text-xl font-bold mt-6 mb-2">Move History ({moveIndex + 1} / {gameData.moves.length})</h4>
                 <div className="h-48 overflow-y-auto bg-gray-900 p-2 rounded-md font-mono text-sm">
                    {gameData.moves?.map((move, index) => (
                        <div key={index} className={`flex justify-between items-center p-1 rounded ${index === moveIndex ? 'bg-blue-600' : ''}`}>
                           <span>{index % 2 === 0 ? `${Math.floor(index / 2) + 1}. ` : ''} {move.san}</span>
                           <span className="text-gray-500">{move.time}s</span>
                        </div>
                    ))}
                </div>
                <button onClick={() => setView('profile')} className="w-full mt-6 bg-gray-600 text-white py-2 rounded-md hover:bg-gray-700 transition">
                    Back to Profile
                </button>
            </div>
        </div>
    );
};

const GameClocks = ({ gameData, game }) => {
    const [whiteTime, setWhiteTime] = useState(gameData.player1Time);
    const [blackTime, setBlackTime] = useState(gameData.player2Time);

    useEffect(() => {
        setWhiteTime(gameData.player1Time);
        setBlackTime(gameData.player2Time);

        const interval = setInterval(() => {
            if (gameData.status !== 'active' || game.isGameOver()) {
                return;
            }

            const now = Date.now() / 1000;
            const lastMoveTime = gameData.lastMoveTimestamp?.seconds || now;
            const timeElapsed = now - lastMoveTime;

            if (game.turn() === 'w') {
                setWhiteTime(Math.max(0, gameData.player1Time - timeElapsed));
            } else {
                setBlackTime(Math.max(0, gameData.player2Time - timeElapsed));
            }
        }, 1000);

        return () => clearInterval(interval);

    }, [gameData, game]);

    const formatTime = (seconds) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    };

    return (
        <div className="w-full flex justify-between items-center mb-4">
            <div className="bg-gray-900 p-3 rounded-md text-center">
                <p className="text-lg font-bold">{gameData.player2?.email || 'Black'}</p>
                <p className={`text-2xl font-mono ${game.turn() === 'b' ? 'text-green-400' : ''}`}>{formatTime(blackTime)}</p>
            </div>
            <div className="bg-gray-900 p-3 rounded-md text-center">
                 <p className="text-lg font-bold">{gameData.player1?.email || 'White'}</p>
                <p className={`text-2xl font-mono ${game.turn() === 'w' ? 'text-green-400' : ''}`}>{formatTime(whiteTime)}</p>
            </div>
        </div>
    );
};


// Main App component
export default function App() {
    const [user, setUser] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [view, setView] = useState('lobby'); 
    const [gameId, setGameId] = useState(null);
    const [gameData, setGameData] = useState(null);
    const [reviewGameData, setReviewGameData] = useState(null);
    
    const fen = gameData ? gameData.fen : 'start';
    
    const game = useMemo(() => {
        try {
            if (fen === 'start') return new Chess();
            return new Chess(fen);
        } catch (e) {
            return null;
        }
    }, [fen]);
    
    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
            setUser(currentUser);
            if (!currentUser) {
                setGameId(null);
                setGameData(null);
                setView('lobby');
            }
            setIsAuthReady(true);
        });
        return () => unsubscribe();
    }, []);

    useEffect(() => {
        if (!gameId || gameId === 'local_computer_game') {
            if (gameId === null) setGameData(null); 
            return;
        }

        const gameRef = doc(db, 'games', gameId);
        const unsubscribe = onSnapshot(gameRef, (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data();
                setGameData({ ...data }); 
            } else {
                setGameId(null);
                setGameData(null);
                setView('lobby');
            }
        });
        return () => unsubscribe();
    }, [gameId]);

    const makeAIMove = useCallback(() => {
        if (!game || game.turn() !== 'b' || game.isGameOver()) return;

        const possibleMoves = game.moves({ verbose: true });
        if (possibleMoves.length === 0) return;
        const bestMove = possibleMoves[Math.floor(Math.random() * possibleMoves.length)];
        
        const gameCopy = new Chess(fen);
        gameCopy.move(bestMove.san);
        
        setGameData(prev => ({ 
            ...prev, 
            fen: gameCopy.fen(),
            moves: [...(prev.moves || []), { san: bestMove.san, time: 0 }] 
        }));
    }, [game, fen]);

    useEffect(() => {
        if (gameData?.mode === 'computer' && game?.turn() === 'b' && !game?.isGameOver()) {
            setTimeout(makeAIMove, 500);
        }
    }, [fen, gameData, game, makeAIMove]);

    const handleLogout = () => signOut(auth);
    
    const handleStartGame = (id) => {
        setGameId(id);
        setView('game');
    };
    
    const handleStartVsComputer = () => {
        setGameData({
            mode: 'computer',
            fen: new Chess().fen(),
            moves: [],
            player1: { uid: user.uid, email: user.email },
            player2: { uid: 'AI', email: 'Computer' },
            status: 'active',
        });
        setGameId('local_computer_game');
        setView('game');
    }

    const handleReviewGame = (gameToReview) => {
        setReviewGameData(gameToReview);
        setView('review');
    };

    function onDrop(sourceSquare, targetSquare) {
        if (!game || !gameData || !user) return false;
        if (gameData.status !== 'active') return false;

        const isMyTurn = 
            (gameData.mode === 'computer' && game.turn() === 'w') ||
            (gameData.mode === 'online' && (
                (user.uid === gameData.player1?.uid && game.turn() === 'w') ||
                (user.uid === gameData.player2?.uid && game.turn() === 'b')
            ));
        
        if (!isMyTurn) return false;

        const gameCopy = new Chess(fen);
        const move = gameCopy.move({ from: sourceSquare, to: targetSquare, promotion: 'q' });

        if (move === null) return false; 
        
        if (gameData.mode === 'online') {
            const timeSinceLastMove = (Date.now() / 1000) - (gameData.lastMoveTimestamp?.seconds || Date.now() / 1000);
            const timeTaken = Math.round(timeSinceLastMove);
            const timeUpdate = {};
            if (game.turn() === 'w') {
                timeUpdate.player1Time = gameData.player1Time - timeSinceLastMove;
            } else {
                timeUpdate.player2Time = gameData.player2Time - timeSinceLastMove;
            }
            if (timeUpdate.player1Time < 0 || timeUpdate.player2Time < 0) {
                return false;
            }

            const gameRef = doc(db, 'games', gameId);
            const isGameOver = gameCopy.isGameOver();
            const newStatus = isGameOver ? 'finished' : 'active';
            const winner = isGameOver ? (gameCopy.turn() === 'w' ? gameData.player2 : gameData.player1) : null;
            
            updateDoc(gameRef, {
                fen: gameCopy.fen(),
                moves: [...(gameData.moves || []), { san: move.san, time: timeTaken }],
                status: newStatus,
                winner: winner,
                lastMoveTimestamp: serverTimestamp(),
                ...timeUpdate
            });
        } else { 
            setGameData(prev => ({ 
                ...prev, 
                fen: gameCopy.fen(), 
                moves: [...(prev.moves || []), { san: move.san, time: 0 }]
            }));
        }
        
        return true;
    }
    
    const playerOrientation = useMemo(() => {
        if (!user || !gameData) return 'white';
        if (gameData.player1?.uid === user.uid) return 'white';
        if (gameData.player2?.uid === user.uid) return 'black';
        return 'white';
    }, [user, gameData]);

    const renderGameStatus = () => {
        if (!gameData) return null;
        if (gameData.status === 'finished') {
            const winnerName = gameData.winner ? gameData.winner.email : "Nobody";
            return <p className="text-2xl text-blue-400 font-bold">Game Over! Winner: {winnerName}</p>;
        }
        if (gameData.status === 'waiting') {
            return <p className="text-yellow-400 animate-pulse">Waiting for an opponent...</p>;
        }
        if (!game) return <p className="text-red-500">Error: Invalid board state.</p>;

        const turnColor = game.turn() === 'w' ? 'White' : 'Black';
        const isMyTurn = 
            (gameData.mode === 'computer' && game.turn() === 'w') ||
            (gameData.mode === 'online' && (
                (user.uid === gameData.player1?.uid && game.turn() === 'w') ||
                (user.uid === gameData.player2?.uid && game.turn() === 'b')
            ));
        
        return <p className={`text-xl ${isMyTurn ? 'text-green-400' : 'text-gray-400'}`}>{turnColor}'s turn {isMyTurn ? '(Your Move)' : ''}</p>;
    };
    
    const leaveGame = () => {
        setGameId(null);
        setView('lobby');
    };

    const renderContent = () => {
        if (!isAuthReady) return <div className="flex justify-center items-center h-64"><p>Authenticating...</p></div>;
        if (!user) return <AuthForm onAuthSuccess={() => {}} />;

        switch (view) {
            case 'review':
                return <GameReviewPage user={user} gameData={reviewGameData} setView={setView} />;
            case 'profile':
                return <ProfilePage user={user} setView={setView} onReviewGame={handleReviewGame} />;
            case 'game':
                 if (!gameId || !gameData) {
                    setView('lobby'); 
                    return <GameSetup user={user} onGameStart={handleStartGame} onStartVsComputer={handleStartVsComputer} />;
                }
                return (
                    <div className="flex flex-col lg:flex-row gap-8">
                        <div className="w-full lg:w-2/3">
                            <Chessboard 
                                key={fen}
                                position={fen} 
                                onPieceDrop={onDrop} 
                                boardOrientation={playerOrientation} 
                                customBoardStyle={{ borderRadius: '8px', boxShadow: '0 5px 15px rgba(0, 0, 0, 0.5)' }} 
                            />
                        </div>
                        <div className="w-full lg:w-1/3 p-6 bg-gray-800 rounded-lg shadow-lg">
                            {gameData.mode === 'online' && <GameClocks gameData={gameData} game={game} />}
                            <h3 className="text-2xl font-bold mb-4 border-b border-gray-600 pb-2">Game Info</h3>
                            <div className="mb-4">{renderGameStatus()}</div>
                            <div className="mb-4 space-y-2">
                               <p><strong>White:</strong> {gameData.player1?.email || '...'}</p>
                               <p><strong>Black:</strong> {gameData.player2?.email || '...'}</p>
                            </div>
                            <h3 className="text-xl font-bold mt-6 mb-2">Move History</h3>
                            <div className="h-48 overflow-y-auto bg-gray-900 p-2 rounded-md font-mono text-sm">
                                {gameData.moves?.map((move, index) => (
                                    <div key={index} className="flex justify-between items-center text-gray-300">
                                       <span>{index % 2 === 0 ? `${Math.floor(index / 2) + 1}. ` : ''} {move.san}</span>
                                       <span className="text-gray-500">{move.time}s</span>
                                    </div>
                                ))}
                            </div>
                            <button onClick={leaveGame} className="w-full mt-6 bg-gray-600 text-white py-2 rounded-md hover:bg-gray-700 transition">
                                Leave Game
                            </button>
                        </div>
                    </div>
                );
            case 'lobby':
            default:
                return <GameSetup user={user} onGameStart={handleStartGame} onStartVsComputer={handleStartVsComputer} />;
        }
    };

    return (
        <div className="min-h-screen bg-gray-900 text-white p-4 sm:p-6 md:p-8 flex flex-col items-center">
            <header className="w-full max-w-6xl flex justify-between items-center mb-8">
                <h1 className="text-4xl font-bold tracking-wider">Smart Chess</h1>
                {user && (
                    <div className="flex items-center space-x-4">
                        <p className="text-gray-300 hidden sm:block">{user.email}</p>
                        <button onClick={() => setView('profile')} className="bg-purple-600 px-4 py-2 rounded-md hover:bg-purple-700 transition">Profile</button>
                        <button onClick={handleLogout} className="bg-red-600 px-4 py-2 rounded-md hover:bg-red-700 transition">Logout</button>
                    </div>
                )}
            </header>
            <main className="w-full max-w-6xl flex-grow">{renderContent()}</main>
        </div>
    );
}
