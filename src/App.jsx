import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
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
    serverTimestamp,
    arrayUnion,
    addDoc 
} from 'firebase/firestore';
import * as Tone from 'tone';

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

// --- Sound Effects Manager ---
const soundThemes = {
    default: {
        synth: new Tone.PolySynth(Tone.Synth).toDestination(),
        notes: { move: "C4", capture: "A3", check: "G5", gameOver: ["C5", "G4"] }
    },
    wooden: {
        synth: new Tone.PolySynth(Tone.MembraneSynth, { envelope: { attack: 0.01, decay: 0.4, sustain: 0.01, release: 0.4 } }).toDestination(),
        notes: { move: "E2", capture: "C2", check: "G4", gameOver: ["C4", "G3"] }
    },
    arcade: {
        synth: new Tone.PolySynth(Tone.FMSynth, { harmonicity: 8, modulationIndex: 2, detune: 0, envelope: { attack: 0.01, decay: 0.2, sustain: 0, release: 0.2 } }).toDestination(),
        notes: { move: "C5", capture: "G4", check: "B5", gameOver: ["C6", "G5"] }
    }
};

const playSound = (type, settings) => {
    if (!settings.soundEnabled) return;
    Tone.start();
    const sound = soundThemes[settings.soundTheme];
    if (!sound) return;

    try {
        if (type === 'move') sound.synth.triggerAttackRelease(sound.notes.move, "8n");
        else if (type === 'capture') sound.synth.triggerAttackRelease(sound.notes.capture, "8n");
        else if (type === 'check') sound.synth.triggerAttackRelease(sound.notes.check, "16n");
        else if (type === 'game-over') sound.synth.triggerAttackRelease(sound.notes.gameOver, "4n");
    } catch (error) {
        console.error("Tone.js error:", error);
    }
};


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

const timeControls = [
    { label: '1 min', value: 60 },
    { label: '3 min', value: 180 },
    { label: '5 min', value: 300 },
    { label: '10 min', value: 600 },
];

