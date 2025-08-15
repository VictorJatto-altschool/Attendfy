// Runtime Firebase config
// For production via GitHub Actions, this file is overwritten with your secrets.
// Default keeps app working locally without 404 and with cloud disabled.
window.firebaseConfig = {
  enabled: false,
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};

// App behavior flags (non-secret). CI will keep this block; you can edit in repo.
window.appConfig = {
  // When true (default), Course Rep dashboard can be opened without PIN/password.
  repAuthOptional: true,
  // When auth is required (repAuthOptional: false), allow any email by default (set to false to restrict to authorizedReps list in script.js)
  allowAnyRepEmail: true,
};
