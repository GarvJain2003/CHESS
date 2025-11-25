# Smart Chess (Shatranj) – Developer Guide

A React/Vite chess app with Firebase Auth + Firestore for real-time play, quick matchmaking, tournaments, chat, WebRTC video, optional hardware-board hooks, and an Electron wrapper for desktop. This guide is written for new teammates so you can onboard quickly and understand how every piece fits together.

---

## Quick Start (local web)
- `npm install`
- Create `.env.local` (see **Environment & Secrets**) and restart the dev server if you change it.
- `npm run dev` then open the shown localhost URL.
- Lint: `npm run lint`
- Production build: `npm run build` (outputs to `dist/`)

### Electron desktop
- Dev (runs Vite + Electron): `npm run electron:dev`
- Build macOS: `npm run electron:build`
- Build Windows (x64): `npm run electron:build:win` → installer in `dist-electron/`
See `BUILD_INSTRUCTIONS.md` for signing caveats.

### Firebase bits
- Firestore/Hosting config: `firebase.json`
- Rules: `firestore.rules`
- Indexes: `firestore.indexes.json`
- Cloud Functions source: `functions/index.js` (Node 18 runtime via Firebase)

---

## Tech Primer (for newcomers)
- **JavaScript + JSX (React)**: Components are functions returning JSX. State via `useState`, side effects via `useEffect`, memoization via `useMemo`/`useCallback`. Example:
  ```jsx
  const [count, setCount] = useState(0);
  useEffect(() => { console.log(count); }, [count]);
  return <button onClick={() => setCount(c => c + 1)}>Increment</button>;
  ```
- **Modules**: This repo uses ES modules (`import ... from '...'`).
- **Styling**: Tailwind is loaded via CDN in `index.html` (no build-time Tailwind config). `src/App.css` holds a few layout tweaks.
- **Firebase**: Auth (email/password), Firestore (real-time game/tournament data), Cloud Functions (matchmaking). Client SDK is used directly in `src/App.jsx`.
- **Chess logic**: `chess.js` for rules/validation; `react-chessboard` for the UI board.
- **Sound**: `tone` for move/check/finish sounds with selectable themes.
- **WebRTC**: Peer-to-peer video between players only. Flow: `RTCPeerConnection` + `getUserMedia` → offer/answer → ICE candidates exchanged through Firestore (`games.webrtc_signals`).
- **Electron**: Thin shell that loads the Vite app; no native APIs are exposed yet (`electron/preload.js` is empty).

---

## Repository Map
- `src/App.jsx` – Main React app (monolithic). Contains:
  - ErrorBoundary wrapper.
  - Sound theme manager (`Tone.js`).
  - Helpers (logging, IDs, shuffling).
  - Firestore service helpers: `createGame`, tournament creation/join/start, Swiss-ish round pairing, match result updates.
  - UI pieces: auth form, lobby/game setup, tournament lobby UI, game review UI, game clocks, promotion dialog, chat box, video chat, game actions, game over dialog, settings.
  - Game controller: move handling (online/offline/AI/hardware), timers, premoves, highlights, rematch, link-based join, URL-deep-link handling for `?gameId` / `?tournamentId`.
- `src/ConnectBoardModal.jsx` – Placeholder modal for entering a hardware board code and player names; calls back to start a hardware-linked local game.
- `src/components/S_Screen.jsx` – Optional intro video/splash component with skip/unmute controls.
- `src/main.jsx` – React entrypoint, renders `App`.
- `src/App.css`, `src/index.css` – Minimal styles (global dark theme + Tailwind directives).
- `electron/main.js` / `electron/preload.js` – Electron shell.
- `functions/index.js` – Cloud Function `onCreateMatchRequest` pairs quick-match requests into a game transactionally.
- `firestore.rules` – Security rules (summarized below).
- `firestore.indexes.json` – Required Firestore composite indexes.
- `provision_device/provison.js` – Admin script to provision a Firebase Auth user/claim for a physical board device (requires a service account JSON next to it).
- `BUILD_INSTRUCTIONS.md` – Platform build notes.
- `vite.config.js` – Vite config (React plugin, relative base for Electron packaging).

---

## Environment & Secrets
Create `.env.local` (Vite picks up `VITE_*` variables):
```
VITE_API_KEY=
VITE_AUTH_DOMAIN=
VITE_PROJECT_ID=
VITE_STORAGE_BUCKET=
VITE_MESSAGING_SENDER_ID=
VITE_APP_ID=
VITE_MEASUREMENT_ID=
```
These are standard Firebase web config values for your project.

