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
    limit
} from 'firebase/firestore';

// --- Firebase Configuration ---
// This configuration is for the user's project.
const firebaseConfig = {
  apiKey: "AIzaSyCvLWINZANXo5GSZmLCuRcWPMatkpDSgmw",
  authDomain: "chess-25608.firebaseapp.com",
  projectId: "chess-25608",
  storageBucket: "chess-25608.firebasestorage.app",
  messagingSenderId: "720518216386",
  appId: "1:720518216386:web:f6bd16f6bf862a22b5d95b",
  measurementId: "G-JBWZEHVTHH"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// --- Helper Components ---

// AuthForm handles user login and registration.
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

// GameSetup is the lobby for creating or joining games.
const GameSetup = ({ user, onGameStart, onStartVsComputer }) => {
    const [openGames, setOpenGames] = useState([]);
    const [loading, setLoading] = useState(true);

    // Listen for open games in real-time.
    useEffect(() => {
        const q = query(collection(db, 'games'), where('status', '==', 'waiting'), limit(20));
        const unsubscribe = onSnapshot(q, (querySnapshot) => {
            const games = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setOpenGames(games);
            setLoading(false);
        });
        return () => unsubscribe();
    }, []);

    // Creates a new online game document in Firestore.
    const handleCreateGame = async () => {
        setLoading(true);
        const gameId = user.uid + "_" + Date.now();
        const gameRef = doc(db, 'games', gameId);
        await setDoc(gameRef, {
            mode: 'online',
            player1: { uid: user.uid, email: user.email },
            player2: null,
            fen: new Chess().fen(),
            moves: [],
            status: 'waiting',
            winner: null,
            createdAt: new Date(),
        });
        onGameStart(gameId);
    };
    
    // Joins an existing game by updating its document.
    const handleJoinGame = async (gameId) => {
        setLoading(true);
        const gameRef = doc(db, 'games', gameId);
        await updateDoc(gameRef, {
            player2: { uid: user.uid, email: user.email },
            status: 'active'
        });
        onGameStart(gameId);
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

// Main App component
export default function App() {
    const [user, setUser] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [gameId, setGameId] = useState(null);
    const [gameData, setGameData] = useState(null);
    
    // The FEN string is the single source of truth for the board's position.
    const fen = gameData ? gameData.fen : 'start';
    
    // The game object is memoized to avoid re-creating it on every render.
    const game = useMemo(() => {
        try {
            // Correctly handle the "start" keyword for chess.js
            if (fen === 'start') {
                return new Chess();
            }
            return new Chess(fen);
        } catch (e) {
            return null;
        }
    }, [fen]);
    
    // Handles user authentication state changes.
    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
            setUser(currentUser);
            // If the user logs out, reset the game state.
            if (!currentUser) {
                setGameId(null);
                setGameData(null);
            }
            setIsAuthReady(true);
        });
        return () => unsubscribe();
    }, []);

    // Listens for real-time updates to the current game from Firestore.
    useEffect(() => {
        // Don't listen if it's a local computer game.
        if (!gameId || gameId === 'local_computer_game') return;

        const gameRef = doc(db, 'games', gameId);
        const unsubscribe = onSnapshot(gameRef, (docSnap) => {
            if (docSnap.exists()) {
                // When data arrives from Firestore, update the local state.
                // This is the single source of truth for online games.
                setGameData(docSnap.data());
            } else {
                // If the game document is deleted, reset the game state.
                setGameId(null);
                setGameData(null);
            }
        });
        return () => unsubscribe();
    }, [gameId]);

    // Handles the AI's move logic for computer games.
    const makeAIMove = useCallback(() => {
        if (!game || game.turn() !== 'b' || game.isGameOver()) return;

        const possibleMoves = game.moves({ verbose: true });
        if (possibleMoves.length === 0) return;
        const bestMove = possibleMoves[Math.floor(Math.random() * possibleMoves.length)];
        
        const gameCopy = new Chess(fen);
        gameCopy.move(bestMove.san);
        
        // In computer mode, we update the local state directly.
        setGameData(prev => ({ 
            ...prev, 
            fen: gameCopy.fen(),
            moves: [...(prev.moves || []), bestMove.san] 
        }));
    }, [game, fen]);

    // Triggers the AI's move after a short delay.
    useEffect(() => {
        if (gameData?.mode === 'computer' && game?.turn() === 'b' && !game?.isGameOver()) {
            setTimeout(makeAIMove, 500);
        }
    }, [fen, gameData, game, makeAIMove]);

    const handleLogout = () => signOut(auth);
    
    const handleStartGame = (id) => setGameId(id);
    
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
    }

    // This is the core logic for handling a piece being dropped on the board.
    function onDrop(sourceSquare, targetSquare) {
        // --- 1. Initial validation ---
        if (!game || !gameData || !user) return false;
        if (gameData.status !== 'active') return false;

        // --- 2. Check if it's the player's turn ---
        const isMyTurn = 
            (gameData.mode === 'computer' && game.turn() === 'w') ||
            (gameData.mode === 'online' && (
                (user.uid === gameData.player1?.uid && game.turn() === 'w') ||
                (user.uid === gameData.player2?.uid && game.turn() === 'b')
            ));
        
        if (!isMyTurn) return false;

        // --- 3. Try to make the move ---
        const gameCopy = new Chess(fen);
        const move = gameCopy.move({ from: sourceSquare, to: targetSquare, promotion: 'q' });

        if (move === null) return false; 
        
        const newFen = gameCopy.fen();
        // ** THE FIX IS HERE **
        // We now store the simple move notation (e.g., "e4") instead of the complex object.
        const newMoves = [...(gameData.moves || []), move.san]; 
        
        // --- 4. Update state based on game mode ---
        if (gameData.mode === 'online') {
            const gameRef = doc(db, 'games', gameId);
            const isGameOver = gameCopy.isGameOver();
            const newStatus = isGameOver ? 'finished' : 'active';
            const winner = isGameOver ? (gameCopy.turn() === 'w' ? gameData.player2 : gameData.player1) : null;
            
            // This update now sends a simple, serializable object to Firestore, fixing the bug.
            updateDoc(gameRef, {
                fen: newFen,
                moves: newMoves,
                status: newStatus,
                winner: winner,
            });
        } else { // Computer mode
            // For computer games, we can update the local state directly.
            setGameData(prev => ({ ...prev, fen: newFen, moves: newMoves }));
        }
        
        return true;
    }
    
    // Determines the board orientation based on the player.
    const playerOrientation = useMemo(() => {
        if (!user || !gameData) return 'white';
        if (gameData.player1?.uid === user.uid) return 'white';
        if (gameData.player2?.uid === user.uid) return 'black';
        return 'white';
    }, [user, gameData]);

    // Renders the current status of the game (e.g., whose turn it is).
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
        setGameData(null);
    };

    // Main render logic to switch between Auth, Lobby, and Game screens.
    const renderContent = () => {
        if (!isAuthReady) return <div className="flex justify-center items-center h-64"><p>Authenticating...</p></div>;
        if (!user) return <AuthForm onAuthSuccess={() => {}} />;
        if (!gameId || !gameData) return <GameSetup user={user} onGameStart={handleStartGame} onStartVsComputer={handleStartVsComputer} />;

        return (
            <div className="flex flex-col lg:flex-row gap-8">
                <div className="w-full lg:w-2/3">
                    <Chessboard 
                        key={fen} // The key forces a re-render when the position changes.
                        position={fen} 
                        onPieceDrop={onDrop} 
                        boardOrientation={playerOrientation} 
                        customBoardStyle={{ borderRadius: '8px', boxShadow: '0 5px 15px rgba(0, 0, 0, 0.5)' }} 
                    />
                </div>
                <div className="w-full lg:w-1/3 p-6 bg-gray-800 rounded-lg shadow-lg">
                    <h3 className="text-2xl font-bold mb-4 border-b border-gray-600 pb-2">Game Info</h3>
                    <div className="mb-4">{renderGameStatus()}</div>
                    <div className="mb-4 space-y-2">
                       <p><strong>White:</strong> {gameData.player1?.email || '...'}</p>
                       <p><strong>Black:</strong> {gameData.player2?.email || '...'}</p>
                    </div>
                    <h3 className="text-xl font-bold mt-6 mb-2">Move History</h3>
                    <div className="h-64 overflow-y-auto bg-gray-900 p-2 rounded-md font-mono text-sm">
                        {gameData.moves?.map((san, index) => (
                            <div key={index} className="text-gray-300">
                               {index % 2 === 0 ? `${Math.floor(index / 2) + 1}. ` : ''} 
                               {san}
                            </div>
                        ))}
                    </div>
                    <button onClick={leaveGame} className="w-full mt-6 bg-gray-600 text-white py-2 rounded-md hover:bg-gray-700 transition">
                        Leave Game
                    </button>
                </div>
            </div>
        );
    };

    return (
        <div className="min-h-screen bg-gray-900 text-white p-4 sm:p-6 md:p-8 flex flex-col items-center">
            <header className="w-full max-w-6xl flex justify-between items-center mb-8">
                <h1 className="text-4xl font-bold tracking-wider">Smart Chess</h1>
                {user && (
                    <div className="flex items-center space-x-4">
                        <p className="text-gray-300 hidden sm:block">{user.email}</p>
                        <button onClick={handleLogout} className="bg-red-600 px-4 py-2 rounded-md hover:bg-red-700 transition">Logout</button>
                    </div>
                )}
            </header>
            <main className="w-full max-w-6xl flex-grow">{renderContent()}</main>
        </div>
    );
}
