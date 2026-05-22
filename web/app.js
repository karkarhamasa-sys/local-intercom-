// Audio Playback Stream Mix Scheduler (Jitter Buffer Player)
class JitterBufferPlayer {
    constructor(audioCtx, sampleRate = 16000) {
        this.audioCtx = audioCtx;
        this.sampleRate = sampleRate;
        this.nextPlayTime = 0;
        this.bufferDelay = 0.08; // 80ms jitter absorption buffer
        this.gainNode = audioCtx.createGain();
        this.gainNode.connect(audioCtx.destination);
        this.volume = 1.0;
        this.lastFeedTime = 0;
    }
    
    setVolume(v) {
        this.volume = v;
        this.gainNode.gain.setValueAtTime(v, this.audioCtx.currentTime);
    }
    
    feed(pcm16Data) {
        if (this.audioCtx.state === 'suspended') {
            return;
        }
        
        // Convert Int16Array (-32768 to 32767) to Float32Array (-1.0 to 1.0)
        const samples = new Float32Array(pcm16Data.length);
        for (let i = 0; i < pcm16Data.length; i++) {
            samples[i] = pcm16Data[i] / 32768.0;
        }
        
        const audioBuf = this.audioCtx.createBuffer(1, samples.length, this.sampleRate);
        audioBuf.copyToChannel(samples, 0);
        
        const source = this.audioCtx.createBufferSource();
        source.buffer = audioBuf;
        source.connect(this.gainNode);
        
        const now = this.audioCtx.currentTime;
        
        // If there is a silence gap of more than 200ms, reset the play time pointer
        if (now - this.lastFeedTime > 0.2 || this.nextPlayTime < now) {
            this.nextPlayTime = now + this.bufferDelay;
        }
        
        source.start(this.nextPlayTime);
        this.nextPlayTime += audioBuf.duration;
        this.lastFeedTime = now;
    }
}

// Global App State
const state = {
    ws: null,
    audioCtx: null,
    localStream: null,
    micProcessor: null,
    micMuted: false,
    sessionPIN: "",
    userRole: "",
    userName: "",
    playbackQueues: new Map(), // ID -> JitterBufferPlayer
    wakeLock: null,
    isDirector: false,
    directorTargets: {
        all: true,
        roles: {},
        targets: {}
    },
    clientsList: [],
    pingInterval: null,
    reconnectTimeout: null,
    serverURL: "",
    lastSpeakerTimes: new Map() // ID -> timestamp
};

// UI Element References
const loginScreen = document.getElementById("login-screen");
const crewScreen = document.getElementById("crew-screen");
const directorScreen = document.getElementById("director-screen");
const loginForm = document.getElementById("login-form");
const usernameInput = document.getElementById("username");
const roleSelect = document.getElementById("user-role");
const pinInput = document.getElementById("session-pin");
const localhostAlert = document.getElementById("localhost-alert");
const loginError = document.getElementById("login-error");

// Mic pre-auth elements
const btnRequestMic = document.getElementById("btn-request-mic");
const micStatusCard = document.getElementById("mic-status-card");
const micStatusDesc = document.getElementById("mic-status-desc");
const micStatusBadge = document.getElementById("mic-status-badge");

