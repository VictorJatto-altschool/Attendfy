// Copy this file to config.js (project root) and fill in your Firebase project keys for local testing only.
// IMPORTANT: config.js is ignored by git. For production, the GitHub Actions workflow
// generates config.js at the repository root from encrypted repository secrets at deploy time.
window.firebaseConfig = {
  enabled: false, // set to true only in your local untracked config.js
  apiKey: "REPLACE",
  authDomain: "REPLACE",
  projectId: "REPLACE",
  storageBucket: "REPLACE",
  messagingSenderId: "REPLACE",
  appId: "REPLACE",
}

