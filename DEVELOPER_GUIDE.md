# Smart Chess Vite - Developer Guide

Welcome to the **Smart Chess Vite** project! This guide is designed to help you understand every aspect of the codebase, from the basic technologies we use to the complex logic behind our chess engine and video chat features.

Whether you are a seasoned developer or a fresher just starting out, this document will walk you through the "What", "Why", and "How" of this project.

---

## 1. Introduction & Tech Stack

### What is this project?
This is a modern, real-time chess application that allows users to:
-   Play chess against a computer or other humans.
-   Host and join tournaments.
-   Video chat with opponents during games.
-   Connect to smart physical chessboards (future scope).

### The Tech Stack (The "Ingredients")
We chose this stack to ensure performance, scalability, and ease of development.

#### **Frontend Framework: React**
-   **What it is:** A JavaScript library for building user interfaces.
-   **Why we chose it:** React allows us to build reusable "components" (like a Chessboard, a Chat Box, a Button). It handles the "state" of our app efficiently.
-   **Key Concept for Freshers:**
    -   **Components:** Think of them as Lego blocks. `App.jsx` is the big castle, built from smaller blocks like `Chessboard` and `VideoChat`.
    -   **State (`useState`):** This is the memory of a component. If `gameStatus` changes from 'playing' to 'game_over', React automatically updates the screen.
    -   **Effects (`useEffect`):** These are side-effects. "When the game starts, play a sound." or "When the app loads, check if the user is logged in."

#### **Build Tool: Vite**
-   **What it is:** A super-fast build tool and development server.
-   **Why we chose it:** It's much faster than the older standard (Create React App). It starts the server instantly and updates changes in milliseconds.

#### **Language: JavaScript (ES6+)**
-   **Why:** The language of the web. We use modern features like `async/await` (for waiting for data) and arrow functions `() => {}`.

#### **Real-time Database: Firebase Firestore**
-   **What it is:** A NoSQL cloud database by Google.
-   **Why we chose it:** It offers **Real-time Listeners**. When Player A makes a move, Player B's screen updates *instantly* without refreshing. This is crucial for a multiplayer game.

#### **Video & Audio: WebRTC (via PeerJS)**
-   **What it is:** A technology that allows browsers to send video/audio directly to each other (Peer-to-Peer).
-   **Why we chose it:** It's free (no expensive servers needed for video) and very low latency.

#### **Desktop App: Electron**
-   **What it is:** A framework to build desktop apps using web technologies.
-   **Why we chose it:** It lets us wrap our React website into a downloadable `.exe` or `.dmg` file for Windows and Mac.

---

## 2. Project Structure

Here is how the project is organized. Think of this as the map of the building.

```text
smart-chess-vite/
├── .firebase/                 # Firebase hosting configuration
├── dist/                      # The "built" code ready for production (created after running build)
├── electron/                  # Code specific to the Desktop App version
│   ├── main.js                # The "Brain" of the desktop app (creates windows)
│   └── preload.js             # The bridge between the desktop system and our website
├── functions/                 # Cloud Functions (backend code that runs on Google's servers)
├── public/                    # Static files (images, sounds, icons) that don't change
├── src/                       # SOURCE CODE - This is where 99% of your work happens
│   ├── assets/                # Images and fonts imported into code
│   ├── components/            # Reusable UI blocks (Buttons, Modals, Screens)
│   │   └── S_Screen.jsx       # The "Splash Screen" (intro video)
│   ├── App.css                # Global styles
│   ├── App.jsx                # THE MAIN FILE. Contains almost all game logic (God Component)
│   ├── ConnectBoardModal.jsx  # Modal for connecting physical boards
│   ├── main.jsx               # The entry point. It takes App.jsx and puts it into the HTML.
│   └── index.css              # Basic CSS reset and Tailwind imports
├── index.html                 # The main HTML file that loads the React app
├── package.json               # List of all libraries (dependencies) we use
└── vite.config.js             # Configuration for the Vite build tool
```

### Key Files Explained

#### `src/main.jsx`
This is the starting line. It finds the `div` with id `root` in `index.html` and tells React: "Render the `<App />` component inside here."