// 1. INITIAL SETUP & QUERY STRINGS
window.addEventListener("DOMContentLoaded", () => {
    // Parse query parameters
    const params = new URLSearchParams(window.location.search);
    const pinParam = params.get("pin");
    if (pinParam) {
        pinInput.value = pinParam;
        pinInput.readOnly = true;
        pinInput.style.opacity = "0.7";
    }

    // Auto-detect host/localhost run
    const isLocalhost = (location.hostname === "localhost" || location.hostname === "127.0.0.1");
    if (isLocalhost) {
        // Enable Director option for localhost
        const dirOpt = document.getElementById("director-option");
        dirOpt.disabled = false;
        
        // Show localhost director portal shortcut
        localhostAlert.style.display = "flex";
    }

    // Setup event listeners
    loginForm.addEventListener("submit", handleFormSubmit);
    if (btnRequestMic) {
        btnRequestMic.addEventListener("click", triggerMicOnboardingRequest);
    }
    document.getElementById("btn-director-direct").addEventListener("click", enterAsDirectorDirectly);
    document.getElementById("btn-crew-disconnect").addEventListener("click", disconnectIntercom);
    document.getElementById("btn-mic-toggle").addEventListener("click", toggleMicMute);
    document.getElementById("volume-slider").addEventListener("input", handleVolumeSlider);

    // Director screen events
    document.getElementById("btn-regen-pin").addEventListener("click", regeneratePIN);
    document.getElementById("toggle-hear-each-other").addEventListener("change", toggleHearEachOther);
    document.getElementById("btn-director-mic").addEventListener("mousedown", startDirectorSpeaking);
    document.getElementById("btn-director-mic").addEventListener("mouseup", stopDirectorSpeaking);
    document.getElementById("btn-director-mic").addEventListener("mouseleave", stopDirectorSpeaking);
    
    // Mobile touch support for Director's speaking button (Push-to-Talk)
    document.getElementById("btn-director-mic").addEventListener("touchstart", (e) => {
        e.preventDefault();
        startDirectorSpeaking();
    });
    document.getElementById("btn-director-mic").addEventListener("touchend", (e) => {
        e.preventDefault();
        stopDirectorSpeaking();
    });

    // Preset routing buttons
    document.getElementById("route-all").addEventListener("click", () => setRoutingPreset("all"));
    document.getElementById("route-cameras").addEventListener("click", () => setRoutingPreset("Photographer"));
    document.getElementById("route-production").addEventListener("click", () => setRoutingPreset("Production"));
    document.getElementById("route-presenter").addEventListener("click", () => setRoutingPreset("Presenter"));

    // Check periodically for who is talking to clear the tags highlight
    setInterval(updateSpeakerHighlights, 100);
});

// Shortcut helper to enter immediately as Director on localhost
function enterAsDirectorDirectly() {
    state.userName = "المخرج الرئيسي";
    state.userRole = "Director";
    state.isDirector = true;
    
    initAudioContext().then(() => {
        setupLocalMicrophone();
    }).catch(err => {
        console.warn("[Onboarding] Direct Director mic error:", err);
    });
    
    startConnection();
}

// Microphone manual activation trigger from onboarding card
async function triggerMicOnboardingRequest() {
    try {
        await initAudioContext();
        await setupLocalMicrophone();
    } catch (err) {
        console.error("[Onboarding] Manual activation failed:", err);
    }
}

// Live helper to update microphone card styling
function updateMicStatusUI(status, desc, badgeText) {
    if (!micStatusCard) return;
    
    micStatusCard.className = `mic-status-card ${status}`;
    if (micStatusDesc) micStatusDesc.innerHTML = desc;
    if (micStatusBadge) micStatusBadge.textContent = badgeText;
    
    if (btnRequestMic) {
        if (status === "success") {
            btnRequestMic.textContent = "✅ الميكروفون نشط وجاهز";
            btnRequestMic.disabled = true;
        } else if (status === "error") {
            btnRequestMic.textContent = "🔄 أعد تفعيل الميكروفون";
            btnRequestMic.disabled = false;
        }
    }
}

// Login form submit handler (direct-gesture synchronous voice prep)
async function handleFormSubmit(e) {
    e.preventDefault();
    state.userName = usernameInput.value.trim();
    state.userRole = roleSelect.value;
    state.sessionPIN = pinInput.value.trim();
    state.isDirector = (state.userRole === "Director");

    if (!state.userName) return;
    
    const btnJoin = document.getElementById("btn-join");
    const originalText = btnJoin.textContent;
    btnJoin.disabled = true;
    btnJoin.textContent = "🎙️ جاري تفعيل الصوت والمايك...";
    
    try {
        // Direct call in submit loop is guaranteed to bypass async security sandbox
        await initAudioContext();
        await setupLocalMicrophone();
    } catch (err) {
        console.warn("[Onboarding] Submit micro-init bypass:", err);
    }

    btnJoin.textContent = "🔌 جاري الاتصال بالشبكة...";
    startConnection();
}

