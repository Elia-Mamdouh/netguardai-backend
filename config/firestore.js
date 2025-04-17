const admin = require("firebase-admin");
const dotenv = require("dotenv");

dotenv.config();

// Initialize Firestore
const serviceAccount = require("../serviceAccountKey.json"); // Place your Firebase service account key here

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

module.exports = db;
