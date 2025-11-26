# App.jsx Deep Dive

This document provides a line-by-line style breakdown of `src/App.jsx`, the core component of the Smart Chess application.

---

## 1. Imports & Configuration (Lines 1-48)

### Key Imports
-   **React Hooks** (`useState`, `useEffect`, etc.): Essential for managing state and side effects.
-   **Chess.js** (`import { Chess } from 'chess.js'`): The "brain" of the game. It handles move validation, checkmate detection, and FEN string generation.
-   **React Chessboard** (`import { Chessboard } from 'react-chessboard'`): The UI component that renders the board and pieces.
-   **Firebase** (`firebase/app`, `firebase/auth`, `firebase/firestore`): Handles authentication (Login/Signup) and the real-time database.
-   **Tone.js** (`import * as Tone from 'tone'`): A powerful audio library used for generating move sounds and sound themes.

### Firebase Setup
-   **`firebaseConfig`**: Loads API keys from `.env` files (using `import.meta.env`). This keeps secrets out of the code.
-   **`const db = getFirestore(app)`**: Initializes the connection to the Firestore database.

---

## 2. Error Boundary (Lines 49-75)
-   **`class ErrorBoundary`**: A safety net. If any part of the app crashes (throws an error), this component catches it and shows a "Something went wrong" screen instead of a white blank page.
-   **`getDerivedStateFromError`**: Updates state to show the error UI.
-   **`componentDidCatch`**: Logs the error to the console for debugging.

---

## 3. Sound Manager (Lines 77-113)
-   **`soundThemes`**: Defines different audio profiles (Default, Wooden, Arcade).
    -   Each theme uses a different `Tone.Synth` (Synthesizer).
    -   **`notes`**: Defines which musical note plays for each event (Move, Capture, Check).
-   **`playSound(type, settings)`**: The function called whenever a move happens. It checks `settings.soundEnabled` before playing.

---

## 4. Helper Functions (Lines 115-165)
-   **`makeGameId`**: Generates a unique ID for a new game. Uses `crypto.randomUUID()` if available, otherwise falls back to a timestamp.
-   **`shuffle`**: Randomizes an array. Used for tournament pairings.
-   **`incrementTournamentScore`**:
    -   **Critical Logic**: Uses `runTransaction`. This is a "Database Transaction". It ensures that if two people win at the exact same time, the scores update correctly without overwriting each other.

---

## 5. Service Functions (Lines 171-483)
These are "Backend-like" functions that run on the client but interact with Firebase.

### `createGame`
-   Creates a new document in the `games` collection.
-   Sets initial state: `fen` (starting position), `status: 'waiting'`, `player1Time` (clock).

### `startTournament`
-   **Logic**:
    1.  Checks if enough players are in the lobby.
    2.  Shuffles players.
    3.  **Pairing Loop**: Iterates through players 2 by 2.
        -   If a player has no opponent (odd number), they get a "Bye" (automatic win).
        -   Otherwise, calls `createGame` for the pair.
    4.  Creates a `matches` sub-collection to track who is playing whom.

### `checkRoundCompletion`
-   **Purpose**: Called after every game finishes in a tournament.
-   **Logic**:
    -   Checks if *all* matches in the current round are `completed`.
    -   If yes, it calculates the next round (Swiss System logic) or ends the tournament if max rounds are reached.

---

## 6. Sub-Components (Lines 485-1913)

### `AuthForm`
-   Simple Login/Register form. Uses `signInWithEmailAndPassword` and `createUserWithEmailAndPassword`.

### `TournamentLobby`
-   **Real-time Listener**: Uses `onSnapshot` to listen to the tournament document.
-   **Dynamic UI**: Shows "Start Tournament" button only to the Host (`createdByUid`).

### `GameSetup` (The Main Menu)
-   **`startQuickMatch`**:
    -   **Algorithm**:
        1.  Queries for *existing* waiting games with the same time control.
        2.  If found, joins immediately (using a Transaction to prevent double-joining).
        3.  If not found, creates a `matchmaking_request`.
        4.  Listens for other players to join that request.

### `VideoChat` (Lines 1705-1913)
-   **Technology**: WebRTC via direct `RTCPeerConnection` (No external server except for signaling).
-   **Signaling**:
    -   WebRTC needs a way to exchange "Offer" and "Answer" packets (SDP) to connect.
    -   We use the **Firestore Game Document** as the signaling channel.
    -   **`webrtc_signals` field**: Stores the Offer, Answer, and ICE Candidates (network paths).

---

## 7. The Main Component: `App` (Lines 1917-End)

### State Management
-   **`game`**: The `chess.js` instance.
-   **`gameData`**: The full game object from Firestore (includes players, chat, status).
-   **`settings`**: User preferences (Sound, Premoves), saved to `localStorage`.

### `useEffect` Hooks
1.  **Auth Listener**: Checks if user is logged in.
2.  **Game Listener**: `onSnapshot(doc(db, 'games', gameId))`
    -   This is the heartbeat of multiplayer.
    -   When it receives an update, it calls `setGameData`.
    -   This triggers a re-render, updating the board position (`fen`).

### `makeMove` Function (The Core Loop)
1.  **Validation**: Checks if move is legal using `game.move()`.
2.  **Sound**: Plays the appropriate sound.
3.  **Game Over Check**: Checks for Checkmate or Draw.
4.  **Update**:
    -   If **Online**: Writes the new `fen`, `moves`, and `turn` to Firestore.
    -   If **Local/Computer**: Updates local state directly.

### `makeAIMove`
-   Simple AI that picks a random legal move.
-   **Future Improvement**: Connect to Stockfish API for smarter moves.

### Render Return
-   The JSX structure switches based on `view`:
    -   `'lobby'` -> Shows `GameSetup`.
    -   `'game'` -> Shows `Chessboard`, `VideoChat`, `ChatBox`, etc.
    -   `'tournament_lobby'` -> Shows `TournamentLobby`.

---

## Summary
`App.jsx` orchestrates the entire application. It connects the UI (React) to the Logic (Chess.js) and the Data (Firebase). While large, it follows a predictable pattern: **User Action -> Update State/DB -> Listener Triggers -> Re-render**.