// 2. CONNECTION ESTABLISHMENT & LIFECYCLE
function startConnection() {
    loginError.classList.add("hidden");
    const btnJoin = document.getElementById("btn-join");
    if (btnJoin) btnJoin.disabled = true;

    // Build WebSocket address
    const protocol = (location.protocol === "https:") ? "wss:" : "ws:";
    const host = location.host;
    state.serverURL = `${protocol}//${host}/ws?name=${encodeURIComponent(state.userName)}&role=${state.userRole}&pin=${state.sessionPIN}`;

    console.log("[WS] Connecting to", state.serverURL);
    state.ws = new WebSocket(state.serverURL);
    state.ws.binaryType = "arraybuffer";

    state.ws.onopen = () => {
        console.log("[WS] Connected successfully!");
        
        // Hide Login UI
        loginScreen.classList.remove("active");
        
        // Activate Audio Context on user interaction to comply with browser safety rules
        initAudioContext().then(() => {
            if (state.isDirector) {
                directorScreen.classList.add("active");
                setupLocalMicrophone();
            } else {
                crewScreen.classList.add("active");
                setupLocalMicrophone();
                requestWakeLock();
            }
        });

        // Start signal ping-pong loop to track Wi-Fi latency
        startHeartbeatLoop();
    };

    state.ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
            handleBinaryAudioPacket(event.data);
        } else {
            handleJSONControlPacket(event.data);
        }
    };

    state.ws.onclose = (event) => {
        console.warn("[WS] Connection closed:", event.reason);
        cleanupSession();
        
        // Show login with error if disconnected unexpectedly
        loginScreen.classList.add("active");
        const btnJoin = document.getElementById("btn-join");
        if (btnJoin) btnJoin.disabled = false;
        
        if (event.code !== 1000) {
            loginError.textContent = "حدث انقطاع في الاتصال بالخادم. تأكد من اتصالك بالـ Wi-Fi.";
            loginError.classList.remove("hidden");
            
            // Automatic Reconnect loop for Phone clients (if we were connected previously)
            if (!state.isDirector && state.userName) {
                console.log("[WS] Attempting auto-reconnect in 2 seconds...");
                state.reconnectTimeout = setTimeout(startConnection, 2000);
            }
        }
    };

    state.ws.onerror = (err) => {
        console.error("[WS] Error:", err);
        loginError.textContent = "فشل الاتصال بالخادم. يرجى مراجعة عنوان الشبكة أو الرقم السري.";
        loginError.classList.remove("hidden");
        const btnJoin = document.getElementById("btn-join");
        if (btnJoin) btnJoin.disabled = false;
    };
}

// 3. WEB AUDIO API RECORDING & PLAYBACK
async function initAudioContext() {
    if (!state.audioCtx) {
        state.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 16000 // Voice-standard 16kHz
        });
    }
    if (state.audioCtx.state === 'suspended') {
        await state.audioCtx.resume();
    }
}

