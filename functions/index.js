/* eslint-env node */
const admin = require("firebase-admin");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { Chess } = require("chess.js");

admin.initializeApp();
const db = admin.firestore();

/**
 * Robust matchmaking function for Quick Match.
 * - handles different event.data shapes
 * - validates required fields before querying
 * - logs clearly so you can debug easily from logs
 */
exports.onCreateMatchRequest = onDocumentCreated(
  "matchmaking_requests/{reqId}",
  async (event) => {
    try {
      const reqId = event?.params?.reqId;
      console.log("🔥 onCreateMatchRequest triggered, reqId=", reqId);

      // event.data may be a DocumentSnapshot-like object (with .data())
      // or it might already be a plain object depending on runtime/SDK.
      const raw = event.data;
      console.log("raw event.data type:", typeof raw);

      let req;
      if (!raw) {
        console.log("⚠️ event.data is empty. Exiting.");
        return null;
      } else if (typeof raw.data === "function") {
        // DocumentSnapshot-like
        req = raw.data();
      } else {
        // already plain object
        req = raw;
      }

      console.log("📥 parsed request:", JSON.stringify(req));

      // Validate timeControl presence BEFORE trying to use it in a query
      if (!req || typeof req.timeControl === "undefined" || req.timeControl === null) {
        console.log("⚠️ Missing timeControl on matchmaking request. Aborting. req:", JSON.stringify(req));
        return null;
      }

      // Query for other requests with same timeControl (oldest first)
      const q = db.collection("matchmaking_requests")
        .where("timeControl", "==", req.timeControl)
        .orderBy("createdAt", "asc")
        .limit(2);

      const snapList = await q.get();
      console.log(`📊 Found ${snapList.size} match requests for timeControl=${req.timeControl}`);

      // Filter out the document that triggered this function (if present)
      const otherDocs = snapList.docs.filter(d => d.id !== reqId);

      if (otherDocs.length === 0) {
        console.log("⏳ No partner yet; waiting.");
        return null;
      }

      const partnerDoc = otherDocs[0];
      const partnerData = partnerDoc.data();
      console.log("🤝 Partner found:", partnerDoc.id, partnerData);

      // Transaction: create game and delete both matchmaking documents
      await db.runTransaction(async (tx) => {
        const reqRef = db.collection("matchmaking_requests").doc(reqId);
        const partnerRef = partnerDoc.ref;

        const [reqSnap, partnerSnap] = await Promise.all([tx.get(reqRef), tx.get(partnerRef)]);
        if (!reqSnap.exists || !partnerSnap.exists) {
          console.log("⚠️ One of the requests gone (race). Abort transaction.");
          return;
        }

        // Make new game
        const chess = new Chess();
        const fen = chess.fen();

        const assignWhite = Math.random() < 0.5;
        const whitePlayer = assignWhite ? req : partnerData;
        const blackPlayer = assignWhite ? partnerData : req;

        const gameId = `${whitePlayer.uid}_${blackPlayer.uid}_${Date.now()}`;
        const gameRef = db.collection("games").doc(gameId);

        const newGame = {
          mode: "online",
          timeControl: req.timeControl,
          player1: { uid: whitePlayer.uid, email: whitePlayer.email || "" },
          player2: { uid: blackPlayer.uid, email: blackPlayer.email || "" },
          playerIds: [whitePlayer.uid, blackPlayer.uid],
          fen,
          moves: [],
          chatMessages: [],
          capturedPieces: { w: [], b: [] },
          status: "active",
          winner: null,
          winReason: null,
          drawOffer: null,
          rematchOffer: null,
          webrtc_signals: { offer: null, answer: null, iceCandidates: [] },
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          player1Time: req.timeControl,
          player2Time: req.timeControl,
          lastMoveTimestamp: admin.firestore.FieldValue.serverTimestamp(),
        };

        tx.set(gameRef, newGame);
        tx.delete(reqRef);
        tx.delete(partnerRef);

        console.log("✅ Game created in transaction:", gameId);
      });

      return null;
    } catch (err) {
      console.error("❌ onCreateMatchRequest ERROR:", err);
      throw err;
    }
  }
);