#### `src/App.jsx`
**This is the most important file.** Currently, it acts as a "God Component," meaning it holds most of the application's logic, including:
-   Game State (Who's turn is it?)
-   Tournament Logic (Who plays who?)
-   Audio Logic (Playing move sounds)
-   Firebase Connections (Saving games)

> **Note for Freshers:** In a perfect world, we would split this huge file into smaller pieces (like `GameManager.js`, `TournamentManager.js`). We kept it together for simplicity in the early stages, but refactoring it is a great future task!

#### `electron/main.js`
This file only runs when the app is opened as a desktop application. It creates the application window and handles system events (like closing the app).

---

## 3. Detailed Component Analysis

## 3. Detailed Component Analysis

### The "God Component": `App.jsx`
As mentioned, `App.jsx` is the heart of the application. Let's break down what's happening inside.

#### Key State Variables
State variables are how the app "remembers" things. Here are the most critical ones:

-   `game`: The chess engine instance (from `chess.js`). It knows the rules of chess (valid moves, checkmate, etc.).
-   `fen`: A string representing the current board position (e.g., "rnbqkbnr/pppppppp..."). The `Chessboard` component reads this to know where to draw pieces.
-   `gameStatus`: Tracks the current state: `'setup'`, `'playing'`, `'game_over'`, `'tournament_lobby'`.
-   `myPeerId` & `remotePeerId`: Unique IDs for Video Chat. Think of them as phone numbers for WebRTC.
-   `tournamentId`: If playing in a tournament, this stores the ID.

#### Critical Functions
1.  **`makeAMove(move)`**:
    -   Called when a player drags a piece.
    -   Validates the move using `game.move()`.
    -   Updates the `fen` state to redraw the board.
    -   If online, saves the move to Firestore so the opponent sees it.

2.  **`joinTournament(tournamentId)`**:
    -   Adds the user to the tournament's player list in Firestore.
    -   Switches the view to the `TournamentLobby`.

3.  **`startTournament()`**:
    -   (Admin only) Generates the first round of pairings (Player A vs Player B).
    -   Creates game sessions for each pair.

### `TournamentLobby` Component
This component handles the "waiting room" before games start.
-   **What it does:** Shows the list of players, current standings, and countdowns.
-   **How it works:** It listens to the `tournaments/{id}` document in Firestore. When the admin clicks "Start", the document updates, and all players are automatically redirected to their games.

### `GameSetup` Component
This is the main menu.
-   **Options:** Play vs Computer, Play Online, Create Tournament.
-   **Logic:** It's mostly a UI wrapper that calls functions passed down from `App.jsx` (like `onCreateGame`).

---

## 4. Logic Flow & Algorithms

### How Online Multiplayer Works (The "Magic")
We use **Firebase Firestore** as our synchronization server.

1.  **Game Creation:** User A creates a game. A new document is created in `games/{gameId}`.
2.  **Joining:** User B joins. The document updates to set `player2` to User B.
3.  **The Move Loop:**
    -   User A moves. `App.jsx` updates the `fen` in the Firestore document.
    -   User B has a `onSnapshot` listener (a real-time hook).
    -   User B's app sees the `fen` change and automatically updates the board.
    -   **Why this is cool:** We don't need complex servers. Firebase handles the data syncing!

### WebRTC Video Chat Flow
Video chat is harder because video data is too heavy for a database. We use **PeerJS**.

1.  **Handshake:**
    -   Player A generates a "Peer ID" (random string).
    -   Player A saves this ID to the Firestore game document.
    -   Player B reads this ID from Firestore.
2.  **Connection:**
    -   Player B "calls" Player A using the ID.
    -   Player A "answers" the call.
3.  **Stream:**
    -   Once connected, video/audio streams flow directly between computers (P2P). No server in the middle!

### Tournament Pairing Algorithm (Swiss-ish)
When a tournament starts:
1.  **Shuffle:** We randomize the player list.
2.  **Pairing:** We take the first 2 players, then the next 2, etc.
3.  **Odd Numbers:** If there's an odd number of players, one gets a "Bye" (automatic win).
4.  **Next Rounds:** Currently, we use a simplified logic where we just re-pair available players. A full Swiss system (pairing by score) is a future improvement.

---

## 5. Why We Chose This & Future Scope

### Why React + Vite?
-   **Alternative:** Angular or Vue.
-   **Reason:** React has the biggest ecosystem. `react-chessboard` is a great library that saved us weeks of work. Vite is simply the fastest tool for React right now.

### Why Firebase?
-   **Alternative:** Building a custom Node.js + Socket.io server.
-   **Reason:** Speed of development. With Firebase, we built the multiplayer backend in days, not weeks. It scales automatically.
-   **Downside:** It can get expensive if we have millions of users (reads/writes cost money).

### Future Scope (What you can build!)
1.  **Refactor `App.jsx`:** Split the huge file into custom hooks like `useGameLogic`, `useTournament`.
2.  **Better AI:** Currently, the "Computer" plays random moves or simple logic. Integrating Stockfish (a pro chess engine) via WebAssembly would be amazing.
3.  **Spectator Mode:** Allow users to watch live tournament games without playing.
4.  **Mobile App:** Use **Capacitor** or **React Native** to make this a real mobile app.

---

## 6. Conclusion
This codebase is a living thing. It's built to be simple to understand but powerful enough to run real tournaments. Don't be afraid to break things, experiment, and ask questions.

**Happy Coding! ♟️**