async function setupLocalMicrophone() {
    // Prevent double execution if already captured
    if (state.localStream && state.micProcessor) {
        console.log("[Audio] Microphone already active.");
        return;
    }

    try {
        state.localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });

        const source = state.audioCtx.createMediaStreamSource(state.localStream);
        
        // Create audio processor
        state.micProcessor = state.audioCtx.createScriptProcessor(2048, 1, 1);
        
        state.micProcessor.onaudioprocess = (e) => {
            if (state.micMuted || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
                return;
            }

            const floatSamples = e.inputBuffer.getChannelData(0);
            const pcm16Samples = new Int16Array(floatSamples.length);
            
            // Convert Float32 to Int16
            for (let i = 0; i < floatSamples.length; i++) {
                let s = floatSamples[i] * 32768.0;
                if (s > 32767) s = 32767;
                if (s < -32768) s = -32768;
                pcm16Samples[i] = s;
            }

            // Stream raw binary bytes to server
            state.ws.send(pcm16Samples.buffer);
        };

        source.connect(state.micProcessor);
        state.micProcessor.connect(state.audioCtx.destination);
        console.log("[Audio] Microphone captured and pipeline active.");
        
        // Update onboarding UI
        updateMicStatusUI("success", "✅ تم تفعيل الميكروفون والسماح به بنجاح! يمكنك الآن الانضمام للمكالمة الجماعية.", "نشط");
    } catch (err) {
        console.error("[Audio] Failed to get microphone access:", err);
        updateMicStatusUI("error", "❌ فشل تفعيل الميكروفون أو تم رفضه. يرجى الضغط على علامة القفل 🔒 بجانب العنوان في الأعلى لتعديل الإذن، ثم اضغط تفعيل مجدداً.", "مرفوض");
        alert("تنبيه: ميكروفون الجوال معطل أو محظور. لن تتمكن من التحدث، يمكنك الاستماع فقط.");
    }
}

// handleBinaryAudioPacket routes received sound streams to the correct speaker's scheduler
function handleBinaryAudioPacket(arrayBuffer) {
    if (state.audioCtx.state === 'suspended') return;

    const dataView = new DataView(arrayBuffer);
    
    // Parse custom header: length (1 byte) + senderID (ASCII string)
    const headerLen = dataView.getUint8(0);
    const decoder = new TextDecoder("utf-8");
    const headerBytes = new Uint8Array(arrayBuffer, 1, headerLen);
    const headerStr = decoder.decode(headerBytes);
    
    const parts = headerStr.split(":");
    const senderID = parts[0];
    const senderName = parts[1] || "مجهول";
    
    // Update last seen speech for UI visual feedback
    state.lastSpeakerTimes.set(senderID, Date.now());

    // Remaining bytes are Int16 raw audio payload
    const audioPayloadOffset = 1 + headerLen;
    const pcmData = new Int16Array(arrayBuffer, audioPayloadOffset, (arrayBuffer.byteLength - audioPayloadOffset) / 2);

    // Get or Create JitterBufferPlayer for this sender
    let player = state.playbackQueues.get(senderID);
    if (!player) {
        player = new JitterBufferPlayer(state.audioCtx, 16000);
        state.playbackQueues.set(senderID, player);
    }
    
    player.feed(pcmData);
}

// 4. WEBSOCKET JSON PROTOCOL & COMMANDS
function handleJSONControlPacket(textData) {
    let packet;
    try {
        packet = JSON.parse(textData);
    } catch (err) {
        return;
    }

    switch (packet.type) {
        case "error":
            alert(`خطأ: ${packet.message}`);
            disconnectIntercom();
            break;
            
        case "pong":
            // Calculate latency RTT
            const sentTime = packet.timestamp;
            const rtt = Date.now() - sentTime;
            updateLocalSignalDisplay(rtt);
            // Report computed latency back to server for Director's console
            sendJSONCommand({ type: "latency", rtt: rtt });
            break;

        case "mute_update":
            // Received forced mute from director
            setMicMuteState(packet.muted);
            break;

        case "status":
            // Server updates complete room state
            state.clientsList = packet.clients || [];
            
            if (state.isDirector) {
                // Director Dashboard rendering
                document.getElementById("director-pin").textContent = packet.pin;
                document.getElementById("toggle-hear-each-other").checked = packet.clients_hear_each_other;
                
                // Update QR code dynamically (100% offline via local api)
                let hostAddress = location.host; // fallback
                if (packet.ips && packet.ips.length > 0) {
                    const remoteIP = packet.ips.find(ip => ip !== "127.0.0.1" && ip !== "::1") || packet.ips[0];
                    hostAddress = `${remoteIP}:8443`;
                }
                const connectionLink = `https://${hostAddress}/?pin=${packet.pin}`;
                document.getElementById("qr-image").src = `/api/qrcode?url=${encodeURIComponent(connectionLink)}`;
                document.getElementById("server-url-text").textContent = connectionLink;
                
                updateDirectorTargetsUI(packet);
                renderDirectorMatrixGrid();
            } else {
                // Crew Member Dashboard rendering
                renderCrewActiveBrief();
            }
            break;
    }
}