---

## Data Model (Firestore)

### Collection: `games/{gameId}`
```json
{
  "mode": "online" | "offline" | "computer" | "hardware_test",
  "timeControl": 300,
  "player1": { "uid": "uidA", "email": "a@example.com" },
  "player2": { "uid": "uidB", "email": "b@example.com" },
  "playerIds": ["uidA","uidB"],
  "fen": "startpos FEN",
  "moves": [{ "san": "e4", "from": "e2", "to": "e4", "time": 2, "moveNumber": 1 }],
  "chatMessages": [{ "text": "gl", "senderEmail": "a@example.com", "createdAt": "<client Date>" }],
  "capturedPieces": { "w": [], "b": [] },
  "status": "waiting" | "active" | "finished",
  "winner": { "uid": "uidA", "email": "a@example.com" } | null,
  "winReason": "Checkmate" | "Timeout" | "Resignation" | "Draw by Agreement" | "Draw",
  "drawOffer": "player1" | "player2" | null,
  "rematchOffer": "player1" | "player2" | null,
  "rematchedGameId": "..." | null,
  "webrtc_signals": {
    "offer": { "sdp": "...", "type": "offer" } | null,
    "answer": { "sdp": "...", "type": "answer" } | null,
    "iceCandidates": [{ "...": "...", "uid": "senderUid" }]
  },
  "createdAt": <serverTimestamp>,
  "lastMoveTimestamp": <serverTimestamp>,
  "player1Time": 300,
  "player2Time": 300,
  "lastMove": { "from": "e2", "to": "e4", "san": "e4", "moveNumber": 1 },
  "tournamentId": "..." | null,
  "tournamentRound": 1 | null,
  "inviteOnly": false,
  "spectators": [],
  "spectatorRequests": {},
  "createdByUid": "hostUid"
}
```
- Subcollection: `game_events/{eventId}` for audit trail of moves (created server-side for online games).

### Collection: `tournaments/{tournamentId}`
```json
{
  "name": "Birthday Bash",
  "maxPlayers": 8,
  "timeControl": 300,
  "createdBy": "hostUid",
  "players": [{ "uid": "p1", "email": "p1@example.com" }],
  "scores": { "p1": 0, "p2": 1.5 },
  "status": "lobby" | "ongoing" | "completed",
  "currentRound": 1,
  "winnerId": "uid?" | null,
  "createdAt": <serverTimestamp>
}
```
- Subcollection: `rounds/round_{n}/matches/{matchId}` with
```json
{
  "playerWhite": "uidA",
  "playerBlack": "uidB" | null,   // null means bye
  "gameId": "games doc id",
  "status": "ongoing" | "completed",
  "winnerId": "uid" | null,
  "isBye": true | false,
  "createdAt": <serverTimestamp>
}
```

### Collection: `matchmaking_requests/{reqId}`
```json
{ "uid": "playerUid", "email": "player@example.com", "timeControl": 300, "createdAt": <serverTimestamp> }
```
Paired by the Cloud Function into a new `games` doc; both requests are deleted transactionally.

### Collections: hardware integration
- `boards/{boardId}`: created when a hardware board connects; stores players and timestamps.
- `hardware_moves/{boardCode}`: hardware publishes moves `{ from, to, promotion?, seq }`; the client subscribes and applies moves.

---

## Frontend Flow (by feature)

### Auth
- `AuthForm` in `src/App.jsx` handles register/login with email/password via Firebase Auth.
- `onAuthStateChanged` wires user session; unauthenticated users see the auth form.

### Lobby / Game setup
- Component: `GameSetup` (`src/App.jsx`).
- Lists open games (`status=waiting`, excluding `inviteOnly`) and open tournaments (`status=lobby`), both real-time via `onSnapshot`.
- Create online game: chooses time control, optional invite-only flag, writes `games` doc via `createGame`.
- Join online game: Firestore transaction to claim `player2` on a waiting game.
- Quick Match: checks for an existing waiting game with matching `timeControl`, tries to claim it transactionally; otherwise writes `matchmaking_requests` entry and listens for a game involving you.
- Other starts: vs computer (local AI move picker), pass-and-play offline, hardware test (after Connect Board modal).
- Tournament creation: opens modal to configure name/players/time; writes `tournaments` doc and navigates to its lobby.

