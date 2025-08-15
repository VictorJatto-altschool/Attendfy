// Global variables
let currentLocation = null
let timetableData = JSON.parse(localStorage.getItem("timetableData")) || []
const attendanceData = JSON.parse(localStorage.getItem("attendanceData")) || []
let db = null
// Anti-cheat: bind this device to a single student for today
let studentProfile = null
const authorizedReps = ["jattovictor32@gmail.com", "courserep@university.edu"]
// Simple 2FA: email -> PIN mapping (loaded from local storage or Firestore; no defaults in code)
let repPins = JSON.parse(localStorage.getItem("repPins") || "{}")
let gpsFailureCount = 0
// Rep session & scope
let currentRepEmail = null
let repScope = null

// Initialize the application
document.addEventListener("DOMContentLoaded", () => {
  initializeApp()
  initPreloaderLifecycle()
})

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

    // Add form event listeners
    setupEventListeners()

  console.log("  <i class=\"bi bi-patch-check-fill\"></i> Attendance system initialized successfully")
  // Mark app as ready for preloader; lifecycle will hide after minimum display time
  window.__appReady = true
  } catch (error) {
    console.error("<i class=\"bi bi-x-octagon-fill\"></i> Error initializing app:", error)
    showAlert("There was an error initializing the application. Please refresh the page.")
  }
}

// ---------- Preloader lifecycle ----------
function initPreloaderLifecycle() {
  const preload = document.getElementById("preloader")
  if (!preload) return

  // Update subtext subtly while loading
  const sub = preload.querySelector(".preloader-sub")
  const start = performance.now()
  const MIN_DISPLAY_MS = 25000 // keep preloader visible at least 25s
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

  // Safety timeout: hide after 25s even if not fully ready
  setTimeout(() => {
    if (!window.__appReady) {
      if (sub) sub.textContent = "You can start now. Some features may finish loading in the background."
    }
    safeHidePreloader()
    clearInterval(tipTimer)
    clearInterval(readyTimer)
  }, 25000)
}

function safeHidePreloader() {
  const preload = document.getElementById("preloader")
  if (!preload) return
  preload.classList.add("hidden")
  // fully remove from DOM after transition for accessibility
  setTimeout(() => preload.parentNode && preload.parentNode.removeChild(preload), 450)
}

// ---------- Student profile lock (anti-cheat) ----------
function todayKey() {
  const d = new Date()
  return d.toISOString().slice(0, 10)
}

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

function saveStudentProfile(matriculation, studentName) {
  studentProfile = { matriculation, studentName, date: todayKey() }
  localStorage.setItem("studentProfile", JSON.stringify(studentProfile))
  applyStudentProfileLockUI()
}

function clearStudentProfile() {
  localStorage.removeItem("studentProfile")
  studentProfile = null
  applyStudentProfileLockUI()
}

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
async function initCloud() {
  try {
    const cfg = window.firebaseConfig || { enabled: false }
    if (!cfg.enabled) return
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
          repPins = { ...repPins, ...pins }
          localStorage.setItem("repPins", JSON.stringify(repPins))
        }
      }
    } catch (_) {}
  } catch (e) {
    console.warn("Cloud load failed; using local data", e)
  }
}

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
        repPins = { ...repPins, ...remote }
        localStorage.setItem("repPins", JSON.stringify(repPins))
      }
    })
  } catch (e) {
    console.warn("Cloud subscribe failed", e)
  }
}

// Centralized cloud write helpers
function syncTimetableToCloud() {
  if (!db) return
  try {
    db.collection("attendanceApp").doc("timetable").set({ items: timetableData }).catch(() => {})
  } catch (_) {}
}

function syncAttendanceToCloud() {
  if (!db) return
  try {
    db.collection("attendanceApp").doc("attendance").set({ items: attendanceData }).catch(() => {})
  } catch (_) {}
}

// Network status handling for polished UX and manual fallback
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
}