// Send helper for control JSON
function sendJSONCommand(obj) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(obj));
    }
}

// 5. HEARTBEAT SIGNAL LOOP
function startHeartbeatLoop() {
    if (state.pingInterval) clearInterval(state.pingInterval);
    
    state.pingInterval = setInterval(() => {
        sendJSONCommand({
            type: "ping",
            timestamp: Date.now()
        });
    }, 1500);
}

function updateLocalSignalDisplay(rtt) {
    const barsSpan = document.getElementById("crew-signal-bars");
    const rttSpan = document.getElementById("crew-signal-latency");
    if (!barsSpan || !rttSpan) return;

    rttSpan.textContent = `${rtt}ms`;
    
    if (rtt < 30) {
        barsSpan.textContent = "📶🟢 الممتازة";
        barsSpan.style.color = "var(--color-green)";
    } else if (rtt < 100) {
        barsSpan.textContent = "📶🟡 الجيدة";
        barsSpan.style.color = "var(--color-yellow)";
    } else if (rtt < 250) {
        barsSpan.textContent = "📶🟠 تقطع";
        barsSpan.style.color = "var(--color-orange)";
    } else {
        barsSpan.textContent = "📶🔴 ضعيفة جداً";
        barsSpan.style.color = "var(--color-red)";
    }
}

// 6. SCREEN WAKELOCK (PREVENT PHONE SLEEP)
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            state.wakeLock = await navigator.wakeLock.request('screen');
            document.getElementById("wakelock-badge").style.opacity = "1";
            console.log("[WakeLock] Screen WakeLock acquired successfully!");
            
            // Re-acquire lock if browser goes back to background then foreground
            document.addEventListener('visibilitychange', reacquireWakeLock);
        } else {
            console.warn("[WakeLock] WakeLock API not supported by browser.");
            document.getElementById("wakelock-badge").style.opacity = "0.4";
            document.querySelector("#wakelock-badge span:last-child").textContent = "WakeLock غير مدعوم في هذا المتصفح. يرجى إبقاء الشاشة مفعلة يدوياً.";
        }
    } catch (err) {
        console.error("[WakeLock] Request failed:", err);
    }
}

function reacquireWakeLock() {
    if (state.wakeLock !== null && document.visibilityState === 'visible') {
        requestWakeLock();
    }
}

function releaseWakeLock() {
    if (state.wakeLock) {
        state.wakeLock.release().then(() => {
            state.wakeLock = null;
            console.log("[WakeLock] Released.");
        });
    }
}

// 7. PHOTOGRAPHER/CREW PHONE UI
function toggleMicMute() {
    setMicMuteState(!state.micMuted);
}

function setMicMuteState(muted) {
    state.micMuted = muted;
    const btnMic = document.getElementById("btn-mic-toggle");
    const statusText = document.getElementById("mic-status-text");
    
    if (!btnMic) return;

    if (state.micMuted) {
        btnMic.classList.remove("active-talk");
        btnMic.classList.add("muted-talk");
        btnMic.querySelector(".icon").textContent = "🔇";
        statusText.textContent = "صوت صامت";
    } else {
        btnMic.classList.remove("muted-talk");
        btnMic.classList.add("active-talk");
        btnMic.querySelector(".icon").textContent = "🎙️";
        statusText.textContent = "تحدث مباشر";
    }
}

