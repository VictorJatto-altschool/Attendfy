// Global variables
let currentLocation = null
let timetableData = JSON.parse(localStorage.getItem("timetableData")) || []
const attendanceData = JSON.parse(localStorage.getItem("attendanceData")) || []
let db = null
// Anti-cheat: bind this device to a single student for today
let studentProfile = null
const authorizedReps = ["jattovictor32@gmail.com", "courserep@university.edu"]
// Simple 2FA: email -> PIN mapping (loaded from local storage or Firestore; no defaults in code)
let repPins = normalizeRepPins(JSON.parse(localStorage.getItem("repPins") || "{}"))
let gpsFailureCount = 0
// Rep session & scope
let currentRepEmail = null
let repScope = null

// Initialize the application
// App entrypoint: boot the app and start the preloader lifecycle when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  initializeApp()
  initPreloaderLifecycle()
})

// Bootstraps the app: cloud init, GPS, load UI/data, set today, wire events, mark preloader ready
function initializeApp() {
  try {
  // Initialize optional cloud sync and load remote data if enabled
  initCloud().then(loadFromCloudIfAny).then(subscribeCloud)
    getCurrentLocation()
    loadTimetableOptions()
    displayTimetable()

  // Initialize network status UX
  initNetworkStatus()

  // Load and apply device-bound student profile
  loadStudentProfile()
  applyStudentProfileLockUI()

    // Set today's date as default
    const summaryDateInput = document.getElementById("summary-date")
    if (summaryDateInput) {
      summaryDateInput.valueAsDate = new Date()
    }

  // Add form and nav event listeners
  setupEventListeners()
  setupNavHandlers()
  // Disable summary actions until a summary is generated
  const __dl = document.getElementById("download-summary-btn")
  const __pr = document.getElementById("print-summary-btn")
  if (__dl) __dl.disabled = true
  if (__pr) __pr.disabled = true

  console.log("  <i class=\"bi bi-patch-check-fill\"></i> Attendance system initialized successfully")
  // Mark app as ready for preloader; lifecycle will hide after minimum display time
  window.__appReady = true
  } catch (error) {
    console.error("<i class=\"bi bi-x-octagon-fill\"></i> Error initializing app:", error)
    showAlert("There was an error initializing the application. Please refresh the page.")
  }
}

// ---------- Preloader lifecycle ----------
// Shows a short loading screen with rotating tips; hides when app is ready or after a safety timeout
function initPreloaderLifecycle() {
  const preload = document.getElementById("preloader")
  if (!preload) return

  // Update subtext subtly while loading
  const sub = preload.querySelector(".preloader-sub")
  const start = performance.now()
  const MIN_DISPLAY_MS = 1200 // keep preloader visible ~1.2s for a quick, polished load
  let t = 0
  const tips = [
    "Checking GPS & network…",
    "Preparing timetable…",
    "Almost there…",
  ]
  const tipTimer = setInterval(() => {
    if (!sub) return
    sub.textContent = tips[t % tips.length]
    t++
  }, 1200)

  // Hide as soon as app is ready AND minimum display time has elapsed
  const readyTimer = setInterval(() => {
    if (window.__appReady && performance.now() - start >= MIN_DISPLAY_MS) {
      safeHidePreloader()
      clearInterval(readyTimer)
      clearInterval(tipTimer)
    }
  }, 150)

  // Safety timeout: hide after 5s even if not fully ready
  setTimeout(() => {
    if (!window.__appReady) {
      if (sub) sub.textContent = "You can start now. Some features may finish loading in the background."
    }
    safeHidePreloader()
    clearInterval(tipTimer)
    clearInterval(readyTimer)
  }, 5000)
}

// Fades out the preloader and removes it from the DOM after transition
function safeHidePreloader() {
  const preload = document.getElementById("preloader")
  if (!preload) return
  preload.classList.add("hidden")
  // fully remove from DOM after transition for accessibility
  setTimeout(() => preload.parentNode && preload.parentNode.removeChild(preload), 450)
}

// ---------- Student profile lock (anti-cheat) ----------
// Returns today's date in YYYY-MM-DD (used to bind a device per day)
function todayKey() {
  const d = new Date()
  return d.toISOString().slice(0, 10)
}

// Loads the device-bound student for today; expires previous day bindings
function loadStudentProfile() {
  try {
    const raw = localStorage.getItem("studentProfile")
    studentProfile = raw ? JSON.parse(raw) : null
    if (studentProfile && studentProfile.date !== todayKey()) {
      // Expire previous day binding
      localStorage.removeItem("studentProfile")
      studentProfile = null
    }
  } catch {
    studentProfile = null
  }
}

// Binds this device to a student's matric/name for today and updates the UI lock state
function saveStudentProfile(matriculation, studentName) {
  studentProfile = { matriculation, studentName, date: todayKey() }
  localStorage.setItem("studentProfile", JSON.stringify(studentProfile))
  applyStudentProfileLockUI()
}

// Clears the device binding and unlocks the inputs
function clearStudentProfile() {
  localStorage.removeItem("studentProfile")
  studentProfile = null
  applyStudentProfileLockUI()
}

// Locks/unlocks name and matric inputs depending on the current device binding
function applyStudentProfileLockUI() {
  const nameInput = document.getElementById("student-name")
  const matricInput = document.getElementById("matriculation")
  if (!nameInput || !matricInput) return

  const ensureHint = () => {
    let hint = document.getElementById("device-lock-hint")
    if (!hint) {
      hint = document.createElement("small")
      hint.id = "device-lock-hint"
      hint.className = "form-help"
      const parent = matricInput.parentElement
      if (parent) parent.appendChild(hint)
    }
    return hint
  }

  if (studentProfile && studentProfile.matriculation) {
    // Lock inputs to bound identity
    if (studentProfile.studentName) nameInput.value = studentProfile.studentName
    matricInput.value = studentProfile.matriculation
    nameInput.readOnly = true
    matricInput.readOnly = true
    const hint = ensureHint()
    if (hint) hint.textContent = `This device is locked to ${studentProfile.matriculation} for today. Only a Course Rep can unlock.`
  } else {
    // Unlock inputs
    nameInput.readOnly = false
    matricInput.readOnly = false
    const hint = document.getElementById("device-lock-hint")
    if (hint) hint.textContent = "Format: UYYYY/NNNNNNN (e.g., U2021/5570123)"
  }
}

// ------ Cloud Sync (Optional Firebase Firestore) ------
// Initializes Firebase (if enabled via config.js), enables offline persistence, sets Firestore handle
async function initCloud() {
  try {
    const cfg = window.firebaseConfig || { enabled: false }
    if (!cfg.enabled) {
      console.log("Cloud sync: disabled (config present: " + (typeof window.firebaseConfig !== 'undefined') + ")")
      return
    }
    if (typeof firebase === "undefined") {
      console.warn("Firebase SDK not loaded; running in local-only mode")
      return
    }
    // Initialize app only once (in case of HMR or re-entry)
    try {
      if (!firebase.apps || firebase.apps.length === 0) {
        firebase.initializeApp(cfg)
      }
    } catch (_) {
      // no-op if already initialized
    }
    db = firebase.firestore()
    // Best-effort offline persistence so changes queue when offline
    try {
      await db.enablePersistence({ synchronizeTabs: true })
    } catch (e) {
      // Ignore if not supported or already enabled
      // failed-precondition: multiple tabs open
      // unimplemented: browser doesn't support IndexedDB
    }
    console.log("Cloud sync: enabled", cfg.projectId ? `(project: ${cfg.projectId})` : "")
  } catch (e) {
    console.warn("Cloud init failed; continuing with local storage only", e)
    db = null
  }
}

// Loads timetable/attendance/PINs from Firestore; merges attendance with local
async function loadFromCloudIfAny() {
  if (!db) return
  try {
    // Load timetable
    const tSnap = await db.collection("attendanceApp").doc("timetable").get()
    if (tSnap.exists) {
      const remote = Array.isArray(tSnap.data().items) ? tSnap.data().items : []
      if (remote.length) {
        timetableData = remote
        localStorage.setItem("timetableData", JSON.stringify(timetableData))
        loadTimetableOptions()
        displayTimetable()
      }
    }

    // Load attendance and merge with local by key (matric|course|date)
    const aSnap = await db.collection("attendanceApp").doc("attendance").get()
    if (aSnap.exists) {
      const remote = Array.isArray(aSnap.data().items) ? aSnap.data().items : []
      const local = JSON.parse(localStorage.getItem("attendanceData") || "[]")
      const key = (r) => {
        const d = new Date(r.timestamp)
        const day = isNaN(d) ? "" : d.toISOString().slice(0, 10)
        return `${r.matriculation}|${r.courseCode}|${day}`
      }
      const map = new Map()
      remote.forEach((r) => map.set(key(r), r))
      local.forEach((r) => map.set(key(r), r))
      const merged = Array.from(map.values())
      localStorage.setItem("attendanceData", JSON.stringify(merged))
      // mutate attendanceData array in place to keep references
      attendanceData.splice(0, attendanceData.length, ...merged)
    }
    // Load repPins securely from Firestore
    try {
      const pSnap = await db.collection("attendanceApp").doc("repPins").get()
      if (pSnap.exists) {
        const pins = pSnap.data() || {}
        if (pins && typeof pins === "object") {
          const normalized = normalizeRepPins(pins)
          repPins = { ...repPins, ...normalized }
          localStorage.setItem("repPins", JSON.stringify(repPins))
        }
      }
    } catch (_) {}
  } catch (e) {
    console.warn("Cloud load failed; using local data", e)
  }
}