// Navigation functions
function showSection(sectionId) {
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
    document.getElementById(sectionId).classList.add("active")
  }, 100)

  // Add active class to clicked button
  event.target.classList.add("active")
}

// GPS Location functions
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
function retryGetLocation() {
  const statusDiv = document.getElementById("gps-status")
  const attempt = Math.min(gpsFailureCount + 1, 4)
  const backoffMs = 500 * Math.pow(2, attempt - 1)
  updateGPSStatus(statusDiv, `Retrying location in ${Math.round(backoffMs / 1000)}s...`, "loading")
  setTimeout(() => {
    getCurrentLocation()
  }, backoffMs)
}

function showLocationDetails(locationDetails) {
  if (!currentLocation || !locationDetails) return

  document.getElementById("current-lat").textContent = currentLocation.latitude.toFixed(6)
  document.getElementById("current-lng").textContent = currentLocation.longitude.toFixed(6)
  document.getElementById("current-accuracy").textContent = `±${Math.round(currentLocation.accuracy)}m`

  locationDetails.classList.remove("hidden")
}

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
      const withinWindow = isWithinTimeSlot(courseInfo.timeSlot, courseInfo.day)
      const dayText = courseInfo.day || ""
      courseWindowInfo.innerHTML = withinWindow
        ? `<i class="bi bi-clock" style="color: lightgreen;"></i> Attendance open: ${dayText} ${courseInfo.timeSlot}`
        : `<i class="bi bi-hourglass-split" style="color: #ef6c00;"></i> Attendance closed now: ${dayText} ${courseInfo.timeSlot}`
      courseWindowInfo.style.color = withinWindow ? "#4caf50" : "#ef6c00"
    }

    // Smart enable/disable
    if (submitBtn) {
      const canCheckIn = navigator.onLine && currentLocation && distance <= 100 && isWithinTimeSlot(courseInfo.timeSlot, courseInfo.day)
      submitBtn.disabled = !canCheckIn
    }
  })
}

// Calculate distance between two GPS coordinates
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
function loadTimetableOptions() {
  const courseSelect = document.getElementById("course-select")
  if (!courseSelect) return

  courseSelect.innerHTML = '<option value="">Choose a course...</option>'

  const uniqueCourses = [...new Set(timetableData.map((item) => item.courseCode))]
  uniqueCourses.forEach((course) => {
    const option = document.createElement("option")
    option.value = course
    option.textContent = course
    courseSelect.appendChild(option)
  })
}

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

function getCheckinFormData() {
  return {
    studentName: document.getElementById("student-name").value.trim(),
    matriculation: document.getElementById("matriculation").value.trim(),
    courseCode: document.getElementById("course-select").value,
  }
}

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