function handleVolumeSlider(e) {
    const vol = e.target.value;
    document.getElementById("vol-percent").textContent = `${vol}%`;
    
    const floatVol = vol / 100.0;
    // Set global volume on all active stream players
    for (let player of state.playbackQueues.values()) {
        player.setVolume(floatVol);
    }
}

function renderCrewActiveBrief() {
    // Render current active crew names on client mobile screen
    const displayRole = document.getElementById("crew-display-role");
    const displayName = document.getElementById("crew-display-name");
    const container = document.getElementById("crew-active-list");
    
    if (displayName) displayName.textContent = state.userName;
    if (displayRole) {
        let arabicRole = "مصور";
        if (state.userRole === "Production") arabicRole = "إنتاج";
        if (state.userRole === "Presenter") arabicRole = "مذيع";
        displayRole.textContent = arabicRole;
    }
    
    if (!container) return;
    container.innerHTML = "";

    const activeCrew = state.clients.filter(c => c.role !== "Director");
    
    if (activeCrew.length === 0) {
        container.innerHTML = `<span class="crew-tag">لا يوجد مصورين متصلين آخرين</span>`;
        return;
    }

    activeCrew.forEach(c => {
        const tag = document.createElement("span");
        tag.className = `crew-tag c-tag-${c.id}`;
        let roleIcon = "📷";
        if (c.role === "Production") roleIcon = "💼";
        if (c.role === "Presenter") roleIcon = "🎙️";
        
        tag.textContent = `${roleIcon} ${c.name}`;
        container.appendChild(tag);
    });
}

// Highlights tags of active speakers dynamically
function updateSpeakerHighlights() {
    const now = Date.now();
    
    state.lastSpeakerTimes.forEach((lastSpoke, clientID) => {
        const isSpeaking = (now - lastSpoke < 350); // Spoke in last 350ms
        
        // Highlight in Director Matrix
        const card = document.getElementById(`card-${clientID}`);
        if (card) {
            if (isSpeaking) {
                card.classList.add("talking");
            } else {
                card.classList.remove("talking");
            }
        }

        // Highlight in Crew Brief
        const tag = document.querySelector(`.c-tag-${clientID}`);
        if (tag) {
            if (isSpeaking) {
                tag.classList.add("talking");
            } else {
                tag.classList.remove("talking");
            }
        }
    });
}

// 8. DIRECTOR CONTROL ACTIONS & ROUTING
function startDirectorSpeaking() {
    setMicMuteState(false);
    const btnDirMic = document.getElementById("btn-director-mic");
    btnDirMic.classList.add("active-talk");
    btnDirMic.classList.remove("muted-talk");
}

function stopDirectorSpeaking() {
    setMicMuteState(true);
    const btnDirMic = document.getElementById("btn-director-mic");
    btnDirMic.classList.remove("active-talk");
    btnDirMic.classList.add("muted-talk");
}

function regeneratePIN() {
    sendJSONCommand({ type: "regenerate_pin" });
}

function toggleHearEachOther() {
    const hear = document.getElementById("toggle-hear-each-other").checked;
    updateRoutingOnServer({ hear_each_other: hear });
}

function setRoutingPreset(preset) {
    // Reset active preset button styling
    document.querySelectorAll(".route-btn").forEach(btn => btn.classList.remove("active"));

    if (preset === "all") {
        document.getElementById("route-all").classList.add("active");
        state.directorTargets.all = true;
        state.directorTargets.roles = {};
        state.directorTargets.targets = {};
    } else {
        // Toggle role based target
        const btn = document.getElementById(`route-${preset.toLowerCase()}`) || document.getElementById(`route-cameras`);
        if (btn) btn.classList.add("active");
        
        state.directorTargets.all = false;
        state.directorTargets.roles = {};
        state.directorTargets.roles[preset] = true;
        state.directorTargets.targets = {};
    }
    updateRoutingOnServer();
}