// Subscribes to Firestore changes to keep local storage and UI in sync
function subscribeCloud() {
  if (!db) return
  try {
    db.collection("attendanceApp").doc("timetable").onSnapshot((snap) => {
      if (!snap.exists) return
      const remote = Array.isArray(snap.data().items) ? snap.data().items : []
      timetableData = remote
      localStorage.setItem("timetableData", JSON.stringify(timetableData))
      loadTimetableOptions()
      displayTimetable()
    })
    db.collection("attendanceApp").doc("attendance").onSnapshot((snap) => {
      if (!snap.exists) return
      const remote = Array.isArray(snap.data().items) ? snap.data().items : []
      localStorage.setItem("attendanceData", JSON.stringify(remote))
      attendanceData.splice(0, attendanceData.length, ...remote)
    })
    // Listen for repPins (email -> pin) updates
    db.collection("attendanceApp").doc("repPins").onSnapshot((snap) => {
      if (!snap.exists) return
      const remote = snap.data() || {}
      if (remote && typeof remote === "object") {
        const normalized = normalizeRepPins(remote)
        repPins = { ...repPins, ...normalized }
        localStorage.setItem("repPins", JSON.stringify(repPins))
      }
    })
  } catch (e) {
    console.warn("Cloud subscribe failed", e)
  }
}

// Centralized cloud write helpers
// Writes the current timetable array to Firestore (idempotent)
function syncTimetableToCloud() {
  if (!db) return
  try {
    db.collection("attendanceApp").doc("timetable").set({ items: timetableData }).catch(() => {})
  } catch (_) {}
}

// Writes the current attendance array to Firestore (idempotent)
function syncAttendanceToCloud() {
  if (!db) return
  try {
    db.collection("attendanceApp").doc("attendance").set({ items: attendanceData }).catch(() => {})
  } catch (_) {}
}

// Network status handling for polished UX and manual fallback
// Shows offline/online banners; when online, best-effort syncs pending local changes
function initNetworkStatus() {
  const banner = document.getElementById("network-status")
  const manualBtn = document.getElementById("manual-btn")
  if (!banner) return

  const setOfflineUI = () => {
    banner.innerHTML = '<i class="bi bi-wifi-off"></i> You\'re offline. GPS check-in and sync may fail. Use Manual Attendance.'
    banner.classList.remove("hidden")
    banner.classList.remove("alert-success", "alert-error")
    banner.classList.add("alert-warning")
    if (manualBtn) manualBtn.classList.remove("hidden")
  }

  const setOnlineUI = () => {
    banner.innerHTML = '<i class="bi bi-rss-fill"></i> Back online. You can use GPS check-in.'
    banner.classList.remove("hidden")
    banner.classList.remove("alert-warning", "alert-error")
    banner.classList.add("alert-success")
    // Best-effort cloud convergence
    try {
      if (db) {
        const tt = JSON.parse(localStorage.getItem("timetableData") || "[]")
        const at = JSON.parse(localStorage.getItem("attendanceData") || "[]")
        db.collection("attendanceApp").doc("timetable").set({ items: tt }).catch(() => {})
        db.collection("attendanceApp").doc("attendance").set({ items: at }).catch(() => {})
      }
    } catch {}
    setTimeout(() => banner.classList.add("hidden"), 3000)
    if (manualBtn) manualBtn.classList.add("hidden")
  }

  if (!navigator.onLine) setOfflineUI()
  window.addEventListener("offline", setOfflineUI)
  window.addEventListener("online", setOnlineUI)
}

// Wires form submissions, filters, GPS buttons, rep login/scope, and summary reset behavior
function setupEventListeners() {
  // Student check-in form
  const checkinForm = document.getElementById("checkin-form")
  if (checkinForm) {
    checkinForm.addEventListener("submit", handleStudentCheckin)
  }

  // Timetable form
  const timetableForm = document.getElementById("timetable-form")
  if (timetableForm) {
    timetableForm.addEventListener("submit", handleTimetableSubmission)
  }

  // Filter timetable
  const filterFaculty = document.getElementById("filter-faculty")
  const filterDepartment = document.getElementById("filter-department")
  const filterLevel = document.getElementById("filter-level")
  const clearFiltersBtn = document.getElementById("clear-filters-btn")

  if (filterFaculty && filterDepartment && filterLevel && clearFiltersBtn) {
    filterFaculty.addEventListener("change", filterTimetable)
    filterDepartment.addEventListener("change", filterTimetable)
    filterLevel.addEventListener("change", filterTimetable)
    clearFiltersBtn.addEventListener("click", clearFilters)
  }

  // GPS permission and retry controls
  const enableGPSBtn = document.getElementById("enable-gps-btn")
  if (enableGPSBtn) {
    enableGPSBtn.addEventListener("click", requestLocationPermission)
  }
  const retryGPSBtn = document.getElementById("retry-gps-btn")
  if (retryGPSBtn) {
    retryGPSBtn.addEventListener("click", retryGetLocation)
  }
  // Use current location for timetable GPS fields
  const useCurrentBtn = document.getElementById("use-current-location-btn")
  if (useCurrentBtn) {
    useCurrentBtn.addEventListener("click", getCurrentLocation)
  }

  // Manual attendance button
  const manualBtn = document.getElementById("manual-btn")
  if (manualBtn) {
    manualBtn.addEventListener("click", handleManualAttendance)
  }

  // Rep login form to enable browser password manager saving
  const repLoginForm = document.getElementById("rep-login-form")
  if (repLoginForm) {
    repLoginForm.addEventListener("submit", (e) => {
      e.preventDefault()
      verifyRepAccess()
    })
  }

  // Rep scope form save
  const repScopeForm = document.getElementById("rep-scope-form")
  if (repScopeForm) {
    repScopeForm.addEventListener("submit", (e) => {
      e.preventDefault()
      handleSaveRepScope()
    })
  }

  // Summary controls: clear summary and disable actions on input change
  const summaryDateEl = document.getElementById("summary-date")
  const summaryCourseEl = document.getElementById("summary-course")
  const summaryDiv = document.getElementById("attendance-summary")
  const dlBtn = document.getElementById("download-summary-btn")
  const prBtn = document.getElementById("print-summary-btn")
  const resetSummaryState = () => {
    if (summaryDiv) summaryDiv.innerHTML = ""
    if (dlBtn) dlBtn.disabled = true
    if (prBtn) prBtn.disabled = true
  }
  if (summaryDateEl) summaryDateEl.addEventListener("change", resetSummaryState)
  if (summaryCourseEl) summaryCourseEl.addEventListener("change", resetSummaryState)

  // Bind summary action buttons
  const genBtn = document.getElementById("generate-summary-btn")
  if (genBtn) genBtn.addEventListener("click", generateSummary)
  const dl = document.getElementById("download-summary-btn")
  if (dl) dl.addEventListener("click", downloadSummary)
  const pr = document.getElementById("print-summary-btn")
  if (pr) pr.addEventListener("click", printSummary)

  // Clear filters and filter selects
  const clearFiltersBtn2 = document.getElementById("clear-filters-btn")
  if (clearFiltersBtn2) clearFiltersBtn2.addEventListener("click", clearFilters)
  const ff = document.getElementById("filter-faculty")
  const fd = document.getElementById("filter-department")
  const fl = document.getElementById("filter-level")
  if (ff) ff.addEventListener("change", filterTimetable)
  if (fd) fd.addEventListener("input", filterTimetable)
  if (fl) fl.addEventListener("change", filterTimetable)

  // Clear all timetables button
  const clearAllBtn = document.getElementById("clear-timetables-btn")
  if (clearAllBtn) clearAllBtn.addEventListener("click", clearAllTimetables)

  // Rep signout
  const repSignoutBtn = document.getElementById("rep-signout-btn")
  if (repSignoutBtn) repSignoutBtn.addEventListener("click", repSignOut)
}

// Wire up nav buttons using class and data-section (no inline handlers)
// Delegated click handling for main nav; switches visible section and active button
function setupNavHandlers() {
  const nav = document.querySelector('.main-nav')
  if (!nav) return
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-btn')
    if (!btn) return
    const sectionId = btn.getAttribute('data-section')
    if (!sectionId) return
    showSection(sectionId, { target: btn })
  })
}

// Navigation functions
// Shows a section by id and updates the active navigation state
function showSection(sectionId, ev) {
  if (!sectionId) return
  // Hide all sections with smooth transition
  document.querySelectorAll(".section").forEach((section) => {
    section.classList.remove("active")
  })

  // Remove active class from all nav buttons
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.remove("active")
  })

  // Show selected section with delay for smooth transition
  setTimeout(() => {
    const target = document.getElementById(sectionId)
    if (target) target.classList.add("active")
  }, 60)

  // Add active class to clicked button
  if (ev && ev.target && ev.target.classList) {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'))
    ev.target.classList.add("active")
  }
}

// GPS Location functions
// Acquires current GPS location; updates UI, fills rep GPS fields, and distance hints; suggests manual after timeouts
function getCurrentLocation() {
  const statusDiv = document.getElementById("gps-status")
  const locationDetails = document.getElementById("location-details")
  const manualBtn = document.getElementById("manual-btn")

  if (!navigator.geolocation) {
    updateGPSStatus(statusDiv, '<i class="bi bi-exclamation-triangle-fill" style="color:#c62828;"></i> GPS not supported by this browser', "error")
    return
  }

  updateGPSStatus(statusDiv, "Getting your location...", "loading")

  navigator.geolocation.getCurrentPosition(
    (position) => {
      currentLocation = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        timestamp: new Date().toISOString(),
      }

  updateGPSStatus(statusDiv, `  <i class="bi bi-patch-check-fill" style="color: lightgreen;"></i> Location acquired successfully!`, "success")

      showLocationDetails(locationDetails)

      // Auto-fill GPS coordinates in course rep form
      autoFillGPSCoordinates()

      // Update course selection with distance info
      updateCourseSelectionWithDistance()

      // Update GPS accuracy hint for course reps
      const gpsHint = document.getElementById("gps-input-hint")
      if (gpsHint && currentLocation && Number.isFinite(currentLocation.accuracy)) {
        const acc = Math.round(currentLocation.accuracy)
        const icon = '<i class="bi bi-wifi" style="color: lightgreen;"></i>'
        const quality = acc <= 30 ? 'Good signal' : acc <= 70 ? 'Moderate signal' : 'Poor signal'
        const tip = acc > 70 ? ' Move near a window or enable Wi‑Fi/Cellular for better accuracy.' : ''
        gpsHint.innerHTML = `${icon} Current GPS accuracy: ±${acc}m (${quality}).${tip}`
      }

      // reset timeout counter
      gpsFailureCount = 0
    },
    (error) => {
      const errorMessage = getGPSErrorMessage(error)
      updateGPSStatus(statusDiv, errorMessage, "error")
      locationDetails.classList.add("hidden")
      if (manualBtn) manualBtn.classList.remove("hidden")

      // track repeated timeouts to suggest manual path
      if (error.code === error.TIMEOUT) {
        gpsFailureCount++
      }
      if (gpsFailureCount >= 2 && statusDiv) {
        statusDiv.innerHTML = `<span><i class="bi bi-hourglass-split" style="color:#ef6c00;"></i> Location timed out multiple times. You can continue with Manual Attendance or try again.</span>`
      }
    },
    {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 300000,
    },
  )
}