function processAttendance(formData) {
  // Find course in timetable
  const courseInfo = timetableData.find((item) => item.courseCode === formData.courseCode)
  if (!courseInfo) {
    return { message: "Course not found in timetable.", type: "error" }
  }

  // Enforce attendance within time slot and day
  const withinWindow = isWithinTimeSlot(courseInfo.timeSlot, courseInfo.day)
  if (!withinWindow) {
    return { message: "Attendance closed for this course.", type: "error" }
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

  return {
    message: `<i class="bi bi-patch-check-fill" style="color: lightgreen;"></i> Attendance marked successfully! Distance from venue: ${Math.round(distance)}m`,
    type: "success",
  }
}

// Time slot helper: supports formats like "8:00 AM - 10:00 AM"
function isWithinTimeSlot(timeSlot, day) {
  try {
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

function parseTimeToday(label) {
  if (!label) return null
  const now = new Date()
  const m = label.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (!m) return null
  let [_, hh, mm, ap] = m
  let h = parseInt(hh, 10)
  const minutes = parseInt(mm, 10)
  ap = ap.toUpperCase()
  if (ap === "PM" && h !== 12) h += 12
  if (ap === "AM" && h === 12) h = 0
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, minutes, 0, 0)
}

// Manual attendance fallback (offline / GPS issues)
function handleManualAttendance() {
  // Always show a popup regardless of form state
  showAlert("Go and write manully in class")

  const messageDiv = document.getElementById("checkin-message")
  const studentName = document.getElementById("student-name").value.trim()
  const matriculation = document.getElementById("matriculation").value.trim()
  const courseCode = document.getElementById("course-select").value

  // Polished UX: if offline, inform the student clearly
  if (!navigator.onLine && messageDiv) {
    messageDiv.innerHTML = '<div class="alert alert-warning"><i class="bi bi-wifi-off" style="color:#ef6c00;"></i> You are offline. Go and write manual attendance. This entry will be saved as manual-offline.</div>'
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

function isDuplicateAttendance(matriculation, courseCode) {
  const today = new Date().toDateString()
  return attendanceData.some(
    (record) =>
      record.matriculation === matriculation &&
      record.courseCode === courseCode &&
      new Date(record.timestamp).toDateString() === today,
  )
}

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
function verifyRepAccess() {
  const email = document.getElementById("rep-email").value.trim().toLowerCase()
  const pin = document.getElementById("rep-pin")?.value?.trim()
  const dashboard = document.getElementById("rep-dashboard")

  if (!email) {
    showAlert("Please enter your email address.")
    return
  }

  // Simple email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email)) {
    showAlert("Please enter a valid email address.")
    return
  }

  if (authorizedReps.includes(email)) {
    // Require PIN
    const expectedPin = repPins[email]
    if (!expectedPin) {
      showAlert("PIN not set for this email. Contact admin.")
      return
    }
    if (!pin || pin !== expectedPin) {
      showAlert("Invalid PIN.")
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

function enterEditMode(card) {
  card.querySelector('[data-action="edit"]').classList.add("hidden")
  const delBtn = card.querySelector('[data-action="delete"]')
  if (delBtn) delBtn.classList.add("hidden")
  card.querySelector('[data-action="save"]').classList.remove("hidden")
  card.querySelector('[data-action="cancel"]').classList.remove("hidden")
  card.querySelector(".edit-fields").classList.remove("hidden")
}

function exitEditMode(card) {
  card.querySelector('[data-action="edit"]').classList.remove("hidden")
  const delBtn = card.querySelector('[data-action="delete"]')
  if (delBtn) delBtn.classList.remove("hidden")
  card.querySelector('[data-action="save"]').classList.add("hidden")
  card.querySelector('[data-action="cancel"]').classList.add("hidden")
  card.querySelector(".edit-fields").classList.add("hidden")
}

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

function validateTimetableData(data) {
  for (const key in data) {
    if (data[key] === "" || (typeof data[key] === "number" && isNaN(data[key]))) {
      return {
        isValid: false,
        message: `Please fill in the ${key.replace(/([A-Z])/g, " $1").toLowerCase()} field.`,
      }
    }
  }
  return { isValid: true }
}

function generateSummary() {
  const selectedDate = document.getElementById("summary-date").value
  if (!selectedDate) {
    showAlert("Please select a date.")
    return
  }

  const summaryDiv = document.getElementById("attendance-summary")
  const dateObj = new Date(selectedDate)
  const dateString = dateObj.toDateString()

  const dayAttendance = attendanceData.filter((record) => new Date(record.timestamp).toDateString() === dateString)

  if (dayAttendance.length === 0) {
    summaryDiv.innerHTML = '<div class="alert alert-warning">No attendance records found for the selected date.</div>'
    return
  }

  const summaryHTML = generateSummaryHTML(dayAttendance, dateObj)
  summaryDiv.innerHTML = summaryHTML
}

function generateSummaryHTML(dayAttendance, dateObj) {
  // Group by course
  const groupedByCourse = dayAttendance.reduce((acc, record) => {
    if (!acc[record.courseCode]) {
      acc[record.courseCode] = []
    }
    acc[record.courseCode].push(record)
    return acc
  }, {})

  let summaryHTML = `
        <div class="print-only">
            <h2>Daily Attendance Summary - ${dateObj.toLocaleDateString()}</h2>
            <p>Generated on: ${new Date().toLocaleString()}</p>
        </div>
        <div class="attendance-list">
    `

  Object.keys(groupedByCourse).forEach((courseCode) => {
    const courseAttendance = groupedByCourse[courseCode]
  summaryHTML += `
      <div class="attendance-item" style="background: #f8fffe; font-weight: bold; border-left: 4px solid #4CAF50;">
        <div><i class=\"bi bi-book\" style=\"color: lightgreen;\"></i> ${courseCode} - ${courseAttendance.length} students</div>
      </div>
    `

    courseAttendance.forEach((record) => {
  const distanceText = Number.isFinite(record.distance) ? `${record.distance}m` : "N/A"
      summaryHTML += `
                <div class="attendance-item">
                    <div class="student-info">
                        <div class="student-name">${record.studentName}</div>
                        <div class="student-details">
                            ${record.matriculation} | ${record.department} | ${record.level} Level
            <br><i class=\"bi bi-geo-alt\" style=\"color: lightgreen;\"></i> Venue: ${record.venue} | <i class=\"bi bi-arrow-left-right\" style=\"color: lightgreen;\"></i> Distance: ${distanceText}
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

function downloadSummary() {
  const summaryDiv = document.getElementById("attendance-summary")
  if (!summaryDiv.innerHTML.trim()) {
    showAlert("Please generate a summary first.")
    return
  }

  const selectedDate = document.getElementById("summary-date").value
  const content = summaryDiv.innerHTML

  const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Attendance Summary - ${selectedDate}</title>
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
  a.download = `attendance-summary-${selectedDate}.html`
  a.click()
  URL.revokeObjectURL(url)
}

function printSummary() {
  const summaryDiv = document.getElementById("attendance-summary")
  if (!summaryDiv.innerHTML.trim()) {
    showAlert("Please generate a summary first.")
    return
  }

  window.print()
}

// Timetable display functions
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
              <div class="course-title">${item.courseCode}</div>
              <div class="course-details">
                <i class="bi bi-clock" style="color: lightgreen;"></i> ${item.timeSlot}<br>
                <i class="bi bi-geo-alt" style="color: lightgreen;"></i> ${item.venue}<br>
                <i class="bi bi-buildings" style="color: lightgreen;"></i> ${item.faculty} - ${item.department}<br>
                <i class="bi bi-mortarboard" style="color: lightgreen;"></i> ${item.level} Level
                <div class="gps-coordinates">
                  <strong><i class="bi bi-geo"></i> GPS Location:</strong><br>
                  Lat: ${item.gpsLat.toFixed(6)}, Lng: ${item.gpsLng.toFixed(6)}
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

function clearFilters() {
  document.getElementById("filter-faculty").value = ""
  document.getElementById("filter-department").value = ""
  document.getElementById("filter-level").value = ""
  document.getElementById("filter-results").style.display = "none"
  displayTimetable()
}

// Utility functions
function showMessage(container, message, type) {
  if (!container) return

  container.innerHTML = `<div class="alert alert-${type}">${message}</div>`

  // Scroll message into view
  container.scrollIntoView({ behavior: "smooth", block: "nearest" })

  // Auto-remove message after 5 seconds
  setTimeout(() => {
    if (container.innerHTML.includes(message)) {
      container.innerHTML = ""
    }
  }, 5000)
}

function showAlert(message) {
  alert(message)
}

function resetSubmitButton(button) {
  button.classList.remove("loading")
  button.disabled = false
}

// ---------- Rep Scope helpers ----------
function getRepScopeKey(email) {
  return `repScope:${email}`
}

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
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.type !== "submit") {
    // Only prevent if not in a form or if it's an input that shouldn't submit
    const form = e.target.closest("form")
    if (form && e.target.type !== "submit") {
      e.preventDefault()
    }
  }
})