function updateDirectorTargetsUI(packet) {
    state.directorTargets.all = packet.director_all;
    state.directorTargets.roles = {};
    if (packet.director_roles) {
        packet.director_roles.forEach(r => state.directorTargets.roles[r] = true);
    }
    state.directorTargets.targets = {};
    if (packet.director_targets) {
        packet.director_targets.forEach(t => state.directorTargets.targets[t] = true);
    }

    // Refresh active preset styling
    document.querySelectorAll(".route-btn").forEach(btn => btn.classList.remove("active"));
    if (state.directorTargets.all) {
        document.getElementById("route-all").classList.add("active");
    } else if (state.directorTargets.roles["Photographer"]) {
        document.getElementById("route-cameras").classList.add("active");
    } else if (state.directorTargets.roles["Production"]) {
        document.getElementById("route-production").classList.add("active");
    } else if (state.directorTargets.roles["Presenter"]) {
        document.getElementById("route-presenter").classList.add("active");
    }
}

function updateRoutingOnServer(additionalParams = {}) {
    const command = {
        type: "set_targets",
        all: state.directorTargets.all,
        roles: Object.keys(state.directorTargets.roles).filter(k => state.directorTargets.roles[k]),
        targets: Object.keys(state.directorTargets.targets).filter(k => state.directorTargets.targets[k]),
        hear_each_other: document.getElementById("toggle-hear-each-other").checked,
        ...additionalParams
    };
    sendJSONCommand(command);
}

// 9. RENDER CONNECTED CREW MATRIX GRID (DIRECTOR VIEW)
function renderDirectorMatrixGrid() {
    const grid = document.getElementById("crew-matrix-grid");
    const countSpan = document.getElementById("crew-count");
    if (!grid) return;

    // Filter out director from matrix grid
    const crewMembers = state.clientsList.filter(c => c.role !== "Director");
    countSpan.textContent = crewMembers.length;

    if (crewMembers.length === 0) {
        grid.innerHTML = `
            <div class="empty-state">
                📭 لا يوجد أي أعضاء متصلين حالياً.
                <br>
                <span class="sub">شارك الـ QR Code مع الطاقم للبدء.</span>
            </div>
        `;
        return;
    }

    grid.innerHTML = "";
    crewMembers.forEach(c => {
        const card = document.createElement("div");
        card.id = `card-${c.id}`;
        card.className = `crew-card`;

        // Map status classes and signals
        let signalClass = "offline";
        let signalText = "📶 غير متصل";
        if (c.status === "Excellent") {
            signalClass = "excellent";
            signalText = `📶 ممتازة (${c.latency}ms)`;
        } else if (c.status === "Good") {
            signalClass = "good";
            signalText = `📶 جيدة (${c.latency}ms)`;
        } else if (c.status === "Unstable") {
            signalClass = "unstable";
            signalText = `📶 متقطع (${c.latency}ms)`;
        } else if (c.status === "OutOfRange") {
            signalClass = "outofrange";
            signalText = "📶 خارج النطاق ⚠️";
        }

        let roleArabic = "مصور";
        let roleIcon = "📷";
        if (c.role === "Production") { roleArabic = "إنتاج"; roleIcon = "💼"; }
        if (c.role === "Presenter") { roleArabic = "مذيع"; roleIcon = "🎙️"; }

        // Determine if selected for broadcasting
        const isTargeted = state.directorTargets.all || 
                           state.directorTargets.roles[c.role] || 
                           state.directorTargets.targets[c.id];

        const cardContent = `
            <div class="card-top">
                <div class="info">
                    <span class="name">${c.name}</span>
                    <span class="role">${roleIcon} ${roleArabic}</span>
                </div>
                <span class="signal-status ${signalClass}">${signalText}</span>
            </div>
            
            <div class="card-bottom">
                <div class="card-actions">
                    <button class="btn-card talk-toggle ${isTargeted ? 'active' : ''}" onclick="toggleTargetClient('${c.id}')">
                        ${isTargeted ? '🔊 يستمع' : '🔇 لا يستمع'}
                    </button>
                    <button class="btn-card mute-toggle ${c.muted ? 'active' : ''}" onclick="toggleMuteClient('${c.id}', ${c.muted})">
                        ${c.muted ? '🔇 مكتوم' : '🎤 يتحدث'}
                    </button>
                </div>
                <button class="btn-card kick-btn" onclick="kickClient('${c.id}')">طرد 🚪</button>
            </div>
        `;
        card.innerHTML = cardContent;
        grid.appendChild(card);
    });
}