// Renders GPS status visuals (loading/success/error) and messages
function updateGPSStatus(statusDiv, message, type) {
  if (!statusDiv) return

  statusDiv.className = `gps-status ${type}`

  if (type === "loading") {
    statusDiv.innerHTML = `
      <div class="gps-radar"></div>
      <span>
        <i class="bi bi-geo-alt pulse" style="color: lightgreen;"></i>
        ${message}<span class="dots"><span>•</span><span>•</span><span>•</span></span>
      </span>
    `
  } else {
    statusDiv.innerHTML = `<span>${message}</span>`
  }
}

// Human-readable geolocation error messages for denied/unavailable/timeout/unknown
function getGPSErrorMessage(error) {
  switch (error.code) {
    case error.PERMISSION_DENIED:
  return '<i class="bi bi-x-octagon-fill" style="color:#c62828;"></i> Location access denied. Click \"Enable Location\" and allow permission.'
    case error.POSITION_UNAVAILABLE:
  return '<i class="bi bi-slash-circle-fill" style="color:#c62828;"></i> Location information unavailable.'
    case error.TIMEOUT:
  return '<i class="bi bi-hourglass-split" style="color:#ef6c00;"></i> Location request timed out. Click \"Retry Location\".'
    default:
  return '<i class="bi bi-question-circle-fill" style="color:#c62828;"></i> An unknown error occurred.'
  }
}

// Request user permission for geolocation, then try to acquire
// Checks permission state and triggers location retrieval
async function requestLocationPermission() {
  const statusDiv = document.getElementById("gps-status")
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const result = await navigator.permissions.query({ name: "geolocation" })
      if (result.state === "denied") {
  updateGPSStatus(statusDiv, '<i class="bi bi-x-octagon-fill" style="color:#c62828;"></i> Permission denied. Enable location in browser settings and allow when prompted.', "error")
        return
      }
    }
  } catch (_) {
    // Ignore if Permissions API not available
  }
  updateGPSStatus(statusDiv, "Requesting location permission...", "loading")
  getCurrentLocation()
}

// Retry with a gentle exponential backoff based on failures
// Shows countdown and retries GPS acquisition with growing delay
function retryGetLocation() {
  const statusDiv = document.getElementById("gps-status")
  const attempt = Math.min(gpsFailureCount + 1, 4)
  const backoffMs = 500 * Math.pow(2, attempt - 1)
  updateGPSStatus(statusDiv, `Retrying location in ${Math.round(backoffMs / 1000)}s...`, "loading")
  setTimeout(() => {
    getCurrentLocation()
  }, backoffMs)
}

// Shows lat/lng/accuracy and reveals the location details panel
function showLocationDetails(locationDetails) {
  if (!currentLocation || !locationDetails) return

  document.getElementById("current-lat").textContent = currentLocation.latitude.toFixed(6)
  document.getElementById("current-lng").textContent = currentLocation.longitude.toFixed(6)
  document.getElementById("current-accuracy").textContent = `±${Math.round(currentLocation.accuracy)}m`

  locationDetails.classList.remove("hidden")
}

// Autofills the rep GPS inputs with current coordinates and shows accuracy quality
function autoFillGPSCoordinates() {
  if (!currentLocation) return

  const latInput = document.getElementById("gps-lat")
  const lngInput = document.getElementById("gps-lng")

  if (latInput && lngInput) {
    latInput.value = currentLocation.latitude.toFixed(6)
    lngInput.value = currentLocation.longitude.toFixed(6)
    const gpsHint = document.getElementById("gps-input-hint")
    if (gpsHint && Number.isFinite(currentLocation.accuracy)) {
      const acc = Math.round(currentLocation.accuracy)
      const icon = '<i class="bi bi-wifi" style="color: lightgreen;"></i>'
      const quality = acc <= 30 ? 'Good signal' : acc <= 70 ? 'Moderate signal' : 'Poor signal'
      const tip = acc > 70 ? ' Move near a window or enable Wi‑Fi/Cellular for better accuracy.' : ''
      gpsHint.innerHTML = `${icon} Current GPS accuracy: ±${acc}m (${quality}).${tip}`
    }
  }
}

// On course change, shows distance/status/time-window and toggles the check-in button
function updateCourseSelectionWithDistance() {
  const courseSelect = document.getElementById("course-select")
  if (!courseSelect || !currentLocation) return

  courseSelect.addEventListener("change", function () {
    const courseLocationInfo = document.getElementById("course-location-info")
  const courseWindowInfo = document.getElementById("course-window-info")
  const submitBtn = document.getElementById("checkin-btn")
    if (!this.value || !courseLocationInfo) return

    const courseInfo = timetableData.find((item) => item.courseCode === this.value)
    if (!courseInfo) return

    const distance = calculateDistance(
      currentLocation.latitude,
      currentLocation.longitude,
      courseInfo.gpsLat,
      courseInfo.gpsLng,
    )

    const distanceText = Math.round(distance)
  const statusIcon = distance <= 100 ? '<i class="bi bi-check2-circle" style="color: lightgreen;"></i>' : '<i class="bi bi-person-walking" style="color: #ff9800;"></i>'
  const statusText = distance <= 100 ? "Within range" : "Move inside the class"

  courseLocationInfo.innerHTML = `${statusIcon} Distance to ${courseInfo.venue}: ${distanceText}m (${statusText})`
    courseLocationInfo.style.color = distance <= 100 ? "#4caf50" : "#ff9800"

    // Show time window hint
    if (courseWindowInfo) {
      const cfgTW = (window.appConfig && window.appConfig.enforceTimeWindow) ? true : false
      const withinWindow = cfgTW ? isWithinTimeSlot(courseInfo.timeSlot, courseInfo.day) : true
      const dayText = courseInfo.day || ""
      courseWindowInfo.innerHTML = withinWindow
        ? `<i class="bi bi-clock" style="color: lightgreen;"></i> Attendance ${(cfgTW ? 'open' : 'allowed')} ${dayText ? dayText + ' ' : ''}${courseInfo.timeSlot || ''}`
        : `<i class="bi bi-hourglass-split" style="color: #ef6c00;"></i> Attendance closed now: ${dayText} ${courseInfo.timeSlot}`
      courseWindowInfo.style.color = withinWindow ? "#4caf50" : "#ef6c00"
    }

    // Smart enable/disable
    if (submitBtn) {
      const cfgTW = (window.appConfig && window.appConfig.enforceTimeWindow) ? true : false
      const inWindow = cfgTW ? isWithinTimeSlot(courseInfo.timeSlot, courseInfo.day) : true
      const canCheckIn = navigator.onLine && currentLocation && distance <= 100 && inWindow
      submitBtn.disabled = !canCheckIn
    }
  })
}

// Calculate distance between two GPS coordinates
// Haversine distance in meters between two lat/lng points
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3 // Earth's radius in meters
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const Δφ = ((lat2 - lat1) * Math.PI) / 180
  const Δλ = ((lon2 - lon1) * Math.PI) / 180

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return R * c // Distance in meters
}

// Student check-in functions
// Populates student course dropdown and summary course filter from current timetable
function loadTimetableOptions() {
  const courseSelect = document.getElementById("course-select")
  const summaryCourse = document.getElementById("summary-course")
  if (!courseSelect && !summaryCourse) return

  const uniqueCourses = [...new Set(timetableData.map((item) => item.courseCode))]

  if (courseSelect) {
    courseSelect.innerHTML = '<option value="">Choose a course...</option>'
    uniqueCourses.forEach((course) => {
      const option = document.createElement("option")
      option.value = course
      option.textContent = course
      courseSelect.appendChild(option)
    })
  }

  if (summaryCourse) {
    const prev = summaryCourse.value
    summaryCourse.innerHTML = '<option value="">All Courses</option>'
    uniqueCourses.forEach((course) => {
      const opt = document.createElement("option")
      opt.value = course
      opt.textContent = course
      summaryCourse.appendChild(opt)
    })
    if (prev && uniqueCourses.includes(prev)) summaryCourse.value = prev
  }
}

// Handles student check-in submit: validate → process → show message → reset
function handleStudentCheckin(e) {
  e.preventDefault()

  const messageDiv = document.getElementById("checkin-message")
  const submitBtn = document.getElementById("checkin-btn")
  const formData = getCheckinFormData()

  // Show loading state
  submitBtn.classList.add("loading")
  submitBtn.disabled = true

  // Validate form data
  const validation = validateCheckinData(formData)
  if (!validation.isValid) {
    showMessage(messageDiv, validation.message, "error")
    resetSubmitButton(submitBtn)
    return
  }

  // Process attendance with delay for better UX
  setTimeout(() => {
    const result = processAttendance(formData)
    showMessage(messageDiv, result.message, result.type)

    if (result.type === "success") {
      document.getElementById("checkin-form").reset()
      // Clear course location info
      const courseLocationInfo = document.getElementById("course-location-info")
      if (courseLocationInfo) courseLocationInfo.innerHTML = ""
    }

    resetSubmitButton(submitBtn)
  }, 1000)
}

