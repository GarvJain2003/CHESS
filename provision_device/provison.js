// --- provision.js ---
// Run this ONCE from your computer to create the device user

import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serviceAccount = JSON.parse(fs.readFileSync(path.join(__dirname, 'serviceAccountKey.json'), 'utf8'));

// --- CONFIGURATION ---
const BOARD_ID = "S001"; // The boardCode from your modal
const DEVICE_EMAIL = "device-001@playshatranj.com"; // A unique email
const DEVICE_PASSWORD = "shatranj-device-pass@001"; // A secure password
// ---------------------

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

async function provisionDevice() {
  try {
    console.log(`Attempting to create user for board: ${BOARD_ID}...`);
    
    // 1. Create the user with the boardId as its UID
    const userRecord = await admin.auth().createUser({
      uid: BOARD_ID,
      email: DEVICE_EMAIL,
      password: DEVICE_PASSWORD,
      displayName: `Shatranj Board (${BOARD_ID})`
    });

    console.log(`Successfully created user: ${userRecord.uid}`);

    // 2. Set the custom claim { role: 'device' }
    // This is required by the `isDeviceFor` rule
    await admin.auth().setCustomUserClaims(userRecord.uid, { role: 'device' });
    
    console.log(`Successfully set custom claim { role: 'device' } for ${userRecord.uid}`);
    console.log("\n--- Provisioning Complete! ---");
    console.log("Board ID / UID:", userRecord.uid);
    console.log("Device Email:", DEVICE_EMAIL);
    console.log("Device Password:", DEVICE_PASSWORD);
    console.log("\nUse this Email/Password in your ESP32's C++ code to sign in.");

  } catch (error) {
    if (error.code === 'auth/uid-already-exists') {
      console.error(`Error: User with UID '${BOARD_ID}' already exists.`);
      console.log("This is fine if you've run this script before.");
      console.log("To be safe, re-setting custom claim...");
      await admin.auth().setCustomUserClaims(BOARD_ID, { role: 'device' });
      console.log("Custom claim re-applied.");
    } else {
      console.error('Error provisioning device:', error);
    }
  }
}

provisionDevice();