### Tournament lobby
- Component: `TournamentLobby` (`src/App.jsx`).
- Real-time subscribe to the tournament doc; joins add player and score entry; host can start once ≥2 players.
- Starting a tournament: shuffles players, creates `rounds/round_1/matches` entries and `games` for each pairing (or BYE win).
- Round completion: `checkRoundCompletion` verifies all matches completed; advances round with a transaction and creates next-round pairings sorted by current scores. Stops after a capped number of rounds and marks winner based on scores.
- Admin controls: host can force match result or kick player.

### Game play (online)
- Board UI: `react-chessboard` with highlights, premoves (optional), promotion dialog, last-move highlight.
- Move handling: `makeMove` validates with `chess.js`, updates Firestore with new FEN, move list, captured pieces, timestamps, and ends the game on checkmate/draw/timeouts. Tournament results also update `tournaments` via `updateTournamentMatchResult`.
- Timers: `GameClocks` derives remaining time from `player1Time`/`player2Time` + `lastMoveTimestamp`; detects timeouts.
- Actions: offer/accept/decline draw, resign, leave, rematch (non-tournament only).
- Chat: `ChatBox` appends to `games.chatMessages` array.
- Video: `VideoChat` sets up WebRTC 1:1 between players only (host/spectators are blocked). Signaling stored in `games.webrtc_signals`; ICE via STUN `stun1/2.l.google.com`.
- Sounds/UX: `SettingsDialog` toggles sounds, themes, premoves, highlight moves; `Tone.js` drives effects.
- Spectators: allowed to view if they have the link; actions hidden; simple spectator counters via `spectatorRequests` field.
- Shareable links: `?gameId=...` in URL auto-opens the game; `?tournamentId=...` opens the tournament lobby.

### Game play (offline / AI / hardware)
- Offline: local state only, no Firestore writes.
- vs Computer: random-move AI for black (`makeAIMove`).
- Hardware test: `ConnectBoardModal` captures a board code and names; starts a local game and subscribes to `hardware_moves/{boardCode}`; `provision_device/provison.js` helps create device auth users/claims for real hardware.

### Profile & review
- `ProfilePage` lists finished games involving the user (last 50, newest first).
- `GameReviewPage` replays moves on a board with step controls.

### Error handling
- `ErrorBoundary` around the whole app to catch React render errors and allow reload.

---

## Cloud Function: Quick Matchmaker (`functions/index.js`)
- Trigger: `onCreateMatchRequest` on `matchmaking_requests/{reqId}`.
- Validates payload, queries oldest other request with same `timeControl`, and in a transaction:
  - Creates a `games` doc with randomized colors and initial `chess.js` FEN.
  - Deletes both matchmaking requests.
- Logs liberally for debugging. Uses Admin SDK + `chess.js`.

---

## Security Rules (high level) – `firestore.rules`
- Auth required for all reads/writes.
- `games`: creator can create; updates allowed for players, tournament host (`createdByUid`), player2 join on waiting games, or spectator request writes. `game_events` writable by players only.
- `tournaments`: host creates; updates allowed for host or any UID present/added in `scores`. Rounds/matches writable by host or participants; match writes limited to host or players in that match.
- Hardware collections (`boards`, `hardware_moves`) readable/writable by signed-in users (tighten for production if needed).
- `matchmaking_requests`: create/delete restricted to the requestor’s UID.

---

## Electron Shell
- `electron/main.js` spins up a `BrowserWindow` loading Vite dev server in dev (`NODE_ENV=development`) or `dist/index.html` in prod; opens devtools in dev.
- `electron/preload.js` exposes an empty `electronAPI` namespace (extend here for native integrations).

---

## Future Improvements / Alternatives
- Split `src/App.jsx` into feature modules (auth, lobby, tournaments, game, video, hardware) and add tests.
- Migrate to TypeScript for safer Firebase/WebRTC payload handling.
- Replace random-move AI with a stronger engine or service.
- WebRTC: support host/spectator viewing via SFU/mesh or a TURN server for reliability.
- Move Tailwind from CDN to a build pipeline for theming and purgeable CSS.
- Harden hardware auth and narrow Firestore rules for device collections.
- Add optimistic UI + error toasts around Firestore writes and device flows.

---

## Developer Tips
- Logs: `logStep` helper prefixes debug statements with timestamps; watch the browser console + Firebase logs (for functions).
- When editing WebRTC or tournament logic, keep transactions atomic (`runTransaction`) to avoid double-processing rounds or match results.
- If you change the data model, update: `firestore.rules`, `firestore.indexes.json` (if new queries), Cloud Function, and this README.