// Extracts and trims student check-in form values
function getCheckinFormData() {
  return {
    studentName: document.getElementById("student-name").value.trim(),
    matriculation: document.getElementById("matriculation").value.trim(),
    courseCode: document.getElementById("course-select").value,
  }
}

// Validates required fields, matric format, GPS presence, and device lock consistency
function validateCheckinData(data) {
  if (!data.studentName || !data.matriculation || !data.courseCode) {
    return { isValid: false, message: "Please fill in all required fields." }
  }

  if (!currentLocation) {
    return { isValid: false, message: "Location not available. Please enable GPS and try again." }
  }

  // Validate matriculation format (U2021/5570123)
  const matricPattern = /^U[0-9]{4}\/[0-9]{7}$/
  if (!matricPattern.test(data.matriculation)) {
    return { isValid: false, message: "Invalid matriculation format. Use format: U2021/5570123" }
  }

  // Anti-cheat: if device is locked to a student for today, enforce same matric only
  if (studentProfile && studentProfile.matriculation && studentProfile.matriculation !== data.matriculation) {
    return { isValid: false, message: `This device is locked to ${studentProfile.matriculation} for today. Only the Course Rep can unlock.` }
  }

  return { isValid: true }
}

// Enforces day/time window and ≤100m distance, prevents duplicates, records attendance, binds device, syncs
function processAttendance(formData) {
  // Find course in timetable
  const courseInfo = timetableData.find((item) => item.courseCode === formData.courseCode)
  if (!courseInfo) {
    return { message: "Course not found in timetable.", type: "error" }
  }

  // Enforce attendance within time slot and day
  const _appCfg = (typeof window !== 'undefined' && window.appConfig) ? window.appConfig : {}
  const enforceTW = !!_appCfg.enforceTimeWindow
  if (enforceTW) {
    const withinWindow = isWithinTimeSlot(courseInfo.timeSlot, courseInfo.day)
    if (!withinWindow) {
      return { message: "Attendance closed for this course.", type: "error" }
    }
  }

  // Check distance
  const distance = calculateDistance(
    currentLocation.latitude,
    currentLocation.longitude,
    courseInfo.gpsLat,
    courseInfo.gpsLng,
  )

  if (distance > 100) {
    return {
      message: `You are ${Math.round(distance)}m away. <i class="bi bi-person-walking" style="color: #ef6c00;"></i> Move inside the class (within 100m) to mark attendance.`,
      type: "error",
    }
  }

  // Check for duplicate attendance
  if (isDuplicateAttendance(formData.matriculation, formData.courseCode)) {
    return { message: "You have already marked attendance for this course today.", type: "warning" }
  }

  // Record attendance
  const attendanceRecord = createAttendanceRecord(formData, courseInfo, distance)
  attendanceData.push(attendanceRecord)
  localStorage.setItem("attendanceData", JSON.stringify(attendanceData))

  // Bind device to this student on first successful check-in of the day
  if (!studentProfile || studentProfile.matriculation !== formData.matriculation) {
    saveStudentProfile(formData.matriculation, formData.studentName)
  }

  // Cloud sync (optional)
  syncAttendanceToCloud()

  // Build polished success message with GPS and Network quality chips
  const accVal = currentLocation && Number.isFinite(currentLocation.accuracy)
    ? Math.round(currentLocation.accuracy)
    : null
  const gpsQ = classifyGPSAccuracy(accVal)
  const netQ = getNetworkQuality()
  const gpsChip = buildStatusChip(`GPS: ${accVal != null ? `±${accVal}m` : 'N/A'} (${gpsQ.label})`, gpsQ.color, gpsQ.icon)
  const netLabel = netQ.detail ? `${netQ.detail} ${netQ.label}` : netQ.label
  const netChip = buildStatusChip(`Network: ${netLabel}`, netQ.color, netQ.icon)

  const chips = `<div class="status-chips">${gpsChip} ${netChip}</div>`

  return {
    message: `<i class="bi bi-patch-check-fill" style="color: lightgreen;"></i> Attendance marked successfully! Distance from venue: ${Math.round(distance)}m ${chips}`,
    type: "success",
  }
}

// Time slot helper: supports formats like "8:00 AM - 10:00 AM"
// True only when now is on the specified weekday and between the parsed start/end times
function isWithinTimeSlot(timeSlot, day) {
  try {
    const _appCfg = (typeof window !== 'undefined' && window.appConfig) ? window.appConfig : {}
    const enforceTW = !!_appCfg.enforceTimeWindow
    if (!enforceTW) return true // configured to allow any time
    if (!timeSlot || !day) return true // fail-open if missing data
    const [startRaw, endRaw] = timeSlot.split("-").map((s) => s.trim())
    const now = new Date()

    // Only allow on the specified day
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    const todayName = days[now.getDay()]
    if (day !== todayName) return false

    const start = parseTimeToday(startRaw)
    const end = parseTimeToday(endRaw)
    if (!start || !end) return true

    return now >= start && now <= end
  } catch {
    return true
  }
}

// Parses an "h:mm AM/PM" label into a Date object for today
function parseTimeToday(label) {
  if (!label) return null
  const now = new Date()
  // Try to parse a variety of common formats, else return null to fail-open in isWithinTimeSlot
  const m = label.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i)
  if (!m) return null
  let [_, hh, mm, ap] = m
  let h = parseInt(hh, 10)
  const minutes = isNaN(parseInt(mm, 10)) ? 0 : parseInt(mm, 10)
  ap = (ap || '').toUpperCase()
  if (ap === "PM" && h !== 12) h += 12
  if (ap === "AM" && h === 12) h = 0
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, minutes, 0, 0)
}

// Classify GPS accuracy meters into Good/Moderate/Poor for UX display
function classifyGPSAccuracy(accMeters) {
  if (!Number.isFinite(accMeters)) return { label: 'Unknown', color: '#9e9e9e', icon: 'bi-geo-alt' }
  if (accMeters <= 30) return { label: 'Good', color: '#2e7d32', icon: 'bi-geo-alt' }
  if (accMeters <= 70) return { label: 'Moderate', color: '#ef6c00', icon: 'bi-geo-alt' }
  return { label: 'Poor', color: '#c62828', icon: 'bi-geo-alt' }
}

// Report network quality using the Network Information API when available; fallback to Online/Offline
function getNetworkQuality() {
  if (!navigator.onLine) return { label: 'Offline', detail: '', color: '#ef6c00', icon: 'bi-wifi-off' }
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection
  if (c && c.effectiveType) {
    const et = String(c.effectiveType).toLowerCase()
    if (et === '4g') return { label: 'Online', detail: '4g', color: '#2e7d32', icon: 'bi-rss-fill' }
    if (et === '3g') return { label: 'Moderate', detail: '3g', color: '#ef6c00', icon: 'bi-rss-fill' }
    return { label: 'Poor', detail: et, color: '#c62828', icon: 'bi-rss-fill' }
  }
  return { label: 'Online', detail: '', color: '#2e7d32', icon: 'bi-rss-fill' }
}

// Small rounded pill element with icon and themed border/color
function buildStatusChip(text, color, iconClass) {
  const safeText = escapeHtml(String(text))
  const safeIcon = escapeHtml(String(iconClass))
  const safeColor = escapeHtml(String(color))
  return `<span class="status-chip" style="border-color:${safeColor}; color:${safeColor}"><i class="bi ${safeIcon}"></i> ${safeText}</span>`
}

// Manual attendance fallback (offline / GPS issues)
// Records manual/offline attendance with same validations (except GPS distance), then syncs later
function handleManualAttendance() {
  // Always show a popup regardless of form state
  showAlert("Write manual attendance")

  const messageDiv = document.getElementById("checkin-message")
  const studentName = document.getElementById("student-name").value.trim()
  const matriculation = document.getElementById("matriculation").value.trim()
  const courseCode = document.getElementById("course-select").value

  // Polished UX: if offline, inform the student clearly
  if (!navigator.onLine && messageDiv) {
    messageDiv.innerHTML = '<div class="alert alert-warning"><i class="bi bi-wifi-off" style="color:#ef6c00;"></i> You are offline. Write manual attendance now. This entry will be saved as manual-offline.</div>'
  }

  // For manual attendance, don't show the "please fill" error; just stop silently if fields are missing
  if (!studentName || !matriculation || !courseCode) {
    return
  }

  const matricPattern = /^U[0-9]{4}\/[0-9]{7}$/
  if (!matricPattern.test(matriculation)) {
    return showMessage(messageDiv, "Invalid matriculation format. Use format: U2021/5570123", "error")
  }

  const courseInfo = timetableData.find((item) => item.courseCode === courseCode)
  if (!courseInfo) return showMessage(messageDiv, "Course not found in timetable.", "error")

  if (!isWithinTimeSlot(courseInfo.timeSlot, courseInfo.day)) {
    return showMessage(messageDiv, "Attendance closed for this course.", "error")
  }

  // Anti-cheat: enforce device lock for manual too
  if (studentProfile && studentProfile.matriculation && studentProfile.matriculation !== matriculation) {
    return showMessage(messageDiv, `This device is locked to ${studentProfile.matriculation} for today. Only the Course Rep can unlock.`, "error")
  }

  if (isDuplicateAttendance(matriculation, courseCode)) {
    return showMessage(messageDiv, "You have already marked attendance for this course today.", "warning")
  }

  const record = {
    studentName,
    matriculation,
    courseCode,
    courseName: courseInfo.courseCode,
    venue: courseInfo.venue,
    faculty: courseInfo.faculty,
    department: courseInfo.department,
    level: courseInfo.level,
    timestamp: new Date().toISOString(),
    gpsLocation: null,
    distance: null,
    status: "manual-offline",
  }
  attendanceData.push(record)
  localStorage.setItem("attendanceData", JSON.stringify(attendanceData))
  // Bind device after successful manual record
  if (!studentProfile || studentProfile.matriculation !== matriculation) {
    saveStudentProfile(matriculation, studentName)
  }
  // Cloud sync (optional)
  syncAttendanceToCloud()
  showMessage(messageDiv, '<i class="bi bi-pencil-square" style="color: lightgreen;"></i> Manual attendance recorded. Sync when online.', "success")
  document.getElementById("checkin-form").reset()
}