// Global actions exposed from matrix cards
window.toggleTargetClient = (id) => {
    state.directorTargets.all = false; // Disable "All" when individually toggling
    state.directorTargets.targets[id] = !state.directorTargets.targets[id];
    updateRoutingOnServer();
};

window.toggleMuteClient = (id, currentMuteState) => {
    sendJSONCommand({
        type: "mute_update",
        id: id,
        muted: !currentMuteState
    });
};

window.kickClient = (id) => {
    if (confirm("هل تريد طرد هذا المستخدم من نظام الانتركم؟")) {
        sendJSONCommand({
            type: "kick_client",
            id: id
        });
    }
};

// 10. SESSION CLEANUP & EXIT
function disconnectIntercom() {
    if (confirm("هل تريد مغادرة مكالمة الانتركم الجماعية؟")) {
        disconnectSession();
    }
}

function disconnectSession() {
    cleanupSession();
    if (state.ws) {
        state.ws.close(1000, "User clicked disconnect");
        state.ws = null;
    }
}

function cleanupSession() {
    if (state.pingInterval) {
        clearInterval(state.pingInterval);
        state.pingInterval = null;
    }
    if (state.reconnectTimeout) {
        clearTimeout(state.reconnectTimeout);
        state.reconnectTimeout = null;
    }
    
    // Stop mic stream
    if (state.localStream) {
        state.localStream.getTracks().forEach(track => track.stop());
        state.localStream = null;
    }
    
    // Disconnect processor
    if (state.micProcessor) {
        state.micProcessor.disconnect();
        state.micProcessor = null;
    }
    
    // Release WakeLock
    releaseWakeLock();

    // Reset views
    crewScreen.classList.remove("active");
    directorScreen.classList.remove("active");
    loginScreen.classList.add("active");
    
    const btnJoin = document.getElementById("btn-join");
    if (btnJoin) btnJoin.disabled = false;

    // Reset local mic mute
    setMicMuteState(false);
}

// Expose state list globally for simple inline templates in HTML
Object.defineProperty(state, 'clients', {
    get: function() { return this.clientsList; }
});

// ==========================================
// 11. PWA SERVICE WORKER & INSTALLATION ENGINE
// ==========================================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('[PWA] Service Worker registered successfully!', reg))
            .catch(err => console.error('[PWA] Service Worker registration failed!', err));
    });
}

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    // Intercept standard browser prompt
    e.preventDefault();
    deferredPrompt = e;
    
    // Reveal our beautiful custom install button
    const installContainer = document.getElementById("pwa-install-container");
    if (installContainer) {
        installContainer.classList.remove("hidden");
    }
});

const btnInstallPwa = document.getElementById("btn-install-pwa");
if (btnInstallPwa) {
    btnInstallPwa.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        
        // Open native installation dialog
        deferredPrompt.prompt();
        
        const { outcome } = await deferredPrompt.userChoice;
        console.log(`[PWA] Installation prompt choice: ${outcome}`);
        
        deferredPrompt = null;
        
        // Hide button after choice
        const installContainer = document.getElementById("pwa-install-container");
        if (installContainer) {
            installContainer.classList.add("hidden");
        }
    });
}