const GameSetup = ({ user, onGameStart, onStartVsComputer, onStartOfflineGame }) => {
    const [openGames, setOpenGames] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedTime, setSelectedTime] = useState(300);

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
        
        await setDoc(gameRef, {
            mode: 'online',
            timeControl: selectedTime,
            player1: { uid: user.uid, email: user.email },
            player2: null,
            playerIds: [user.uid],
            fen: new Chess().fen(),
            moves: [],
            chatMessages: [],
            capturedPieces: { w: [], b: [] }, 
            status: 'waiting',
            winner: null,
            winReason: null,
            drawOffer: null, 
            rematchOffer: null,
            webrtc_signals: { offer: null, answer: null, iceCandidates: [] },
            createdAt: serverTimestamp(),
            player1Time: selectedTime,
            player2Time: selectedTime,
            lastMoveTimestamp: serverTimestamp(),
        });
        onGameStart(gameId);
    };
    
    const handleJoinGame = async (gameId) => {
        setLoading(true);
        onGameStart(gameId); 
        const gameRef = doc(db, 'games', gameId);
        const gameDoc = await getDoc(gameRef);
        if (gameDoc.exists()) {
             await updateDoc(gameRef, {
                player2: { uid: user.uid, email: user.email },
                playerIds: [gameDoc.data().player1.uid, user.uid],
                status: 'active',
                lastMoveTimestamp: serverTimestamp(), 
            });
        }
    };

    return (
        <div className="w-full max-w-2xl mx-auto p-8 bg-gray-800 rounded-lg shadow-lg">
            <h2 className="text-3xl font-bold text-white text-center mb-6">Game Lobby</h2>
            <div className="flex flex-col sm:flex-row justify-center items-center space-y-4 sm:space-y-0 sm:space-x-4 mb-6">
                <div className="flex bg-gray-700 rounded-md p-1">
                    {timeControls.map(tc => (
                         <button 
                            key={tc.value} 
                            onClick={() => setSelectedTime(tc.value)}
                            className={`px-4 py-2 text-sm font-medium rounded-md transition ${selectedTime === tc.value ? 'bg-indigo-600 text-white' : 'text-gray-300 hover:bg-gray-600'}`}
                        >
                            {tc.label}
                        </button>
                    ))}
                </div>
                 <button onClick={handleCreateGame} className="w-full sm:w-auto bg-green-600 text-white font-bold py-2 px-6 rounded-md hover:bg-green-700 transition duration-300 disabled:bg-gray-500" disabled={loading}>
                    Create Game
                </button>
            </div>
             <div className="flex justify-center items-center space-x-4 mb-6">
                 <button onClick={onStartVsComputer} className="w-full sm:w-auto bg-blue-600 text-white font-bold py-2 px-6 rounded-md hover:bg-blue-700 transition duration-300">
                    Play vs Computer
                </button>
                 <button onClick={onStartOfflineGame} className="w-full sm:w-auto bg-teal-600 text-white font-bold py-2 px-6 rounded-md hover:bg-teal-700 transition duration-300">
                    Pass & Play
                </button>
             </div>
            <h3 className="text-2xl text-white mb-4">Open Online Games</h3>
            <div className="h-64 overflow-y-auto bg-gray-900 p-4 rounded-md">
                {loading && <p className="text-gray-400">Loading...</p>}
                {!loading && openGames.length === 0 && <p className="text-gray-400">No open games. Create one!</p>}
                {openGames.map(g => (
                    <div key={g.id} className="flex justify-between items-center p-3 mb-2 bg-gray-700 rounded-md">
                        <p className="font-bold text-white">{g.player1.email}</p>
                        <span className="text-sm font-mono bg-gray-600 px-2 py-1 rounded-md">{g.timeControl / 60} | 0</span>
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
            const sortedGames = games.sort((a, b) => (b.createdAt?.toDate() || 0) - (a.createdAt?.toDate() || 0));
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
                            <div className="text-right text-gray-400 text-sm"><p>{new Date(game.createdAt?.toDate() || Date.now()).toLocaleDateString()}</p></div>
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

const GameClocks = ({ gameData, game, onTimeout }) => {
    const [whiteTime, setWhiteTime] = useState(gameData.player1Time);
    const [blackTime, setBlackTime] = useState(gameData.player2Time);

    useEffect(() => {
        setWhiteTime(gameData.player1Time);
        setBlackTime(gameData.player2Time);

        const interval = setInterval(() => {
            if (gameData.status !== 'active' || !game || game.isGameOver()) {
                clearInterval(interval);
                return;
            }

            const now = Date.now() / 1000;
            const lastMoveTime = gameData.lastMoveTimestamp?.seconds || now;
            const timeElapsed = now - lastMoveTime;
            
            let newWhiteTime = whiteTime;
            let newBlackTime = blackTime;

            if (game.turn() === 'w') {
                newWhiteTime = Math.max(0, gameData.player1Time - timeElapsed);
                setWhiteTime(newWhiteTime);
            } else {
                newBlackTime = Math.max(0, gameData.player2Time - timeElapsed);
                setBlackTime(newBlackTime);
            }

            if (newWhiteTime <= 0) {
                onTimeout('white');
                clearInterval(interval);
            } else if (newBlackTime <= 0) {
                onTimeout('black');
                clearInterval(interval);
            }

        }, 1000);

        return () => clearInterval(interval);

    }, [gameData, game, onTimeout]);

    const formatTime = (seconds) => {
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
        <div className="w-full flex justify-between items-center mb-4">
            <div className="bg-gray-900 p-3 rounded-md text-center">
                <p className="text-lg font-bold">{gameData.player2?.email || 'Black'}</p>
                <p className={`text-2xl font-mono ${game?.turn() === 'b' ? 'text-green-400' : getClockColor(blackTime)}`}>{formatTime(blackTime)}</p>
            </div>
            <div className="bg-gray-900 p-3 rounded-md text-center">
                 <p className="text-lg font-bold">{gameData.player1?.email || 'White'}</p>
                <p className={`text-2xl font-mono ${game?.turn() === 'w' ? 'text-green-400' : getClockColor(whiteTime)}`}>{formatTime(whiteTime)}</p>
            </div>
        </div>
    );
};

const PromotionDialog = ({ onSelectPromotion, color }) => {
    const pieces = ['q', 'r', 'b', 'n'];
    const pieceColor = color === 'white' ? 'w' : 'b';

    const pieceImages = {
        q: `https://images.chesscomfiles.com/chess-themes/pieces/neo/150/${pieceColor}q.png`,
        r: `https://images.chesscomfiles.com/chess-themes/pieces/neo/150/${pieceColor}r.png`,
        b: `https://images.chesscomfiles.com/chess-themes/pieces/neo/150/${pieceColor}b.png`,
        n: `https://images.chesscomfiles.com/chess-themes/pieces/neo/150/${pieceColor}n.png`,
    };

    return (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex justify-center items-center z-50">
            <div className="bg-gray-800 p-8 rounded-lg shadow-2xl">
                <h3 className="text-2xl text-white font-bold text-center mb-6">Promote Pawn to:</h3>
                <div className="flex justify-center space-x-4">
                    {pieces.map(piece => (
                        <button key={piece} onClick={() => onSelectPromotion(piece)} className="bg-gray-700 p-2 rounded-md hover:bg-gray-600 transition">
                            <img src={pieceImages[piece]} alt={piece} className="w-16 h-16"/>
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

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }

    useEffect(() => {
        scrollToBottom();
    }, [messages.length]);

    const handleSendMessage = async (e) => {
        e.preventDefault();
        if (newMessage.trim() === '' || !gameId) return;

        const gameRef = doc(db, 'games', gameId);
        await updateDoc(gameRef, {
            chatMessages: arrayUnion({
                text: newMessage,
                senderEmail: user.email,
                createdAt: new Date(),
            })
        });
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
                <input 
                    type="text" 
                    value={newMessage} 
                    onChange={(e) => setNewMessage(e.target.value)} 
                    placeholder="Type a message..."
                    className="flex-grow bg-gray-700 text-white px-3 py-2 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button type="submit" className="bg-indigo-600 text-white font-bold py-2 px-4 rounded-md hover:bg-indigo-700">Send</button>
            </form>
        </div>
    );
};

const GameOverDialog = ({ gameData, user, onViewProfile, onRematch, onLeave }) => {
    if (!gameData || gameData.status !== 'finished') return null;

    const winner = gameData.winner;
    const reason = gameData.winReason || 'Checkmate';
    const isWinner = winner && winner.uid === user.uid;
    const myPlayerKey = user.uid === gameData.player1.uid ? 'player1' : 'player2';
    const opponentPlayerKey = myPlayerKey === 'player1' ? 'player2' : 'player1';

    let message;
    if (winner) {
        message = isWinner ? 'You Won!' : `${winner.email.split('@')[0]} Won!`;
    } else {
        message = "It's a Draw!";
    }

    const handleRematchOffer = () => {
        onRematch(myPlayerKey);
    };

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
        <div className="fixed inset-0 bg-black bg-opacity-80 flex justify-center items-center z-50">
            <div className="bg-gray-800 p-10 rounded-lg shadow-2xl text-center">
                <h2 className="text-4xl font-bold mb-4">{message}</h2>
                <p className="text-lg text-gray-400 mb-8">by {reason}</p>
                <div className="flex justify-center space-x-4">
                    <button onClick={onViewProfile} className="bg-purple-600 px-6 py-2 rounded-md hover:bg-purple-700">Profile</button>
                    {gameData.mode === 'online' && (gameData.rematchOffer === myPlayerKey ? (
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

    const gameRef = doc(db, 'games', gameId);
    const myPlayerKey = user.uid === gameData.player1.uid ? 'player1' : 'player2';

    const handleResign = async () => {
        const opponent = myPlayerKey === 'player1' ? gameData.player2 : gameData.player1;
        await updateDoc(gameRef, {
            status: 'finished',
            winner: opponent,
            winReason: 'Resignation'
        });
    };

    const handleOfferDraw = async () => {
        await updateDoc(gameRef, { drawOffer: myPlayerKey });
    };

    const handleAcceptDraw = async () => {
        await updateDoc(gameRef, {
            status: 'finished',
            winner: null,
            winReason: 'Draw by Agreement',
            drawOffer: null
        });
    };

    const handleDeclineDraw = async () => {
        await updateDoc(gameRef, { drawOffer: null });
    };

    const opponentPlayerKey = myPlayerKey === 'player1' ? 'player2' : 'player1';
    if (gameData.drawOffer === opponentPlayerKey) {
        return (
            <div className="mt-4 flex space-x-2">
                <button onClick={handleAcceptDraw} className="w-full bg-green-600 text-white py-2 rounded-md hover:bg-green-700">Accept Draw</button>
                <button onClick={handleDeclineDraw} className="w-full bg-red-600 text-white py-2 rounded-md hover:bg-red-700">Decline</button>
            </div>
        );
    }

    if (gameData.drawOffer === myPlayerKey) {
         return <p className="mt-4 text-center text-yellow-400">Draw offer sent...</p>;
    }

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
                <img key={i} src={getPieceImage(p)} alt={p} className="h-6 w-6"/>
            ))}
        </div>
    );
};

const SettingsDialog = ({ settings, setSettings, onClose }) => {
    const handleSoundToggle = (e) => {
        setSettings(s => ({ ...s, soundEnabled: e.target.checked }));
    };

    const handleThemeChange = (e) => {
        setSettings(s => ({ ...s, soundTheme: e.target.value }));
    };

    const handlePremoveToggle = (e) => {
        setSettings(s => ({ ...s, premovesEnabled: e.target.checked }));
    };

    const handleHighlightToggle = (e) => {
        setSettings(s => ({ ...s, highlightMoves: e.target.checked }));
    };

    return (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex justify-center items-center z-50">
            <div className="bg-gray-800 p-8 rounded-lg shadow-2xl w-full max-w-md">
                <div className="flex justify-between items-center mb-6">
                    <h2 className="text-2xl text-white font-bold">Settings</h2>
                    <button onClick={onClose} className="text-gray-400 hover:text-white">&times;</button>
                </div>
                <div className="space-y-6">
                    {/* Sound Settings */}
                    <div className="flex items-center justify-between">
                        <label htmlFor="sound-toggle" className="text-lg text-gray-300">Enable Sounds</label>
                        <input type="checkbox" id="sound-toggle" checked={settings.soundEnabled} onChange={handleSoundToggle} className="w-5 h-5"/>
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
                     {/* Premove Settings */}
                    <div className="flex items-center justify-between">
                        <label htmlFor="premove-toggle" className="text-lg text-gray-300">Enable Premoves</label>
                        <input type="checkbox" id="premove-toggle" checked={settings.premovesEnabled} onChange={handlePremoveToggle} className="w-5 h-5"/>
                    </div>
                    {/* ** NEW ** Highlight Moves Setting */}
                    <div className="flex items-center justify-between">
                        <label htmlFor="highlight-toggle" className="text-lg text-gray-300">Highlight Legal Moves</label>
                        <input type="checkbox" id="highlight-toggle" checked={settings.highlightMoves} onChange={handleHighlightToggle} className="w-5 h-5"/>
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
  
    useEffect(() => {
      if (!gameId || !gameData?.player1 || !gameData?.player2) return;
  
      let mounted = true;
      const gameRef = doc(db, 'games', gameId);
  
      const servers = {
        iceServers: [
          { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }
        ],
        iceCandidatePoolSize: 10,
      };
  
      const init = async () => {
        if (!mounted || pcRef.current) return;
  
        pcRef.current = new RTCPeerConnection(servers);
  
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
          localStreamRef.current = stream;
          if (localVideoRef.current) localVideoRef.current.srcObject = stream;
          stream.getTracks().forEach(track => pcRef.current.addTrack(track, stream));
        } catch (err) {
          console.error('getUserMedia error', err);
          return;
        }
  
        pcRef.current.ontrack = (ev) => {
          if (remoteVideoRef.current && ev.streams && ev.streams[0]) {
            remoteVideoRef.current.srcObject = ev.streams[0];
          }
        };
  
        pcRef.current.onicecandidate = (event) => {
          if (event.candidate) {
            updateDoc(gameRef, {
              'webrtc_signals.iceCandidates': arrayUnion({ ...event.candidate.toJSON(), uid: user.uid })
            }).catch(e => console.warn('ice write failed', e));
          }
        };
  
        signalingUnsubRef.current = onSnapshot(gameRef, async (snap) => {
          const data = snap.data();
          if (!data || !data.webrtc_signals) return;
  
          const signals = data.webrtc_signals;
  
          if (user.uid === gameData.player2.uid && signals.offer && !signals.answer) {
            try {
              if (!pcRef.current.remoteDescription) {
                await pcRef.current.setRemoteDescription(new RTCSessionDescription(signals.offer));
                const answer = await pcRef.current.createAnswer();
                await pcRef.current.setLocalDescription(answer);
                await updateDoc(gameRef, { 'webrtc_signals.answer': { sdp: answer.sdp, type: answer.type } });
              }
            } catch (err) {
              console.error('answer flow error', err);
            }
          }
  
          if (user.uid === gameData.player1.uid && signals.answer && !pcRef.current.remoteDescription) {
            try {
              await pcRef.current.setRemoteDescription(new RTCSessionDescription(signals.answer));
            } catch (err) {
              console.error('setRemoteDescription for answer failed', err);
            }
          }
  
          try {
            (signals.iceCandidates || []).forEach(cand => {
              const key = cand.candidate || JSON.stringify(cand);
              if (cand.uid === user.uid) return;
              if (processedCandidatesRef.current.has(key)) return;
              processedCandidatesRef.current.add(key);
              pcRef.current.addIceCandidate(new RTCIceCandidate(cand)).catch(e => {
                console.warn('addIceCandidate failed', e);
              });
            });
          } catch (err) {
            console.warn('processing ICE candidates failed', err);
          }
        });
  
        if (user.uid === gameData.player1.uid) {
          const snap = await getDoc(gameRef);
          const existing = snap.exists() ? snap.data().webrtc_signals : null;
          if (!existing || !existing.offer) {
            const offer = await pcRef.current.createOffer();
            await pcRef.current.setLocalDescription(offer);
            await updateDoc(gameRef, { 'webrtc_signals.offer': { sdp: offer.sdp, type: offer.type } });
          } else {
            if (existing.offer && !pcRef.current.remoteDescription) {
              await pcRef.current.setRemoteDescription(new RTCSessionDescription(existing.offer));
            }
          }
        }
      };
  
      init();
  
      return () => {
        mounted = false;
        if (signalingUnsubRef.current) {
          try { signalingUnsubRef.current(); } catch(_) {}
          signalingUnsubRef.current = null;
        }
        if (pcRef.current) {
          try { pcRef.current.close(); } catch(_) {}
          pcRef.current = null;
        }
        if (localStreamRef.current) {
          try {
            localStreamRef.current.getTracks().forEach(t => t.stop());
          } catch(_) {}
          localStreamRef.current = null;
        }
        processedCandidatesRef.current.clear();
      };
    }, [
      gameId,
      user?.uid,
      gameData?.player1?.uid,
      gameData?.player2?.uid
    ]);

    const toggleAudio = () => {
        const newMutedState = !isAudioMuted;
        if (localStreamRef.current) {
            localStreamRef.current.getAudioTracks().forEach(track => {
                track.enabled = !newMutedState;
            });
        }
        setIsAudioMuted(newMutedState);
    };

    const toggleVideo = () => {
        const newMutedState = !isVideoMuted;
        if (localStreamRef.current) {
            localStreamRef.current.getVideoTracks().forEach(track => {
                track.enabled = !newMutedState;
            });
        }
        setIsVideoMuted(newMutedState);
    };
  
    return (
      <div className="mt-6">
        <h3 className="text-xl font-bold mb-2">Video Chat</h3>
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-gray-900 rounded-md aspect-video">
            <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full rounded-md"></video>
          </div>
          <div className="bg-gray-900 rounded-md aspect-video">
            <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full rounded-md"></video>
          </div>
        </div>
        <div className="flex justify-center space-x-4 mt-2">
          <button onClick={toggleAudio} className={`p-2 rounded-full ${isAudioMuted ? 'bg-red-600' : 'bg-gray-700'}`}>Mic</button>
          <button onClick={toggleVideo} className={`p-2 rounded-full ${isVideoMuted ? 'bg-red-600' : 'bg-gray-700'}`}>Cam</button>
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
    const [promotionMove, setPromotionMove] = useState(null);
    const [showSettings, setShowSettings] = useState(false);
    const [settings, setSettings] = useState(() => {
        const savedSettings = localStorage.getItem('chess-settings');
        return savedSettings ? JSON.parse(savedSettings) : {
            soundEnabled: true,
            soundTheme: 'default',
            premovesEnabled: false,
            highlightMoves: true, // ** NEW **
        };
    });
    const [premove, setPremove] = useState(null);
    // ** NEW ** State for move highlights
    const [optionSquares, setOptionSquares] = useState({});
    const [moveFrom, setMoveFrom] = useState(null);
    const [moveHighlight, setMoveHighlight] = useState(null);


    useEffect(() => {
        localStorage.setItem('chess-settings', JSON.stringify(settings));
    }, [settings]);
    
    const fen = gameData ? gameData.fen : 'start';
    
    const game = useMemo(() => {
        try {
            if (fen === 'start') return new Chess();
            return new Chess(fen);
        } catch (e) {
            return null;
        }
    }, [fen]);
    
    // Use the explicit lastMove field from gameData when available (Option B).
    // This is O(1) and scales far better than replaying SAN history on every render.
    useEffect(() => {
        if (gameData?.lastMove?.from && gameData?.lastMove?.to) {
            setMoveHighlight({ from: gameData.lastMove.from, to: gameData.lastMove.to });
        } else {
            setMoveHighlight(null);
        }
    }, [gameData?.lastMove]);

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
        if (!gameId || gameId.startsWith('local_')) {
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
        // result contains .from and .to because bestMove is verbose
        const result = gameCopy.move(bestMove.san);

        const currentCaptured = gameData.capturedPieces || { w: [], b: [] };
        const newCaptured = {
            w: [...(currentCaptured.w || [])],
            b: [...(currentCaptured.b || [])],
        };
        if (result && result.captured) {
            // AI is black so captured piece is recorded opposite
            newCaptured.b.push(result.captured);
        }

        setGameData(prev => ({ 
            ...prev, 
            fen: gameCopy.fen(),
            moves: [...(prev.moves || []), { san: bestMove.san, from: result?.from, to: result?.to, time: 0, moveNumber: (prev.moves || []).length + 1 }],
            capturedPieces: newCaptured,
            lastMove: result ? { from: result.from, to: result.to, san: result.san, moveNumber: (prev.moves || []).length + 1 } : prev.lastMove
        }));
    }, [game, fen, gameData]);

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
            chatMessages: [],
            capturedPieces: { w: [], b: [] },
            player1: { uid: user.uid, email: user.email },
            player2: { uid: 'AI', email: 'Computer' },
            status: 'active',
            lastMove: null,
        });
        setGameId('local_computer_game');
        setView('game');
    }

    const handleStartOfflineGame = () => {
        setGameData({
            mode: 'offline',
            fen: new Chess().fen(),
            moves: [],
            capturedPieces: { w: [], b: [] },
            player1: { email: 'White' },
            player2: { email: 'Black' },
            status: 'active',
            lastMove: null,
        });
        setGameId('local_offline_game');
        setView('game');
    }

    const handleReviewGame = (gameToReview) => {
        setReviewGameData(gameToReview);
        setView('review');
    };

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
            if (gameCopy.isCheckmate()) {
                winner = result.color === 'w' ? gameData.player1 : gameData.player2;
                winReason = 'Checkmate';
            } else {
                winReason = 'Draw';
            }
        }
        
        const currentCaptured = gameData.capturedPieces || { w: [], b: [] };
        const newCaptured = {
            w: [...currentCaptured.w],
            b: [...currentCaptured.b],
        };
        
        if (result.captured) {
             if (result.color === 'w') { 
                newCaptured.w.push(result.captured);
            } else { 
                newCaptured.b.push(result.captured);
            }
        }

        if (gameData.mode === 'online') {
            const timeSinceLastMove = (Date.now() / 1000) - (gameData.lastMoveTimestamp?.seconds || Date.now() / 1000);
            const timeTaken = Math.round(timeSinceLastMove);
            const timeUpdate = {};
            
            if (result.color === 'w') {
                timeUpdate.player1Time = gameData.player1Time - timeSinceLastMove;
            } else {
                timeUpdate.player2Time = gameData.player2Time - timeSinceLastMove;
            }

            const gameRef = doc(db, 'games', gameId);
            
            // Build move object including from/to and moveNumber
            const newMoveObj = { san: result.san, from: result.from, to: result.to, time: timeTaken, moveNumber: (gameData.moves || []).length + 1 };
            const lastMoveObj = { from: result.from, to: result.to, san: result.san, moveNumber: newMoveObj.moveNumber };

            const gameUpdate = {
                fen: gameCopy.fen(),
                moves: [...(gameData.moves || []), newMoveObj],
                capturedPieces: newCaptured,
                status: newStatus,
                winner: winner,
                winReason: winReason,
                lastMoveTimestamp: serverTimestamp(),
                lastMove: lastMoveObj,
                drawOffer: null, 
                ...timeUpdate
            };

            await updateDoc(gameRef, gameUpdate);

            const eventRef = collection(doc(db, "games", gameId), "game_events");
            await addDoc(eventRef, {
                moveNumber: (gameData.moves || []).length + 1,
                playerColor: result.color,
                move: result.san,
                timestamp: serverTimestamp()
            });

        } else { // Computer or Offline mode
            const moveNumber = (gameData.moves || []).length + 1;
            setGameData(prev => ({ 
                ...prev, 
                fen: gameCopy.fen(), 
                moves: [...(prev.moves || []), { san: result.san, from: result.from, to: result.to, time: 0, moveNumber }],
                capturedPieces: newCaptured,
                status: newStatus,
                winner: winner,
                winReason: winReason,
                lastMove: { from: result.from, to: result.to, san: result.san, moveNumber }
            }));
        }
        return result;
    }, [fen, gameData, gameId, settings]);
    
    const handleTimeout = useCallback(async (timedOutPlayer) => {
        if (!gameData || gameData.status === 'finished') return;
        
        if (settings.soundEnabled) playSound('game-over', settings);
        const winner = timedOutPlayer === 'white' ? gameData.player2 : gameData.player1;

        if (gameData.mode === 'online') {
            const gameRef = doc(db, 'games', gameId);
            await updateDoc(gameRef, {
                status: 'finished',
                winner: winner,
                winReason: 'Timeout'
            });
        } else {
             setGameData(prev => ({ 
                ...prev, 
                status: 'finished',
                winner: winner,
                winReason: 'Timeout'
            }));
        }
    }, [gameData, gameId, settings]);

    useEffect(() => {
        const isMyTurn = 
            (gameData?.mode === 'computer' && game?.turn() === 'w') ||
            (gameData?.mode === 'online' && (
                (user?.uid === gameData?.player1?.uid && game?.turn() === 'w') ||
                (user?.uid === gameData?.player2?.uid && game?.turn() === 'b')
            ));
        
        if (premove && isMyTurn) {
            try {
                const gameCopy = new Chess(fen);
                const move = gameCopy.move({ from: premove.from, to: premove.to, promotion: premove.promotion });
                if (move) {
                    makeMove(premove);
                }
            } catch (e) {
                // Premove was illegal, do nothing
            } finally {
                setPremove(null);
            }
        }
    }, [fen, premove, game, gameData, user, makeMove]);


    function onDrop(sourceSquare, targetSquare) {
        setMoveFrom(null); // Clear click-to-move state
        setOptionSquares({});

        if (!game || !gameData) return false;
        if (gameData.status !== 'active' || promotionMove) return false;

        const isMyTurn = 
            (gameData.mode === 'computer' && game.turn() === 'w') ||
            (gameData.mode === 'offline') ||
            (gameData.mode === 'online' && (
                (user?.uid === gameData.player1?.uid && game.turn() === 'w') ||
                (user?.uid === gameData.player2?.uid && game.turn() === 'b')
            ));
        
        if (!isMyTurn) {
            if (settings.premovesEnabled && gameData.mode === 'online') {
                setPremove({ from: sourceSquare, to: targetSquare });
            }
            return false;
        }

        const gameCopy = new Chess(fen);
        const moves = gameCopy.moves({ square: sourceSquare, verbose: true });
        const move = moves.find(m => m.to === targetSquare);
        
        if (!move) return false;
        
        if (move.flags.includes('p')) {
            setPromotionMove({ from: sourceSquare, to: targetSquare });
            return false;
        }
        
        const moveResult = makeMove({ from: sourceSquare, to: targetSquare });
        return moveResult !== null;
    }
    
    const handleSelectPromotion = (piece) => {
        if (!promotionMove) return;
        makeMove({ 
            from: promotionMove.from, 
            to: promotionMove.to, 
            promotion: piece 
        });
        setPromotionMove(null);
    };
    
    const handleSquareRightClick = () => {
        setPremove(null); 
    };

    function onSquareClick(square) {
        if (moveFrom && optionSquares[square]) {
            onDrop(moveFrom, square);
            return;
        }

        if (!settings.highlightMoves) {
            setOptionSquares({});
            setMoveFrom(null);
            return;
        };

        const isMyTurn = 
            (gameData.mode === 'computer' && game.turn() === 'w') ||
            (gameData.mode === 'offline') ||
            (gameData.mode === 'online' && (
                (user.uid === gameData.player1?.uid && game.turn() === 'w') ||
                (user.uid === gameData.player2?.uid && game.turn() === 'b')
            ));

        if (!isMyTurn) return;

        const piece = game.get(square);
        if (piece && piece.color === game.turn()){
            const moves = game.moves({ square, verbose: true });
            if (moves.length === 0) {
                setOptionSquares({});
                setMoveFrom(null);
                return;
            }
            
            setMoveFrom(square);
            const newSquares = {};
            moves.forEach(move => {
                // Prefer move.captured (boolean/char) when available — it's the most reliable indicator.
                const isCapture = Boolean(move.captured) || (move.flags && move.flags.includes('c'));
                newSquares[move.to] = {
                    background: isCapture
                        ? "radial-gradient(circle, rgba(255,0,0,.55) 85%, transparent 85%)"
                        : "radial-gradient(circle, rgba(0,0,0,.12) 25%, transparent 25%)",
                    borderRadius: "50%",
                    transition: "background-color 120ms ease, box-shadow 120ms ease"
                };
            });
            newSquares[square] = { background: "rgba(255, 255, 0, 0.4)", transition: "background-color 120ms ease, box-shadow 120ms ease" };
            setOptionSquares(newSquares);

        } else {
             setMoveFrom(null);
             setOptionSquares({});
        }
    }
    
    const playerOrientation = useMemo(() => {
        if (!user || !gameData) return 'white';
        if (gameData.mode === 'offline') return 'white';
        if (gameData.player1?.uid === user.uid) return 'white';
        if (gameData.player2?.uid === user.uid) return 'black';
        return 'white';
    }, [user, gameData]);

    const renderGameStatus = () => {
        if (!gameData || gameData.status === 'finished') return null;
        if (gameData.status === 'waiting') {
            return <p className="text-yellow-400 animate-pulse">Waiting for an opponent...</p>;
        }
        if (!game) return <p className="text-red-500">Error: Invalid board state.</p>;

        const turnColor = game.turn() === 'w' ? 'White' : 'Black';
        const isMyTurn = 
            (gameData.mode === 'computer' && game.turn() === 'w') ||
            (gameData.mode === 'offline') ||
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

    const handleRematch = useCallback(async (action) => {
        if (!gameData || gameData.mode !== 'online') return;

        const gameRef = doc(db, 'games', gameId);
        const myPlayerKey = user.uid === gameData.player1.uid ? 'player1' : 'player2';

        if (action === 'accept') {
            // Create a new game
            const newGameId = user.uid + "_" + Date.now();
            const newGameRef = doc(db, 'games', newGameId);
            
            await setDoc(newGameRef, {
                ...gameData, // Copy settings from old game
                fen: new Chess().fen(),
                moves: [],
                chatMessages: [],
                capturedPieces: { w: [], b: [] }, 
                status: 'active',
                winner: null,
                winReason: null,
                drawOffer: null, 
                rematchOffer: null,
                createdAt: serverTimestamp(),
                lastMoveTimestamp: serverTimestamp(),
                // Swap players
                player1: gameData.player2,
                player2: gameData.player1,
                playerIds: [gameData.player2.uid, gameData.player1.uid],
                player1Time: gameData.timeControl,
                player2Time: gameData.timeControl,
            });

            // Point old game to new game to trigger navigation for both players
            await updateDoc(gameRef, { rematchedGameId: newGameId });

        } else { // Offer rematch
            await updateDoc(gameRef, { rematchOffer: myPlayerKey });
        }
    }, [gameData, gameId, user]);

    // ** NEW ** Effect to handle navigation to the new game
    useEffect(() => {
        if (gameData?.rematchedGameId) {
            handleStartGame(gameData.rematchedGameId);
        }
    }, [gameData?.rematchedGameId]);


    const renderContent = () => {
        if (!isAuthReady) return <div className="flex justify-center items-center h-64"><p>Authenticating...</p></div>;
        if (!user) return <AuthForm onAuthSuccess={() => {}} />;

        switch (view) {
            case 'review':
                return <GameReviewPage user={user} gameData={reviewGameData} setView={setView} />;
            case 'profile':
                return <ProfilePage user={user} setView={setView} onReviewGame={handleReviewGame} />;
            case 'game':
                 if (gameId && !gameData) {
                    return <div className="flex justify-center items-center h-64"><p className="text-2xl animate-pulse">Loading game...</p></div>;
                }
                 if (!gameId || !gameData) {
                    setView('lobby'); 
                    return <GameSetup user={user} onGameStart={handleStartGame} onStartVsComputer={handleStartVsComputer} onStartOfflineGame={handleStartOfflineGame} />;
                }
                
                const premoveSquareStyles = premove ? {
                    [premove.from]: { backgroundColor: 'rgba(255, 255, 0, 0.4)' },
                    [premove.to]: { backgroundColor: 'rgba(255, 255, 0, 0.4)' },
                } : {};
                
                const lastMoveStyles = moveHighlight ? {
                    [moveHighlight.from]: { backgroundColor: 'rgba(255, 255, 0, 0.4)', transition: 'background-color 120ms ease, box-shadow 120ms ease' },
                    [moveHighlight.to]: { backgroundColor: 'rgba(255, 255, 0, 0.4)', transition: 'background-color 120ms ease, box-shadow 120ms ease' },
                } : {};

                return (
                     <div className="relative">
                        <GameOverDialog 
                            gameData={gameData} 
                            user={user} 
                            onViewProfile={() => setView('profile')}
                            onLeave={leaveGame}
                            onRematch={handleRematch}
                        />
                        <div className="relative flex flex-col lg:flex-row gap-8">
                            {promotionMove && <PromotionDialog color={playerOrientation} onSelectPromotion={handleSelectPromotion} />}
                            <div className="w-full lg:w-2/3">
                                <CapturedPiecesPanel 
                                    pieces={playerOrientation === 'white' ? gameData.capturedPieces.b : gameData.capturedPieces.w}
                                    color={playerOrientation === 'white' ? 'w' : 'b'}
                                />
                                <Chessboard 
                                    position={fen} 
                                    onPieceDrop={onDrop} 
                                    boardOrientation={playerOrientation} 
                                    onSquareClick={onSquareClick}
                                    onSquareRightClick={handleSquareRightClick}
                                    customSquareStyles={{...optionSquares, ...premoveSquareStyles, ...lastMoveStyles}}
                                    customBoardStyle={{ borderRadius: '8px', boxShadow: '0 5px 15px rgba(0, 0, 0, 0.5)' }} 
                                />
                                <CapturedPiecesPanel 
                                    pieces={playerOrientation === 'white' ? gameData.capturedPieces.w : gameData.capturedPieces.b}
                                    color={playerOrientation === 'white' ? 'b' : 'w'}
                                />
                            </div>
                            <div className="w-full lg:w-1/3 p-6 bg-gray-800 rounded-lg shadow-lg">
                                {gameData.mode !== 'offline' && <GameClocks gameData={gameData} game={game} onTimeout={handleTimeout} />}
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
                                           {gameData.mode === 'online' && <span className="text-gray-500">{move.time}s</span>}
                                        </div>
                                    ))}
                                </div>
                                {gameData.mode === 'online' && <VideoChat gameData={gameData} gameId={gameId} user={user} />}
                                {gameData.mode === 'online' && <ChatBox user={user} gameId={gameId} messages={gameData.chatMessages || []} />}
                                {gameData.mode === 'online' && <GameActions user={user} gameData={gameData} gameId={gameId}/>}
                                <button onClick={leaveGame} className="w-full mt-6 bg-gray-600 text-white py-2 rounded-md hover:bg-gray-700 transition">
                                    Leave Game
                                </button>
                            </div>
                        </div>
                    </div>
                );
            case 'lobby':
            default:
                return <GameSetup user={user} onGameStart={handleStartGame} onStartVsComputer={handleStartVsComputer} onStartOfflineGame={handleStartOfflineGame} />;
        }
    };

    return (
        <div className="min-h-screen bg-gray-900 text-white p-4 sm:p-6 md:p-8 flex flex-col items-center">
            <header className="w-full max-w-6xl flex justify-between items-center mb-8">
                <h1 className="text-4xl font-bold tracking-wider">Shatranj</h1>
                {user && (
                    <div className="flex items-center space-x-4">
                        <p className="text-gray-300 hidden sm:block">{user.email}</p>
                        <button onClick={() => setView('profile')} className="bg-purple-600 px-4 py-2 rounded-md hover:bg-purple-700 transition">Profile</button>
                        <button onClick={handleLogout} className="bg-red-600 px-4 py-2 rounded-md hover:bg-red-700 transition">Logout</button>
                        <button onClick={() => setShowSettings(true)} className="p-2 rounded-full hover:bg-gray-700 transition">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            </svg>
                        </button>
                    </div>
                )}
            </header>
            <main className="w-full max-w-6xl flex-grow">
                {showSettings && <SettingsDialog settings={settings} setSettings={setSettings} onClose={() => setShowSettings(false)} />}
                {renderContent()}
            </main>
        </div>
    );
}