// Returns true if the same matric/course already has a record today
function isDuplicateAttendance(matriculation, courseCode) {
  const today = new Date().toDateString()
  return attendanceData.some(
    (record) =>
      record.matriculation === matriculation &&
      record.courseCode === courseCode &&
      new Date(record.timestamp).toDateString() === today,
  )
}

// Builds a normalized attendance record with GPS location and rounded distance
function createAttendanceRecord(formData, courseInfo, distance) {
  return {
    studentName: formData.studentName,
    matriculation: formData.matriculation,
    courseCode: formData.courseCode,
    courseName: courseInfo.courseCode,
    venue: courseInfo.venue,
    faculty: courseInfo.faculty,
    department: courseInfo.department,
    level: courseInfo.level,
    timestamp: new Date().toISOString(),
    gpsLocation: {
      latitude: currentLocation.latitude,
      longitude: currentLocation.longitude,
    },
    distance: Math.round(distance),
  }
}

// Course Rep functions
// Verifies (or bypasses) Course Rep access.
// When appConfig.repAuthOptional is true (default), allow opening the dashboard without PIN/password.
// Otherwise, require either a matching rep PIN (from Firestore/local) or Firebase Auth password.
async function verifyRepAccess() {
  let email = document.getElementById("rep-email").value.trim().toLowerCase()
  const pin = document.getElementById("rep-pin")?.value?.trim()
  const dashboard = document.getElementById("rep-dashboard")
  const appCfg = (typeof window !== 'undefined' && window.appConfig) ? window.appConfig : {}
  const authOptional = appCfg && Object.prototype.hasOwnProperty.call(appCfg, 'repAuthOptional') ? !!appCfg.repAuthOptional : true
  const allowAnyEmail = appCfg && Object.prototype.hasOwnProperty.call(appCfg, 'allowAnyRepEmail') ? !!appCfg.allowAnyRepEmail : true

  // If authentication is optional, allow opening dashboard with or without email/PIN
  if (authOptional) {
    if (!email) {
      // Provide a stable pseudo-identity for local storage scoping
      email = 'guest@local'
    } else {
      // Best-effort email normalization; accept any email string
      email = String(email).toLowerCase()
    }
    // Persist session and reveal dashboard
    localStorage.setItem("repSession", JSON.stringify({ email, ts: Date.now(), mode: 'open' }))
    currentRepEmail = email
    loadRepScope()
    applyRepScopeUI()
    ensureUnlockButton()
    renderRepTimetableList()
    if (dashboard) {
      dashboard.classList.remove("hidden")
      const msg = document.createElement("div")
      msg.className = "alert alert-success"
      msg.innerHTML = '<i class="bi bi-unlock" style="color: lightgreen;"></i> Course Rep dashboard opened (no verification required).'
      dashboard.insertBefore(msg, dashboard.firstChild)
      setTimeout(() => { if (msg.parentNode) msg.parentNode.removeChild(msg) }, 3000)
      dashboard.scrollIntoView({ behavior: "smooth" })
    }
    return
  }

  if (!email) {
    showAlert("Please enter your email address.")
    return
  }

  // Simple email validation (when auth is required)
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email)) {
    showAlert("Please enter a valid email address.")
    return
  }

  if (allowAnyEmail || authorizedReps.includes(email)) {
    // Accept either matching repPins PIN or Firebase Auth password as credentials
    const expectedPin = repPins[email]
    let authenticated = false
    if (expectedPin && pin && pin === expectedPin) {
      authenticated = true
    } else {
      // Try Firebase Auth if available and configured
      try {
        const cfg = window.firebaseConfig || { enabled: false }
        if (cfg.enabled && typeof firebase !== "undefined" && firebase.apps && firebase.apps.length > 0 && firebase.auth) {
          await firebase.auth().signInWithEmailAndPassword(email, pin)
          authenticated = true
          // Optional: sign out immediately to avoid holding an auth session
          try { await firebase.auth().signOut() } catch (_) {}
        }
      } catch (e) {
        // Keep unauthenticated; attach hint based on Firebase error code
        let hint = ''
        const code = e && e.code ? String(e.code) : ''
        if (code === 'auth/operation-not-allowed') hint = ' Email/Password sign-in is disabled in Firebase Auth.'
        else if (code === 'auth/user-not-found') hint = ' No user found for this email.'
        else if (code === 'auth/wrong-password') hint = ' Incorrect password.'
        else if (code === 'auth/too-many-requests') hint = ' Too many attempts, please try again later.'
        if (hint) console.warn('Auth failed:', code, hint)
      }
    }

    if (!authenticated) {
      const cfg = window.firebaseConfig || { enabled: false }
      const cloudNote = cfg && cfg.enabled === false ? " Cloud auth is disabled on this site; only the Rep PIN can be used unless the admin enables Firebase secrets." : ""
      showAlert("Invalid PIN or password." + cloudNote)
      return
    }

  // Persist current rep session
    localStorage.setItem("repSession", JSON.stringify({ email, ts: Date.now() }))
  currentRepEmail = email
  // Load scope and lock UI accordingly
  loadRepScope()
  applyRepScopeUI()

  // Best effort: prompt Chrome/Google Password Manager to save credentials
  attemptSaveRepCredentials(email, pin)
  // Fallback heuristic: submit a hidden shadow form to a hidden iframe so browsers detect a successful login
  triggerPasswordManagerHeuristic(email, pin)
  dashboard.classList.remove("hidden")

    // Create success message
    const messageDiv = document.createElement("div")
    messageDiv.className = "alert alert-success"
  messageDiv.innerHTML = '<i class="bi bi-patch-check-fill" style="color: lightgreen;"></i> Access granted! Welcome, Course Representative.'
    dashboard.insertBefore(messageDiv, dashboard.firstChild)

    // Remove message after 3 seconds
    setTimeout(() => {
      if (messageDiv.parentNode) {
        messageDiv.parentNode.removeChild(messageDiv)
      }
    }, 3000)

    // Scroll to dashboard
    dashboard.scrollIntoView({ behavior: "smooth" })

    // Show unlock button for device lock (anti-cheat)
    ensureUnlockButton()
  // Render editable timetable list
  renderRepTimetableList()
  } else {
    dashboard.classList.add("hidden")
    showAlert("Access denied. You are not authorized as a course representative.")
  }
}

// Ask the browser (Chrome/Google Password Manager) to save the rep's credentials
// Uses Credential Management API to prompt credential storage when supported
function attemptSaveRepCredentials(email, pin) {
  try {
    if (!('credentials' in navigator)) return
    // Only store on secure origins for best compatibility
    const isSecure = location.protocol === 'https:' || location.hostname === 'localhost'
    if (!isSecure) {
      // Still attempt; many browsers require HTTPS to persist
    }
    const supportsPasswordCredential = typeof window.PasswordCredential === 'function'
    if (!supportsPasswordCredential) return
    const cred = new PasswordCredential({ id: email, name: email, password: pin })
    navigator.credentials.store(cred).catch(() => {})
  } catch (e) {
    // Non-fatal if the API isn't available
    console.warn('Credential store failed', e)
  }
}

// Submit a hidden form (username/password) to a hidden iframe to nudge browser password managers
// Heuristic fallback to trigger password manager save flows
function triggerPasswordManagerHeuristic(email, pin) {
  try {
    const sinkName = 'auth_sink'
    const shadow = document.createElement('form')
    shadow.method = 'post'
    shadow.action = '/__rep_login'
    shadow.target = sinkName
    shadow.style.display = 'none'
    const u = document.createElement('input')
    u.type = 'email'
    u.name = 'username'
    u.autocomplete = 'username'
    u.value = email
    const p = document.createElement('input')
    p.type = 'password'
    p.name = 'password'
    p.autocomplete = 'current-password'
    p.value = pin
    shadow.appendChild(u)
    shadow.appendChild(p)
    document.body.appendChild(shadow)
    // submit and remove later to avoid clutter
    shadow.submit()
    setTimeout(() => {
      if (shadow.parentNode) shadow.parentNode.removeChild(shadow)
    }, 2000)
  } catch (_) {
    // ignore
  }
}

// Clears rep session and scope and resets UI lock state
function repSignOut() {
  localStorage.removeItem("repSession")
  currentRepEmail = null
  repScope = null
  const dashboard = document.getElementById("rep-dashboard")
  if (dashboard) dashboard.classList.add("hidden")
  // Re-enable create form fields
  const fac = document.getElementById("faculty")
  const dep = document.getElementById("department")
  const lvl = document.getElementById("level")
  if (fac) fac.disabled = false
  if (dep) dep.readOnly = false
  if (lvl) lvl.disabled = false
  showAlert("Signed out.")
}

// Adds a one-click button (for reps) to unlock the device-bound student for the day
function ensureUnlockButton() {
  const parent = document.getElementById("course-rep") || document.body
  let btn = document.getElementById("unlock-device-btn")
  if (!btn) {
    btn = document.createElement("button")
    btn.id = "unlock-device-btn"
    btn.className = "btn btn-secondary btn-small"
    btn.style.margin = "10px 0"
    btn.innerHTML = '<i class="bi bi-unlock" style="color: lightgreen;"></i> Unlock This Device'
    parent.insertBefore(btn, parent.firstChild)
    btn.addEventListener("click", () => {
      clearStudentProfile()
      showAlert("Device unlocked. Students can enter a different matric for today.")
    })
  }
}

// Creates a timetable entry (enforcing rep scope), validates and persists, syncs, and refreshes UI
function handleTimetableSubmission(e) {
  e.preventDefault()

  const formData = getTimetableFormData()

  // Enforce Rep Scope on creation
  if (!repScope || !repScope.faculty || !repScope.department || !repScope.level) {
    showAlert("Please set your Rep Profile & Scope first.")
    return
  }
  // Override incoming values with scope to prevent tampering
  formData.faculty = repScope.faculty
  formData.department = repScope.department
  formData.level = String(repScope.level)

  // Validate form data
  const validation = validateTimetableData(formData)
  if (!validation.isValid) {
    showAlert(validation.message)
    return
  }

  // Add to timetable
  formData.id = Date.now() // Simple ID generation
  timetableData.push(formData)
  localStorage.setItem("timetableData", JSON.stringify(timetableData))

  // Cloud sync (optional)
  syncTimetableToCloud()

  showAlert("Timetable entry added successfully!")
  document.getElementById("timetable-form").reset()

  // Refresh displays
  loadTimetableOptions()
  displayTimetable()
}

// -------- Course Rep: Manage Timetable (edit existing entries) --------
// Renders an editable list of timetable items filtered to the rep scope and wires actions
function renderRepTimetableList() {
  const container = document.getElementById("rep-timetable-list")
  if (!container) return

  // Ensure every timetable item has a stable ID (one-time migration for older data)
  ensureTimetableIds()

  if (!repScope) {
    container.innerHTML = '<div class="alert alert-warning"><i class="bi bi-person-badge"></i> Set and save your Rep Scope to view and edit your timetable entries.</div>'
    return
  }

  // Filter entries to rep scope only
  const scopedItems = Array.isArray(timetableData)
    ? timetableData.filter((it) => matchRepScope(it))
    : []

  if (scopedItems.length === 0) {
    container.innerHTML = '<div class="alert alert-warning">No timetable entries yet.</div>'
    return
  }

  const dayOptions = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
  const facultyOptions = ["Science", "Arts", "Engineering", "Medicine", "Law", "Computing"]
  const levelOptions = ["100", "200", "300", "400", "500"]
  container.innerHTML = scopedItems
    .slice()
    .sort((a, b) => `${a.day} ${a.timeSlot}`.localeCompare(`${b.day} ${b.timeSlot}`))
    .map((item, index) => {
      const id = item.id || `${item.courseCode}-${index}`
      return `
        <div class="timetable-card" data-id="${id}">
          <div class="timetable-entry">
            <div class="course-title">${item.courseCode} <small style=\"color:#888\">(${item.venue})</small></div>
            <div class="course-details">
              <span><i class=\"bi bi-calendar-event\" style=\"color: lightgreen;\"></i> <strong>Day:</strong> <span class=\"view-day\">${item.day}</span></span><br/>
              <span><i class=\"bi bi-clock\" style=\"color: lightgreen;\"></i> <strong>Time:</strong> <span class=\"view-time\">${item.timeSlot}</span></span><br/>
              <span><i class=\"bi bi-buildings\" style=\"color: lightgreen;\"></i> ${item.faculty} - ${item.department} | <i class=\"bi bi-mortarboard\" style=\"color: lightgreen;\"></i> ${item.level} Level</span>
            </div>
            <div class="button-group" style="margin-top:10px;">
              <button class="btn btn-secondary btn-small" data-action="edit"><i class="bi bi-pencil"></i> Edit</button>
              <button class="btn btn-danger btn-small" data-action="delete"><i class="bi bi-trash"></i> Delete</button>
              <button class="btn btn-success btn-small hidden" data-action="save"><i class="bi bi-check2"></i> Save</button>
              <button class="btn btn-secondary btn-small hidden" data-action="cancel"><i class="bi bi-x"></i> Cancel</button>
            </div>
            <div class="edit-fields hidden" style="margin-top:12px;">
              <div class="form-grid">
                <div class="form-group">
                  <label>Day</label>
                  <select class="edit-day" required>
                    ${dayOptions.map((d) => `<option value="${d}" ${d === item.day ? "selected" : ""}>${d}</option>`).join("")}
                  </select>
                </div>
                <div class="form-group">
                  <label>Time Slot</label>
                  <input type="text" class="edit-time" value="${item.timeSlot}" placeholder="e.g., 8:00 AM - 10:00 AM" />
                </div>
                <div class="form-group">
                  <label>Faculty</label>
                  <select class="edit-faculty" required>
                    ${facultyOptions.map((f) => `<option value="${f}" ${f === item.faculty ? "selected" : ""}>${f}</option>`).join("")}
                  </select>
                </div>
                <div class="form-group">
                  <label>Department</label>
                  <input type="text" class="edit-department" value="${item.department}" placeholder="e.g., Computer Science" />
                </div>
              </div>
              <div class="form-grid-2">
                <div class="form-group">
                  <label>Level</label>
                  <select class="edit-level" required>
                    ${levelOptions.map((lvl) => `<option value="${lvl}" ${lvl === String(item.level) ? "selected" : ""}>${lvl} Level</option>`).join("")}
                  </select>
                </div>
                <div class="form-group">
                  <label>Venue</label>
                  <input type="text" class="edit-venue" value="${item.venue}" placeholder="e.g., LT 1" />
                </div>
              </div>
              <div class="form-grid-2">
                <div class="form-group">
                  <label>GPS Latitude</label>
                  <input type="number" step="any" class="edit-gps-lat" value="${Number(item.gpsLat).toFixed(6)}" placeholder="e.g., 6.5244" />
                </div>
                <div class="form-group">
                  <label>GPS Longitude</label>
                  <input type="number" step="any" class="edit-gps-lng" value="${Number(item.gpsLng).toFixed(6)}" placeholder="e.g., 3.3792" />
                </div>
              </div>
              <small class="form-help"><i class="bi bi-info-circle" style="color: lightgreen;"></i> Update all needed fields below. Ensure GPS is accurate before saving.</small>
            </div>
          </div>
        </div>
      `
    })
    .join("")

  // Attach handler once per render
  container.onclick = (e) => {
    const btn = e.target.closest("button[data-action]")
    if (!btn) return
    const card = btn.closest(".timetable-card")
    if (!card) return
    const action = btn.getAttribute("data-action")
    const idx = indexOfTimetableCard(card)
    if (idx === -1) return
    if (action === "edit") return enterEditMode(card)
    if (action === "cancel") return exitEditMode(card)
    if (action === "save") return saveEdit(card, idx)
  if (action === "delete") return deleteTimetableEntry(idx)
  }
}

// Finds the index of a timetable card by stable id or by visible course/day/time fallback
function indexOfTimetableCard(card) {
  // Prefer stable ID matching
  const dataId = card.getAttribute("data-id")
  if (dataId) {
    const byId = timetableData.findIndex((it) => String(it.id) === String(dataId))
    if (byId !== -1) return byId
  }
  // Fallback: exact text match on course code + day + time (avoid splitting)
  const titleEl = card.querySelector(".course-title")
  // Extract course code text before the space + opening parenthesis that precedes venue
  let courseCode = ""
  if (titleEl) {
    courseCode = (titleEl.childNodes[0]?.textContent || titleEl.textContent || "").trim()
    // In case venue is directly concatenated, remove trailing " ("
    const p = courseCode.indexOf(" (")
    if (p > -1) courseCode = courseCode.slice(0, p).trim()
  }
  const viewDay = card.querySelector(".view-day")?.textContent?.trim()
  const viewTime = card.querySelector(".view-time")?.textContent?.trim()
  return timetableData.findIndex((it) => String(it.courseCode).trim() === courseCode && it.day === viewDay && it.timeSlot === viewTime)
}

// Toggles a card into inline edit mode
function enterEditMode(card) {
  card.querySelector('[data-action="edit"]').classList.add("hidden")
  const delBtn = card.querySelector('[data-action="delete"]')
  if (delBtn) delBtn.classList.add("hidden")
  card.querySelector('[data-action="save"]').classList.remove("hidden")
  card.querySelector('[data-action="cancel"]').classList.remove("hidden")
  card.querySelector(".edit-fields").classList.remove("hidden")
}

// Exits inline edit mode without saving
function exitEditMode(card) {
  card.querySelector('[data-action="edit"]').classList.remove("hidden")
  const delBtn = card.querySelector('[data-action="delete"]')
  if (delBtn) delBtn.classList.remove("hidden")
  card.querySelector('[data-action="save"]').classList.add("hidden")
  card.querySelector('[data-action="cancel"]').classList.add("hidden")
  card.querySelector(".edit-fields").classList.add("hidden")
}

// Validates and saves inline edits (enforces rep scope), persists, syncs, and refreshes
function saveEdit(card, idx) {
  const daySel = card.querySelector(".edit-day")
  const timeInput = card.querySelector(".edit-time")
  const facultySel = card.querySelector(".edit-faculty")
  const deptInput = card.querySelector(".edit-department")
  const levelSel = card.querySelector(".edit-level")
  const venueInput = card.querySelector(".edit-venue")
  const gpsLatInput = card.querySelector(".edit-gps-lat")
  const gpsLngInput = card.querySelector(".edit-gps-lng")
  const newDay = daySel.value
  const newTime = timeInput.value.trim()
  const newFaculty = facultySel?.value?.trim()
  const newDepartment = deptInput?.value?.trim()
  const newLevel = levelSel?.value?.trim()
  const newVenue = venueInput?.value?.trim()
  const newLat = parseFloat(gpsLatInput?.value)
  const newLng = parseFloat(gpsLngInput?.value)
  if (!newDay || !newTime || !newFaculty || !newDepartment || !newLevel || !newVenue || isNaN(newLat) || isNaN(newLng)) {
    showAlert("Please complete all fields, including valid GPS coordinates.")
    return
  }

  // Enforce Rep Scope on edit
  if (!repScope || !matchRepScope({ faculty: newFaculty, department: newDepartment, level: String(newLevel) })) {
    showAlert("Edit blocked: You can only edit entries within your faculty, department, and level.")
    return
  }

  // Optional: validate time format like "8:00 AM - 10:00 AM"
  const timeRe = /^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*-\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$/i
  if (!timeRe.test(newTime)) {
    showAlert("Time Slot must look like: 8:00 AM - 10:00 AM")
    return
  }

  // Update in memory and persist
  timetableData[idx].day = newDay
  timetableData[idx].timeSlot = newTime
  timetableData[idx].faculty = repScope.faculty
  timetableData[idx].department = repScope.department
  timetableData[idx].level = String(repScope.level)
  timetableData[idx].venue = newVenue
  timetableData[idx].gpsLat = newLat
  timetableData[idx].gpsLng = newLng
  localStorage.setItem("timetableData", JSON.stringify(timetableData))

  syncTimetableToCloud()

  // Refresh UIs
  loadTimetableOptions()
  displayTimetable()
  renderRepTimetableList()
}

// Ensure all timetable entries have an 'id' field for stable operations
// Migrates legacy entries to have stable ids, persists, then syncs
function ensureTimetableIds() {
  let changed = false
  for (const it of timetableData) {
    if (!it.id) {
      it.id = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`
      changed = true
    }
  }
  if (changed) {
    try {
      localStorage.setItem("timetableData", JSON.stringify(timetableData))
  syncTimetableToCloud()
    } catch (e) {
      console.warn("Failed to persist migrated IDs", e)
    }
  }
}

// Confirms and deletes a timetable entry (enforces rep scope), persists, syncs, refreshes
function deleteTimetableEntry(idx) {
  try {
    const item = timetableData[idx]
    if (!item) return
    // Enforce Rep Scope on delete as well
    if (!repScope || !matchRepScope(item)) {
      showAlert("Delete blocked: You can only delete entries within your faculty, department, and level.")
      return
    }
    const ok = window.confirm(`Delete ${item.courseCode} on ${item.day} at ${item.timeSlot}? This cannot be undone.`)
    if (!ok) return

    // Remove and persist
    timetableData.splice(idx, 1)
    localStorage.setItem("timetableData", JSON.stringify(timetableData))

  syncTimetableToCloud()

    // Refresh UIs
    loadTimetableOptions()
    displayTimetable()
    renderRepTimetableList()
    showAlert("Timetable entry deleted.")
  } catch (e) {
    console.error("Delete failed", e)
    showAlert("Could not delete the timetable entry. Please try again.")
  }
}

// Clear all timetable entries both locally and in Firebase
// Global destructive clear of timetable (local + cloud) with confirmation and UI refresh
function clearAllTimetables() {
  try {
    // Only show to authenticated reps via UI, but protect anyway
    const confirmed = window.confirm(
      "This will remove ALL timetable entries for everyone (local + Firebase). Do you want to continue?",
    )
    if (!confirmed) return

    // Clear local copy
    timetableData.splice(0, timetableData.length)
    localStorage.setItem("timetableData", JSON.stringify(timetableData))

    // Sync to cloud (writes empty array)
    try {
      if (typeof syncTimetableToCloud === "function") {
        syncTimetableToCloud()
      } else if (db) {
        db.collection("attendanceApp").doc("timetable").set({ items: [] }).catch(() => {})
      }
    } catch (_) {}

    // Refresh UI
    loadTimetableOptions()
    displayTimetable()
    renderRepTimetableList()
    showAlert("All timetables cleared.")
  } catch (e) {
    console.error("Failed to clear timetables", e)
    showAlert("Failed to clear timetables. Please try again.")
  }
}

// Reads the create-timetable form fields and normalizes types
function getTimetableFormData() {
  return {
    faculty: document.getElementById("faculty").value,
    department: document.getElementById("department").value,
    level: document.getElementById("level").value,
    day: document.getElementById("day").value,
    timeSlot: document.getElementById("time-slot").value,
    courseCode: document.getElementById("course-code").value,
    venue: document.getElementById("venue").value,
    gpsLat: Number.parseFloat(document.getElementById("gps-lat").value),
    gpsLng: Number.parseFloat(document.getElementById("gps-lng").value),
  }
}

// Validates required fields, allowed day, time format, and numeric GPS
function validateTimetableData(data) {
  for (const key in data) {
    if (data[key] === "" || (typeof data[key] === "number" && isNaN(data[key]))) {
      return {
        isValid: false,
        message: `Please fill in the ${key.replace(/([A-Z])/g, " $1").toLowerCase()} field.`,
      }
    }
  }
  // Validate day field is from allowed list
  const validDays = ["Monday","Tuesday","Wednesday","Thursday","Friday"]
  if (!validDays.includes(String(data.day))) {
    return { isValid: false, message: "Please select a valid day." }
  }
  // Validate time slot format unless any format is allowed via config
  const _appCfg = (typeof window !== 'undefined' && window.appConfig) ? window.appConfig : {}
  const allowAnyFmt = !!_appCfg.allowAnyTimeSlotFormat
  if (!allowAnyFmt) {
    const timeRe = /^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*-\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$/i
    if (!timeRe.test(String(data.timeSlot || ""))) {
      return { isValid: false, message: "Time Slot must look like: 8:00 AM - 10:00 AM" }
    }
  }
  // Validate GPS coordinates
  if (!Number.isFinite(data.gpsLat) || !Number.isFinite(data.gpsLng)) {
    return { isValid: false, message: "Please provide valid GPS coordinates." }
  }
  return { isValid: true }
}

// Generates the daily summary for selected date (and optional course), updates buttons and scrolls into view
function generateSummary() {
  const selectedDate = document.getElementById("summary-date").value
  if (!selectedDate) {
    showAlert("Please select a date.")
    return
  }

  const summaryDiv = document.getElementById("attendance-summary")
  const dateObj = new Date(selectedDate)
  const dateString = dateObj.toDateString()
  const courseSel = document.getElementById("summary-course")
  const selectedCourse = courseSel ? courseSel.value.trim() : ""

  let dayAttendance = attendanceData.filter((record) => new Date(record.timestamp).toDateString() === dateString)
  if (selectedCourse) {
    dayAttendance = dayAttendance.filter((r) => String(r.courseCode) === selectedCourse)
  }

  if (dayAttendance.length === 0) {
    summaryDiv.innerHTML = '<div class="alert alert-warning">No attendance was recorded for the course.</div>'
    const dl = document.getElementById("download-summary-btn")
    const pr = document.getElementById("print-summary-btn")
    if (dl) dl.disabled = true
    if (pr) pr.disabled = true
    return
  }

  const summaryHTML = generateSummaryHTML(dayAttendance, dateObj, selectedCourse)
  summaryDiv.innerHTML = summaryHTML
  const dl = document.getElementById("download-summary-btn")
  const pr = document.getElementById("print-summary-btn")
  if (dl) dl.disabled = false
  if (pr) pr.disabled = false
  summaryDiv.scrollIntoView({ behavior: "smooth", block: "start" })
}

// Groups attendance by course and returns printable HTML (with optional course label)
function generateSummaryHTML(dayAttendance, dateObj, selectedCourse) {
  // Group by course
  const groupedByCourse = dayAttendance.reduce((acc, record) => {
    if (!acc[record.courseCode]) {
      acc[record.courseCode] = []
    }
    acc[record.courseCode].push(record)
    return acc
  }, {})

  const courseLabel = selectedCourse ? ` - ${escapeHtml(String(selectedCourse))}` : ''
  let summaryHTML = `
        <div class="print-only">
            <h2>Daily Attendance Summary - ${dateObj.toLocaleDateString()}${courseLabel}</h2>
            <p>Generated on: ${new Date().toLocaleString()}</p>
        </div>
        <div class="attendance-list">
    `

  Object.keys(groupedByCourse).forEach((courseCode) => {
    const courseAttendance = groupedByCourse[courseCode]
  summaryHTML += `
      <div class="attendance-item" style="background: #f8fffe; font-weight: bold; border-left: 4px solid #4CAF50;">
    <div><i class=\"bi bi-book\" style=\"color: lightgreen;\"></i> ${escapeHtml(String(courseCode))} - ${courseAttendance.length} students</div>
      </div>
    `

    courseAttendance.forEach((record) => {
  const distanceText = Number.isFinite(record.distance) ? `${record.distance}m` : "N/A"
      summaryHTML += `
                <div class="attendance-item">
                    <div class="student-info">
            <div class="student-name">${escapeHtml(String(record.studentName))}</div>
                        <div class="student-details">
              ${escapeHtml(String(record.matriculation))} | ${escapeHtml(String(record.department))} | ${escapeHtml(String(record.level))} Level
      <br><i class=\"bi bi-geo-alt\" style=\"color: lightgreen;\"></i> Venue: ${escapeHtml(String(record.venue))} | <i class=\"bi bi-arrow-left-right\" style=\"color: lightgreen;\"></i> Distance: ${distanceText}
                        </div>
                    </div>
                    <div class="timestamp">${new Date(record.timestamp).toLocaleTimeString()}</div>
                </div>
            `
    })
  })

  summaryHTML += "</div>"
  return summaryHTML
}

// Downloads the current summary as a standalone HTML file (course/date in filename)
function downloadSummary() {
  const summaryDiv = document.getElementById("attendance-summary")
  if (!summaryDiv.innerHTML.trim()) {
  showAlert("No attendance was recorded for the course.")
    return
  }

  const selectedDate = document.getElementById("summary-date").value
  const selectedCourse = (document.getElementById("summary-course")?.value || '').trim()
  const content = summaryDiv.innerHTML

  const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Attendance Summary - ${selectedDate}${selectedCourse ? ` - ${selectedCourse}` : ''}</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 20px; line-height: 1.6; }
                .attendance-list { border: 1px solid #ccc; border-radius: 8px; }
                .attendance-item { padding: 15px; border-bottom: 1px solid #eee; }
                .attendance-item:last-child { border-bottom: none; }
                .student-name { font-weight: bold; color: #333; }
                .student-details { color: #666; margin-top: 5px; font-size: 0.9rem; }
                .timestamp { float: right; color: #999; font-size: 0.8rem; }
                h2 { color: #2196F3; border-bottom: 2px solid #4CAF50; padding-bottom: 10px; }
            </style>
        </head>
        <body>
            ${content}
        </body>
        </html>
    `

  const blob = new Blob([htmlContent], { type: "text/html" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `attendance-summary-${selectedDate}${selectedCourse ? '-' + selectedCourse.replace(/\s+/g, '_') : ''}.html`
  a.click()
  URL.revokeObjectURL(url)
}

// Prints the current page using print styles; guards when summary is empty
function printSummary() {
  const summaryDiv = document.getElementById("attendance-summary")
  if (!summaryDiv.innerHTML.trim()) {
  showAlert("No attendance was recorded for the course.")
    return
  }

  window.print()
}

// Timetable display functions
// Renders the weekly timetable (read-only) or a no-data message; keeps manage list in sync
function displayTimetable() {
  const displayDiv = document.getElementById("timetable-display")

  if (timetableData.length === 0) {
    displayDiv.innerHTML =
      '<div class="alert alert-warning">No timetable entries found. Course representatives can add entries in the Course Rep Access section.</div>'
    return
  }

  const timetableHTML = generateTimetableHTML()
  displayDiv.innerHTML = timetableHTML
  // Keep rep manage list in sync when visible
  renderRepTimetableList()
}

// Builds grouped-by-day timetable cards including GPS coordinates
function generateTimetableHTML() {
  // Group by day
  const groupedByDay = timetableData.reduce((acc, item) => {
    if (!acc[item.day]) {
      acc[item.day] = []
    }
    acc[item.day].push(item)
    return acc
  }, {})

  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
  let timetableHTML = ""

  days.forEach((day) => {
    if (groupedByDay[day]) {
      timetableHTML += `
        <div class="timetable-card">
          <div class="timetable-header">${day}</div>
      `

      groupedByDay[day]
        .sort((a, b) => a.timeSlot.localeCompare(b.timeSlot))
        .forEach((item) => {
          timetableHTML += `
            <div class="timetable-entry">
              <div class="course-title">${escapeHtml(String(item.courseCode))}</div>
              <div class="course-details">
                <i class="bi bi-clock" style="color: lightgreen;"></i> ${escapeHtml(String(item.timeSlot))}<br>
                <i class="bi bi-geo-alt" style="color: lightgreen;"></i> ${escapeHtml(String(item.venue))}<br>
                <i class="bi bi-buildings" style="color: lightgreen;"></i> ${escapeHtml(String(item.faculty))} - ${escapeHtml(String(item.department))}<br>
                <i class="bi bi-mortarboard" style="color: lightgreen;"></i> ${escapeHtml(String(item.level))} Level
                <div class="gps-coordinates">
                  <strong><i class="bi bi-geo"></i> GPS Location:</strong><br>
                  Lat: ${Number(item.gpsLat).toFixed(6)}, Lng: ${Number(item.gpsLng).toFixed(6)}
                </div>
              </div>
            </div>
          `
        })

      timetableHTML += "</div>"
    }
  })

  return timetableHTML
}

// Filters timetable by faculty/department/level; shows counts and temporarily renders subset
function filterTimetable() {
  const faculty = document.getElementById("filter-faculty").value
  const department = document.getElementById("filter-department").value.toLowerCase().trim()
  const level = document.getElementById("filter-level").value
  const resultsDiv = document.getElementById("filter-results")

  let filteredData = timetableData

  if (faculty) {
    filteredData = filteredData.filter((item) => item.faculty === faculty)
  }

  if (department) {
    filteredData = filteredData.filter((item) => item.department.toLowerCase().includes(department))
  }

  if (level) {
    filteredData = filteredData.filter((item) => item.level === level)
  }

  // Show filter results
  const totalEntries = timetableData.length
  const filteredEntries = filteredData.length

  if (faculty || department || level) {
  resultsDiv.innerHTML = `<i class="bi bi-bar-chart-line"></i> Showing ${filteredEntries} of ${totalEntries} timetable entries`
    resultsDiv.style.display = "block"
  } else {
    resultsDiv.style.display = "none"
  }

  // Temporarily replace timetableData for display
  const originalData = timetableData
  timetableData = filteredData
  displayTimetable()
  timetableData = originalData
}

// Clears filters and shows the full timetable again
function clearFilters() {
  document.getElementById("filter-faculty").value = ""
  document.getElementById("filter-department").value = ""
  document.getElementById("filter-level").value = ""
  document.getElementById("filter-results").style.display = "none"
  displayTimetable()
}

// Utility functions
// Renders a dismissible alert into a container and auto-clears after a few seconds
function showMessage(container, message, type) {
  if (!container) return

  container.innerHTML = `<div class="alert alert-${escapeHtml(String(type))}">${message}</div>`

  // Scroll message into view
  container.scrollIntoView({ behavior: "smooth", block: "nearest" })

  // Auto-remove message after 5 seconds
  setTimeout(() => {
    if (container.innerHTML.includes(message)) {
      container.innerHTML = ""
    }
  }, 5000)
}

// Simple wrapper for blocking alert dialog
function showAlert(message) {
  alert(message)
}

// Clears loading state and re-enables a button
function resetSubmitButton(button) {
  button.classList.remove("loading")
  button.disabled = false
}

// ---------- Rep Scope helpers ----------
// Derives the localStorage key used to store a rep's scope
function getRepScopeKey(email) {
  return `repScope:${email}`
}

// Loads rep scope for the current session email (if any); returns null when absent
function loadRepScope() {
  try {
    if (!currentRepEmail) {
      const cached = JSON.parse(localStorage.getItem("repSession") || "null")
      currentRepEmail = cached?.email || null
    }
    if (!currentRepEmail) {
      repScope = null
      return null
    }
    const raw = localStorage.getItem(getRepScopeKey(currentRepEmail))
    repScope = raw ? JSON.parse(raw) : null
    return repScope
  } catch {
    repScope = null
    return null
  }
}

// Validates and saves the rep scope, applies UI locks, rerenders lists
function handleSaveRepScope() {
  const fac = document.getElementById("rep-faculty")?.value
  const dep = document.getElementById("rep-department")?.value?.trim()
  const lvl = document.getElementById("rep-level")?.value
  if (!currentRepEmail) {
    showAlert("Please verify access first.")
    return
  }
  if (!fac || !dep || !lvl) {
    showAlert("Please complete your Rep Scope (faculty, department, level).")
    return
  }
  repScope = { faculty: fac, department: dep, level: String(lvl) }
  localStorage.setItem(getRepScopeKey(currentRepEmail), JSON.stringify(repScope))
  applyRepScopeUI()
  renderRepTimetableList()
  showAlert("Rep Scope saved.")
}

// Applies the saved scope to prefill/lock forms and shows a descriptive hint
function applyRepScopeUI() {
  // Prefill Rep Scope form
  const facSel = document.getElementById("rep-faculty")
  const depInp = document.getElementById("rep-department")
  const lvlSel = document.getElementById("rep-level")
  if (repScope) {
    if (facSel) facSel.value = repScope.faculty
    if (depInp) depInp.value = repScope.department
    if (lvlSel) lvlSel.value = String(repScope.level)
  }

  // Lock Create Timetable form to scope
  const fac = document.getElementById("faculty")
  const dep = document.getElementById("department")
  const lvl = document.getElementById("level")
  if (repScope && fac && dep && lvl) {
    fac.value = repScope.faculty
    dep.value = repScope.department
    lvl.value = String(repScope.level)
    fac.disabled = true
    dep.readOnly = true
    lvl.disabled = true
    const hint = document.getElementById("rep-scope-hint")
    if (hint) hint.textContent = `Your scope is set to ${repScope.faculty} / ${repScope.department} / ${repScope.level} Level.`
  } else {
    if (fac) fac.disabled = false
    if (dep) dep.readOnly = false
    if (lvl) lvl.disabled = false
  }
}

// Returns true when a timetable item matches the current rep's faculty/department/level
function matchRepScope(item) {
  if (!repScope) return true
  const sameFaculty = String(item.faculty) === String(repScope.faculty)
  const sameLevel = String(item.level) === String(repScope.level)
  const sameDept = String(item.department || "").trim().toLowerCase() === String(repScope.department || "").trim().toLowerCase()
  return sameFaculty && sameDept && sameLevel
}

// Auto-refresh location every 5 minutes
setInterval(getCurrentLocation, 300000)

// Prevent form submission on Enter key for better UX
// Prevents accidental Enter submissions in inputs (except textareas/submit buttons)
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.type !== "submit") {
    // Only prevent if not in a form or if it's an input that shouldn't submit
    const form = e.target.closest("form")
    if (form && e.target.type !== "submit") {
      e.preventDefault()
    }
  }
})

// Basic HTML escape to protect dynamic content
// Escapes special characters to prevent HTML injection in dynamic strings
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Normalizes the repPins map so email keys are lowercase and values are trimmed strings
// Input: an object mapping email -> pin (string/number). Output: clean object with lowercase emails and string PINs.
function normalizeRepPins(pins) {
  try {
    const out = {}
    if (!pins || typeof pins !== 'object') return out
    for (const key of Object.keys(pins)) {
      const email = String(key || '').trim().toLowerCase()
      if (!email) continue
      const raw = pins[key]
      // Only accept primitive string/number pins; ignore nested objects/arrays/null
      if (raw === undefined || raw === null) continue
      const type = typeof raw
      if (type === 'string' || type === 'number' || type === 'boolean') {
        const pin = String(raw).trim()
        if (pin) out[email] = pin
      }
    }
    return out
  } catch (_) {
    return {}
  }
}
